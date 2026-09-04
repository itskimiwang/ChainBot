import { z } from 'zod';
import {
  AddressSchema,
  BaseUnitsSchema,
  BpsSchema,
  HashSchema,
  LaunchPhaseSchema,
  QuoteAssetSchema,
  UnitIntervalSchema,
  UnixMsSchema,
} from './primitives.js';

/* ------------------------------------------------------------------ *
 * Phase 0 — event listener
 * ------------------------------------------------------------------ */

/**
 * A new bonding-curve deployment. One curve contract per launch, so consumers must
 * treat `curveAddress` as the subscription target rather than expecting a shared pool.
 */
export const NewLaunchEventSchema = z.object({
  kind: z.literal('new-launch'),
  launchpadId: z.string(),
  tokenAddress: AddressSchema,
  curveAddress: AddressSchema,
  deployerAddress: AddressSchema,
  quoteAsset: QuoteAssetSchema,
  /** Pricing reserve of the quote asset, inclusive of the phantom amount. */
  curveReserve: BaseUnitsSchema,
  graduationThreshold: BaseUnitsSchema,
  blockNumber: z.number().int().nonnegative(),
  txHash: HashSchema,
  timestamp: UnixMsSchema,
  /** Set when the creator bought in the same tx via the launch-and-buy router. */
  creatorFirstBuy: BaseUnitsSchema.nullable().default(null),
  creatorTaxBps: BpsSchema.nullable().default(null),
});
export type NewLaunchEvent = z.infer<typeof NewLaunchEventSchema>;

export const CurveTradeEventSchema = z.object({
  kind: z.literal('curve-trade'),
  launchpadId: z.string(),
  tokenAddress: AddressSchema,
  curveAddress: AddressSchema,
  side: z.enum(['buy', 'sell']),
  trader: AddressSchema,
  /** Token recipient on a buy. Snipe-tax exemptions are keyed to this, not to `trader`. */
  recipient: AddressSchema,
  quoteAmount: BaseUnitsSchema,
  tokenAmount: BaseUnitsSchema,
  feePaid: BaseUnitsSchema,
  taxPaid: BaseUnitsSchema,
  /** Quote-asset pricing reserve after the trade. Drives curve-depth stop-losses. */
  curveReserve: BaseUnitsSchema,
  blockNumber: z.number().int().nonnegative(),
  txHash: HashSchema,
  timestamp: UnixMsSchema,
});
export type CurveTradeEvent = z.infer<typeof CurveTradeEventSchema>;

/**
 * Graduation. The curve is gone and both directions must route to the Uniswap v4 pool
 * behind the Pons hook. `hookAddress` is what distinguishes a Pons pool from any other
 * v4 pool sharing the chain-wide PoolManager singleton.
 */
export const GraduationEventSchema = z.object({
  kind: z.literal('graduation'),
  launchpadId: z.string(),
  tokenAddress: AddressSchema,
  poolAddress: AddressSchema,
  hookAddress: AddressSchema,
  poolId: HashSchema.nullable().default(null),
  quoteAsset: QuoteAssetSchema,
  quoteSeeded: BaseUnitsSchema,
  tokensSeeded: BaseUnitsSchema,
  blockNumber: z.number().int().nonnegative(),
  txHash: HashSchema,
  timestamp: UnixMsSchema,
});
export type GraduationEvent = z.infer<typeof GraduationEventSchema>;

export const ListenerEventSchema = z.discriminatedUnion('kind', [
  NewLaunchEventSchema,
  CurveTradeEventSchema,
  GraduationEventSchema,
]);
export type ListenerEvent = z.infer<typeof ListenerEventSchema>;

/* ------------------------------------------------------------------ *
 * Phase 1 — vetting
 * ------------------------------------------------------------------ */

export const VettingFailureSchema = z.enum([
  'honeypot-sell-reverts',
  'sell-proceeds-implausible',
  'buy-tax-too-high',
  'sell-tax-too-high',
  'creator-tax-too-high',
  'liquidity-not-locked',
  'owner-not-renounced',
  'external-scanner-flagged',
  'curve-already-closed',
  'simulation-unavailable',
  'unsupported-quote-asset',
]);
export type VettingFailure = z.infer<typeof VettingFailureSchema>;

export const VettingResultSchema = z.object({
  kind: z.literal('vetting-result'),
  tokenAddress: AddressSchema,
  curveAddress: AddressSchema,
  passVetting: z.boolean(),
  buyTax: BpsSchema,
  sellTax: BpsSchema,
  liquidityLocked: z.boolean(),
  ownerRenounced: z.boolean(),
  /** Decaying opening-seconds tax on buys. High values mean "wait", not "reject". */
  snipeTaxBps: BpsSchema,
  failures: z.array(VettingFailureSchema),
  /** Which checks actually ran. A skipped check is never counted as a pass. */
  checksRun: z.array(z.string()),
  externalScanner: z
    .object({
      provider: z.string(),
      available: z.boolean(),
      flagged: z.boolean(),
      raw: z.unknown().optional(),
    })
    .nullable()
    .default(null),
  simulatedAtBlock: z.number().int().nonnegative(),
  timestamp: UnixMsSchema,
});
export type VettingResult = z.infer<typeof VettingResultSchema>;

/* ------------------------------------------------------------------ *
 * Phase 2 — deployer funding graph
 * ------------------------------------------------------------------ */

export const FundingSourceKindSchema = z.enum(['cex', 'bridge', 'wallet', 'contract', 'unknown']);
export type FundingSourceKind = z.infer<typeof FundingSourceKindSchema>;

export const LaunchOutcomeSchema = z.enum(['graduated', 'stalled', 'dumped', 'pending']);
export type LaunchOutcome = z.infer<typeof LaunchOutcomeSchema>;

export const DeployerScoreSchema = z.object({
  kind: z.literal('deployer-score'),
  deployerAddress: AddressSchema,
  clusterId: z.string(),
  priorLaunchCount: z.number().int().nonnegative(),
  priorSuccessRate: UnitIntervalSchema,
  isKnownRugCluster: z.boolean(),
  fundingSource: AddressSchema.nullable(),
  fundingSourceKind: FundingSourceKindSchema,
  /** Wallets sharing this cluster's funding source, including the deployer itself. */
  clusterSize: z.number().int().positive(),
  clusterLaunchCount: z.number().int().nonnegative(),
  clusterSuccessRate: UnitIntervalSchema,
  /** 0..1. Low means avoid. Explicitly distinct from "unknown" — see `confidence`. */
  score: UnitIntervalSchema,
  /**
   * How much evidence backs `score`. A brand-new deployer scores neutral with near-zero
   * confidence; the decision engine must size on score AND confidence, otherwise every
   * fresh wallet reads identically to a proven one.
   */
  confidence: UnitIntervalSchema,
  reasons: z.array(z.string()),
  timestamp: UnixMsSchema,
});
export type DeployerScore = z.infer<typeof DeployerScoreSchema>;

/* ------------------------------------------------------------------ *
 * Phase 3 — smart-wallet tracker + wash-trade filter
 * ------------------------------------------------------------------ */

export const TrackedWalletBuySchema = z.object({
  wallet: AddressSchema,
  /** 0..1 quality of this wallet's historical early entries on this launchpad. */
  walletScore: UnitIntervalSchema,
  quoteSpent: BaseUnitsSchema,
  tokensReceived: BaseUnitsSchema,
  txHash: HashSchema,
  blockNumber: z.number().int().nonnegative(),
  timestamp: UnixMsSchema,
});
export type TrackedWalletBuy = z.infer<typeof TrackedWalletBuySchema>;

export const AuthenticityRejectionSchema = z.enum([
  'insufficient-unique-buyers',
  'buyers-share-funding-source',
  'holder-concentration-too-high',
  'volume-without-buyer-growth',
  'window-too-young',
]);
export type AuthenticityRejection = z.infer<typeof AuthenticityRejectionSchema>;

export const WalletSignalSchema = z.object({
  kind: z.literal('wallet-signal'),
  tokenAddress: AddressSchema,
  trackedWalletBuys: z.array(TrackedWalletBuySchema),
  /** Distinct, independently-funded buyers per minute over the observation window. */
  uniqueBuyerVelocity: z.number().nonnegative(),
  uniqueBuyerCount: z.number().int().nonnegative(),
  /** Gini coefficient of buy volume across buyers. 0 = even, 1 = one wallet. */
  concentrationScore: UnitIntervalSchema,
  /** Share of buy volume from wallets that share a funding source with each other. */
  sharedFundingVolumeShare: UnitIntervalSchema,
  authentic: z.boolean(),
  /** 0..1 confidence that observed demand is real. Feeds position sizing directly. */
  authenticityScore: UnitIntervalSchema,
  rejections: z.array(AuthenticityRejectionSchema),
  windowSeconds: z.number().nonnegative(),
  timestamp: UnixMsSchema,
});
export type WalletSignal = z.infer<typeof WalletSignalSchema>;

/* ------------------------------------------------------------------ *
 * Phase 4 — decision engine
 * ------------------------------------------------------------------ */

export const EntryStageSchema = z.enum(['scout', 'confirm']);
export type EntryStage = z.infer<typeof EntryStageSchema>;

export const TradeIntentSchema = z.object({
  kind: z.literal('trade-intent'),
  intentId: z.string(),
  side: z.enum(['buy', 'sell']),
  stage: EntryStageSchema.nullable(),
  tokenAddress: AddressSchema,
  curveAddress: AddressSchema.nullable(),
  poolAddress: AddressSchema.nullable(),
  venue: z.enum(['curve', 'univ4']),
  quoteAsset: QuoteAssetSchema,
  /** Buys: quote base units to spend. Sells: token base units to sell. */
  amount: BaseUnitsSchema,
  maxSlippageBps: BpsSchema,
  reason: z.string(),
  confidence: z
    .object({
      deployer: UnitIntervalSchema,
      authenticity: UnitIntervalSchema,
      demandVelocity: UnitIntervalSchema,
      graduationProximity: UnitIntervalSchema,
      combined: UnitIntervalSchema,
    })
    .nullable()
    .default(null),
  timestamp: UnixMsSchema,
});
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

/* ------------------------------------------------------------------ *
 * Execution + positions
 * ------------------------------------------------------------------ */

export const FillSchema = z.object({
  kind: z.literal('fill'),
  intentId: z.string(),
  mode: z.enum(['paper', 'live']),
  side: z.enum(['buy', 'sell']),
  tokenAddress: AddressSchema,
  venue: z.enum(['curve', 'univ4']),
  quoteAsset: QuoteAssetSchema,
  quoteAmount: BaseUnitsSchema,
  tokenAmount: BaseUnitsSchema,
  /** Quote base units per whole token, as a decimal string. */
  price: z.string(),
  /** Realised gap between the marginal spot price and the achieved fill price. */
  slippageBps: z.number(),
  feePaid: BaseUnitsSchema,
  taxPaid: BaseUnitsSchema,
  gasCostWei: BaseUnitsSchema,
  txHash: HashSchema.nullable(),
  blockNumber: z.number().int().nonnegative(),
  timestamp: UnixMsSchema,
});
export type Fill = z.infer<typeof FillSchema>;

export const ExitReasonSchema = z.enum([
  'take-profit-ladder',
  'trailing-stop',
  'curve-depth-stop',
  'hard-stop',
  'graduation-exit',
  'risk-manager-flatten',
  'manual',
  'timeout',
]);
export type ExitReason = z.infer<typeof ExitReasonSchema>;

export const PositionSchema = z.object({
  positionId: z.string(),
  tokenAddress: AddressSchema,
  curveAddress: AddressSchema.nullable(),
  poolAddress: AddressSchema.nullable(),
  symbol: z.string(),
  venue: z.enum(['curve', 'univ4']),
  phase: LaunchPhaseSchema,
  quoteAsset: QuoteAssetSchema,
  mode: z.enum(['paper', 'live']),
  status: z.enum(['open', 'closing', 'closed']),
  stage: EntryStageSchema,
  /** Quote base units committed, net of any partial exits. */
  quoteInvested: BaseUnitsSchema,
  tokensHeld: BaseUnitsSchema,
  averageEntryPrice: z.string(),
  /** Marginal spot from curve reserves; display-only, carries no slippage. */
  lastPrice: z.string(),
  /** Sell-side mark: what the remaining tokens would actually realise right now. */
  markPrice: z.string(),
  peakMultiple: z.number().nonnegative(),
  realizedPnlQuote: z.string(),
  unrealizedPnlQuote: z.string(),
  ladderStepsFilled: z.array(z.number()),
  openedAt: UnixMsSchema,
  closedAt: UnixMsSchema.nullable(),
  exitReason: ExitReasonSchema.nullable(),
  fills: z.array(FillSchema),
});
export type Position = z.infer<typeof PositionSchema>;

/* ------------------------------------------------------------------ *
 * Phase 5 — exit engine
 * ------------------------------------------------------------------ */

export const ExitSignalSchema = z.object({
  kind: z.literal('exit-signal'),
  positionId: z.string(),
  tokenAddress: AddressSchema,
  reason: ExitReasonSchema,
  /** Fraction of the remaining position to sell. 1 closes it. */
  fraction: UnitIntervalSchema,
  currentMultiple: z.number().nonnegative(),
  /** Which ladder rung fired, if any. */
  ladderStep: z.number().nullable(),
  detail: z.string(),
  timestamp: UnixMsSchema,
});
export type ExitSignal = z.infer<typeof ExitSignalSchema>;

/* ------------------------------------------------------------------ *
 * Risk manager
 * ------------------------------------------------------------------ */

export const RiskVerdictSchema = z.object({
  allowed: z.boolean(),
  reasons: z.array(z.string()),
  /** Size the risk manager will permit, clamped down from the requested amount. */
  permittedAmount: BaseUnitsSchema,
});
export type RiskVerdict = z.infer<typeof RiskVerdictSchema>;

export const RiskStateSchema = z.object({
  halted: z.boolean(),
  haltReason: z.string().nullable(),
  killSwitchEngaged: z.boolean(),
  openPositions: z.number().int().nonnegative(),
  maxConcurrentPositions: z.number().int().nonnegative(),
  dayStartEquityQuote: z.string(),
  currentEquityQuote: z.string(),
  dailyPnlQuote: z.string(),
  dailyLossLimitQuote: z.string(),
  dailyDrawdownPct: z.number(),
  tradesToday: z.number().int().nonnegative(),
  updatedAt: UnixMsSchema,
});
export type RiskState = z.infer<typeof RiskStateSchema>;
