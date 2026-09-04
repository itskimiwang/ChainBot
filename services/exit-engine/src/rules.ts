import type { BotConfig } from '@rhc/core';
import type { ExitReason, Position } from '@rhc/types';

export interface ExitDecision {
  reason: ExitReason;
  /** Fraction of the *remaining* position to sell. */
  fraction: number;
  ladderStep: number | null;
  detail: string;
  /** Stops must persist; take-profits fire immediately. */
  requiresPersistence: boolean;
}

/**
 * Take-profit ladder.
 *
 * Rungs sell a fixed share of what remains at each multiple, so the position is scaled
 * out rather than exited at one guessed top. Each rung fires at most once, tracked on
 * the position itself so a restart cannot re-fire a rung that already sold.
 */
export function evaluateTakeProfit(
  config: BotConfig,
  position: Position,
  currentMultiple: number,
): ExitDecision | null {
  const ladder = config.exit.takeProfitLadder;

  // Walk from the top so a violent move straight past several rungs settles on the
  // highest one reached rather than dribbling out one rung per refresh tick.
  for (let step = ladder.length - 1; step >= 0; step--) {
    const rung = ladder[step]!;
    if (position.ladderStepsFilled.includes(step)) continue;
    if (currentMultiple < rung.multiple) continue;

    return {
      reason: 'take-profit-ladder',
      fraction: rung.fraction,
      ladderStep: step,
      detail: `hit ${rung.multiple}x, selling ${Math.round(rung.fraction * 100)}% of the remainder`,
      requiresPersistence: false,
    };
  }
  return null;
}

/**
 * Trailing stop that widens with the run.
 *
 * A fixed trail that is tight enough to protect a 2x will cut a 20x out on an ordinary
 * pullback, because volatility scales with the size of the move. The trail therefore
 * loosens as the peak multiple grows, up to a cap.
 */
export function trailingStopPct(config: BotConfig, peakMultiple: number): number {
  const { trailingStopBasePct, trailingStopWidenPerMultiple, maxTrailingStopPct } = config.exit;
  const widened = trailingStopBasePct + trailingStopWidenPerMultiple * Math.max(0, peakMultiple - 1);
  return Math.min(maxTrailingStopPct, widened);
}

export function evaluateTrailingStop(
  config: BotConfig,
  position: Position,
  currentMultiple: number,
): ExitDecision | null {
  // Only trail once the position has actually run; below entry the hard stop governs.
  if (position.peakMultiple <= 1.2) return null;

  const trailPct = trailingStopPct(config, position.peakMultiple);
  const triggerMultiple = position.peakMultiple * (1 - trailPct / 100);
  if (currentMultiple > triggerMultiple) return null;

  return {
    reason: 'trailing-stop',
    fraction: 1,
    ladderStep: null,
    detail:
      `fell to ${currentMultiple.toFixed(2)}x from a peak of ${position.peakMultiple.toFixed(2)}x ` +
      `(trail ${trailPct.toFixed(0)}%)`,
    requiresPersistence: true,
  };
}

/**
 * Liquidity-aware stop.
 *
 * A raw percentage stop is the wrong instrument on a bonding curve, because price impact
 * there is mechanically determined by the reserve balance: on a thin curve a single
 * ordinary-sized sell moves the price further than a "crash" would on a deep one, and a
 * percentage stop cannot tell those apart.
 *
 * So the drawdown is compared against `impactBpsOfOwnSize` — the impact one sell the
 * size of our own position would produce at the curve's current depth. A drawdown within
 * that is one wallet's noise and is ignored. A drawdown beyond it means more selling
 * arrived than any single participant our size could explain, which is the thing worth
 * stopping on.
 *
 * Post-graduation the same logic applies against Uniswap v4 pool depth.
 */
export function evaluateDepthAwareStop(
  config: BotConfig,
  position: Position,
  currentMultiple: number,
  impactBpsOfOwnSize: number,
): ExitDecision | null {
  const drawdownPct = (1 - currentMultiple) * 100;
  if (drawdownPct <= 0) return null;

  if (drawdownPct >= config.exit.hardStopPct) {
    return {
      reason: 'hard-stop',
      fraction: 1,
      ladderStep: null,
      detail: `down ${drawdownPct.toFixed(1)}% from entry, past the ${config.exit.hardStopPct}% hard stop`,
      requiresPersistence: true,
    };
  }

  // Impact is in bps of price; the drawdown is a percentage. Convert and add a margin so
  // the stop is not triggered by exactly the move our own exit would cause.
  const ownImpactPct = impactBpsOfOwnSize / 100;
  const noiseFloorPct = Math.max(5, ownImpactPct * 1.5);

  if (drawdownPct > noiseFloorPct) {
    return {
      reason: 'curve-depth-stop',
      fraction: 1,
      ladderStep: null,
      detail:
        `down ${drawdownPct.toFixed(1)}%, deeper than the ${noiseFloorPct.toFixed(1)}% a single ` +
        'sell our own size could explain at current curve depth',
      requiresPersistence: true,
    };
  }

  return null;
}

/**
 * Trim into graduation. The curve stops accepting sells at the sweep — before the
 * factory reports a new phase — so a position still on the curve at that moment is
 * stranded until the v4 route exists. Taking some off beforehand is cheap insurance.
 */
export function evaluateGraduationTrim(
  config: BotConfig,
  position: Position,
  progress: number,
): ExitDecision | null {
  const trim = config.exit.graduationProximityTrim;
  if (!trim.enabled) return null;
  if (progress < trim.progressThreshold) return null;
  if (position.ladderStepsFilled.includes(GRADUATION_TRIM_STEP)) return null;

  return {
    reason: 'graduation-exit',
    fraction: trim.fraction,
    ladderStep: GRADUATION_TRIM_STEP,
    detail: `curve ${(progress * 100).toFixed(1)}% to graduation; trimming before the sweep closes sells`,
    requiresPersistence: false,
  };
}

export function evaluateTimeout(config: BotConfig, position: Position, now: number): ExitDecision | null {
  const heldSeconds = (now - position.openedAt) / 1000;
  if (heldSeconds < config.exit.maxHoldSeconds) return null;

  return {
    reason: 'timeout',
    fraction: 1,
    ladderStep: null,
    detail: `held ${Math.round(heldSeconds / 60)}m without resolving; freeing the position slot`,
    requiresPersistence: false,
  };
}

/** Reserved ladder index for the graduation trim, so it cannot collide with a rung. */
export const GRADUATION_TRIM_STEP = 9_000;
