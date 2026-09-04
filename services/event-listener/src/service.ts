import type { Address } from 'viem';
import {
  ChainReader,
  LogScanner,
  QuoteAssetRegistry,
  graduationProgress,
  type RawLog,
  type RhcPublicClient,
} from '@rhc/chain';
import { createLogger, type AppConfig, type MessageBus } from '@rhc/core';
import type { NewLaunchEvent, QuoteAsset } from '@rhc/types';
import type { DecodeContext, LaunchpadAdapter } from './adapter.js';

const log = createLogger('listener');

export interface TrackedCurve {
  tokenAddress: string;
  curveAddress: Address;
  deployerAddress: string;
  launchpadId: string;
  quoteAsset: QuoteAsset;
  graduationThreshold: bigint;
  /** Pricing reserve, refreshed on each state read. */
  quoteReserve: bigint;
  realQuoteReserve: bigint;
  progress: number;
  launchedAt: number;
  lastTradeAt: number;
  lastReadAt: number;
  tradeCount: number;
  swept: boolean;
  graduated: boolean;
}

/**
 * Phase 0 event listener.
 *
 * Two scanners run against different address sets. The factory scanner watches one
 * contract for launches, sweeps, and graduations. The curve scanner watches the set of
 * curves currently being tracked — one contract per live launch, which is the part of
 * this chain's design that makes subscription management a real problem rather than a
 * detail: the chain produces roughly fifteen launches a minute, so the tracked set has
 * to be actively bounded and evicted or the scanner's address filter grows without
 * limit and the RPC starts refusing pages.
 */
export class EventListenerService {
  private readonly tracked = new Map<string, TrackedCurve>();
  private readonly curveToToken = new Map<string, string>();
  private factoryScanner: LogScanner | null = null;
  private curveScanner: LogScanner | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  /** Anchor for estimating block timestamps without an RPC call per log. */
  private anchor = { blockNumber: 0, timestampMs: 0 };

  readonly stats = {
    launchesSeen: 0,
    launchesTracked: 0,
    launchesSkipped: 0,
    tradesSeen: 0,
    graduations: 0,
    evictions: 0,
  };

  constructor(
    private readonly config: AppConfig,
    private readonly client: RhcPublicClient,
    private readonly reader: ChainReader,
    private readonly quoteAssets: QuoteAssetRegistry,
    private readonly adapters: LaunchpadAdapter[],
    private readonly bus: MessageBus,
  ) {}

  async start(): Promise<void> {
    if (this.adapters.length === 0) {
      throw new Error('no launchpad adapters enabled: the listener would emit nothing');
    }

    const head = await this.reader.getBlockNumber();
    this.anchor = { blockNumber: head, timestampMs: await this.reader.getBlockTimestampMs(head) };

    const { listener } = this.config.bot;
    const fromBlock = Math.max(0, head - listener.backfillBlocks);

    const factoryAddresses = this.adapters.map((a) => a.factoryAddress);
    const factoryTopics = [...new Set(this.adapters.flatMap((a) => a.factoryTopics))];

    this.factoryScanner = new LogScanner({
      client: this.client,
      name: 'factory',
      filter: () => ({ addresses: factoryAddresses, topics: factoryTopics }),
      onLogs: (logs) => this.handleFactoryLogs(logs),
      pollIntervalMs: listener.pollIntervalMs,
      pageSize: listener.logPageSize,
    });

    this.curveScanner = new LogScanner({
      client: this.client,
      name: 'curves',
      filter: () => ({
        addresses: [...this.tracked.values()].filter((t) => !t.graduated).map((t) => t.curveAddress),
        topics: [...new Set(this.adapters.flatMap((a) => a.curveTopics))],
      }),
      onLogs: (logs) => this.handleCurveLogs(logs),
      pollIntervalMs: listener.pollIntervalMs,
      pageSize: listener.logPageSize,
    });

    await this.factoryScanner.start(fromBlock);
    // Curve scanning starts at head: backfilled launches have their state read directly,
    // and replaying their historical trades would emit stale demand signals.
    await this.curveScanner.start(head);

    this.refreshTimer = setInterval(() => void this.refreshTracked(), 2_000);

    log.info('event listener started', {
      adapters: this.adapters.map((a) => a.id),
      fromBlock,
      head,
      backfillBlocks: listener.backfillBlocks,
      quoteAssetAllowlist: listener.quoteAssetAllowlist,
    });
  }

  stop(): void {
    this.factoryScanner?.stop();
    this.curveScanner?.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  getTracked(tokenAddress: string): TrackedCurve | undefined {
    return this.tracked.get(tokenAddress.toLowerCase());
  }

  listTracked(): TrackedCurve[] {
    return [...this.tracked.values()];
  }

  /**
   * Keep watching a curve regardless of idle time. Called when a position is opened, so
   * eviction can never blind the exit engine to the token it is holding.
   */
  private readonly pinned = new Set<string>();
  pin(tokenAddress: string): void {
    this.pinned.add(tokenAddress.toLowerCase());
  }
  unpin(tokenAddress: string): void {
    this.pinned.delete(tokenAddress.toLowerCase());
  }

  getScannerStats() {
    return {
      factory: this.factoryScanner?.stats ?? null,
      curves: this.curveScanner?.stats ?? null,
      trackedCurves: this.tracked.size,
      pinned: this.pinned.size,
      ...this.stats,
    };
  }

  private decodeContext(): DecodeContext {
    return {
      timestampFor: (blockNumber) => this.estimateTimestamp(blockNumber),
      resolveQuoteAsset: (address) => this.quoteAssets.resolve(address),
      curveFor: (token) => this.tracked.get(token.toLowerCase())?.curveAddress,
      tokenForCurve: (curve) => this.curveToToken.get(curve.toLowerCase()),
      quoteAssetFor: (token) => this.tracked.get(token.toLowerCase())?.quoteAsset,
      reserveFor: (curve) => {
        const token = this.curveToToken.get(curve.toLowerCase());
        return token ? this.tracked.get(token)?.quoteReserve : undefined;
      },
    };
  }

  /**
   * Blocks land every ~100ms here, so fetching a block per log would cost more RPC than
   * every other read combined. Interpolating from a periodically refreshed anchor is
   * accurate to well inside the resolution any downstream window actually needs.
   */
  private estimateTimestamp(blockNumber: number): number {
    const delta = blockNumber - this.anchor.blockNumber;
    return this.anchor.timestampMs + delta * this.config.chain.chain.approxBlockTimeMs;
  }

  private async handleFactoryLogs(logs: RawLog[]): Promise<void> {
    const ctx = this.decodeContext();

    for (const raw of logs) {
      const adapter = this.adapters.find((a) => a.factoryAddress.toLowerCase() === raw.address.toLowerCase());
      if (!adapter) continue;

      let result;
      try {
        result = await adapter.decodeFactoryLog(raw, ctx);
      } catch (err) {
        log.warn('failed to decode factory log', { topic0: raw.topics[0], err: (err as Error).message });
        continue;
      }
      if (!result) continue;

      if (result.type === 'launch') {
        this.stats.launchesSeen += 1;
        this.onNewLaunch(result.event);
      } else if (result.type === 'graduation') {
        this.stats.graduations += 1;
        const tracked = this.tracked.get(result.event.tokenAddress);
        if (tracked) {
          tracked.graduated = true;
          tracked.progress = 1;
        }
        this.bus.publish('launch.graduated', result.event);
        log.info('token graduated to uniswap v4', {
          token: result.event.tokenAddress,
          quoteSeeded: result.event.quoteSeeded,
          symbol: result.event.quoteAsset.symbol,
        });
      } else {
        const tracked = this.tracked.get(result.tokenAddress);
        // Sells revert from the sweep onward, before the factory reports a new phase.
        if (tracked) tracked.swept = true;
      }
    }
  }

  private onNewLaunch(event: NewLaunchEvent): void {
    if (!this.quoteAssets.isAllowed(event.quoteAsset)) {
      this.stats.launchesSkipped += 1;
      return;
    }

    if (this.tracked.size >= this.config.bot.listener.maxTrackedCurves) {
      this.evictStalest();
    }
    if (this.tracked.size >= this.config.bot.listener.maxTrackedCurves) {
      this.stats.launchesSkipped += 1;
      return;
    }

    const tracked: TrackedCurve = {
      tokenAddress: event.tokenAddress,
      curveAddress: event.curveAddress as Address,
      deployerAddress: event.deployerAddress,
      launchpadId: event.launchpadId,
      quoteAsset: event.quoteAsset,
      graduationThreshold: BigInt(event.graduationThreshold),
      quoteReserve: BigInt(event.curveReserve),
      realQuoteReserve: 0n,
      progress: 0,
      launchedAt: event.timestamp,
      lastTradeAt: event.timestamp,
      lastReadAt: 0,
      tradeCount: 0,
      swept: false,
      graduated: false,
    };

    this.tracked.set(event.tokenAddress, tracked);
    this.curveToToken.set(event.curveAddress, event.tokenAddress);
    this.stats.launchesTracked += 1;

    this.bus.publish('launch.new', event);
  }

  private async handleCurveLogs(logs: RawLog[]): Promise<void> {
    const ctx = this.decodeContext();

    for (const raw of logs) {
      for (const adapter of this.adapters) {
        let event;
        try {
          event = await adapter.decodeCurveLog(raw, ctx);
        } catch (err) {
          log.debug('failed to decode curve log', { err: (err as Error).message });
          continue;
        }
        if (!event) continue;

        this.stats.tradesSeen += 1;
        const tracked = this.tracked.get(event.tokenAddress);
        if (tracked) {
          tracked.lastTradeAt = event.timestamp;
          tracked.tradeCount += 1;
        }
        this.bus.publish('launch.trade', event);
        break;
      }
    }
  }

  /**
   * Refresh curve state for tokens with recent activity, and evict what has gone quiet.
   *
   * Reserves drive graduation progress, the exit engine's depth-aware stop, and the
   * decision engine's proximity signal, so they need to be current for anything live —
   * but reading all 250 tracked curves every tick would swamp the endpoint. Pinned
   * tokens (open positions) and recently active ones are prioritised.
   */
  private async refreshTracked(): Promise<void> {
    const now = Date.now();
    const { curveIdleEvictionSeconds } = this.config.bot.listener;

    const candidates = [...this.tracked.values()]
      .filter((t) => !t.graduated)
      .sort((a, b) => {
        const aPinned = this.pinned.has(a.tokenAddress) ? 1 : 0;
        const bPinned = this.pinned.has(b.tokenAddress) ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        return b.lastTradeAt - a.lastTradeAt;
      })
      .slice(0, 60);

    await Promise.all(
      candidates.map(async (tracked) => {
        const snapshot = await this.reader.readCurve(tracked.curveAddress);
        if (!snapshot) return;
        tracked.quoteReserve = snapshot.quoteReserve;
        tracked.realQuoteReserve = snapshot.realQuoteReserve;
        tracked.progress = graduationProgress(snapshot);
        tracked.lastReadAt = now;
        if (snapshot.readyToGraduate) tracked.swept = true;
        if (snapshot.graduated) tracked.graduated = true;
      }),
    );

    for (const [token, tracked] of this.tracked) {
      if (this.pinned.has(token)) continue;
      const idleSeconds = (now - tracked.lastTradeAt) / 1000;
      if (tracked.graduated || idleSeconds > curveIdleEvictionSeconds) {
        this.tracked.delete(token);
        this.curveToToken.delete(tracked.curveAddress.toLowerCase());
        this.stats.evictions += 1;
      }
    }
  }

  private evictStalest(): void {
    let stalest: TrackedCurve | null = null;
    for (const tracked of this.tracked.values()) {
      if (this.pinned.has(tracked.tokenAddress)) continue;
      if (!stalest || tracked.lastTradeAt < stalest.lastTradeAt) stalest = tracked;
    }
    if (stalest) {
      this.tracked.delete(stalest.tokenAddress);
      this.curveToToken.delete(stalest.curveAddress.toLowerCase());
      this.stats.evictions += 1;
    }
  }
}
