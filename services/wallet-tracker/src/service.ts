import {
  clamp01,
  createLogger,
  gini,
  migrate,
  openDb,
  RingBuffer,
  type AppConfig,
  type Db,
  type MessageBus,
} from '@rhc/core';
import type { FundingSourceResolver } from '@rhc/deployer-graph';
import type {
  AuthenticityRejection,
  CurveTradeEvent,
  GraduationEvent,
  TrackedWalletBuy,
  WalletSignal,
} from '@rhc/types';
import { FundingIndex } from './funding-index.js';

const log = createLogger('wallet-tracker');

interface WindowBuy {
  wallet: string;
  quote: bigint;
  timestamp: number;
}

interface TrackedWalletRow {
  address: string;
  profitable_entries: number;
  total_entries: number;
  score: number;
  last_seen: number;
}

/**
 * Phase 3: smart-wallet tracking, gated by an authenticity check.
 *
 * The copy-trade signal on its own is trivially spoofable — anyone can watch which
 * wallets bots follow and make those wallets buy. So a tracked-wallet buy is treated as
 * a *candidate*, and it only reaches the decision engine if the surrounding demand looks
 * like it came from independent participants.
 *
 * Three things separate real demand from manufactured demand:
 *
 *  - Unique buyer velocity, counting distinct wallets rather than trades. Wash volume
 *    inflates trade count and notional while leaving buyer count flat.
 *  - Concentration, as a Gini coefficient over per-wallet volume. One wallet cycling
 *    size registers as extreme concentration no matter how many trades it splits into.
 *  - Shared funding. Wallets bought from the same pocket are one participant wearing
 *    several hats, and their combined volume is discounted, not counted.
 *
 * The tracked-wallet list builds itself: when a token graduates, wallets that entered
 * early are credited, and a wallet with enough credited early entries is promoted. That
 * means the list reflects this launchpad specifically, which is the only place the
 * signal is claimed to work.
 */
export class WalletTrackerService {
  private readonly db: Db;
  private readonly fundingIndex: FundingIndex;

  /** Rolling per-token buy windows. Bounded per token and evicted with the token. */
  private readonly windows = new Map<string, RingBuffer<WindowBuy>>();
  /** Entries by token, so a graduation can credit everyone who got in early. */
  private readonly entriesByToken = new Map<string, Map<string, { progress: number; at: number }>>();
  private readonly trackedWallets = new Map<string, TrackedWalletRow>();
  private readonly recentTrackedBuys = new Map<string, TrackedWalletBuy[]>();

  readonly stats = { buysObserved: 0, signalsEmitted: 0, authentic: 0, rejected: 0, trackedWallets: 0 };

  constructor(
    private readonly config: AppConfig,
    resolver: FundingSourceResolver,
    private readonly bus: MessageBus,
    /** Curve progress lookup, so an entry can be graded as early or late. */
    private readonly progressFor: (tokenAddress: string) => number,
  ) {
    this.db = openDb(config.bot.walletTracker.dbPath);
    migrate(this.db, 'wallet-tracker', [
      `CREATE TABLE tracked_wallets (
         address TEXT PRIMARY KEY,
         profitable_entries INTEGER NOT NULL DEFAULT 0,
         total_entries INTEGER NOT NULL DEFAULT 0,
         score REAL NOT NULL DEFAULT 0,
         last_seen INTEGER NOT NULL
       );
       CREATE INDEX idx_tracked_score ON tracked_wallets(score DESC);`,
      `CREATE TABLE wallet_entries (
         wallet TEXT NOT NULL,
         token_address TEXT NOT NULL,
         entry_progress REAL NOT NULL,
         entered_at INTEGER NOT NULL,
         graduated INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (wallet, token_address)
       );
       CREATE INDEX idx_entries_token ON wallet_entries(token_address);`,
    ]);

    this.fundingIndex = new FundingIndex(this.db, resolver);
    this.loadTrackedWallets();
  }

  start(): void {
    this.bus.subscribe('launch.trade', (event) => this.onTrade(event));
    this.bus.subscribe('launch.graduated', (event) => this.onGraduation(event));
    log.info('wallet tracker started', {
      trackedWallets: this.trackedWallets.size,
      fundingCoverage: this.fundingIndex.coverage.resolved,
    });
  }

  stop(): void {
    this.db.close();
  }

  private loadTrackedWallets(): void {
    const rows = this.db.all<TrackedWalletRow>(
      'SELECT * FROM tracked_wallets WHERE profitable_entries >= ? ORDER BY score DESC LIMIT 5000',
      this.config.bot.walletTracker.minProfitableEntriesToTrack,
    );
    for (const row of rows) this.trackedWallets.set(row.address, row);
    this.stats.trackedWallets = this.trackedWallets.size;
  }

  isTracked(wallet: string): boolean {
    return this.trackedWallets.has(wallet.toLowerCase());
  }

  private onTrade(event: CurveTradeEvent): void {
    if (event.side !== 'buy') return;
    this.stats.buysObserved += 1;

    const token = event.tokenAddress;
    const wallet = event.recipient;

    let window = this.windows.get(token);
    if (!window) {
      // Capped so a single heavily-traded launch cannot grow without bound.
      window = new RingBuffer<WindowBuy>(2_000);
      this.windows.set(token, window);
    }
    window.push({ wallet, quote: BigInt(event.quoteAmount), timestamp: event.timestamp });

    // Record the first entry per wallet per token, at the curve progress it happened at.
    let entries = this.entriesByToken.get(token);
    if (!entries) {
      entries = new Map();
      this.entriesByToken.set(token, entries);
    }
    if (!entries.has(wallet)) {
      entries.set(wallet, { progress: this.progressFor(token), at: event.timestamp });
    }

    // Resolution is background work; this only queues it.
    this.fundingIndex.request(wallet);

    if (this.isTracked(wallet)) {
      const buys = this.recentTrackedBuys.get(token) ?? [];
      buys.push({
        wallet: wallet as TrackedWalletBuy['wallet'],
        walletScore: this.trackedWallets.get(wallet)?.score ?? 0,
        quoteSpent: event.quoteAmount,
        tokensReceived: event.tokenAmount,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        timestamp: event.timestamp,
      });
      this.recentTrackedBuys.set(token, buys.slice(-25));

      // A tracked wallet buying is the trigger to evaluate, not a reason to act.
      const signal = this.evaluate(token);
      this.bus.publish('wallet.signal', signal);
      this.stats.signalsEmitted += 1;
      if (signal.authentic) this.stats.authentic += 1;
      else this.stats.rejected += 1;
    }
  }

  /**
   * Assess whether the demand around a token is authentic. Callable at any time — the
   * decision engine asks for this directly at its confirm stage rather than waiting for
   * a tracked wallet to happen to trade.
   */
  evaluate(tokenAddress: string): WalletSignal {
    const token = tokenAddress.toLowerCase();
    const { walletTracker } = this.config.bot;
    const now = Date.now();
    const windowMs = walletTracker.windowSeconds * 1000;

    const window = this.windows.get(token);
    window?.prune((b) => now - b.timestamp <= windowMs);
    const buys = window?.toArray() ?? [];

    const volumeByWallet = new Map<string, bigint>();
    let earliest = now;
    for (const buy of buys) {
      volumeByWallet.set(buy.wallet, (volumeByWallet.get(buy.wallet) ?? 0n) + buy.quote);
      if (buy.timestamp < earliest) earliest = buy.timestamp;
    }

    const uniqueBuyerCount = volumeByWallet.size;
    const observedSeconds = Math.max(1, (now - earliest) / 1000);
    const uniqueBuyerVelocity = (uniqueBuyerCount / observedSeconds) * 60;

    // Gini over per-wallet volume. Splitting one actor's buying across many small trades
    // does not reduce it, because it is computed on wallets rather than on trades.
    const volumes = [...volumeByWallet.values()].map((v) => Number(v));
    const concentrationScore = gini(volumes);

    // Volume from wallets sharing a funder with at least one other buyer.
    const totalVolume = volumes.reduce((a, b) => a + b, 0);
    const byFunder = new Map<string, { volume: number; wallets: Set<string> }>();
    let resolvedWallets = 0;

    for (const [wallet, volume] of volumeByWallet) {
      const funding = this.fundingIndex.known(wallet);
      if (!funding?.funder) continue;
      resolvedWallets += 1;
      // A high-fanout funder is an exchange, not a shared pocket; it links nobody.
      if (funding.outDegree != null && funding.outDegree >= 50) continue;

      const bucket = byFunder.get(funding.funder) ?? { volume: 0, wallets: new Set<string>() };
      bucket.volume += Number(volume);
      bucket.wallets.add(wallet);
      byFunder.set(funding.funder, bucket);
    }

    let coFundedVolume = 0;
    for (const bucket of byFunder.values()) {
      if (bucket.wallets.size > 1) coFundedVolume += bucket.volume;
    }
    const sharedFundingVolumeShare = totalVolume > 0 ? clamp01(coFundedVolume / totalVolume) : 0;
    const fundingCoverage = uniqueBuyerCount > 0 ? resolvedWallets / uniqueBuyerCount : 0;

    const rejections: AuthenticityRejection[] = [];
    if (observedSeconds < 10) rejections.push('window-too-young');
    if (uniqueBuyerCount < walletTracker.minUniqueBuyers) rejections.push('insufficient-unique-buyers');
    if (uniqueBuyerVelocity < walletTracker.minUniqueBuyerVelocity) rejections.push('volume-without-buyer-growth');
    if (concentrationScore > walletTracker.maxConcentrationScore) rejections.push('holder-concentration-too-high');
    if (sharedFundingVolumeShare > walletTracker.maxSharedFundingVolumeShare) {
      rejections.push('buyers-share-funding-source');
    }

    // Confidence, not a boolean dressed up as one. Each component degrades the score
    // rather than flipping it, and unresolved funding caps the ceiling instead of being
    // scored as clean — an unknown is not evidence of independence.
    const buyerComponent = clamp01(uniqueBuyerCount / (walletTracker.minUniqueBuyers * 2));
    const velocityComponent = clamp01(uniqueBuyerVelocity / (walletTracker.minUniqueBuyerVelocity * 2));

    // Concentration and shared funding both score the *absence* of a bad pattern, so on
    // a token nobody has bought they read as perfectly clean and hand an untouched
    // launch a respectable score. Both are therefore scaled by how many buyers actually
    // back the measurement: no observations, no credit.
    const evidence = clamp01(uniqueBuyerCount / walletTracker.minUniqueBuyers);
    const concentrationComponent =
      clamp01(1 - concentrationScore / Math.max(0.01, walletTracker.maxConcentrationScore)) * evidence;
    const fundingComponent = (1 - sharedFundingVolumeShare) * evidence;
    const coverageCeiling = 0.6 + 0.4 * fundingCoverage;

    const authenticityScore = clamp01(
      buyerComponent * 0.3 +
        velocityComponent * 0.25 +
        concentrationComponent * 0.25 +
        fundingComponent * 0.2,
    ) * coverageCeiling;

    return {
      kind: 'wallet-signal',
      tokenAddress: token as WalletSignal['tokenAddress'],
      trackedWalletBuys: (this.recentTrackedBuys.get(token) ?? []).filter((b) => now - b.timestamp <= windowMs),
      uniqueBuyerVelocity,
      uniqueBuyerCount,
      concentrationScore,
      sharedFundingVolumeShare,
      authentic: rejections.length === 0,
      authenticityScore,
      rejections,
      windowSeconds: observedSeconds,
      timestamp: now,
    };
  }

  /**
   * Credit early entrants when a token graduates.
   *
   * Graduation is the objective, on-chain definition of a launch that worked on this
   * launchpad, which makes it a clean label: no price feed, no arbitrary "did it pump"
   * threshold. Wallets that were in before the curve was mostly filled get the credit;
   * wallets that bought the last stretch were following, not finding.
   */
  private onGraduation(event: GraduationEvent): void {
    const entries = this.entriesByToken.get(event.tokenAddress);
    if (!entries) return;

    const threshold = this.config.bot.walletTracker.earlyEntryProgressThreshold;
    let credited = 0;

    for (const [wallet, entry] of entries) {
      const early = entry.progress <= threshold;
      this.db.run(
        `INSERT OR REPLACE INTO wallet_entries (wallet, token_address, entry_progress, entered_at, graduated)
         VALUES (?, ?, ?, ?, 1)`,
        wallet,
        event.tokenAddress,
        entry.progress,
        entry.at,
      );
      if (!early) continue;

      credited += 1;
      this.db.run(
        `INSERT INTO tracked_wallets (address, profitable_entries, total_entries, score, last_seen)
         VALUES (?, 1, 1, 0, ?)
         ON CONFLICT(address) DO UPDATE SET
           profitable_entries = profitable_entries + 1,
           total_entries = total_entries + 1,
           last_seen = excluded.last_seen`,
        wallet,
        Date.now(),
      );
    }

    this.recomputeScores();
    this.entriesByToken.delete(event.tokenAddress);
    this.windows.delete(event.tokenAddress);
    this.recentTrackedBuys.delete(event.tokenAddress);

    if (credited > 0) log.info('credited early entrants on graduation', { token: event.tokenAddress, credited });
  }

  /** Record entries that did not graduate, so hit rate is a rate and not a tally. */
  recordFailedLaunch(tokenAddress: string): void {
    const entries = this.entriesByToken.get(tokenAddress.toLowerCase());
    if (!entries) return;

    for (const wallet of entries.keys()) {
      this.db.run(
        `INSERT INTO tracked_wallets (address, profitable_entries, total_entries, score, last_seen)
         VALUES (?, 0, 1, 0, ?)
         ON CONFLICT(address) DO UPDATE SET total_entries = total_entries + 1, last_seen = excluded.last_seen`,
        wallet,
        Date.now(),
      );
    }

    this.entriesByToken.delete(tokenAddress.toLowerCase());
    this.windows.delete(tokenAddress.toLowerCase());
  }

  /**
   * Score = hit rate, shrunk toward zero by how little evidence there is. Without the
   * shrinkage a wallet that got one early entry right would rank above a wallet that has
   * been right twenty times out of thirty.
   */
  private recomputeScores(): void {
    const min = this.config.bot.walletTracker.minProfitableEntriesToTrack;
    this.db.run(
      `UPDATE tracked_wallets
       SET score = (CAST(profitable_entries AS REAL) / MAX(total_entries, 1))
                   * MIN(1.0, CAST(profitable_entries AS REAL) / ?)`,
      min * 2,
    );
    this.trackedWallets.clear();
    this.loadTrackedWallets();
  }

  topWallets(limit = 10): TrackedWalletRow[] {
    return this.db.all<TrackedWalletRow>('SELECT * FROM tracked_wallets ORDER BY score DESC LIMIT ?', limit);
  }

  get fundingCoverage(): { resolved: number; queued: number } {
    return this.fundingIndex.coverage;
  }
}
