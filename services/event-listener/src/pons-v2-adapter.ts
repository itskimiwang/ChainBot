import { decodeEventLog, type Address, type Hex } from 'viem';
import { ponsV2CurveAbi, ponsV2FactoryAbi, TOPIC0, type RawLog } from '@rhc/chain';
import { createLogger } from '@rhc/core';
import type { CurveTradeEvent, GraduationEvent, NewLaunchEvent } from '@rhc/types';
import type { DecodeContext, FactoryDecodeResult, LaunchpadAdapter } from './adapter.js';

const log = createLogger('listener:pons-v2');

/**
 * Pons V2: fixed 1B supply minted into a per-token constant-product bonding curve, which
 * graduates into a permanently locked Uniswap v4 pool behind a Pons-owned hook.
 */
export class PonsV2Adapter implements LaunchpadAdapter {
  readonly id = 'pons-v2';
  readonly name = 'Pons V2';

  readonly factoryTopics: Hex[] = [TOPIC0.TokenLaunched, TOPIC0.PoolGraduated, TOPIC0.LaunchSwept];
  readonly curveTopics: Hex[] = [TOPIC0.CurveBuy, TOPIC0.CurveSell];

  constructor(
    readonly factoryAddress: Address,
    private readonly hookAddress: Address,
  ) {}

  async decodeFactoryLog(raw: RawLog, ctx: DecodeContext): Promise<FactoryDecodeResult | null> {
    const topic0 = raw.topics[0]?.toLowerCase();
    const blockNumber = Number(BigInt(raw.blockNumber));

    if (topic0 === TOPIC0.TokenLaunched) {
      const decoded = decodeEventLog({ abi: ponsV2FactoryAbi, data: raw.data, topics: raw.topics as never });
      if (decoded.eventName !== 'TokenLaunched') return null;
      const args = decoded.args as unknown as {
        token: Address;
        curve: Address;
        deployer: Address;
        pairToken: Address;
        graduationThreshold: bigint;
      };

      const quoteAsset = await ctx.resolveQuoteAsset(args.pairToken);
      if (!quoteAsset) {
        // The factory approved an asset we cannot resolve economics for. Declining is
        // correct: without decimals and a threshold we can neither price nor size.
        log.debug('skipping launch in unresolvable quote asset', { token: args.token, pairToken: args.pairToken });
        return null;
      }

      const event: NewLaunchEvent = {
        kind: 'new-launch',
        launchpadId: this.id,
        tokenAddress: args.token.toLowerCase() as NewLaunchEvent['tokenAddress'],
        curveAddress: args.curve.toLowerCase() as NewLaunchEvent['curveAddress'],
        deployerAddress: args.deployer.toLowerCase() as NewLaunchEvent['deployerAddress'],
        quoteAsset,
        // The curve is empty at this instant beyond its phantom balance; the listener
        // fills in a real reserve on the first state read.
        curveReserve: quoteAsset.phantomQuote ?? '0',
        graduationThreshold: args.graduationThreshold.toString(),
        blockNumber,
        txHash: raw.transactionHash.toLowerCase() as NewLaunchEvent['txHash'],
        timestamp: ctx.timestampFor(blockNumber),
        creatorFirstBuy: null,
        creatorTaxBps: null,
      };
      return { type: 'launch', event };
    }

    if (topic0 === TOPIC0.PoolGraduated) {
      const decoded = decodeEventLog({ abi: ponsV2FactoryAbi, data: raw.data, topics: raw.topics as never });
      if (decoded.eventName !== 'PoolGraduated') return null;
      const args = decoded.args as unknown as {
        token: Address;
        positionId: bigint;
        tokenAmount: bigint;
        pairTokenAmount: bigint;
      };

      const tokenAddress = args.token.toLowerCase();
      const quoteAsset = ctx.quoteAssetFor(tokenAddress);
      if (!quoteAsset) return null;

      const event: GraduationEvent = {
        kind: 'graduation',
        launchpadId: this.id,
        tokenAddress: tokenAddress as GraduationEvent['tokenAddress'],
        // Uniswap v4 has no per-pool contract: liquidity lives in the PoolManager
        // singleton and a pool is identified by its PoolId. The hook is what marks the
        // pool as a Pons pool, so it is the address that actually matters downstream.
        poolAddress: this.hookAddress.toLowerCase() as GraduationEvent['poolAddress'],
        hookAddress: this.hookAddress.toLowerCase() as GraduationEvent['hookAddress'],
        poolId: null,
        quoteAsset,
        quoteSeeded: args.pairTokenAmount.toString(),
        tokensSeeded: args.tokenAmount.toString(),
        blockNumber,
        txHash: raw.transactionHash.toLowerCase() as GraduationEvent['txHash'],
        timestamp: ctx.timestampFor(blockNumber),
      };
      return { type: 'graduation', event };
    }

    if (topic0 === TOPIC0.LaunchSwept) {
      const decoded = decodeEventLog({ abi: ponsV2FactoryAbi, data: raw.data, topics: raw.topics as never });
      if (decoded.eventName !== 'LaunchSwept') return null;
      const args = decoded.args as unknown as { token: Address };
      // Sweep precedes pool creation. Sells revert from this moment even though the
      // factory may still report the pre-graduation phase, so positions must stop
      // trying to exit on the curve as soon as this lands.
      return { type: 'swept', tokenAddress: args.token.toLowerCase() as Address };
    }

    return null;
  }

  async decodeCurveLog(raw: RawLog, ctx: DecodeContext): Promise<CurveTradeEvent | null> {
    const topic0 = raw.topics[0]?.toLowerCase();
    if (topic0 !== TOPIC0.CurveBuy && topic0 !== TOPIC0.CurveSell) return null;

    const decoded = decodeEventLog({ abi: ponsV2CurveAbi, data: raw.data, topics: raw.topics as never });
    const blockNumber = Number(BigInt(raw.blockNumber));
    const curveAddress = raw.address.toLowerCase();

    if (decoded.eventName === 'CurveBuy') {
      const args = decoded.args as unknown as {
        buyer: Address;
        recipient: Address;
        quoteIn: bigint;
        tokensOut: bigint;
        fee: bigint;
        tax: bigint;
      };
      return this.toTrade(raw, ctx, {
        side: 'buy',
        trader: args.buyer,
        recipient: args.recipient,
        quoteAmount: args.quoteIn,
        tokenAmount: args.tokensOut,
        fee: args.fee,
        tax: args.tax,
        blockNumber,
        curveAddress,
      });
    }

    if (decoded.eventName === 'CurveSell') {
      const args = decoded.args as unknown as {
        seller: Address;
        recipient: Address;
        tokensIn: bigint;
        quoteOut: bigint;
        fee: bigint;
        tax: bigint;
      };
      return this.toTrade(raw, ctx, {
        side: 'sell',
        trader: args.seller,
        recipient: args.recipient,
        quoteAmount: args.quoteOut,
        tokenAmount: args.tokensIn,
        fee: args.fee,
        tax: args.tax,
        blockNumber,
        curveAddress,
      });
    }

    return null;
  }

  private toTrade(
    raw: RawLog,
    ctx: DecodeContext,
    parts: {
      side: 'buy' | 'sell';
      trader: Address;
      recipient: Address;
      quoteAmount: bigint;
      tokenAmount: bigint;
      fee: bigint;
      tax: bigint;
      blockNumber: number;
      curveAddress: string;
    },
  ): CurveTradeEvent | null {
    // A miss means the curve was evicted mid-page, not an unknown token: the scanner
    // only ever asks for logs from curves the listener is already tracking.
    const tokenAddress = ctx.tokenForCurve(parts.curveAddress);
    if (!tokenAddress) return null;

    return {
      kind: 'curve-trade',
      launchpadId: this.id,
      tokenAddress: tokenAddress as CurveTradeEvent['tokenAddress'],
      curveAddress: parts.curveAddress as CurveTradeEvent['curveAddress'],
      side: parts.side,
      trader: parts.trader.toLowerCase() as CurveTradeEvent['trader'],
      recipient: parts.recipient.toLowerCase() as CurveTradeEvent['recipient'],
      quoteAmount: parts.quoteAmount.toString(),
      tokenAmount: parts.tokenAmount.toString(),
      feePaid: parts.fee.toString(),
      taxPaid: parts.tax.toString(),
      curveReserve: (ctx.reserveFor(parts.curveAddress) ?? 0n).toString(),
      blockNumber: parts.blockNumber,
      txHash: raw.transactionHash.toLowerCase() as CurveTradeEvent['txHash'],
      timestamp: ctx.timestampFor(parts.blockNumber),
    };
  }
}
