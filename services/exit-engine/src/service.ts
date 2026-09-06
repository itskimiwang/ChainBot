import { graduationProgress, sellImpactBps, tokensForQuote } from '@rhc/chain';
import { createLogger, mutex, type AppConfig, type MessageBus, type UsdPriceOracle } from '@rhc/core';
import type { ExecutionService, PortfolioLedger } from '@rhc/execution';
import type { RiskManager } from '@rhc/risk-manager';
import type { ExitSignal, Position } from '@rhc/types';
import {
  evaluateDepthAwareStop,
  evaluateGraduationTrim,
  evaluateTakeProfit,
  evaluateTimeout,
  evaluateTrailingStop,
  type ExitDecision,
} from './rules.js';

const log = createLogger('exit');

/** Shortest gap between two sell-driven re-marks of the same position. */
const REACTION_COALESCE_MS = 400;

interface PendingStop {
  reason: string;
  since: number;
  sinceBlock: number;
}

export interface ExitDeps {
  config: AppConfig;
  bus: MessageBus;
  oracle: UsdPriceOracle;
  ledger: PortfolioLedger;
  execution: ExecutionService;
  risk: RiskManager;
  unpin: (tokenAddress: string) => void;
  onPositionClosed: (position: Position) => void;
}

/**
 * Phase 5: the exit engine.
 *
 * Runs a refresh loop over open positions, re-marking each against live curve state and
 * applying the exit rules in priority order.
 *
 * Stops are required to persist before they fire. A bonding curve with a few ETH in it
 * is thin enough that one wallet's sell prints a spike that reverts a block or two
 * later, and a stop that reacts to the first tick below its level will be shaken out of
 * positions that were never actually in trouble. Take-profits, by contrast, fire
 * immediately — waiting to confirm a favourable move only gives it time to retrace.
 *
 * Persistence is skipped once a breach is far past its own threshold. The wait buys
 * information about whether a move is one wallet or many, and past a certain depth that
 * is no longer in question — at which point holding on only sells lower.
 */
export class ExitEngineService {
  private readonly serialize = mutex();
  private readonly pendingStops = new Map<string, PendingStop>();
  private readonly lastReaction = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  readonly stats = { ticks: 0, exitsFired: 0, stopsArmed: 0, stopsDisarmed: 0, stranded: 0, sellReactions: 0 };

  constructor(private readonly deps: ExitDeps) {}

  start(): void {
    this.timer = setInterval(
      () => void this.serialize(() => this.tick()),
      this.deps.config.bot.exit.markRefreshMs,
    );

    // The refresh loop alone samples a position every few seconds, and a thin curve can
    // give up most of its reserve inside one interval — which is how a stop that should
    // have filled near its trigger fills far below it. The scanner sees curve logs much
    // more often than that, so a sell on something we hold re-marks it straight away
    // instead of waiting for the next tick.
    this.deps.bus.subscribe('launch.trade', (trade) => {
      if (trade.side !== 'sell') return;
      const position = this.deps.ledger.positionForToken(trade.tokenAddress);
      if (!position || position.status !== 'open') return;
      void this.reactToSell(position);
    });

    log.info('exit engine started', {
      ladder: this.deps.config.bot.exit.takeProfitLadder,
      markRefreshMs: this.deps.config.bot.exit.markRefreshMs,
      stopPersistenceSeconds: this.deps.config.bot.exit.stopPersistenceSeconds,
    });
  }

  /**
   * Re-mark a held position because someone sold it.
   *
   * Coalesced per position: a single scan page routinely carries a burst of sells on the
   * same curve, and each re-mark is an RPC round trip against an endpoint that is already
   * rate-limited. One read per burst carries the same information as ten.
   */
  private async reactToSell(position: Position): Promise<void> {
    const last = this.lastReaction.get(position.positionId) ?? 0;
    if (Date.now() - last < REACTION_COALESCE_MS) return;
    this.lastReaction.set(position.positionId, Date.now());

    this.stats.sellReactions += 1;
    await this.serialize(async () => {
      const current = this.deps.ledger.getPosition(position.positionId);
      if (!current || current.status !== 'open') return;
      try {
        await this.evaluatePosition(current);
      } catch (err) {
        log.error('failed to evaluate position on sell', { positionId: current.positionId, err });
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Flatten everything. Used by the kill switch and by operator command. */
  async flattenAll(reason: 'risk-manager-flatten' | 'manual'): Promise<void> {
    for (const position of this.deps.ledger.openPositions()) {
      await this.exit(position, {
        reason,
        fraction: 1,
        ladderStep: null,
        detail: 'flatten requested',
        requiresPersistence: false,
      });
    }
  }

  private async tick(): Promise<void> {
    this.stats.ticks += 1;
    this.deps.risk.tick();

    for (const position of this.deps.ledger.openPositions()) {
      try {
        await this.evaluatePosition(position);
      } catch (err) {
        log.error('failed to evaluate position', { positionId: position.positionId, err });
      }
    }
  }

  private async evaluatePosition(position: Position): Promise<void> {
    const marked = await this.deps.execution.markPosition(position);
    if (!marked) return;

    const updated = this.deps.ledger.updateMark(position.positionId, marked.mark, marked.spot);
    if (!updated) return;

    const currentMultiple = this.deps.ledger.currentMultiple(updated);
    const progress = graduationProgress(marked.snapshot);
    const { config } = this.deps;

    // The curve refuses sells from the sweep onward, before the factory reports a new
    // phase. Exiting from here needs the Uniswap v4 route, which does not exist yet, so
    // the position is marked stranded exactly once. Retrying would re-alert on every
    // tick and hold a concurrency slot for the lifetime of the process.
    if (marked.snapshot.readyToGraduate || marked.snapshot.graduated) {
      const stranded = this.deps.ledger.markStranded(
        updated.positionId,
        `curve closed to sells at ${currentMultiple.toFixed(2)}x`,
      );
      if (!stranded) return;

      this.stats.stranded += 1;
      this.deps.unpin(updated.tokenAddress);
      this.deps.bus.publish('alert.notify', {
        level: 'warn',
        title: `${updated.symbol} graduated while still held`,
        body:
          `The curve stopped accepting sells at ${currentMultiple.toFixed(2)}x, so ` +
          `${updated.symbol} cannot be exited: selling now needs the Uniswap v4 route, ` +
          'which is not implemented. The cost basis is written down to zero and the ' +
          'position no longer occupies a slot. Trim earlier by lowering ' +
          'exit.graduationProximityTrim.progressThreshold.',
      });
      return;
    }

    // Two impact measures at current curve depth: what our own exit would cost, and what
    // one ordinary participant's sell would cost. Together they set the threshold that
    // separates single-wallet noise from real selling pressure.
    const ownSizeTokens =
      (BigInt(updated.tokensHeld) * BigInt(Math.round(config.bot.exit.depthAwareStopSizeFraction * 10_000))) /
      10_000n;
    const impactBpsOfOwnSize = sellImpactBps(marked.snapshot, ownSizeTokens);

    const referenceQuote = this.deps.oracle.fromUsd(config.bot.exit.depthStopReferenceTradeUsd, updated.quoteAsset);
    const referenceTokens =
      referenceQuote != null ? tokensForQuote(referenceQuote, BigInt(updated.markPrice)) : 0n;
    const impactBpsOfReferenceTrade = sellImpactBps(marked.snapshot, referenceTokens);

    const decision =
      evaluateTakeProfit(config.bot, updated, currentMultiple) ??
      evaluateGraduationTrim(config.bot, updated, progress) ??
      evaluateTrailingStop(config.bot, updated, currentMultiple) ??
      evaluateDepthAwareStop(
        config.bot,
        updated,
        currentMultiple,
        impactBpsOfOwnSize,
        impactBpsOfReferenceTrade,
      ) ??
      evaluateTimeout(config.bot, updated, Date.now());

    if (!decision) {
      if (this.pendingStops.delete(updated.positionId)) this.stats.stopsDisarmed += 1;
      return;
    }

    if (decision.requiresPersistence && !this.hasPersisted(updated, decision, marked.snapshot.blockNumber)) {
      return;
    }

    await this.exit(updated, decision);
  }

  /**
   * A stop must hold for both a wall-clock duration and a number of blocks before it
   * fires. Both matter: the block requirement is what actually filters a single-wallet
   * spike, and the time requirement keeps a stalled RPC from satisfying the block count
   * instantly on a chain producing ten blocks a second.
   */
  private hasPersisted(position: Position, decision: ExitDecision, blockNumber: number): boolean {
    const existing = this.pendingStops.get(position.positionId);

    if (!existing || existing.reason !== decision.reason) {
      this.pendingStops.set(position.positionId, {
        reason: decision.reason,
        since: Date.now(),
        sinceBlock: blockNumber,
      });
      this.stats.stopsArmed += 1;
      log.debug('stop armed, waiting for persistence', {
        token: position.tokenAddress,
        reason: decision.reason,
      });
      return false;
    }

    const heldSeconds = (Date.now() - existing.since) / 1000;
    const heldBlocks = blockNumber - existing.sinceBlock;
    const { stopPersistenceSeconds, stopPersistenceBlocks } = this.deps.config.bot.exit;

    return heldSeconds >= stopPersistenceSeconds && heldBlocks >= stopPersistenceBlocks;
  }

  private async exit(position: Position, decision: ExitDecision): Promise<void> {
    const tokensHeld = BigInt(position.tokensHeld);
    if (tokensHeld <= 0n) return;

    const tokensToSell =
      decision.fraction >= 1
        ? tokensHeld
        : (tokensHeld * BigInt(Math.round(decision.fraction * 10_000))) / 10_000n;
    if (tokensToSell <= 0n) return;

    const currentMultiple = this.deps.ledger.currentMultiple(position);

    const signal: ExitSignal = {
      kind: 'exit-signal',
      positionId: position.positionId,
      tokenAddress: position.tokenAddress,
      reason: decision.reason,
      fraction: decision.fraction,
      currentMultiple,
      ladderStep: decision.ladderStep,
      detail: decision.detail,
      timestamp: Date.now(),
    };
    this.deps.bus.publish('exit.signal', signal);

    const intent = this.deps.execution.buildIntent({
      side: 'sell',
      stage: null,
      tokenAddress: position.tokenAddress,
      curveAddress: position.curveAddress,
      poolAddress: position.poolAddress,
      venue: position.venue,
      quoteAsset: position.quoteAsset,
      amount: tokensToSell.toString(),
      // Exits are allowed more slippage than entries. A stop that will not fill because
      // the price is moving is not a stop.
      maxSlippageBps: Math.min(2_000, this.deps.config.bot.decision.maxSlippageBps * 3),
      reason: decision.detail,
      confidence: null,
    });

    const result = await this.deps.execution.execute(intent, {
      stage: position.stage,
      reason: decision.reason,
      positionId: position.positionId,
      ladderStep: decision.ladderStep,
    });

    if (!result) return;

    this.stats.exitsFired += 1;
    this.pendingStops.delete(position.positionId);

    const after = result.position;
    if (after && after.status === 'closed') {
      this.deps.unpin(after.tokenAddress);
      this.deps.onPositionClosed(after);

      const pnl = Number(after.realizedPnlQuote);
      log.info('position closed', {
        symbol: after.symbol,
        reason: decision.reason,
        multiple: currentMultiple.toFixed(2),
        realizedPnlQuote: after.realizedPnlQuote,
      });
      this.deps.bus.publish('alert.notify', {
        level: pnl >= 0 ? 'info' : 'warn',
        title: `${pnl >= 0 ? 'Closed +' : 'Closed '}${after.symbol} at ${currentMultiple.toFixed(2)}x`,
        body: `${decision.detail}. Realised ${after.realizedPnlQuote} ${after.quoteAsset.symbol}.`,
      });
    }
  }
}
