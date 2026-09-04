import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInProcessBus, loadConfig, type AppConfig, type MessageBus } from '@rhc/core';
import type { GraduationEvent, NewLaunchEvent, QuoteAsset } from '@rhc/types';
import { HUB_OUT_DEGREE_THRESHOLD, type FundingAttribution, type FundingSourceResolver } from './funding-source.js';
import { DeployerGraphService } from './service.js';

let tempDir: string;
let graph: DeployerGraphService | null = null;

const ETH: QuoteAsset = {
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000000',
  decimals: 18,
  isNative: true,
  graduationThreshold: '4200000000000000000',
  phantomQuote: null,
};

class StubResolver implements FundingSourceResolver {
  readonly name = 'stub';
  readonly available = true;
  constructor(private readonly funders: Record<string, { funder: string; outDegree: number }> = {}) {}

  async resolve(address: string): Promise<FundingAttribution> {
    const hit = this.funders[address.toLowerCase()];
    return {
      funder: hit?.funder ?? null,
      kind: hit ? (hit.outDegree >= HUB_OUT_DEGREE_THRESHOLD ? 'cex' : 'wallet') : 'unknown',
      fundedAtMs: hit ? 1_700_000_000_000 : null,
      funderOutDegree: hit?.outDegree ?? null,
    };
  }
}

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function build(
  resolver: FundingSourceResolver = new StubResolver(),
  overrides: Partial<AppConfig['bot']['deployerGraph']> = {},
) {
  const base = loadConfig();
  const config: AppConfig = {
    ...base,
    bot: {
      ...base.bot,
      deployerGraph: {
        ...base.bot.deployerGraph,
        dbPath: join(tempDir, 'deployer-graph.sqlite'),
        ...overrides,
      },
    },
  };

  const bus: MessageBus = createInProcessBus({ bufferSize: 64 });
  graph = new DeployerGraphService(config, resolver, bus);
  graph.start();
  return { graph, bus, config };
}

function launch(bus: MessageBus, deployer: string, token: string): void {
  const event: NewLaunchEvent = {
    kind: 'new-launch',
    launchpadId: 'pons-v2',
    tokenAddress: token as NewLaunchEvent['tokenAddress'],
    curveAddress: addr(9_000) as NewLaunchEvent['curveAddress'],
    deployerAddress: deployer as NewLaunchEvent['deployerAddress'],
    quoteAsset: ETH,
    curveReserve: '1000000000000000000',
    graduationThreshold: '4200000000000000000',
    blockNumber: 1,
    txHash: `0x${'2'.repeat(64)}` as NewLaunchEvent['txHash'],
    timestamp: Date.now(),
    creatorFirstBuy: null,
    creatorTaxBps: null,
  };
  bus.publish('launch.new', event);
}

function graduate(bus: MessageBus, token: string): void {
  const event: GraduationEvent = {
    kind: 'graduation',
    launchpadId: 'pons-v2',
    tokenAddress: token as GraduationEvent['tokenAddress'],
    poolAddress: addr(8_000) as GraduationEvent['poolAddress'],
    hookAddress: addr(8_001) as GraduationEvent['hookAddress'],
    poolId: null,
    quoteAsset: ETH,
    quoteSeeded: '4200000000000000000',
    tokensSeeded: '200000000000000000000000000',
    blockNumber: 2,
    txHash: `0x${'3'.repeat(64)}` as GraduationEvent['txHash'],
    timestamp: Date.now(),
  };
  bus.publish('launch.graduated', event);
}

/** Funding resolution is background work kicked off by the launch handler. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rhc-graph-'));
});

afterEach(() => {
  graph?.stop();
  graph = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('clustering by funding source', () => {
  it('groups deployers funded from the same low-fanout wallet', async () => {
    const shared = addr(500);
    const resolver = new StubResolver({
      [addr(1)]: { funder: shared, outDegree: 3 },
      [addr(2)]: { funder: shared, outDegree: 3 },
    });
    const { graph, bus } = build(resolver);

    launch(bus, addr(1), addr(101));
    launch(bus, addr(2), addr(102));
    await settle();

    const first = graph.score(addr(1));
    const second = graph.score(addr(2));

    expect(first.clusterId).toBe(`fund:${shared}`);
    expect(second.clusterId).toBe(first.clusterId);
    expect(first.clusterSize).toBe(2);
  });

  it('refuses to group deployers behind a high-fanout funder', async () => {
    // Everyone who withdrew from the same exchange shares a funder. Treating that as a
    // relationship would merge thousands of unrelated deployers into one cluster whose
    // statistics mean nothing.
    const exchange = addr(600);
    const resolver = new StubResolver({
      [addr(1)]: { funder: exchange, outDegree: HUB_OUT_DEGREE_THRESHOLD + 1 },
      [addr(2)]: { funder: exchange, outDegree: HUB_OUT_DEGREE_THRESHOLD + 1 },
    });
    const { graph, bus } = build(resolver);

    launch(bus, addr(1), addr(101));
    launch(bus, addr(2), addr(102));
    await settle();

    const first = graph.score(addr(1));
    const second = graph.score(addr(2));

    expect(first.clusterId).not.toBe(second.clusterId);
    expect(first.clusterId).toBe(`solo:${addr(1)}`);
    expect(first.clusterSize).toBe(1);
    expect(first.fundingSourceKind).toBe('cex');
  });

  it('leaves an unresolvable deployer in its own cluster', async () => {
    const { graph, bus } = build(new StubResolver({}));

    launch(bus, addr(1), addr(101));
    await settle();

    expect(graph.score(addr(1)).clusterId).toBe(`solo:${addr(1)}`);
  });

  it('reports only multi-wallet clusters as clusters worth showing', async () => {
    const shared = addr(500);
    const resolver = new StubResolver({
      [addr(1)]: { funder: shared, outDegree: 2 },
      [addr(2)]: { funder: shared, outDegree: 2 },
      [addr(3)]: { funder: addr(700), outDegree: 1 },
    });
    const { graph, bus } = build(resolver);

    launch(bus, addr(1), addr(101));
    launch(bus, addr(2), addr(102));
    launch(bus, addr(3), addr(103));
    await settle();

    const clusters = graph.topClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ clusterId: `fund:${shared}`, size: 2 });
  });
});

describe('scoring', () => {
  it('scores an unknown deployer neutral with near-zero confidence', async () => {
    // A fresh wallet must not read like a proven one. The decision engine sizes on both
    // numbers, so a neutral score with no confidence behind it is the honest answer.
    const { graph, bus, config } = build(new StubResolver({}));

    launch(bus, addr(1), addr(101));
    await settle();

    const score = graph.score(addr(1));
    expect(score.score).toBe(config.bot.deployerGraph.unknownDeployerScore);
    expect(score.confidence).toBe(0);
    expect(score.priorLaunchCount).toBe(0);
  });

  it('gains confidence as graded history accumulates', async () => {
    const { graph, bus } = build(new StubResolver({}), { minLaunchesForConfidence: 3 });

    for (let i = 0; i < 6; i++) {
      launch(bus, addr(1), addr(200 + i));
      graduate(bus, addr(200 + i));
    }
    await settle();

    const score = graph.score(addr(1));
    expect(score.priorLaunchCount).toBe(6);
    expect(score.confidence).toBe(1);
    expect(score.score).toBeGreaterThan(0.9);
  });

  it('rates a deployer whose launches all graduated above an unknown one', async () => {
    const { graph, bus, config } = build(new StubResolver({}));

    for (let i = 0; i < 4; i++) {
      launch(bus, addr(1), addr(300 + i));
      graduate(bus, addr(300 + i));
    }
    launch(bus, addr(2), addr(400));
    await settle();

    expect(graph.score(addr(1)).score).toBeGreaterThan(config.bot.deployerGraph.unknownDeployerScore);
    expect(graph.score(addr(1)).score).toBeGreaterThan(graph.score(addr(2)).score);
  });

  it('counts graduation as the objective definition of a launch that worked', async () => {
    const { graph, bus } = build(new StubResolver({}));

    launch(bus, addr(1), addr(101));
    launch(bus, addr(1), addr(102));
    graduate(bus, addr(101));
    await settle();

    // Only the graduated launch is graded; the other is still pending and excluded.
    const score = graph.score(addr(1));
    expect(score.priorLaunchCount).toBe(1);
    expect(score.priorSuccessRate).toBe(1);
  });

  it('shares a cluster-mate’s record with a deployer that has none of its own', async () => {
    // The point of clustering: a fresh wallet funded from the same pocket as a proven
    // launcher inherits that evidence instead of reading as unknown.
    const shared = addr(500);
    const resolver = new StubResolver({
      [addr(1)]: { funder: shared, outDegree: 2 },
      [addr(2)]: { funder: shared, outDegree: 2 },
    });
    const { graph, bus } = build(resolver);

    launch(bus, addr(1), addr(101));
    await settle();
    for (let i = 0; i < 3; i++) {
      launch(bus, addr(1), addr(200 + i));
      graduate(bus, addr(200 + i));
    }

    launch(bus, addr(2), addr(300));
    await settle();

    const fresh = graph.score(addr(2));
    expect(fresh.priorLaunchCount).toBe(0);
    expect(fresh.clusterLaunchCount).toBeGreaterThan(0);
    expect(fresh.confidence).toBeGreaterThan(0);
    expect(fresh.reasons.join(' ')).toMatch(/clustered with/);
  });
});

describe('rug clusters', () => {
  it('zeroes the score for a cluster dominated by abandoned launches', async () => {
    const { graph, bus } = build(new StubResolver({}), {
      minLaunchesForConfidence: 3,
      rugClusterThreshold: 0.6,
      stalledProgressThreshold: 0.15,
      outcomeEvaluationMinutes: 0,
    });

    for (let i = 0; i < 5; i++) launch(bus, addr(1), addr(500 + i));
    await settle();

    // Grade them: nothing moved, so every launch is a dud.
    graph.gradePendingLaunches();

    const score = graph.score(addr(1));
    expect(score.isKnownRugCluster).toBe(true);
    expect(score.score).toBe(0);
    expect(score.reasons.join(' ')).toMatch(/abandoned launches/);
  });

  it('does not flag a cluster that mostly stalled rather than died', async () => {
    const { graph, bus } = build(new StubResolver({}), {
      minLaunchesForConfidence: 3,
      rugClusterThreshold: 0.6,
      stalledProgressThreshold: 0.15,
      outcomeEvaluationMinutes: 0,
    });

    for (let i = 0; i < 5; i++) {
      launch(bus, addr(1), addr(600 + i));
      graph.recordProgress(addr(600 + i), 0.5);
    }
    await settle();
    graph.gradePendingLaunches();

    expect(graph.score(addr(1)).isKnownRugCluster).toBe(false);
  });

  it('will not condemn a cluster on too little evidence', async () => {
    const { graph, bus } = build(new StubResolver({}), {
      minLaunchesForConfidence: 5,
      rugClusterThreshold: 0.6,
      outcomeEvaluationMinutes: 0,
    });

    for (let i = 0; i < 2; i++) launch(bus, addr(1), addr(700 + i));
    await settle();
    graph.gradePendingLaunches();

    expect(graph.score(addr(1)).isKnownRugCluster).toBe(false);
  });
});
