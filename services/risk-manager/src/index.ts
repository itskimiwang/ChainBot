import { existsSync } from 'node:fs';
import { createLogger, type AppConfig, type MessageBus } from '@rhc/core';
import type { QuoteAsset, RiskState, RiskVerdict } from '@rhc/types';

const log = createLogger('risk');

export interface RiskContext {
  /** Current total equity in USD, marked at realisable prices. */
  equityUsd(): number;
  openPositionCount(): number;
  /** USD committed across all open positions. */
  totalExposureUsd(): number;
}

/**
 * Cross-cutting risk control.
 *
 * Sits between the decision engine and execution, and has final say on every entry. Its
 * job is to bound the damage from a bad signal, a bug, or a compromised key — so it
 * enforces limits regardless of how confident the strategy is, and it can only ever
 * reduce a requested size, never increase one.
 *
 * The daily circuit breaker and the kill switch both halt *new entries only*. Exits are
 * never blocked: refusing to sell during a drawdown would turn a bad day into an
 * unrecoverable one, which is the opposite of risk management.
 */
export class RiskManager {
  private halted = false;
  private haltReason: string | null = null;
  private dayStartEquityUsd = 0;
  private dayKey = '';
  private tradesToday = 0;
  private peakEquityUsd = 0;
  private maxDrawdownPct = 0;

  /** Cluster id -> timestamp until which entries from that cluster are refused. */
  private readonly clusterCooldowns = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly context: RiskContext,
    private readonly bus: MessageBus,
  ) {}

  initialise(): void {
    this.rollDayIfNeeded();
    this.peakEquityUsd = this.context.equityUsd();
  }

  /**
   * The manual kill switch is a file on disk rather than an API call on purpose: it
   * works when the process is wedged, when the dashboard is down, and from any shell
   * with access to the host.
   */
  get killSwitchEngaged(): boolean {
    return existsSync(this.config.bot.risk.killSwitchFile);
  }

  pause(reason: string): void {
    this.halted = true;
    this.haltReason = reason;
    log.warn('trading halted', { reason });
    this.bus.publish('alert.notify', { level: 'warn', title: 'Trading halted', body: reason });
  }

  resume(): void {
    // Refuse to resume into a breached circuit breaker: the operator would be un-doing
    // the one control specifically designed to survive a bad run.
    const breach = this.dailyLossBreach();
    if (breach) {
      log.warn('resume refused: daily loss limit still breached', { breach });
      this.bus.publish('alert.notify', {
        level: 'warn',
        title: 'Resume refused',
        body: `Daily loss limit still breached (${breach}). Reset the day or raise the limit deliberately.`,
      });
      return;
    }
    this.halted = false;
    this.haltReason = null;
    log.info('trading resumed');
    this.bus.publish('alert.notify', { level: 'info', title: 'Trading resumed', body: 'Entries re-enabled.' });
  }

  recordTrade(): void {
    this.rollDayIfNeeded();
    this.tradesToday += 1;
  }

  /** Refuse further entries from a cluster after it produces a loss. */
  penaliseCluster(clusterId: string): void {
    const until = Date.now() + this.config.bot.risk.clusterCooldownSeconds * 1000;
    this.clusterCooldowns.set(clusterId, until);
  }

  /** Called on every mark refresh so the breaker and drawdown stay current. */
  tick(): void {
    this.rollDayIfNeeded();

    const equity = this.context.equityUsd();
    if (equity > this.peakEquityUsd) this.peakEquityUsd = equity;
    if (this.peakEquityUsd > 0) {
      const drawdown = ((this.peakEquityUsd - equity) / this.peakEquityUsd) * 100;
      if (drawdown > this.maxDrawdownPct) this.maxDrawdownPct = drawdown;
    }

    const breach = this.dailyLossBreach();
    if (breach && !this.halted) this.pause(breach);
  }

  private dailyLossBreach(): string | null {
    if (this.dayStartEquityUsd <= 0) return null;
    const equity = this.context.equityUsd();
    const lossPct = ((this.dayStartEquityUsd - equity) / this.dayStartEquityUsd) * 100;
    if (lossPct >= this.config.bot.risk.dailyLossLimitPct) {
      return `daily loss limit hit: -${lossPct.toFixed(2)}% vs limit ${this.config.bot.risk.dailyLossLimitPct}%`;
    }
    return null;
  }

  private rollDayIfNeeded(): void {
    const key = new Date().toISOString().slice(0, 10);
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.dayStartEquityUsd = this.context.equityUsd();
    this.tradesToday = 0;
    // A new day clears a breaker that tripped purely on the previous day's losses.
    if (this.halted && this.haltReason?.startsWith('daily loss limit')) {
      this.halted = false;
      this.haltReason = null;
      log.info('new trading day: daily loss breaker reset', { dayStartEquityUsd: this.dayStartEquityUsd });
    }
  }

  /**
   * Approve, clamp, or refuse an entry. `requestedUsd` is what the decision engine
   * wants; the returned amount is what it may actually have.
   */
  checkEntry(params: { requestedUsd: number; quoteAsset: QuoteAsset; clusterId: string | null }): RiskVerdict {
    this.rollDayIfNeeded();
    const { risk } = this.config.bot;
    const reasons: string[] = [];

    if (this.killSwitchEngaged) {
      return { allowed: false, reasons: ['kill switch engaged'], permittedAmount: '0' };
    }
    if (this.halted) {
      return { allowed: false, reasons: [this.haltReason ?? 'halted'], permittedAmount: '0' };
    }

    const breach = this.dailyLossBreach();
    if (breach) {
      this.pause(breach);
      return { allowed: false, reasons: [breach], permittedAmount: '0' };
    }

    if (this.context.openPositionCount() >= risk.maxConcurrentPositions) {
      return {
        allowed: false,
        reasons: [`max concurrent positions reached (${risk.maxConcurrentPositions})`],
        permittedAmount: '0',
      };
    }

    if (this.tradesToday >= risk.maxTradesPerDay) {
      return { allowed: false, reasons: [`daily trade cap reached (${risk.maxTradesPerDay})`], permittedAmount: '0' };
    }

    if (params.clusterId) {
      const until = this.clusterCooldowns.get(params.clusterId);
      if (until && until > Date.now()) {
        const remaining = Math.round((until - Date.now()) / 1000);
        return {
          allowed: false,
          reasons: [`deployer cluster in cooldown for ${remaining}s after a prior loss`],
          permittedAmount: '0',
        };
      }
    }

    let permittedUsd = params.requestedUsd;

    if (permittedUsd > risk.maxPositionSizeUsd) {
      permittedUsd = risk.maxPositionSizeUsd;
      reasons.push(`clamped to max position size $${risk.maxPositionSizeUsd}`);
    }

    const equity = this.context.equityUsd();
    const exposureCapUsd = equity * risk.maxTotalExposurePct;
    const headroom = exposureCapUsd - this.context.totalExposureUsd();
    if (headroom <= 0) {
      return {
        allowed: false,
        reasons: [`total exposure cap reached (${(risk.maxTotalExposurePct * 100).toFixed(0)}% of equity)`],
        permittedAmount: '0',
      };
    }
    if (permittedUsd > headroom) {
      permittedUsd = headroom;
      reasons.push('clamped to remaining exposure headroom');
    }

    // Below a dollar the fees dominate and the fill is not informative even on paper.
    if (permittedUsd < 1) {
      return { allowed: false, reasons: ['permitted size below the $1 minimum'], permittedAmount: '0' };
    }

    return { allowed: true, reasons, permittedAmount: String(permittedUsd) };
  }

  state(): RiskState {
    const equity = this.context.equityUsd();
    return {
      halted: this.halted || this.killSwitchEngaged,
      haltReason: this.killSwitchEngaged ? 'kill switch engaged' : this.haltReason,
      killSwitchEngaged: this.killSwitchEngaged,
      openPositions: this.context.openPositionCount(),
      maxConcurrentPositions: this.config.bot.risk.maxConcurrentPositions,
      dayStartEquityQuote: this.dayStartEquityUsd.toFixed(2),
      currentEquityQuote: equity.toFixed(2),
      dailyPnlQuote: (equity - this.dayStartEquityUsd).toFixed(2),
      dailyLossLimitQuote: ((this.dayStartEquityUsd * this.config.bot.risk.dailyLossLimitPct) / 100).toFixed(2),
      dailyDrawdownPct:
        this.dayStartEquityUsd > 0 ? ((this.dayStartEquityUsd - equity) / this.dayStartEquityUsd) * 100 : 0,
      tradesToday: this.tradesToday,
      updatedAt: Date.now(),
    };
  }

  get peakDrawdownPct(): number {
    return this.maxDrawdownPct;
  }
}
