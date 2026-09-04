import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInProcessBus, loadConfig, type AppConfig } from '@rhc/core';
import type { QuoteAsset } from '@rhc/types';
import { RiskManager, type RiskContext } from './index.js';

const ETH: QuoteAsset = {
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  isNative: true,
  graduationThreshold: '4200000000000000000',
  phantomQuote: null,
};

let tempDir: string;

/** Mutable stand-in for the ledger, so a test can move equity and exposure directly. */
class FakeContext implements RiskContext {
  equity = 1_000;
  positions = 0;
  exposure = 0;

  equityUsd(): number {
    return this.equity;
  }
  openPositionCount(): number {
    return this.positions;
  }
  totalExposureUsd(): number {
    return this.exposure;
  }
}

function build(overrides: Partial<AppConfig['bot']['risk']> = {}) {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    bot: {
      ...base.bot,
      risk: {
        ...base.bot.risk,
        killSwitchFile: join(tempDir, 'KILL'),
        ...overrides,
      },
    },
  };

  const context = new FakeContext();
  const bus = createInProcessBus({ bufferSize: 32 });
  const risk = new RiskManager(config, context, bus);
  risk.initialise();
  return { risk, context, config, bus };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rhc-risk-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('position sizing', () => {
  it('approves a request inside every limit', () => {
    const { risk } = build({ maxPositionSizeUsd: 60 });
    const verdict = risk.checkEntry({ requestedUsd: 25, quoteAsset: ETH, clusterId: null });

    expect(verdict.allowed).toBe(true);
    expect(Number(verdict.permittedAmount)).toBe(25);
  });

  it('clamps down to the max position size, and never up', () => {
    const { risk } = build({ maxPositionSizeUsd: 60 });
    const verdict = risk.checkEntry({ requestedUsd: 500, quoteAsset: ETH, clusterId: null });

    expect(verdict.allowed).toBe(true);
    expect(Number(verdict.permittedAmount)).toBe(60);
    expect(verdict.reasons.join(' ')).toMatch(/max position size/);
  });

  it('clamps to remaining exposure headroom', () => {
    // 35% of $1,000 equity is $350 of allowed exposure; $300 is already committed.
    const { risk, context } = build({ maxPositionSizeUsd: 200, maxTotalExposurePct: 0.35 });
    context.exposure = 300;

    const verdict = risk.checkEntry({ requestedUsd: 200, quoteAsset: ETH, clusterId: null });
    expect(verdict.allowed).toBe(true);
    expect(Number(verdict.permittedAmount)).toBeCloseTo(50, 6);
    expect(verdict.reasons.join(' ')).toMatch(/exposure headroom/);
  });

  it('refuses once the exposure cap is exhausted', () => {
    const { risk, context } = build({ maxTotalExposurePct: 0.35 });
    context.exposure = 350;

    const verdict = risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.permittedAmount).toBe('0');
  });

  it('refuses a size the fees would dominate', () => {
    const { risk, context } = build({ maxTotalExposurePct: 0.35 });
    context.exposure = 349.5;

    const verdict = risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/\$1 minimum/);
  });
});

describe('concurrency and trade caps', () => {
  it('refuses a new entry at the concurrent position limit', () => {
    const { risk, context } = build({ maxConcurrentPositions: 5 });
    context.positions = 5;

    const verdict = risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/max concurrent positions/);
  });

  it('refuses once the daily trade cap is hit', () => {
    const { risk } = build({ maxTradesPerDay: 3 });
    for (let i = 0; i < 3; i++) risk.recordTrade();

    const verdict = risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/daily trade cap/);
  });
});

describe('daily loss circuit breaker', () => {
  it('halts new entries once the limit is breached', () => {
    const { risk, context } = build({ dailyLossLimitPct: 15 });
    context.equity = 840; // -16% from the $1,000 day start.

    const verdict = risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/daily loss limit/);
    expect(risk.state().halted).toBe(true);
  });

  it('trips on its own from the mark-refresh tick, without waiting for an entry', () => {
    const { risk, context } = build({ dailyLossLimitPct: 15 });
    context.equity = 800;
    risk.tick();

    expect(risk.state().halted).toBe(true);
  });

  it('refuses to resume back into a live breach', () => {
    // Resuming here would undo the one control designed to survive a bad run.
    const { risk, context } = build({ dailyLossLimitPct: 15 });
    context.equity = 800;
    risk.tick();

    risk.resume();
    expect(risk.state().halted).toBe(true);
  });

  it('resumes once equity has recovered above the limit', () => {
    const { risk, context } = build({ dailyLossLimitPct: 15 });
    context.equity = 800;
    risk.tick();

    context.equity = 950;
    risk.resume();
    expect(risk.state().halted).toBe(false);
  });

  it('tracks peak-to-trough drawdown across the run', () => {
    const { risk, context } = build({ dailyLossLimitPct: 90 });

    context.equity = 1_200;
    risk.tick();
    context.equity = 900; // 25% off the 1,200 peak.
    risk.tick();
    context.equity = 1_100;
    risk.tick();

    expect(risk.peakDrawdownPct).toBeCloseTo(25, 6);
  });
});

describe('kill switch', () => {
  it('is a file on disk, so it works when the process is wedged', () => {
    const { risk, config } = build();
    expect(risk.killSwitchEngaged).toBe(false);

    writeFileSync(config.bot.risk.killSwitchFile, 'engaged\n');

    expect(risk.killSwitchEngaged).toBe(true);
    expect(risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null }).allowed).toBe(false);
    expect(risk.state().halted).toBe(true);
    expect(risk.state().haltReason).toBe('kill switch engaged');
  });

  it('takes precedence over every other check', () => {
    const { risk, config, context } = build();
    context.positions = 0;
    context.exposure = 0;
    writeFileSync(config.bot.risk.killSwitchFile, 'engaged\n');

    const verdict = risk.checkEntry({ requestedUsd: 1, quoteAsset: ETH, clusterId: null });
    expect(verdict.reasons).toEqual(['kill switch engaged']);
  });
});

describe('manual pause', () => {
  it('blocks entries until resumed', () => {
    const { risk } = build();
    risk.pause('paused by operator');

    expect(risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null }).allowed).toBe(false);

    risk.resume();
    expect(risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: null }).allowed).toBe(true);
  });
});

describe('cluster cooldown', () => {
  it('refuses further entries from a cluster that just lost', () => {
    const { risk } = build({ clusterCooldownSeconds: 1_800 });
    risk.penaliseCluster('fund:0xabc');

    const blocked = risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: 'fund:0xabc' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(' ')).toMatch(/cluster in cooldown/);
  });

  it('leaves other clusters alone', () => {
    const { risk } = build({ clusterCooldownSeconds: 1_800 });
    risk.penaliseCluster('fund:0xabc');

    expect(risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: 'fund:0xdef' }).allowed).toBe(true);
  });

  it('expires the cooldown', () => {
    const { risk } = build({ clusterCooldownSeconds: 0 });
    risk.penaliseCluster('fund:0xabc');

    expect(risk.checkEntry({ requestedUsd: 10, quoteAsset: ETH, clusterId: 'fund:0xabc' }).allowed).toBe(true);
  });
});

describe('exits are never blocked', () => {
  it('gates entries only', () => {
    // The risk manager has no say over sells by construction: refusing to sell during a
    // drawdown turns a bad day into an unrecoverable one. This asserts the API shape
    // that makes that true — there is no checkExit to call.
    const { risk } = build();
    expect('checkExit' in risk).toBe(false);
  });
});
