import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@rhc/core';
import type { Position } from '@rhc/types';
import { evaluateRun } from './evaluation.js';

const HOUR = 3_600_000;

function config(overrides: Partial<AppConfig['bot']['evaluation']> = {}): AppConfig {
  const base = loadConfig();
  return { ...base, bot: { ...base.bot, evaluation: { ...base.bot.evaluation, ...overrides } } };
}

function closed(realizedPnlQuote: string): Position {
  return {
    positionId: `pos_${Math.random()}`,
    tokenAddress: '0x1111111111111111111111111111111111111111',
    curveAddress: null,
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
    status: 'closed',
    stage: 'scout',
    quoteInvested: '0',
    tokensHeld: '0',
    averageEntryPrice: '1',
    lastPrice: '1',
    markPrice: '1',
    peakMultiple: 1,
    realizedPnlQuote,
    unrealizedPnlQuote: '0',
    ladderStepsFilled: [],
    openedAt: 0,
    closedAt: 1,
    exitReason: 'take-profit-ladder',
    fills: [],
  };
}

/** A run that clears every gate, so each test can break exactly one thing. */
function passingRun(overrides: Partial<Parameters<typeof evaluateRun>[0]> = {}) {
  const wins = Array.from({ length: 24 }, () => closed('100'));
  const losses = Array.from({ length: 16 }, () => closed('-50'));

  return evaluateRun({
    config: config({
      windowHours: 48,
      minTrades: 30,
      minWinRate: 0.4,
      maxDrawdownPct: 20,
      minNetPnlPct: 5,
      maxHoneypotEntryRate: 0.02,
      maxStrandedRate: 0.05,
    }),
    startedAt: Date.now() - 49 * HOUR,
    startingEquityUsd: 1_000,
    currentEquityUsd: 1_100,
    maxDrawdownPct: 8,
    closedPositions: [...wins, ...losses],
    honeypotEntries: 0,
    strandedPositions: 0,
    ...overrides,
  });
}

describe('go/no-go gate', () => {
  it('returns go only when every criterion is met', () => {
    const report = passingRun();
    expect(report.criteria.every((c) => c.met)).toBe(true);
    expect(report.verdict).toBe('go');
  });

  it('is never a go before the window completes, however good the run looks', () => {
    // The whole point of writing the criteria down beforehand is that a green P&L on day
    // one cannot end the evaluation early.
    const report = passingRun({ startedAt: Date.now() - 2 * HOUR });
    expect(report.windowComplete).toBe(false);
    expect(report.verdict).toBe('in-progress');
  });

  it('fails on too few observed trades', () => {
    const report = passingRun({ closedPositions: [closed('100'), closed('100')] });
    expect(report.criteria.find((c) => c.id === 'trades')?.met).toBe(false);
    expect(report.verdict).toBe('no-go');
  });

  it('fails on a win rate below the floor', () => {
    const report = passingRun({
      closedPositions: [
        ...Array.from({ length: 10 }, () => closed('100')),
        ...Array.from({ length: 30 }, () => closed('-50')),
      ],
    });
    expect(report.winRate).toBeCloseTo(0.25, 6);
    expect(report.criteria.find((c) => c.id === 'winRate')?.met).toBe(false);
    expect(report.verdict).toBe('no-go');
  });

  it('fails on drawdown even when the run finished profitable', () => {
    // A run that made money by surviving a 30% hole is not a run to put capital behind.
    const report = passingRun({ maxDrawdownPct: 30 });
    expect(report.criteria.find((c) => c.id === 'drawdown')?.met).toBe(false);
    expect(report.verdict).toBe('no-go');
  });

  it('fails on net P&L below the floor', () => {
    const report = passingRun({ currentEquityUsd: 1_010 });
    expect(report.netPnlPct).toBeCloseTo(1, 6);
    expect(report.criteria.find((c) => c.id === 'pnl')?.met).toBe(false);
  });

  it('fails when vetting let honeypots through, regardless of P&L', () => {
    // This is a filter-quality gate, not a profit one: entering unsellable tokens and
    // getting away with it is luck, not a working pipeline.
    const report = passingRun({ honeypotEntries: 5 });
    expect(report.criteria.find((c) => c.id === 'honeypots')?.met).toBe(false);
    expect(report.verdict).toBe('no-go');
  });

  it('fails when too many positions were stranded by graduation', () => {
    const report = passingRun({ strandedPositions: 10 });
    expect(report.criteria.find((c) => c.id === 'stranded')?.met).toBe(false);
    expect(report.verdict).toBe('no-go');
  });

  it('measures the stranded rate over every terminal position, not just closed ones', () => {
    // A stranding never becomes a closed trade, so dividing by closed trades alone would
    // let the rate fall as strandings piled up.
    const report = passingRun({ strandedPositions: 10 });
    expect(report.strandedRate).toBeCloseTo(10 / 50, 6);
  });

  it('reports zero rates on a run with no trades rather than dividing by zero', () => {
    const report = passingRun({ closedPositions: [], honeypotEntries: 0, strandedPositions: 0 });
    expect(report.winRate).toBe(0);
    expect(report.honeypotEntryRate).toBe(0);
    expect(report.strandedRate).toBe(0);
    expect(Number.isNaN(report.netPnlPct)).toBe(false);
  });

  it('states both the target and the observed value for every criterion', () => {
    // The report has to be readable as a decision record after the fact, not just a
    // pass/fail bit.
    for (const criterion of passingRun().criteria) {
      expect(criterion.target).toBeTruthy();
      expect(criterion.actual).toBeTruthy();
      expect(criterion.label).toBeTruthy();
    }
  });
});
