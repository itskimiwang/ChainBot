import {
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  encodeAbiParameters,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';
import { erc20Abi, ponsV2CurveAbi, type RhcPublicClient } from '@rhc/chain';
import { createLogger, retry } from '@rhc/core';
import type { QuoteAsset } from '@rhc/types';

const log = createLogger('vetting:sim');

/**
 * A probe address with no history, used as the simulated buyer. Its balances are
 * supplied entirely by state overrides, so the simulation never touches a real account
 * and never needs a funded wallet.
 *
 * Snipe tax is keyed per recipient, so a fresh address also means the simulation sees
 * the same tax an unexempted buyer would pay rather than a creator's exempt rate.
 */
const PROBE: Address = '0x00000000000000000000000000000000000d1a9e';

interface SimCall {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

interface SimCallResult {
  status: Hex;
  returnData: Hex;
  gasUsed: Hex;
  error?: { message: string };
}

export interface RoundTripResult {
  ok: boolean;
  /** Set when a leg reverted. The sell leg reverting is the honeypot signature. */
  failedLeg: 'buy' | 'approve' | 'sell' | null;
  revertReason: string | null;
  quoteIn: bigint;
  tokensOut: bigint;
  quoteReturned: bigint;
  /** Share of the original spend recovered by immediately selling back, in bps. */
  retentionBps: number;
}

/**
 * Simulated buy/sell round trip via `eth_simulateV1`.
 *
 * This is the authoritative vetting check and the reason paper mode is worth anything:
 * it executes the exact call sequence a real entry would, against real mainnet state, in
 * a simulated block that is discarded. It costs no gas and touches no funds, so it runs
 * identically in paper and live mode.
 *
 * Sequential state is the whole point — the sell leg has to run against the state the
 * buy leg produced. A pair of independent `eth_call`s cannot express that, which is why
 * this uses `eth_simulateV1` rather than two calls.
 */
export class RoundTripSimulator {
  /** ERC-20 balance storage slots, discovered once per token and cached. */
  private readonly balanceSlots = new Map<string, number | null>();

  constructor(private readonly client: RhcPublicClient) {}

  async simulate(params: {
    curveAddress: Address;
    tokenAddress: Address;
    quoteAsset: QuoteAsset;
    quoteIn: bigint;
  }): Promise<RoundTripResult> {
    const { curveAddress, tokenAddress, quoteAsset, quoteIn } = params;

    const stateOverrides: Record<string, { balance?: Hex; stateDiff?: Record<Hex, Hex> }> = {
      // Cover the trade plus generous headroom for gas.
      [PROBE]: { balance: numberToHex(quoteAsset.isNative ? quoteIn + 10n ** 18n : 10n ** 18n) },
    };

    const calls: SimCall[] = [];

    if (!quoteAsset.isNative) {
      // An ERC-20 quote needs the probe to hold and approve the pair token. Balance is
      // injected by writing the mapping slot directly, so no real holder is involved.
      const slot = await this.findBalanceSlot(quoteAsset.address as Address);
      if (slot == null) {
        return {
          ok: false,
          failedLeg: 'buy',
          revertReason: 'could not locate ERC-20 balance slot for the quote asset',
          quoteIn,
          tokensOut: 0n,
          quoteReturned: 0n,
          retentionBps: 0,
        };
      }
      stateOverrides[quoteAsset.address] = {
        stateDiff: { [balanceSlotKey(PROBE, slot)]: numberToHex(quoteIn * 2n, { size: 32 }) },
      };
      calls.push({
        from: PROBE,
        to: quoteAsset.address as Address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curveAddress, quoteIn] }),
      });
    }

    calls.push({
      from: PROBE,
      to: curveAddress,
      data: encodeFunctionData({
        abi: ponsV2CurveAbi,
        functionName: 'buy',
        // minTokensOut of zero: the simulation is asking "can this be bought and sold at
        // all", not "at what price". Slippage protection belongs on the real order.
        args: [quoteIn, 0n, PROBE],
      }),
      ...(quoteAsset.isNative ? { value: quoteIn } : {}),
    });

    const buyIndex = calls.length - 1;

    try {
      const firstPass = await this.run(calls, stateOverrides);
      const buyResult = firstPass[buyIndex];
      if (!buyResult || buyResult.status !== '0x1') {
        return {
          ok: false,
          failedLeg: 'buy',
          revertReason: buyResult?.error?.message ?? 'buy reverted',
          quoteIn,
          tokensOut: 0n,
          quoteReturned: 0n,
          retentionBps: 0,
        };
      }

      const tokensOut = decodeFunctionResult({
        abi: ponsV2CurveAbi,
        functionName: 'buy',
        data: buyResult.returnData,
      }) as bigint;

      if (tokensOut === 0n) {
        return {
          ok: false,
          failedLeg: 'buy',
          revertReason: 'buy returned zero tokens',
          quoteIn,
          tokensOut: 0n,
          quoteReturned: 0n,
          retentionBps: 0,
        };
      }

      // Sell the entire simulated holding straight back. The curve pulls tokens via
      // transferFrom, so the approval has to land first.
      const sellCalls: SimCall[] = [
        ...calls,
        {
          from: PROBE,
          to: tokenAddress,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [curveAddress, tokensOut],
          }),
        },
        {
          from: PROBE,
          to: curveAddress,
          data: encodeFunctionData({
            abi: ponsV2CurveAbi,
            functionName: 'sell',
            args: [tokensOut, 0n, PROBE],
          }),
        },
      ];

      const secondPass = await this.run(sellCalls, stateOverrides);
      const approveResult = secondPass[sellCalls.length - 2];
      const sellResult = secondPass[sellCalls.length - 1];

      if (!approveResult || approveResult.status !== '0x1') {
        // A token that cannot even be approved is unsellable by construction.
        return {
          ok: false,
          failedLeg: 'approve',
          revertReason: approveResult?.error?.message ?? 'approve reverted',
          quoteIn,
          tokensOut,
          quoteReturned: 0n,
          retentionBps: 0,
        };
      }

      if (!sellResult || sellResult.status !== '0x1') {
        return {
          ok: false,
          failedLeg: 'sell',
          revertReason: sellResult?.error?.message ?? 'sell reverted',
          quoteIn,
          tokensOut,
          quoteReturned: 0n,
          retentionBps: 0,
        };
      }

      const quoteReturned = decodeFunctionResult({
        abi: ponsV2CurveAbi,
        functionName: 'sell',
        data: sellResult.returnData,
      }) as bigint;

      return {
        ok: true,
        failedLeg: null,
        revertReason: null,
        quoteIn,
        tokensOut,
        quoteReturned,
        retentionBps: quoteIn > 0n ? Number((quoteReturned * 10_000n) / quoteIn) : 0,
      };
    } catch (err) {
      // An unavailable simulation is not a pass. The caller records this as
      // `simulation-unavailable` and declines the entry.
      log.debug('round-trip simulation failed', { curveAddress, err: (err as Error).message });
      return {
        ok: false,
        failedLeg: null,
        revertReason: (err as Error).message,
        quoteIn,
        tokensOut: 0n,
        quoteReturned: 0n,
        retentionBps: 0,
      };
    }
  }

  private async run(
    calls: SimCall[],
    stateOverrides: Record<string, { balance?: Hex; stateDiff?: Record<Hex, Hex> }>,
  ): Promise<SimCallResult[]> {
    // The public endpoint throttles bursts, and a throttled simulation is indistinguish-
    // able from a failing one at the call site. Retrying here keeps a rate limit from
    // being recorded as a vetting failure against an otherwise fine token.
    return retry(
      async () => {
        const response = (await this.client.request({
          method: 'eth_simulateV1',
          params: [
            {
              blockStateCalls: [
                {
                  stateOverrides,
                  calls: calls.map((c) => ({
                    from: c.from,
                    to: c.to,
                    data: c.data,
                    ...(c.value != null ? { value: numberToHex(c.value) } : {}),
                  })),
                },
              ],
              validation: false,
              traceTransfers: false,
            },
            'latest',
          ],
        } as never)) as unknown as Array<{ calls: SimCallResult[] }>;

        const block = Array.isArray(response) ? response[0] : undefined;
        if (!block?.calls) throw new Error('eth_simulateV1 returned no call results');
        return block.calls;
      },
      { attempts: 3, baseDelayMs: 120, maxDelayMs: 900 },
    );
  }

  /**
   * Locate an ERC-20's balance mapping slot by brute force.
   *
   * Writing a balance requires knowing which storage slot holds the `_balances` mapping,
   * and that is a compiler-layout detail no interface exposes. Overriding each candidate
   * slot in turn and asking `balanceOf` which one took effect is reliable and, because
   * the answer is cached per token and the approved quote-asset set is small, happens
   * once per asset for the lifetime of the process.
   */
  private async findBalanceSlot(token: Address): Promise<number | null> {
    const key = token.toLowerCase();
    const cached = this.balanceSlots.get(key);
    if (cached !== undefined) return cached;

    const sentinel = numberToHex(123_456_789n, { size: 32 });
    const balanceOfData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [PROBE] });

    for (let slot = 0; slot < 16; slot++) {
      try {
        const result = (await this.client.request({
          method: 'eth_call',
          params: [
            { to: token, data: balanceOfData },
            'latest',
            { [token]: { stateDiff: { [balanceSlotKey(PROBE, slot)]: sentinel } } },
          ],
        } as never)) as unknown as Hex;

        if (BigInt(result) === 123_456_789n) {
          log.debug('located erc20 balance slot', { token, slot });
          this.balanceSlots.set(key, slot);
          return slot;
        }
      } catch {
        // Try the next candidate.
      }
    }

    log.warn('could not locate erc20 balance slot; launches quoted in this asset cannot be simulated', { token });
    this.balanceSlots.set(key, null);
    return null;
  }
}

/** Storage key of `mapping(address => uint256)` at `slot` for `holder`. */
function balanceSlotKey(holder: Address, slot: number): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(slot)]),
  );
}
