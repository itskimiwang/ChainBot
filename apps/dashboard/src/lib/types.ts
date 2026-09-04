/**
 * Shapes returned by the bot's operator API (`apps/bot/src/api.ts`).
 *
 * These are hand-mirrored rather than imported from `@rhc/types`. The dashboard is a
 * separate deployable that talks to the bot over HTTP and should keep compiling if the
 * bot workspace is not installed; more importantly, everything crossing that boundary
 * has already been JSON-serialised, so bigints arrive as strings and the bot-side types
 * would be actively misleading here.
 */

export type TradingMode = "paper" | "live";
export type LaunchPhase = "curve" | "swept" | "pool" | "rescued";
export type EntryStage = "scout" | "confirm";
export type Verdict = "go" | "no-go" | "in-progress";

export interface QuoteAsset {
  symbol: string;
  address: string;
  decimals: number;
  isNative: boolean;
  graduationThreshold: string | null;
  phantomQuote: string | null;
}

export interface RiskState {
  halted: boolean;
  haltReason: string | null;
  killSwitchEngaged: boolean;
  openPositions: number;
  maxConcurrentPositions: number;
  dayStartEquityQuote: string;
  currentEquityQuote: string;
  dailyPnlQuote: string;
  dailyLossLimitQuote: string;
  dailyDrawdownPct: number;
  tradesToday: number;
  updatedAt: number;
}

export interface Criterion {
  id: string;
  label: string;
  target: string;
  actual: string;
  met: boolean;
}

export interface EvaluationReport {
  startedAt: number;
  elapsedHours: number;
  windowHours: number;
  windowComplete: boolean;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlUsd: number;
  netPnlPct: number;
  maxDrawdownPct: number;
  honeypotEntryRate: number;
  stranded: number;
  strandedRate: number;
  criteria: Criterion[];
  verdict: Verdict;
}

export interface ScannerStats {
  ticks: number;
  logsSeen: number;
  pagesFetched: number;
  errors: number;
  lastBlock: number;
  lagBlocks: number;
}

export interface BotState {
  mode: TradingMode;
  startedAt: number;
  chain: {
    id: number;
    name: string;
    explorer: string;
    rpcTier: string;
    sequencerOrderingConfirmed: boolean;
  };
  launchpads: Array<{
    id: string;
    name: string;
    primary: boolean;
    adapter: string;
  }>;
  equityUsd: number;
  startingEquityUsd: number;
  risk: RiskState;
  pricing: {
    strategy: string;
    anchorNotionalUsd: number | null;
    prices: Record<string, number>;
  };
  quoteAssets: Array<{
    symbol: string;
    decimals: number;
    graduationThreshold: string | null;
    usdPrice: number | null;
  }>;
  evaluation: EvaluationReport;
  stats: {
    listener: {
      factory: ScannerStats | null;
      curves: ScannerStats | null;
      trackedCurves: number;
      pinned: number;
      launchesSeen: number;
      launchesTracked: number;
      launchesSkipped: number;
      tradesSeen: number;
      graduations: number;
      evictions: number;
    };
    vetting: {
      vetted: number;
      passed: number;
      failed: number;
      honeypots: number;
      simulationUnavailable: number;
    };
    deployerGraph: {
      deployersKnown: number;
      launchesRecorded: number;
      resolved: number;
      unresolved: number;
      clusters: number;
    };
    walletTracker: {
      buysObserved: number;
      signalsEmitted: number;
      authentic: number;
      rejected: number;
      trackedWallets: number;
      fundingCoverage: { resolved: number; queued: number };
    };
    decision: {
      evaluated: number;
      scoutEntries: number;
      confirmEntries: number;
      rejected: number;
    };
    exit: {
      ticks: number;
      exitsFired: number;
      stopsArmed: number;
      stopsDisarmed: number;
    };
    execution: {
      submitted: number;
      filled: number;
      rejected: number;
      failed: number;
    };
  };
}

export interface Fill {
  intentId: string;
  mode: TradingMode;
  side: "buy" | "sell";
  tokenAddress: string;
  venue: "curve" | "univ4";
  quoteAsset: QuoteAsset;
  quoteAmount: string;
  tokenAmount: string;
  price: string;
  slippageBps: number;
  feePaid: string;
  taxPaid: string;
  gasCostWei: string;
  txHash: string | null;
  blockNumber: number;
  timestamp: number;
}

export type ExitReason =
  | "take-profit-ladder"
  | "trailing-stop"
  | "curve-depth-stop"
  | "hard-stop"
  | "graduation-exit"
  | "risk-manager-flatten"
  | "manual"
  | "timeout";

export interface Position {
  positionId: string;
  tokenAddress: string;
  curveAddress: string | null;
  poolAddress: string | null;
  symbol: string;
  venue: "curve" | "univ4";
  phase: LaunchPhase;
  quoteAsset: QuoteAsset;
  mode: TradingMode;
  status: "open" | "closing" | "closed" | "stranded";
  stage: EntryStage;
  quoteInvested: string;
  tokensHeld: string;
  averageEntryPrice: string;
  lastPrice: string;
  markPrice: string;
  peakMultiple: number;
  realizedPnlQuote: string;
  unrealizedPnlQuote: string;
  ladderStepsFilled: number[];
  openedAt: number;
  closedAt: number | null;
  exitReason: ExitReason | null;
  fills: Fill[];
  /** Added by the API for open positions only. */
  currentMultiple?: number;
}

export interface PositionsResponse {
  open: Position[];
  closed: Position[];
  /** Held through graduation and unsellable until a Uniswap v4 route exists. */
  stranded: Position[];
  strandedCostUsd: number;
}

export type VettingFailure =
  | "honeypot-sell-reverts"
  | "sell-proceeds-implausible"
  | "buy-tax-too-high"
  | "sell-tax-too-high"
  | "creator-tax-too-high"
  | "liquidity-not-locked"
  | "owner-not-renounced"
  | "external-scanner-flagged"
  | "curve-already-closed"
  | "simulation-unavailable"
  | "unsupported-quote-asset";

export interface VettingResult {
  tokenAddress: string;
  curveAddress: string;
  passVetting: boolean;
  buyTax: number;
  sellTax: number;
  liquidityLocked: boolean;
  ownerRenounced: boolean;
  snipeTaxBps: number;
  failures: VettingFailure[];
  checksRun: string[];
  externalScanner: {
    provider: string;
    available: boolean;
    flagged: boolean;
  } | null;
  simulatedAtBlock: number;
  timestamp: number;
}

export interface DeployerScore {
  deployerAddress: string;
  clusterId: string;
  priorLaunchCount: number;
  priorSuccessRate: number;
  isKnownRugCluster: boolean;
  fundingSource: string | null;
  fundingSourceKind: "cex" | "bridge" | "wallet" | "contract" | "unknown";
  clusterSize: number;
  clusterLaunchCount: number;
  clusterSuccessRate: number;
  score: number;
  confidence: number;
  reasons: string[];
  timestamp: number;
}

export interface TrackedLaunch {
  tokenAddress: string;
  symbol: string | null;
  deployerAddress: string;
  quoteAsset: string;
  progress: number;
  realQuoteReserve: string;
  graduationThreshold: string;
  tradeCount: number;
  launchedAt: number;
  lastTradeAt: number;
  vetting: VettingResult | null;
  deployer: DeployerScore;
}

export interface LaunchesResponse {
  tracked: TrackedLaunch[];
}

export type AuthenticityRejection =
  | "insufficient-unique-buyers"
  | "buyers-share-funding-source"
  | "holder-concentration-too-high"
  | "volume-without-buyer-growth"
  | "window-too-young";

export interface WalletSignal {
  tokenAddress: string;
  trackedWalletBuys: Array<{
    wallet: string;
    walletScore: number;
    quoteSpent: string;
    tokensReceived: string;
    txHash: string;
    blockNumber: number;
    timestamp: number;
  }>;
  uniqueBuyerVelocity: number;
  uniqueBuyerCount: number;
  concentrationScore: number;
  sharedFundingVolumeShare: number;
  authentic: boolean;
  authenticityScore: number;
  rejections: AuthenticityRejection[];
  windowSeconds: number;
  timestamp: number;
}

export interface SignalsResponse {
  rejections: Array<{
    tokenAddress: string;
    stage: EntryStage;
    reason: string;
    timestamp: number;
  }>;
  walletSignals: WalletSignal[];
  topClusters: Array<{
    clusterId: string;
    size: number;
    launches: number;
    graduated: number;
  }>;
  topWallets: Array<{
    address: string;
    profitable_entries: number;
    total_entries: number;
    score: number;
    last_seen: number;
  }>;
}

export interface ExitSignal {
  positionId: string;
  tokenAddress: string;
  reason: ExitReason;
  fraction: number;
  currentMultiple: number;
  ladderStep: number | null;
  detail: string;
  timestamp: number;
}

export interface GraduationEvent {
  tokenAddress: string;
  poolAddress: string;
  hookAddress: string;
  poolId: string | null;
  quoteAsset: QuoteAsset;
  quoteSeeded: string;
  tokensSeeded: string;
  blockNumber: number;
  txHash: string;
  timestamp: number;
}

export interface LogRecord {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface ActivityResponse {
  fills: Fill[];
  exits: ExitSignal[];
  graduations: GraduationEvent[];
  logs: LogRecord[];
}
