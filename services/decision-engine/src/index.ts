import { clamp01, createLogger, mutex, type AppConfig, type MessageBus, type UsdPriceOracle } from '@rhc/core';
import type { DeployerGraphService } from '@rhc/deployer-graph';
import type { ExecutionService, PortfolioLedger } from '@rhc/execution';
import type { RiskManager } from '@rhc/risk-manager';
import type { EntryStage, NewLaunchEvent, QuoteAsset, WalletSignal } from '@rhc/types';
import type { VettingService } from '@rhc/vetting';
import type { WalletTrackerService } from '@rhc/wallet-tracker';

const log = createLogger('decision');

export interface LaunchView {
  tokenAddress: string;
  curveAddress: string;
  deployerAddress: string;
  quoteAsset: QuoteAsset;
  progress: number;
  launchedAt: number;
  graduated: boolean;
  swept: boolean;
}

export interface DecisionDeps {
  config: AppConfig;
  bus: MessageBus;
  vetting: VettingService;
  deployerGraph: DeployerGraphService;
  walletTracker: WalletTrackerService;
  execution: ExecutionService;
  ledger: PortfolioLedger;
  risk: RiskManager;
  oracle: UsdPriceOracle;
  launchView: (tokenAddress: string) => LaunchView | undefined;
  pin: (tokenAddress: string) => void;
}

export interface RejectionRecord {
  tokenAddress: string;
  stage: EntryStage;
  reason: string;
  timestamp: number;
}

/**
 * Phase 4: two-stage entry.
 *
 * Stage one takes a small scout position on a token that is merely *not disqualified* —
 * it passed vetting, its deployer is not a known problem, and there is some real demand.
 * Stage two scales up only once Phase 3 says the demand is authentic. The split exists
 * because the authenticity signal needs a population of buyers to measure and that takes
 * time to accumulate, while the entry price is decaying the whole while. Scouting small
 * buys exposure to the window where confirmation is still forming.
 *
 * Sizing is a weighted *geometric* mean of the confidence components rather than an
 * average. The spec describes the combination as a product, and that behaviour is the
 * point: an average lets a strong deployer score paper over demand that looks fabricated,
 * whereas a product collapses toward zero if any single component does.
 */
export class DecisionEngine {
  private readonly serialize = mutex();
  private readonly scouted = new Set<string>();
  private readonly confirmed = new Set<string>();
  private readonly recentRejections: RejectionRecord[] = [];

  readonly stats = { evaluated: 0, scoutEntries: 0, confirmEntries: 0, rejected: 0 };

  constructor(private readonly deps: DecisionDeps) {}

  start(): void {
    this.deps.bus.subscribe('launch.new', (event) => this.serialize(() => this.considerScout(event)));
    this.deps.bus.subscribe('wallet.signal', (signal) => this.serialize(() => this.considerConfirm(signal)));
    log.info('decision engine started', {
      scoutSizePctOfEquity: this.deps.config.bot.decision.scoutSizePctOfEquity,
      confirmSizePctOfEquity: this.deps.config.bot.decision.confirmSizePctOfEquity,
      minCombinedConfidence: this.deps.config.bot.decision.minCombinedConfidence,
    });
  }

  get rejections(): RejectionRecord[] {
    return this.recentRejections.slice(-100);
  }

  private reject(tokenAddress: string, stage: EntryStage, reason: string): void {
    this.stats.rejected += 1;
    this.recentRejections.push({ tokenAddress, stage, reason, timestamp: Date.now() });
    if (this.recentRejections.length > 300) this.recentRejections.splice(0, 100);
  }

  /* ------------------------------ stage 1 ------------------------------ */

  private async considerScout(event: NewLaunchEvent): Promise<void> {
    const { decision } = this.deps.config.bot;
    const token = event.tokenAddress;
    this.stats.evaluated += 1;

    if (this.scouted.has(token)) return;
    if (this.deps.ledger.positionForToken(token)) return;

    const view = this.deps.launchView(token);
    if (!view || view.graduated || view.swept) return this.reject(token, 'scout', 'launch no longer on the curve');

    const ageSeconds = (Date.now() - event.timestamp) / 1000;
    if (ageSeconds > decision.maxLaunchAgeSeconds) return this.reject(token, 'scout', 'launch too old');

    // The curve opens with a decaying snipe tax that starts near 99%. Entering into it
    // is a guaranteed loss on the way in, and it costs only seconds to wait it out.
    if (view.progress < decision.minGraduationProgress) {
      return this.reject(token, 'scout', 'no demand yet');
    }
    if (view.progress > decision.maxGraduationProgress) {
      return this.reject(token, 'scout', 'too close to graduation to enter');
    }

    const vetting = await this.deps.vetting.vet(event);
    if (!vetting.passVetting) {
      return this.reject(token, 'scout', `vetting: ${vetting.failures.join(', ')}`);
    }
    if (vetting.snipeTaxBps > decision.maxSnipeTaxBps) {
      return this.reject(token, 'scout', `snipe tax still ${vetting.snipeTaxBps}bps`);
    }

    const deployerScore = this.deps.deployerGraph.score(event.deployerAddress);
    if (deployerScore.isKnownRugCluster) {
      return this.reject(token, 'scout', 'deployer belongs to a known rug cluster');
    }
    if (deployerScore.score < decision.minDeployerScoreForScout) {
      return this.reject(token, 'scout', `deployer score ${deployerScore.score.toFixed(2)} below floor`);
    }

    const signal = this.deps.walletTracker.evaluate(token);
    const confidence = this.combine({
      deployer: deployerScore.score,
      authenticity: signal.authenticityScore,
      demandVelocity: this.demandComponent(signal),
      graduationProximity: this.proximityComponent(view.progress),
    });

    if (confidence.combined < decision.minCombinedConfidence) {
      return this.reject(token, 'scout', `confidence ${confidence.combined.toFixed(2)} below floor`);
    }

    await this.enter({
      view,
      stage: 'scout',
      sizePct: decision.scoutSizePctOfEquity,
      confidence,
      clusterId: deployerScore.clusterId,
      reason: `scout: ${deployerScore.reasons[0] ?? 'passed vetting'}`,
    });

    this.scouted.add(token);
    this.stats.scoutEntries += 1;
  }

  /* ------------------------------ stage 2 ------------------------------ */

  private async considerConfirm(signal: WalletSignal): Promise<void> {
    const token = signal.tokenAddress;
    if (!signal.authentic) return;
    if (this.confirmed.has(token)) return;

    const position = this.deps.ledger.positionForToken(token);
    // Confirmation scales an existing scout. Without one there is no entry price to
    // build on, and the token would be bought at whatever the run has already reached.
    if (!position) return;

    const view = this.deps.launchView(token);
    if (!view || view.graduated || view.swept) return;

    const vetting = this.deps.vetting.getCached(token);
    if (!vetting?.passVetting) return;

    const deployerScore = this.deps.deployerGraph.score(view.deployerAddress);
    const confidence = this.combine({
      deployer: deployerScore.score,
      authenticity: signal.authenticityScore,
      demandVelocity: this.demandComponent(signal),
      graduationProximity: this.proximityComponent(view.progress),
    });

    if (confidence.combined < this.deps.config.bot.decision.minCombinedConfidence) return;

    await this.enter({
      view,
      stage: 'confirm',
      sizePct: this.deps.config.bot.decision.confirmSizePctOfEquity,
      confidence,
      clusterId: deployerScore.clusterId,
      reason:
        `confirm: ${signal.uniqueBuyerCount} independent buyers, ` +
        `concentration ${signal.concentrationScore.toFixed(2)}`,
    });

    this.confirmed.add(token);
    this.stats.confirmEntries += 1;
  }

  /* ------------------------------ sizing ------------------------------- */

  private async enter(params: {
    view: LaunchView;
    stage: EntryStage;
    sizePct: number;
    confidence: ReturnType<DecisionEngine['combine']>;
    clusterId: string;
    reason: string;
  }): Promise<void> {
    const { view, stage, confidence } = params;
    const equityUsd = this.deps.ledger.equityUsd();

    // Confidence scales the size continuously. A marginal signal gets a marginal
    // position; nothing about this is a flat bet.
    const requestedUsd = equityUsd * params.sizePct * confidence.combined;

    const verdict = this.deps.risk.checkEntry({
      requestedUsd,
      quoteAsset: view.quoteAsset,
      clusterId: params.clusterId,
    });
    if (!verdict.allowed) {
      return this.reject(view.tokenAddress, stage, `risk: ${verdict.reasons.join(', ')}`);
    }

    const amount = this.deps.oracle.fromUsd(Number(verdict.permittedAmount), view.quoteAsset);
    if (amount == null || amount <= 0n) {
      return this.reject(view.tokenAddress, stage, 'could not size the order in the quote asset');
    }

    const intent = this.deps.execution.buildIntent({
      side: 'buy',
      stage,
      tokenAddress: view.tokenAddress as never,
      curveAddress: view.curveAddress as never,
      poolAddress: null,
      venue: 'curve',
      quoteAsset: view.quoteAsset,
      amount: amount.toString(),
      maxSlippageBps: this.deps.config.bot.decision.maxSlippageBps,
      reason: params.reason,
      confidence,
    });

    this.deps.bus.publish('trade.intent', intent);

    // Pin before executing so eviction cannot blind the exit engine to a token the
    // ledger is about to hold.
    this.deps.pin(view.tokenAddress);

    const result = await this.deps.execution.execute(intent, {
      stage,
      reason: null,
      positionId: null,
      ladderStep: null,
    });

    if (!result) return this.reject(view.tokenAddress, stage, 'execution declined the order');

    this.deps.risk.recordTrade();
  }

  /**
   * Weighted geometric mean. A zero in any component drives the result to zero, which is
   * the intended behaviour: no amount of deployer pedigree should buy into demand that
   * looks manufactured.
   */
  private combine(components: {
    deployer: number;
    authenticity: number;
    demandVelocity: number;
    graduationProximity: number;
  }): {
    deployer: number;
    authenticity: number;
    demandVelocity: number;
    graduationProximity: number;
    combined: number;
  } {
    const w = this.deps.config.bot.decision.weights;
    // Floored just above zero so a single missing component degrades the score sharply
    // without making the whole product identically zero and unrankable.
    const floor = (v: number): number => Math.max(0.01, clamp01(v));

    const combined =
      floor(components.deployer) ** w.deployer *
      floor(components.authenticity) ** w.authenticity *
      floor(components.demandVelocity) ** w.demandVelocity *
      floor(components.graduationProximity) ** w.graduationProximity;

    return { ...components, combined: clamp01(combined) };
  }

  /**
   * Demand velocity from distinct buyers per minute.
   *
   * The spec suggests a public watcher-count proxy such as GMGN, which has no confirmed
   * coverage of this chain. Unique-buyer velocity is measured directly from the curve's
   * own trade events, which is both available and harder to fake than a watcher count.
   */
  private demandComponent(signal: WalletSignal): number {
    const target = this.deps.config.bot.walletTracker.minUniqueBuyerVelocity * 2;
    return clamp01(signal.uniqueBuyerVelocity / target);
  }

  /**
   * Graduation proximity as a signal in its own right.
   *
   * Reaching the threshold is structurally meaningful, not just another price tick: the
   * curve is swept into a permanently locked Uniswap v4 pool, so real liquidity is about
   * to exist where there was none. Approaching it is therefore worth paying up for — but
   * only up to a point, because past the entry band the move has already happened and
   * the curve is about to stop accepting sells.
   */
  private proximityComponent(progress: number): number {
    const { minGraduationProgress, maxGraduationProgress } = this.deps.config.bot.decision;
    if (progress <= minGraduationProgress) return 0.1;
    if (progress >= maxGraduationProgress) return 0.2;
    const span = maxGraduationProgress - minGraduationProgress;
    return clamp01(0.2 + 0.8 * ((progress - minGraduationProgress) / span));
  }
}
