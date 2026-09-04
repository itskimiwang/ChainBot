import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInProcessBus, gini, loadConfig, type AppConfig, type MessageBus } from '@rhc/core';
import type { FundingAttribution, FundingSourceResolver } from '@rhc/deployer-graph';
import type { CurveTradeEvent } from '@rhc/types';
import { WalletTrackerService } from './service.js';

let tempDir: string;
let tracker: WalletTrackerService | null = null;

const TOKEN = '0xdead000000000000000000000000000000000001';

/** Resolver backed by a fixed map, so funding topology is stated per test. */
class StubResolver implements FundingSourceResolver {
  readonly name = 'stub';
  readonly available = true;
  constructor(private readonly funders: Record<string, { funder: string; outDegree: number }> = {}) {}

  async resolve(address: string): Promise<FundingAttribution> {
    const hit = this.funders[address.toLowerCase()];
    return {
      funder: hit?.funder ?? null,
      kind: hit ? 'wallet' : 'unknown',
      fundedAtMs: hit ? 1_700_000_000_000 : null,
      funderOutDegree: hit?.outDegree ?? null,
    };
  }
}

function build(
  overrides: Partial<AppConfig['bot']['walletTracker']> = {},
  resolver: FundingSourceResolver = new StubResolver(),
) {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    bot: {
      ...base.bot,
      walletTracker: {
        ...base.bot.walletTracker,
        dbPath: join(tempDir, 'wallet-tracker.sqlite'),
        ...overrides,
      },
    },
  };

  const bus: MessageBus = createInProcessBus({ bufferSize: 64 });
  tracker = new WalletTrackerService(config, resolver, bus, () => 0.1);
  tracker.start();
  return { tracker, bus, config };
}

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function buy(bus: MessageBus, from: string, quote: bigint, agoMs = 0): void {
  const event: CurveTradeEvent = {
    kind: 'curve-trade',
    launchpadId: 'pons-v2',
    tokenAddress: TOKEN as CurveTradeEvent['tokenAddress'],
    curveAddress: wallet(999) as CurveTradeEvent['curveAddress'],
    side: 'buy',
    trader: from as CurveTradeEvent['trader'],
    recipient: from as CurveTradeEvent['recipient'],
    quoteAmount: quote.toString(),
    tokenAmount: '1000000000000000000000',
    feePaid: '0',
    taxPaid: '0',
    curveReserve: '1000000000000000000',
    blockNumber: 1,
    txHash: `0x${'1'.repeat(64)}` as CurveTradeEvent['txHash'],
    timestamp: Date.now() - agoMs,
  };
  bus.publish('launch.trade', event);
}

/** Independent buyers, spread over a window long enough to clear `window-too-young`. */
function organicDemand(bus: MessageBus, count: number): void {
  for (let i = 0; i < count; i++) {
    buy(bus, wallet(i + 1), 10n ** 17n + BigInt(i) * 10n ** 15n, 30_000 - i * 400);
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rhc-wallet-'));
});

afterEach(() => {
  tracker?.stop();
  tracker = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('gini concentration', () => {
  it('is zero for a perfectly even distribution', () => {
    expect(gini([10, 10, 10, 10])).toBeCloseTo(0, 6);
  });

  it('approaches one as a single participant dominates', () => {
    expect(gini([1, 1, 1, 10_000])).toBeGreaterThan(0.7);
  });

  it('treats a lone buyer as maximally concentrated', () => {
    // One wallet is not a market, and scoring it as evenly distributed would let a
    // single actor look like organic demand.
    expect(gini([500])).toBe(1);
  });

  it('is unmoved by splitting one actor across many trades', () => {
    // Computed on per-wallet totals, so chopping a buy into pieces changes nothing.
    // This is the property that makes it wash-resistant.
    expect(gini([100, 100, 100])).toBeCloseTo(gini([100, 100, 100]), 6);
  });

  it('handles empty and non-positive input without producing NaN', () => {
    expect(gini([])).toBe(0);
    expect(gini([0, 0])).toBe(0);
    expect(gini([-5, -1])).toBe(0);
  });
});

describe('authenticity gate', () => {
  it('rejects a window with too few unique buyers', () => {
    const { tracker, bus } = build({ minUniqueBuyers: 12 });
    organicDemand(bus, 4);

    const signal = tracker.evaluate(TOKEN);
    expect(signal.uniqueBuyerCount).toBe(4);
    expect(signal.authentic).toBe(false);
    expect(signal.rejections).toContain('insufficient-unique-buyers');
  });

  it('accepts genuinely broad, independently funded demand', () => {
    const { tracker, bus } = build({ minUniqueBuyers: 12, minUniqueBuyerVelocity: 4 });
    organicDemand(bus, 20);

    const signal = tracker.evaluate(TOKEN);
    expect(signal.uniqueBuyerCount).toBe(20);
    expect(signal.rejections).toEqual([]);
    expect(signal.authentic).toBe(true);
    expect(signal.authenticityScore).toBeGreaterThan(0.4);
  });

  it('counts wallets rather than trades, so repeat buys do not manufacture breadth', () => {
    // 40 trades from 3 wallets is the shape wash volume takes.
    const { tracker, bus } = build({ minUniqueBuyers: 12 });
    for (let i = 0; i < 40; i++) buy(bus, wallet((i % 3) + 1), 10n ** 17n, 30_000 - i * 500);

    const signal = tracker.evaluate(TOKEN);
    expect(signal.uniqueBuyerCount).toBe(3);
    expect(signal.authentic).toBe(false);
    expect(signal.rejections).toContain('insufficient-unique-buyers');
  });

  it('rejects volume concentrated in one wallet even when buyer count clears', () => {
    const { tracker, bus } = build({ minUniqueBuyers: 5, maxConcentrationScore: 0.6 });
    organicDemand(bus, 10);
    buy(bus, wallet(1), 10n ** 21n, 5_000); // one whale dwarfing everyone

    const signal = tracker.evaluate(TOKEN);
    expect(signal.concentrationScore).toBeGreaterThan(0.6);
    expect(signal.rejections).toContain('holder-concentration-too-high');
    expect(signal.authentic).toBe(false);
  });

  it('rejects a window that is too young to have measured anything', () => {
    // Ten buyers in the same instant is not velocity, it is one transaction batch.
    const { tracker, bus } = build({ minUniqueBuyers: 5 });
    for (let i = 0; i < 10; i++) buy(bus, wallet(i + 1), 10n ** 17n, 0);

    expect(tracker.evaluate(TOKEN).rejections).toContain('window-too-young');
  });

  it('reports no demand at all as unauthentic rather than as clean', () => {
    const { tracker } = build();
    const signal = tracker.evaluate(TOKEN);

    expect(signal.uniqueBuyerCount).toBe(0);
    expect(signal.authentic).toBe(false);
    expect(signal.authenticityScore).toBe(0);
  });
});

describe('shared funding', () => {
  it('discounts buyers funded from the same pocket', async () => {
    // Eight wallets, all funded by one low-fanout source: one participant in costume.
    const funders: Record<string, { funder: string; outDegree: number }> = {};
    for (let i = 1; i <= 8; i++) funders[wallet(i)] = { funder: wallet(500), outDegree: 8 };

    const { tracker, bus } = build(
      { minUniqueBuyers: 5, maxSharedFundingVolumeShare: 0.4 },
      new StubResolver(funders),
    );

    organicDemand(bus, 8);
    await waitForFundingResolution();

    const signal = tracker.evaluate(TOKEN);
    expect(signal.sharedFundingVolumeShare).toBeGreaterThan(0.4);
    expect(signal.rejections).toContain('buyers-share-funding-source');
    expect(signal.authentic).toBe(false);
  });

  it('does not link wallets through a high-fanout funder', async () => {
    // An exchange hot wallet funds thousands of unrelated people. Treating that as
    // shared control would reject every token an exchange's users touched.
    const funders: Record<string, { funder: string; outDegree: number }> = {};
    for (let i = 1; i <= 20; i++) funders[wallet(i)] = { funder: wallet(500), outDegree: 5_000 };

    const { tracker, bus } = build(
      { minUniqueBuyers: 5, maxSharedFundingVolumeShare: 0.4 },
      new StubResolver(funders),
    );

    organicDemand(bus, 20);
    await waitForFundingResolution();

    const signal = tracker.evaluate(TOKEN);
    expect(signal.sharedFundingVolumeShare).toBe(0);
    expect(signal.rejections).not.toContain('buyers-share-funding-source');
  });

  it('caps confidence while funding is unresolved instead of scoring unknown as clean', async () => {
    // Treating "we don't know who funded these wallets" as independence is precisely
    // the hole a wash trader would drive through.
    const resolved = build({ minUniqueBuyers: 5 }, new StubResolver({}));
    organicDemand(resolved.bus, 20);
    const unresolvedSignal = resolved.tracker.evaluate(TOKEN);
    resolved.tracker.stop();
    tracker = null;

    expect(unresolvedSignal.authenticityScore).toBeLessThanOrEqual(0.6);
  });
});

/** The funding index resolves in the background; give its queue a turn to drain. */
async function waitForFundingResolution(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}
