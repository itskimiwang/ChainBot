import type { AppConfig } from '@rhc/core';
import type { Position } from '@rhc/types';

export interface Criterion {
  id: string;
  label: string;
  /** What the config demands. */
  target: string;
  /** What the run actually produced. */
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
  criteria: Criterion[];
  verdict: 'go' | 'no-go' | 'in-progress';
}

/**
 * Go/no-go evaluation for the paper-to-live flip.
 *
 * The criteria come from config, which is the entire point: they are written down before
 * the run starts, so the decision is a lookup rather than a judgement call made while
 * looking at a green P&L. This report deliberately produces a bare verdict with no
 * softening language — "in-progress" until the window is complete, then "go" only if
 * every criterion is met.
 *
 * Nothing here flips the mode. It reports; a human still has to change the config and
 * restart, which is the last place a deliberate pause is worth more than automation.
 */
export function evaluateRun(params: {
  config: AppConfig;
  startedAt: number;
  startingEquityUsd: number;
  currentEquityUsd: number;
  maxDrawdownPct: number;
  closedPositions: Position[];
  /** Entries that vetting should have caught. Measures filter quality, not P&L. */
  honeypotEntries: number;
}): EvaluationReport {
  const { config, startedAt, startingEquityUsd, currentEquityUsd, closedPositions } = params;
  const gates = config.bot.evaluation;

  const elapsedHours = (Date.now() - startedAt) / 3_600_000;
  const windowComplete = elapsedHours >= gates.windowHours;

  const trades = closedPositions.length;
  const wins = closedPositions.filter((p) => Number(p.realizedPnlQuote) > 0).length;
  const losses = trades - wins;
  const winRate = trades > 0 ? wins / trades : 0;

  const netPnlUsd = currentEquityUsd - startingEquityUsd;
  const netPnlPct = startingEquityUsd > 0 ? (netPnlUsd / startingEquityUsd) * 100 : 0;
  const honeypotEntryRate = trades > 0 ? params.honeypotEntries / trades : 0;

  const criteria: Criterion[] = [
    {
      id: 'window',
      label: 'Evaluation window complete',
      target: `${gates.windowHours}h`,
      actual: `${elapsedHours.toFixed(1)}h`,
      met: windowComplete,
    },
    {
      id: 'trades',
      label: 'Closed trades observed',
      target: `>= ${gates.minTrades}`,
      actual: String(trades),
      met: trades >= gates.minTrades,
    },
    {
      id: 'winRate',
      label: 'Win rate',
      target: `>= ${(gates.minWinRate * 100).toFixed(0)}%`,
      actual: `${(winRate * 100).toFixed(1)}%`,
      met: winRate >= gates.minWinRate,
    },
    {
      id: 'drawdown',
      label: 'Max drawdown',
      target: `<= ${gates.maxDrawdownPct}%`,
      actual: `${params.maxDrawdownPct.toFixed(1)}%`,
      met: params.maxDrawdownPct <= gates.maxDrawdownPct,
    },
    {
      id: 'pnl',
      label: 'Net P&L',
      target: `>= ${gates.minNetPnlPct}%`,
      actual: `${netPnlPct.toFixed(2)}%`,
      met: netPnlPct >= gates.minNetPnlPct,
    },
    {
      id: 'honeypots',
      label: 'Entries into unsellable tokens',
      target: `<= ${(gates.maxHoneypotEntryRate * 100).toFixed(1)}%`,
      actual: `${(honeypotEntryRate * 100).toFixed(1)}%`,
      met: honeypotEntryRate <= gates.maxHoneypotEntryRate,
    },
  ];

  const allMet = criteria.every((c) => c.met);

  return {
    startedAt,
    elapsedHours,
    windowHours: gates.windowHours,
    windowComplete,
    trades,
    wins,
    losses,
    winRate,
    netPnlUsd,
    netPnlPct,
    maxDrawdownPct: params.maxDrawdownPct,
    honeypotEntryRate,
    criteria,
    // A run that has not finished its window is never a "go", however good it looks.
    verdict: !windowComplete ? 'in-progress' : allMet ? 'go' : 'no-go',
  };
}
