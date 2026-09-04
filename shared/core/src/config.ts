import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { registerSecret } from './logger.js';

/* ------------------------------------------------------------------ *
 * config/chain.json — versioned, non-secret, reviewed
 * ------------------------------------------------------------------ */

const AddressLike = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const LaunchpadConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  primary: z.boolean().default(false),
  adapter: z.string(),
  mechanism: z.string().optional(),
  docs: z.string().optional(),
  addressesVerified: z.boolean(),
  verification: z.unknown().optional(),
  contracts: z.record(z.string(), AddressLike),
  economics: z.record(z.string(), z.unknown()).optional(),
  note: z.string().optional(),
});
export type LaunchpadConfig = z.infer<typeof LaunchpadConfigSchema>;

const ChainConfigSchema = z.object({
  configVersion: z.number().int(),
  revisedAt: z.string(),
  chain: z.object({
    id: z.number().int(),
    name: z.string(),
    shortName: z.string(),
    stack: z.string(),
    nativeCurrency: z.object({ name: z.string(), symbol: z.string(), decimals: z.number().int() }),
    approxBlockTimeMs: z.number().int().positive(),
    explorer: z.object({ name: z.string(), url: z.string(), apiUrl: z.string() }),
    docs: z.string(),
    testnet: z.object({ id: z.number().int(), note: z.string() }),
  }),
  rpc: z.object({
    primary: z.object({
      http: z.string().url(),
      ws: z.string().nullable(),
      tier: z.string(),
      rateLimited: z.boolean(),
      supportsWebsocket: z.boolean(),
      supportsLogSubscription: z.boolean(),
      note: z.string(),
    }),
    overrideEnvVars: z.object({ http: z.string(), ws: z.string() }),
    dedicatedProviders: z.array(z.record(z.string(), z.unknown())),
    sequencer: z.object({
      orderingConfirmed: z.boolean(),
      assumedOrdering: z.string(),
      note: z.string(),
    }),
  }),
  launchpads: z.array(LaunchpadConfigSchema),
  quoteAssets: z.object({
    resolveFromChain: z.boolean(),
    authority: z.string(),
    note: z.string(),
    seed: z.array(
      z.object({
        symbol: z.string(),
        address: AddressLike,
        decimals: z.number().int(),
        native: z.boolean().optional(),
        graduationThreshold: z.string().optional(),
      }),
    ),
  }),
  externalApis: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      endpoint: z.string().nullable().optional(),
      apiKeyEnvVar: z.string().optional(),
      network: z.string().optional(),
      chainSupportConfirmed: z.boolean().optional(),
      note: z.string(),
    }),
  ),
});
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

/* ------------------------------------------------------------------ *
 * config/bot.json — strategy and risk parameters
 * ------------------------------------------------------------------ */

const BotConfigSchema = z.object({
  configVersion: z.number().int(),

  /**
   * The single switch the whole spec hangs on. It gates exactly one thing: whether the
   * execution service signs and broadcasts. Nothing upstream reads it.
   */
  mode: z.enum(['paper', 'live']),

  accounting: z.object({
    /** Headline unit for the ledger, risk limits, and the dashboard. */
    displayCurrency: z.literal('USD'),
    startingBalanceUsd: z.number().positive(),
    /**
     * Pons sizes every quote asset's graduation threshold to the same USD notional, so
     * the ratio of thresholds prices the assets against each other with no external
     * feed. USDG anchors the scale at 1.0. This is an inference about how the launchpad
     * is configured, not a market oracle: exact P&L is always tracked in quote units,
     * and USD is presentation and risk-limit sizing only. Override per asset below if
     * the assumption stops holding.
     */
    usdPriceStrategy: z.enum(['derive-from-graduation-threshold', 'config-only']),
    stableAnchorSymbol: z.string(),
    usdPriceOverrides: z.record(z.string(), z.number().positive()).default({}),
  }),

  listener: z.object({
    /** `poll` works on any RPC. `websocket` needs a dedicated provider. */
    transport: z.enum(['poll', 'websocket', 'auto']),
    pollIntervalMs: z.number().int().positive(),
    /** Blocks per eth_getLogs page. Chain runs ~100ms blocks, so this fills fast. */
    logPageSize: z.number().int().positive(),
    /** Blocks behind head to start from on a cold boot. */
    backfillBlocks: z.number().int().nonnegative(),
    /** Curves stop being watched once they graduate or go this long without a trade. */
    curveIdleEvictionSeconds: z.number().int().positive(),
    maxTrackedCurves: z.number().int().positive(),
    quoteAssetAllowlist: z.array(z.string()),
  }),

  vetting: z.object({
    /** Quote base units used for the simulated round trip. Small but non-dust. */
    simulationSizeUsd: z.number().positive(),
    maxBuyTaxBps: z.number().int(),
    maxSellTaxBps: z.number().int(),
    maxCreatorTaxBps: z.number().int(),
    /** Simulated sell must return at least this share of the simulated buy's cost. */
    minRoundTripRetentionBps: z.number().int(),
    requireOwnerRenounced: z.boolean(),
    useExternalScanner: z.boolean(),
    /** If the scanner is down, proceed on on-chain simulation alone. Never auto-pass. */
    failOpenOnScannerError: z.boolean(),
  }),

  deployerGraph: z.object({
    dbPath: z.string(),
    /** Hops back through funders when attributing a deployer to a funding source. */
    fundingTraceDepth: z.number().int().positive(),
    /** Cluster is flagged a rug cluster past this share of dumped prior launches. */
    rugClusterThreshold: z.number().min(0).max(1),
    minLaunchesForConfidence: z.number().int().positive(),
    /** Score for a deployer with no history. Neutral, with confidence near zero. */
    unknownDeployerScore: z.number().min(0).max(1),
    /** A launch that never reaches this share of its threshold counts as stalled. */
    stalledProgressThreshold: z.number().min(0).max(1),
    outcomeEvaluationMinutes: z.number().int().positive(),
  }),

  walletTracker: z.object({
    dbPath: z.string(),
    /** Rolling window for buyer-velocity and concentration statistics. */
    windowSeconds: z.number().int().positive(),
    minUniqueBuyers: z.number().int().positive(),
    minUniqueBuyerVelocity: z.number().positive(),
    /** Reject above this Gini. Meme launches are naturally concentrated; this is loose. */
    maxConcentrationScore: z.number().min(0).max(1),
    /** Reject when this share of buy volume comes from co-funded wallets. */
    maxSharedFundingVolumeShare: z.number().min(0).max(1),
    /** Promote a wallet to tracked after this many profitable early entries. */
    minProfitableEntriesToTrack: z.number().int().positive(),
    /** "Early" means within this share of the curve's path to graduation. */
    earlyEntryProgressThreshold: z.number().min(0).max(1),
  }),

  decision: z.object({
    /** Scout size as a share of equity, before confidence scaling. */
    scoutSizePctOfEquity: z.number().positive(),
    confirmSizePctOfEquity: z.number().positive(),
    minCombinedConfidence: z.number().min(0).max(1),
    minDeployerScoreForScout: z.number().min(0).max(1),
    /** Curve progress band the scout will enter in. Avoids the snipe-tax window. */
    minGraduationProgress: z.number().min(0).max(1),
    maxGraduationProgress: z.number().min(0).max(1),
    /** Skip a launch while its snipe tax is above this. Decays to zero in ~5s. */
    maxSnipeTaxBps: z.number().int(),
    maxSlippageBps: z.number().int(),
    /** Weights for the combined confidence product. Must sum to 1. */
    weights: z.object({
      deployer: z.number().min(0).max(1),
      authenticity: z.number().min(0).max(1),
      demandVelocity: z.number().min(0).max(1),
      graduationProximity: z.number().min(0).max(1),
    }),
    /** Stop considering a launch this long after deployment. */
    maxLaunchAgeSeconds: z.number().int().positive(),
  }),

  exit: z.object({
    /** Ladder rungs: sell `fraction` of what remains once `multiple` is reached. */
    takeProfitLadder: z.array(z.object({ multiple: z.number().positive(), fraction: z.number().min(0).max(1) })),
    /** Trail starts here and widens as the peak multiple grows. */
    trailingStopBasePct: z.number().positive(),
    trailingStopWidenPerMultiple: z.number().nonnegative(),
    maxTrailingStopPct: z.number().positive(),
    /** Drawdown from entry that triggers a stop, expressed against curve depth. */
    hardStopPct: z.number().positive(),
    /**
     * A stop must hold for this long before firing. Single-wallet noise on a thin curve
     * routinely prints a spike that reverts within a block or two.
     */
    stopPersistenceSeconds: z.number().positive(),
    stopPersistenceBlocks: z.number().int().positive(),
    /** Share of the position used when measuring our own exit's price impact. */
    depthAwareStopSizeFraction: z.number().min(0).max(1),
    /**
     * Size of one ordinary participant's sell, in USD. The stop threshold is derived
     * from what a trade this size would do to the price at current curve depth, which is
     * what makes the stop scale with liquidity instead of being a fixed percentage.
     */
    depthStopReferenceTradeUsd: z.number().positive(),
    depthStopImpactMultiplier: z.number().positive(),
    /** Bounds on the derived threshold, so it cannot collapse or run away. */
    depthStopMinPct: z.number().positive(),
    depthStopMaxPct: z.number().positive(),
    /** Take some off the table as graduation opens real Uniswap liquidity. */
    graduationProximityTrim: z.object({
      enabled: z.boolean(),
      progressThreshold: z.number().min(0).max(1),
      fraction: z.number().min(0).max(1),
    }),
    /** Close a position that has gone nowhere, to free a concurrency slot. */
    maxHoldSeconds: z.number().int().positive(),
    markRefreshMs: z.number().int().positive(),
  }),

  risk: z.object({
    maxPositionSizeUsd: z.number().positive(),
    maxConcurrentPositions: z.number().int().positive(),
    dailyLossLimitPct: z.number().positive(),
    maxTradesPerDay: z.number().int().positive(),
    /** Never commit more than this share of equity across all open positions. */
    maxTotalExposurePct: z.number().min(0).max(1),
    /** Cooldown after a loss on the same deployer cluster. */
    clusterCooldownSeconds: z.number().int().nonnegative(),
    killSwitchFile: z.string(),
  }),

  evaluation: z.object({
    /** Go/no-go gates for the paper -> live flip. Set now, not after seeing the P&L. */
    windowHours: z.number().positive(),
    minTrades: z.number().int().positive(),
    minWinRate: z.number().min(0).max(1),
    maxDrawdownPct: z.number().positive(),
    minNetPnlPct: z.number(),
    /** Vetting must reject the honeypots; a low rate means the filter is not working. */
    maxHoneypotEntryRate: z.number().min(0).max(1),
    /**
     * Share of entries left holding an unsellable position because the curve graduated
     * before the exit engine got out. Each one writes off its cost basis, so this is a
     * capital-loss gate as much as a timing one.
     */
    maxStrandedRate: z.number().min(0).max(1),
  }),

  api: z.object({
    host: z.string(),
    port: z.number().int().positive(),
  }),

  alerts: z.object({
    telegram: z.object({
      enabled: z.boolean(),
      botTokenEnvVar: z.string(),
      chatIdEnvVar: z.string(),
      /** Poll getUpdates for /pause, /resume, /status, /kill. */
      commandPolling: z.boolean(),
      pollIntervalMs: z.number().int().positive(),
    }),
  }),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;

/* ------------------------------------------------------------------ *
 * Secrets — env only. Never from a config file.
 * ------------------------------------------------------------------ */

export interface Secrets {
  /** Only ever read when mode is `live`. Paper mode must not require a key to exist. */
  executionPrivateKey: string | undefined;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  goPlusApiKey: string | undefined;
  bitqueryApiKey: string | undefined;
}

function loadSecrets(): Secrets {
  const secrets: Secrets = {
    executionPrivateKey: process.env.EXECUTION_PRIVATE_KEY,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    goPlusApiKey: process.env.GOPLUS_API_KEY,
    bitqueryApiKey: process.env.BITQUERY_API_KEY,
  };
  registerSecret(secrets.executionPrivateKey);
  registerSecret(secrets.telegramBotToken);
  registerSecret(secrets.goPlusApiKey);
  registerSecret(secrets.bitqueryApiKey);
  return secrets;
}

export interface AppConfig {
  chain: ChainConfig;
  bot: BotConfig;
  secrets: Secrets;
  rpcHttpUrl: string;
  rpcWsUrl: string | null;
  configDir: string;
  repoRoot: string;
}

/**
 * Locate the repo root by walking up from the working directory looking for the config
 * it must contain.
 *
 * npm workspaces run scripts with the cwd set to the package directory, so a relative
 * path like `config/chain.json` or `data/ledger.sqlite` resolves differently depending
 * on whether the bot was started from the root or from `apps/bot`. Anchoring both to the
 * repo root means one config file and one database regardless of how it was launched.
 */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(resolve(dir, 'config', 'chain.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate config/chain.json walking up from ${start}`);
}

/** Resolve a config-relative path (databases, kill-switch file) against the repo root. */
export function resolveFromRoot(config: AppConfig, path: string): string {
  return resolve(config.repoRoot, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`failed to read config at ${path}: ${(err as Error).message}`);
  }
}

export function loadConfig(configDir?: string): AppConfig {
  const repoRoot = findRepoRoot();
  configDir ??= process.env.RHC_CONFIG_DIR ?? resolve(repoRoot, 'config');

  const chain = ChainConfigSchema.parse(readJson(resolve(configDir, 'chain.json')));
  const bot = BotConfigSchema.parse(readJson(resolve(configDir, 'bot.json')));
  const secrets = loadSecrets();

  // Env wins over the file so an operator can point at a dedicated provider without a
  // commit, and so provider URLs carrying an API key never land in version control.
  const rpcHttpUrl = process.env[chain.rpc.overrideEnvVars.http] ?? chain.rpc.primary.http;
  const rpcWsUrl = process.env[chain.rpc.overrideEnvVars.ws] ?? chain.rpc.primary.ws;
  registerSecret(process.env[chain.rpc.overrideEnvVars.http]);
  registerSecret(process.env[chain.rpc.overrideEnvVars.ws]);

  const modeOverride = process.env.TRADING_MODE;
  if (modeOverride === 'paper' || modeOverride === 'live') bot.mode = modeOverride;

  const weightSum =
    bot.decision.weights.deployer +
    bot.decision.weights.authenticity +
    bot.decision.weights.demandVelocity +
    bot.decision.weights.graduationProximity;
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new Error(`decision.weights must sum to 1, got ${weightSum}`);
  }

  // Anchor every filesystem path in the config so the bot behaves identically whether it
  // was started from the repo root or from inside a workspace package.
  bot.deployerGraph.dbPath = resolve(repoRoot, bot.deployerGraph.dbPath);
  bot.walletTracker.dbPath = resolve(repoRoot, bot.walletTracker.dbPath);
  bot.risk.killSwitchFile = resolve(repoRoot, bot.risk.killSwitchFile);

  return { chain, bot, secrets, rpcHttpUrl, rpcWsUrl, configDir, repoRoot };
}

/**
 * Fail closed before anything can sign. Called by the execution service at startup and
 * again immediately before the first live broadcast, so a mid-run config reload cannot
 * sneak past the checks.
 */
export function assertLiveModePreconditions(config: AppConfig): void {
  const problems: string[] = [];

  if (!config.secrets.executionPrivateKey) {
    problems.push('EXECUTION_PRIVATE_KEY is not set');
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(config.secrets.executionPrivateKey)) {
    problems.push('EXECUTION_PRIVATE_KEY is not a 32-byte hex key');
  }

  const enabled = config.chain.launchpads.filter((l) => l.enabled);
  if (enabled.length === 0) problems.push('no launchpad is enabled');
  for (const lp of enabled) {
    if (!lp.addressesVerified) {
      problems.push(`launchpad "${lp.id}" is enabled but its addresses are not marked verified`);
    }
    if (Object.keys(lp.contracts).length === 0) {
      problems.push(`launchpad "${lp.id}" is enabled but has no contract addresses`);
    }
  }

  if (config.chain.rpc.primary.rateLimited && !process.env[config.chain.rpc.overrideEnvVars.http]) {
    problems.push(
      'live mode is pointed at the rate-limited public RPC; set ' +
        `${config.chain.rpc.overrideEnvVars.http} to a dedicated provider endpoint`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`refusing to start in live mode:\n  - ${problems.join('\n  - ')}`);
  }
}
