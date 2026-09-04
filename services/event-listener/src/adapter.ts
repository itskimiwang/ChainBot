import type { Address, Hex } from 'viem';
import type { RawLog } from '@rhc/chain';
import type { CurveTradeEvent, GraduationEvent, NewLaunchEvent, QuoteAsset } from '@rhc/types';

/**
 * What the listener needs from a launchpad in order to watch it.
 *
 * Pons is the only implemented adapter, but the landscape has already rebranded once
 * (NOXA to Pons) and other launchpads exist on this chain, so the listener is written
 * against this interface rather than against Pons directly. Adding flap.sh or Clanker
 * means writing an adapter and flipping `enabled` in chain.json — no changes to the
 * listener, and no changes to anything downstream, because every adapter emits the same
 * normalised events.
 */
export interface LaunchpadAdapter {
  readonly id: string;
  readonly name: string;

  /** Contract that announces new launches. Scanned continuously. */
  readonly factoryAddress: Address;

  /** topic0 values emitted by the factory that this adapter cares about. */
  readonly factoryTopics: Hex[];

  /**
   * topic0 values emitted by the per-launch trading contracts. Pons deploys one curve
   * per token, so these are matched across a changing set of addresses rather than one.
   */
  readonly curveTopics: Hex[];

  decodeFactoryLog(log: RawLog, ctx: DecodeContext): Promise<FactoryDecodeResult | null>;
  decodeCurveLog(log: RawLog, ctx: DecodeContext): Promise<CurveTradeEvent | null>;
}

export interface DecodeContext {
  /** Wall-clock time for a block, from the listener's anchored estimate. */
  timestampFor(blockNumber: number): number;
  resolveQuoteAsset(address: Address): Promise<QuoteAsset | null>;
  /** Curve address for a token the listener already knows about. */
  curveFor(tokenAddress: string): Address | undefined;
  /**
   * Token for a curve. Curve trade logs carry no token address, so this reverse mapping
   * comes from the launch event that deployed the curve.
   */
  tokenForCurve(curveAddress: string): string | undefined;
  /** Quote asset for a token the listener already knows about. */
  quoteAssetFor(tokenAddress: string): QuoteAsset | undefined;
  /** Latest observed pricing reserve for a curve, used to stamp trade events. */
  reserveFor(curveAddress: string): bigint | undefined;
}

export type FactoryDecodeResult =
  | { type: 'launch'; event: NewLaunchEvent }
  | { type: 'graduation'; event: GraduationEvent }
  | { type: 'swept'; tokenAddress: Address };
