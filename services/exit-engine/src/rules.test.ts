import { describe, expect, it } from 'vitest';
import { loadConfig, type BotConfig } from '@rhc/core';
import type { Position } from '@rhc/types';
import {
  evaluateDepthAwareStop,
  evaluateGraduationTrim,
  evaluateTakeProfit,
  evaluateTimeout,
  evaluateTrailingStop,
  noiseFloorPct,
  trailingStopPct,
  GRADUATION_TRIM_STEP,
} from './rules.js';

// The shipped config is the subject: a rule that only behaves under invented thresholds
// is not evidence about the bot anyone will actually run.
const shipped = loadConfig().bot;

function config(exit: Partial<BotConfig['exit']> = {}): BotConfig {
  return { ...shipped, exit: { ...shipped.exit, ...exit } };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: 'pos_test',
    tokenAddress: '0x1111111111111111111111111111111111111111',
    curveAddress: '0x2222222222222222222222222222222222222222',
    poolAddress: null,
    symbol: 'TEST',
    venue: 'curve',
    phase: 'curve',
    quoteAsset: {
      symbol: 'ETH',
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      isNative: true,
      graduationThreshold: '4200000000000000000',
      phantomQuote: null,
    },
    mode: 'paper',
    status: 'open',
    stage: 'scout',
    quoteInvested: '1000000000000000000',
    tokensHeld: '1000000000000000000000',
    averageEntryPrice: '1000000000000000',
    lastPrice: '1000000000000000',
    markPrice: '1000000000000000',
    peakMultiple: 1,
    realizedPnlQuote: '0',
    unrealizedPnlQuote: '0',
    ladderStepsFilled: [],
    openedAt: 1_000_000,
    closedAt: null,
    exitReason: null,
    fills: [],
    ...overrides,
  };
}

describe('take-profit ladder', () => {
  const ladder = [
    { multiple: 2, fraction: 0.3 },
    { multiple: 3.5, fraction: 0.3 },
    { multiple: 6, fraction: 0.25 },
    { multiple: 12, fraction: 0.25 },
  ];
  const cfg = config({ takeProfitLadder: ladder });

  it('does not fire below the first rung', () => {
    expect(evaluateTakeProfit(cfg, position(), 1.9)).toBeNull();
  });

  it('fires the first rung on reaching it', () => {
    const decision = evaluateTakeProfit(cfg, position(), 2);
    expect(decision).toMatchObject({ reason: 'take-profit-ladder', ladderStep: 0, fraction: 0.3 });
  });

  it('settles on the highest rung reached rather than dribbling out one per tick', () => {
    // A violent move straight past three rungs should sell at the top one, not repeatedly
    // sell 30% on the way up after the move has already happened.
    const decision = evaluateTakeProfit(cfg, position(), 7);
    expect(decision).toMatchObject({ ladderStep: 2, fraction: 0.25 });
  });

  it('never re-fires a rung that already sold', () => {
    const held = position({ ladderStepsFilled: [0, 1, 2] });
    expect(evaluateTakeProfit(cfg, held, 7)).toBeNull();
  });

  it('falls back to the highest unfilled rung below the current multiple', () => {
    const held = position({ ladderStepsFilled: [2] });
    expect(evaluateTakeProfit(cfg, held, 7)).toMatchObject({ ladderStep: 1 });
  });

  it('fires immediately, without waiting for the move to persist', () => {
    // Confirming a favourable move only gives it time to retrace.
    expect(evaluateTakeProfit(cfg, position(), 2)?.requiresPersistence).toBe(false);
  });

  it('sells a fraction of the remainder, never the whole position', () => {
    for (let step = 0; step < ladder.length; step++) {
      const decision = evaluateTakeProfit(cfg, position({ ladderStepsFilled: [] }), ladder[step]!.multiple);
      expect(decision!.fraction).toBeLessThan(1);
    }
  });
});

describe('trailing stop', () => {
  const cfg = config({
    trailingStopBasePct: 22,
    trailingStopWidenPerMultiple: 4,
    maxTrailingStopPct: 55,
  });

  it('widens as the run grows', () => {
    // A trail tight enough to protect a 2x would cut a 20x out on an ordinary pullback.
    expect(trailingStopPct(cfg, 1)).toBe(22);
    expect(trailingStopPct(cfg, 3)).toBe(30);
    expect(trailingStopPct(cfg, 6)).toBe(42);
  });

  it('caps the widening', () => {
    expect(trailingStopPct(cfg, 100)).toBe(55);
  });

  it('never narrows below the base for a position under water', () => {
    expect(trailingStopPct(cfg, 0.2)).toBe(22);
  });

  it('stays silent until the position has actually run', () => {
    // Below the activation peak the hard stop governs; trailing off a 1.05x peak would
    // exit on noise.
    expect(evaluateTrailingStop(cfg, position({ peakMultiple: 1.1 }), 0.9)).toBeNull();
  });

  it('fires once price falls through the trail from the peak', () => {
    // Peak 3x, trail 30% -> trigger at 2.1x.
    const held = position({ peakMultiple: 3 });
    expect(evaluateTrailingStop(cfg, held, 2.2)).toBeNull();
    expect(evaluateTrailingStop(cfg, held, 2.05)).toMatchObject({ reason: 'trailing-stop', fraction: 1 });
  });

  it('requires the move to persist before acting', () => {
    const decision = evaluateTrailingStop(cfg, position({ peakMultiple: 3 }), 2);
    expect(decision?.requiresPersistence).toBe(true);
  });

  it('lets a big run pull back further than a small one before stopping out', () => {
    // 20x peak with a 55% trail survives a drop to 9x; a 2x peak with a 26% trail does
    // not survive the equivalent proportional move.
    expect(evaluateTrailingStop(cfg, position({ peakMultiple: 20 }), 10)).toBeNull();
    expect(evaluateTrailingStop(cfg, position({ peakMultiple: 2 }), 1)).not.toBeNull();
  });
});

describe('noise floor', () => {
  const cfg = config({
    depthStopImpactMultiplier: 1.5,
    depthStopMinPct: 18,
    depthStopMaxPct: 45,
  });

  it('takes the larger of our own impact and a reference trade', () => {
    // 3000 bps = 30%, times 1.5 = 45%, capped at 45.
    expect(noiseFloorPct(cfg, 3_000, 100)).toBe(45);
    expect(noiseFloorPct(cfg, 100, 3_000)).toBe(45);
  });

  it('floors at the configured minimum when both impacts are negligible', () => {
    // This is the regression that matters: with a small position in a deep curve, own
    // impact rounds to nearly nothing. Without a floor the "depth-aware" stop collapses
    // into a flat few-percent stop that no meme launch survives.
    expect(noiseFloorPct(cfg, 0, 0)).toBe(18);
    expect(noiseFloorPct(cfg, 5, 5)).toBe(18);
  });

  it('caps at the configured maximum', () => {
    expect(noiseFloorPct(cfg, 100_000, 100_000)).toBe(45);
  });

  it('scales between the bounds with curve depth', () => {
    // 1600 bps = 16%, times 1.5 = 24%, inside [18, 45].
    expect(noiseFloorPct(cfg, 0, 1_600)).toBeCloseTo(24, 6);
  });
});

describe('depth-aware stop', () => {
  const cfg = config({
    hardStopPct: 35,
    depthStopImpactMultiplier: 1.5,
    depthStopMinPct: 18,
    depthStopMaxPct: 45,
  });

  it('ignores a position in profit', () => {
    expect(evaluateDepthAwareStop(cfg, position(), 1.5, 0, 0)).toBeNull();
  });

  it('holds through a drawdown that one ordinary sell explains', () => {
    // 10% down, on a curve where a reference trade moves it 16%: noise.
    expect(evaluateDepthAwareStop(cfg, position(), 0.9, 0, 1_600)).toBeNull();
  });

  it('fires once the drawdown is deeper than single-wallet selling explains', () => {
    // 30% down against a 24% floor: real selling pressure.
    const decision = evaluateDepthAwareStop(cfg, position(), 0.7, 0, 1_600);
    expect(decision).toMatchObject({ reason: 'curve-depth-stop', fraction: 1, requiresPersistence: true });
  });

  it('escalates to the hard stop regardless of curve depth', () => {
    // Even where the curve is thin enough to explain a 45% move, the hard stop wins:
    // it is a bound on loss, not a read on liquidity.
    const decision = evaluateDepthAwareStop(cfg, position(), 0.6, 0, 100_000);
    expect(decision).toMatchObject({ reason: 'hard-stop', fraction: 1 });
  });

  it('tolerates a deeper drawdown on a thin curve than on a deep one', () => {
    // Same 25% drawdown, two curves. This is the property a raw percentage stop cannot
    // express, and the reason the stop is computed from reserves.
    const thinCurveReferenceImpact = 2_000;
    const deepCurveReferenceImpact = 400;

    expect(evaluateDepthAwareStop(cfg, position(), 0.75, 0, thinCurveReferenceImpact)).toBeNull();
    expect(evaluateDepthAwareStop(cfg, position(), 0.75, 0, deepCurveReferenceImpact)).toMatchObject({
      reason: 'curve-depth-stop',
    });
  });
});

describe('graduation trim', () => {
  const cfg = config({
    graduationProximityTrim: { enabled: true, progressThreshold: 0.92, fraction: 0.25 },
  });

  it('stays silent well before the threshold', () => {
    expect(evaluateGraduationTrim(cfg, position(), 0.5)).toBeNull();
  });

  it('trims as the curve approaches the sweep', () => {
    // The curve stops accepting sells at the sweep, so a position still on it becomes
    // unsellable. Taking some off beforehand is the only protection available.
    const decision = evaluateGraduationTrim(cfg, position(), 0.95);
    expect(decision).toMatchObject({
      reason: 'graduation-exit',
      fraction: 0.25,
      ladderStep: GRADUATION_TRIM_STEP,
      requiresPersistence: false,
    });
  });

  it('trims only once', () => {
    const trimmed = position({ ladderStepsFilled: [GRADUATION_TRIM_STEP] });
    expect(evaluateGraduationTrim(cfg, trimmed, 0.99)).toBeNull();
  });

  it('uses a reserved step index that cannot collide with a ladder rung', () => {
    expect(GRADUATION_TRIM_STEP).toBeGreaterThan(shipped.exit.takeProfitLadder.length);
  });

  it('can be turned off', () => {
    const off = config({ graduationProximityTrim: { enabled: false, progressThreshold: 0.92, fraction: 0.25 } });
    expect(evaluateGraduationTrim(off, position(), 0.99)).toBeNull();
  });
});

describe('max-hold timeout', () => {
  const cfg = config({ maxHoldSeconds: 5_400 });
  const openedAt = 1_000_000;

  it('holds a position inside the window', () => {
    expect(evaluateTimeout(cfg, position({ openedAt }), openedAt + 5_399_000)).toBeNull();
  });

  it('frees the slot once the window elapses', () => {
    const decision = evaluateTimeout(cfg, position({ openedAt }), openedAt + 5_400_000);
    expect(decision).toMatchObject({ reason: 'timeout', fraction: 1, requiresPersistence: false });
  });
});
