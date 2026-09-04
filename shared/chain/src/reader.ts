import type { Address } from 'viem';
import { createLogger, retry } from '@rhc/core';
import type { LaunchPhase } from '@rhc/types';
import { LAUNCH_PHASE_BY_INDEX } from '@rhc/types';
import { erc20Abi, ponsV2CurveAbi, ponsV2FactoryAbi } from './abi/pons-v2.js';
import type { CurveState } from './curve-math.js';
import type { RhcPublicClient } from './client.js';

const log = createLogger('chain:reader');

export interface CurveSnapshot extends CurveState {
  curveAddress: Address;
  readyToGraduate: boolean;
  graduated: boolean;
  blockNumber: number;
  readAt: number;
}

/**
 * Reads live curve state.
 *
 * Everything here is an `eth_call`. That is what makes paper mode honest: the simulated
 * fills are priced off exactly the same reserves a live order would hit, and reads cost
 * nothing and touch no funds.
 */
export class ChainReader {
  constructor(private readonly client: RhcPublicClient) {}

  /** One multicall for the six values needed to price a trade against a curve. */
  async readCurve(curveAddress: Address): Promise<CurveSnapshot | null> {
    try {
      const results = await retry(() =>
        this.client.multicall({
          allowFailure: true,
          contracts: [
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'getReserves' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'sellableTokens' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'feeBps' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'creatorTaxBps' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'realQuoteReserve' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'graduationThreshold' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'readyToGraduate' },
            { address: curveAddress, abi: ponsV2CurveAbi, functionName: 'graduated' },
          ],
        }),
      );

      const reserves = results[0];
      if (reserves.status !== 'success') return null;
      const [quoteReserve, tokenReserve] = reserves.result as readonly [bigint, bigint];

      const value = (i: number, fallback: bigint): bigint => {
        const r = results[i];
        return r?.status === 'success' ? (r.result as bigint) : fallback;
      };
      const flag = (i: number): boolean => {
        const r = results[i];
        return r?.status === 'success' ? (r.result as boolean) : false;
      };

      return {
        curveAddress,
        quoteReserve,
        tokenReserve,
        sellableTokens: value(1, 0n),
        feeBps: value(2, 100n),
        creatorTaxBps: value(3, 0n),
        realQuoteReserve: value(4, 0n),
        graduationThreshold: value(5, 0n),
        readyToGraduate: flag(6),
        graduated: flag(7),
        blockNumber: Number(await this.client.getBlockNumber()),
        readAt: Date.now(),
      };
    } catch (err) {
      log.debug('curve read failed', { curveAddress, err });
      return null;
    }
  }

  /**
   * Snipe tax is keyed to the token *recipient*, not the sender, because exemptions are
   * held per recipient. Quoting with the wrong address can understate a 99% tax.
   */
  async readSnipeTaxBps(curveAddress: Address, recipient: Address): Promise<bigint> {
    try {
      return await this.client.readContract({
        address: curveAddress,
        abi: ponsV2CurveAbi,
        functionName: 'currentSnipeTaxBps',
        args: [recipient],
      });
    } catch {
      // Unknown tax must not read as "no tax": treat it as the opening rate so the
      // decision engine waits rather than buying blind into a 99% skim.
      return 9_900n;
    }
  }

  /**
   * The factory's launch record. `phase` is authoritative for routing and must not be
   * inferred from balances or from having seen a graduation event.
   */
  async readLaunchRecord(
    factory: Address,
    token: Address,
  ): Promise<{
    exists: boolean;
    curve: Address;
    deployer: Address;
    pairToken: Address;
    graduationThreshold: bigint;
    creatorTaxBps: number;
    phase: LaunchPhase;
  } | null> {
    try {
      const record = (await this.client.readContract({
        address: factory,
        abi: ponsV2FactoryAbi,
        functionName: 'getLaunchedToken',
        args: [token],
      })) as {
        token: Address;
        curve: Address;
        deployer: Address;
        pairToken: Address;
        graduationThreshold: bigint;
        creatorTaxBps: number;
        phase: number;
        exists: boolean;
      };

      return {
        exists: record.exists,
        curve: record.curve,
        deployer: record.deployer,
        pairToken: record.pairToken,
        graduationThreshold: record.graduationThreshold,
        creatorTaxBps: Number(record.creatorTaxBps),
        phase: LAUNCH_PHASE_BY_INDEX[record.phase] ?? 'curve',
      };
    } catch (err) {
      log.debug('launch record read failed', { token, err });
      return null;
    }
  }

  /**
   * Per-asset economics straight from the factory. The approved quote-asset set is
   * owner-mutable, so this — not the config seed list — is the source of truth.
   */
  async readPairTokenEconomics(
    factory: Address,
    pairToken: Address,
  ): Promise<{ phantomQuote: bigint; graduationThreshold: bigint; decimals: number; approved: boolean } | null> {
    try {
      const [economics, approved] = await this.client.multicall({
        allowFailure: false,
        contracts: [
          { address: factory, abi: ponsV2FactoryAbi, functionName: 'pairTokenEconomics', args: [pairToken] },
          { address: factory, abi: ponsV2FactoryAbi, functionName: 'approvedPairTokens', args: [pairToken] },
        ],
      });
      const [phantomQuote, graduationThreshold, decimals] = economics as readonly [bigint, bigint, number];
      return { phantomQuote, graduationThreshold, decimals: Number(decimals), approved: approved as boolean };
    } catch (err) {
      log.debug('pairTokenEconomics read failed', { pairToken, err });
      return null;
    }
  }

  async readTokenMeta(token: Address): Promise<{ name: string; symbol: string; decimals: number }> {
    const results = await this.client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: erc20Abi, functionName: 'name' },
        { address: token, abi: erc20Abi, functionName: 'symbol' },
        { address: token, abi: erc20Abi, functionName: 'decimals' },
      ],
    });
    return {
      name: results[0]?.status === 'success' ? (results[0].result as string) : 'unknown',
      symbol: results[1]?.status === 'success' ? (results[1].result as string) : '???',
      decimals: results[2]?.status === 'success' ? Number(results[2].result) : 18,
    };
  }

  /**
   * Does the token contract still have an owner?
   *
   * Pons launch tokens are a fixed-supply ERC-20 where the deployer is metadata with no
   * privileges, so a missing `owner()` is the expected, good case — not a failed check.
   */
  async readOwner(token: Address): Promise<{ hasOwner: boolean; owner: Address | null }> {
    try {
      const owner = await this.client.readContract({ address: token, abi: erc20Abi, functionName: 'owner' });
      const isZero = /^0x0{40}$/i.test(owner);
      return { hasOwner: !isZero, owner: isZero ? null : owner };
    } catch {
      return { hasOwner: false, owner: null };
    }
  }

  async getBlockNumber(): Promise<number> {
    return Number(await this.client.getBlockNumber());
  }

  async getBlockTimestampMs(blockNumber: number): Promise<number> {
    const block = await this.client.getBlock({ blockNumber: BigInt(blockNumber) });
    return Number(block.timestamp) * 1000;
  }
}
