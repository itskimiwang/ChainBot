import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import {
  assertChainIdentity,
  assertTopicsMatchAbi,
  ChainReader,
  createRhcPublicClient,
  QuoteAssetRegistry,
} from '@rhc/chain';
import {
  addLogSink,
  createInProcessBus,
  createLogger,
  formatUnits,
  loadConfig,
  resolveFromRoot,
  UsdPriceOracle,
  type LogRecord,
} from '@rhc/core';
import { DecisionEngine, type LaunchView } from '@rhc/decision-engine';
import { BlockscoutFundingResolver, DeployerGraphService, NullFundingResolver } from '@rhc/deployer-graph';
import { EventListenerService, PonsV2Adapter, type LaunchpadAdapter } from '@rhc/event-listener';
import { ExecutionService, PortfolioLedger } from '@rhc/execution';
import { ExitEngineService } from '@rhc/exit-engine';
import { RiskManager } from '@rhc/risk-manager';
import { VettingService } from '@rhc/vetting';
import { WalletTrackerService } from '@rhc/wallet-tracker';
import type { Position } from '@rhc/types';
import { OperatorApi } from './api.js';
import { evaluateRun } from './evaluation.js';
import { TelegramNotifier } from './telegram.js';

const log = createLogger('bot');

/**
 * Composition root.
 *
 * Every service is independent and talks over the message bus; this file is the only
 * place that knows they all exist. Keeping the wiring in one place is what allows the
 * services to be developed and tested in isolation, and what would allow them to be
 * split across processes later by swapping the in-process bus for a Redis transport
 * without touching a service implementation.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();

  log.info('starting Robinhood Chain meme-coin bot', {
    mode: config.bot.mode,
    chain: `${config.chain.chain.name} (${config.chain.chain.id})`,
    configVersion: config.chain.configVersion,
  });

  if (config.bot.mode === 'paper') {
    log.info(
      'PAPER MODE: reads real mainnet state and prices fills against real reserves; ' +
        'never signs or broadcasts a transaction',
    );
  }

  // Fail fast if the ABI and the pinned event topics ever disagree — a listener that
  // matches nothing looks perfectly healthy and trades nothing.
  assertTopicsMatchAbi();

  const client = createRhcPublicClient(config);
  await assertChainIdentity(client, config.chain.chain.id);
  const reader = new ChainReader(client);

  const launchpads = config.chain.launchpads.filter((l) => l.enabled);
  if (launchpads.length === 0) throw new Error('no launchpad enabled in config/chain.json');

  for (const lp of launchpads) {
    if (!lp.addressesVerified) {
      throw new Error(
        `launchpad "${lp.id}" is enabled but its addresses are not marked verified. ` +
          'Verify them against the block explorer before enabling: wrong addresses here lose funds.',
      );
    }
  }

  const primary = launchpads.find((l) => l.primary) ?? launchpads[0]!;
  const factory = primary.contracts.factory as Address;

  const adapters: LaunchpadAdapter[] = [];
  for (const lp of launchpads) {
    if (lp.adapter === 'pons-v2') {
      adapters.push(new PonsV2Adapter(lp.contracts.factory as Address, lp.contracts.memeHook as Address));
    } else {
      log.warn('launchpad enabled but has no adapter implementation; skipping', { id: lp.id });
    }
  }

  /* ---------------------------- shared services ---------------------------- */

  const bus = createInProcessBus({ bufferSize: 400 });

  const quoteAssets = new QuoteAssetRegistry(config, reader, factory);
  const resolvedAssets = await quoteAssets.resolveAll();

  const oracle = new UsdPriceOracle(
    config.bot.accounting.usdPriceStrategy,
    config.bot.accounting.stableAnchorSymbol,
    config.bot.accounting.usdPriceOverrides,
  );
  oracle.ingest(resolvedAssets);

  const ledger = new PortfolioLedger(
    resolveFromRoot(config, 'data/ledger.sqlite'),
    config.bot.mode,
    config.bot.accounting.startingBalanceUsd,
    oracle,
  );
  ledger.fundVirtual(quoteAssets.allowed());

  const startingEquityUsd = ledger.equityUsd();

  const risk = new RiskManager(
    config,
    {
      equityUsd: () => ledger.equityUsd(),
      openPositionCount: () => ledger.openPositions().length,
      totalExposureUsd: () =>
        ledger
          .openPositions()
          .reduce((sum, p) => sum + (oracle.toUsd(BigInt(p.quoteInvested), p.quoteAsset) ?? 0), 0),
    },
    bus,
  );
  risk.initialise();

  /* ------------------------------- phase 0 -------------------------------- */

  const listener = new EventListenerService(config, client, reader, quoteAssets, adapters, bus);

  const symbolCache = new Map<string, string>();

  const execution = new ExecutionService({
    config,
    client,
    reader,
    ledger,
    oracle,
    bus,
    symbolFor: (token) => symbolCache.get(token.toLowerCase()) ?? shortAddress(token),
    phaseFor: (token) => {
      const tracked = listener.getTracked(token);
      if (!tracked) return 'curve';
      return tracked.graduated ? 'pool' : tracked.swept ? 'swept' : 'curve';
    },
  });
  await execution.initialise();

  /* ---------------------------- phases 1 to 5 ------------------------------ */

  const vetting = new VettingService(config, client, reader, oracle, factory, bus);

  const fundingResolver = config.chain.chain.explorer.url
    ? new BlockscoutFundingResolver(config)
    : new NullFundingResolver();

  const deployerGraph = new DeployerGraphService(config, fundingResolver, bus);

  const walletTracker = new WalletTrackerService(
    config,
    fundingResolver,
    bus,
    (token) => listener.getTracked(token)?.progress ?? 0,
  );

  const launchView = (tokenAddress: string): LaunchView | undefined => {
    const tracked = listener.getTracked(tokenAddress);
    if (!tracked) return undefined;
    return {
      tokenAddress: tracked.tokenAddress,
      curveAddress: tracked.curveAddress,
      deployerAddress: tracked.deployerAddress,
      quoteAsset: tracked.quoteAsset,
      progress: tracked.progress,
      launchedAt: tracked.launchedAt,
      graduated: tracked.graduated,
      swept: tracked.swept,
    };
  };

  const decision = new DecisionEngine({
    config,
    bus,
    vetting,
    deployerGraph,
    walletTracker,
    execution,
    ledger,
    risk,
    oracle,
    launchView,
    pin: (token) => listener.pin(token),
  });

  const closedThisRun: Position[] = [];
  let honeypotEntries = 0;

  const exitEngine = new ExitEngineService({
    config,
    bus,
    oracle,
    ledger,
    execution,
    risk,
    unpin: (token) => listener.unpin(token),
    onPositionClosed: (position) => {
      closedThisRun.push(position);
      // A loss on a cluster cools that cluster off for a while.
      if (Number(position.realizedPnlQuote) < 0) {
        const view = launchView(position.tokenAddress);
        if (view) risk.penaliseCluster(deployerGraph.score(view.deployerAddress).clusterId);
      }
    },
  });

  /* ------------------------------ observability ---------------------------- */

  const recentLogs: LogRecord[] = [];
  addLogSink((record) => {
    recentLogs.push(record);
    if (recentLogs.length > 300) recentLogs.splice(0, 100);
  });

  bus.subscribe('launch.new', (event) => {
    // Resolve the symbol lazily; the ledger and alerts read better with it than with a
    // truncated address, and it is one cheap call per tracked launch.
    void reader
      .readTokenMeta(event.tokenAddress as Address)
      .then((meta) => symbolCache.set(event.tokenAddress, meta.symbol))
      .catch(() => undefined);
  });

  // Feed observed curve progress back to the deployer graph so it can grade outcomes.
  setInterval(() => {
    for (const tracked of listener.listTracked()) {
      deployerGraph.recordProgress(tracked.tokenAddress, tracked.progress);
    }
  }, 30_000);

  const telegram = new TelegramNotifier(config, bus);

  /* -------------------------------- start ---------------------------------- */

  deployerGraph.start();
  walletTracker.start();
  decision.start();
  exitEngine.start();
  await listener.start();

  const flattenAndHalt = async (): Promise<void> => {
    mkdirSync(dirname(config.bot.risk.killSwitchFile), { recursive: true });
    writeFileSync(config.bot.risk.killSwitchFile, `engaged at ${new Date().toISOString()}\n`);
    risk.pause('kill switch engaged');
    await exitEngine.flattenAll('manual');
  };

  const buildReport = () =>
    evaluateRun({
      config,
      startedAt,
      startingEquityUsd,
      currentEquityUsd: ledger.equityUsd(),
      maxDrawdownPct: risk.peakDrawdownPct,
      closedPositions: closedThisRun,
      honeypotEntries,
      strandedPositions: ledger.strandedPositions().length,
    });

  telegram.start({
    pause: () => risk.pause('paused by operator'),
    resume: () => {
      try {
        rmSync(config.bot.risk.killSwitchFile, { force: true });
      } catch {
        // Nothing to clear.
      }
      risk.resume();
    },
    kill: flattenAndHalt,
    status: () => {
      const state = risk.state();
      const report = buildReport();
      return [
        `<b>Mode</b> ${config.bot.mode}`,
        `<b>Equity</b> $${state.currentEquityQuote} (day ${state.dailyPnlQuote})`,
        `<b>Positions</b> ${state.openPositions}/${state.maxConcurrentPositions}`,
        `<b>Halted</b> ${state.halted ? state.haltReason : 'no'}`,
        `<b>Trades</b> ${report.trades} closed, ${(report.winRate * 100).toFixed(0)}% win`,
        `<b>Verdict</b> ${report.verdict}`,
      ].join('\n');
    },
    positions: () => {
      const open = ledger.openPositions();
      if (open.length === 0) return 'No open positions.';
      return open
        .map(
          (p) =>
            `<b>${p.symbol}</b> ${ledger.currentMultiple(p).toFixed(2)}x  ` +
            `in ${formatUnits(BigInt(p.quoteInvested), p.quoteAsset.decimals, 5)} ${p.quoteAsset.symbol}`,
        )
        .join('\n');
    },
  });

  /* --------------------------------- api ----------------------------------- */

  const api = new OperatorApi(config);

  api.get('/api/health', () => ({ ok: true, mode: config.bot.mode, uptimeSeconds: process.uptime() }));

  api.get('/api/state', () => ({
    mode: config.bot.mode,
    startedAt,
    chain: {
      id: config.chain.chain.id,
      name: config.chain.chain.name,
      explorer: config.chain.chain.explorer.url,
      rpcTier: process.env[config.chain.rpc.overrideEnvVars.http] ? 'dedicated' : config.chain.rpc.primary.tier,
      sequencerOrderingConfirmed: config.chain.rpc.sequencer.orderingConfirmed,
    },
    launchpads: launchpads.map((l) => ({ id: l.id, name: l.name, primary: l.primary, adapter: l.adapter })),
    equityUsd: ledger.equityUsd(),
    startingEquityUsd,
    risk: risk.state(),
    pricing: oracle.snapshot(),
    quoteAssets: quoteAssets.allowed().map((a) => ({
      symbol: a.symbol,
      decimals: a.decimals,
      graduationThreshold: a.graduationThreshold,
      usdPrice: oracle.usdPrice(a),
    })),
    evaluation: buildReport(),
    stats: {
      listener: listener.getScannerStats(),
      vetting: vetting.stats,
      deployerGraph: deployerGraph.stats,
      walletTracker: { ...walletTracker.stats, fundingCoverage: walletTracker.fundingCoverage },
      decision: decision.stats,
      exit: exitEngine.stats,
      execution: execution.stats,
    },
  }));

  api.get('/api/positions', () => ({
    open: ledger.openPositions().map((p) => ({ ...p, currentMultiple: ledger.currentMultiple(p) })),
    closed: ledger.closedPositions().slice(0, 50),
    stranded: ledger.strandedPositions(),
    strandedCostUsd: ledger.strandedCostUsd(),
  }));

  api.get('/api/launches', () => ({
    tracked: listener
      .listTracked()
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 60)
      .map((t) => ({
        tokenAddress: t.tokenAddress,
        symbol: symbolCache.get(t.tokenAddress) ?? null,
        deployerAddress: t.deployerAddress,
        quoteAsset: t.quoteAsset.symbol,
        progress: t.progress,
        realQuoteReserve: t.realQuoteReserve.toString(),
        graduationThreshold: t.graduationThreshold.toString(),
        tradeCount: t.tradeCount,
        launchedAt: t.launchedAt,
        lastTradeAt: t.lastTradeAt,
        vetting: vetting.getCached(t.tokenAddress),
        deployer: deployerGraph.score(t.deployerAddress),
      })),
  }));

  api.get('/api/signals', () => ({
    rejections: decision.rejections.slice(-40).reverse(),
    walletSignals: bus.recent('wallet.signal', 25).reverse(),
    topClusters: deployerGraph.topClusters(),
    topWallets: walletTracker.topWallets(),
  }));

  api.get('/api/activity', () => ({
    fills: bus.recent('trade.fill', 40).reverse(),
    exits: bus.recent('exit.signal', 25).reverse(),
    graduations: bus.recent('launch.graduated', 15).reverse(),
    logs: recentLogs.slice(-80).reverse(),
  }));

  api.post('/api/control/pause', () => {
    risk.pause('paused by operator');
    return { ok: true, state: risk.state() };
  });

  api.post('/api/control/resume', () => {
    rmSync(config.bot.risk.killSwitchFile, { force: true });
    risk.resume();
    return { ok: true, state: risk.state() };
  });

  api.post('/api/control/kill', async () => {
    await flattenAndHalt();
    return { ok: true, state: risk.state() };
  });

  api.post('/api/control/flatten', async () => {
    await exitEngine.flattenAll('manual');
    return { ok: true, open: ledger.openPositions().length };
  });

  const { url } = await api.start();

  bus.subscribe('vetting.result', (result) => {
    if (result.failures.includes('honeypot-sell-reverts') && ledger.positionForToken(result.tokenAddress)) {
      // Vetting caught a honeypot we had already entered. This is the false-negative
      // rate the evaluation gate cares about, so it is counted rather than just logged.
      honeypotEntries += 1;
    }
  });

  log.info('all services started', {
    mode: config.bot.mode,
    api: url,
    startingEquityUsd: startingEquityUsd.toFixed(2),
    trackedQuoteAssets: quoteAssets.allowed().map((a) => a.symbol),
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    listener.stop();
    decision.stop();
    exitEngine.stop();
    deployerGraph.stop();
    walletTracker.stop();
    telegram.stop();
    api.stop();
    ledger.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

main().catch((err) => {
  log.error('fatal startup error', { err: (err as Error).message });
  process.exitCode = 1;
});
