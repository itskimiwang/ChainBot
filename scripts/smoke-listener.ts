/**
 * Live smoke test for the Phase 0 listener.
 *
 * Runs the real listener against mainnet for a fixed window and reports what it saw.
 * Read-only: no wallet, no signing, no config mutation.
 *
 *   node --experimental-sqlite --import tsx scripts/smoke-listener.ts [seconds]
 */
import {
  assertChainIdentity,
  assertTopicsMatchAbi,
  ChainReader,
  createRhcPublicClient,
  QuoteAssetRegistry,
} from '@rhc/chain';
import { createInProcessBus, createLogger, loadConfig, setLogLevel, UsdPriceOracle } from '@rhc/core';
import { EventListenerService, PonsV2Adapter } from '@rhc/event-listener';
import type { Address } from 'viem';

const log = createLogger('smoke');
setLogLevel('info');

const seconds = Number(process.argv[2] ?? 20);

const config = loadConfig();
assertTopicsMatchAbi();

const client = createRhcPublicClient(config);
await assertChainIdentity(client, config.chain.chain.id);

const reader = new ChainReader(client);
const pons = config.chain.launchpads.find((l) => l.id === 'pons-v2')!;
const factory = pons.contracts.factory as Address;

const registry = new QuoteAssetRegistry(config, reader, factory);
const assets = await registry.resolveAll();

const oracle = new UsdPriceOracle(
  config.bot.accounting.usdPriceStrategy,
  config.bot.accounting.stableAnchorSymbol,
  config.bot.accounting.usdPriceOverrides,
);
oracle.ingest(assets);
log.info('usd reference prices', oracle.snapshot());

const bus = createInProcessBus();
const listener = new EventListenerService(config, client, reader, registry, [
  new PonsV2Adapter(factory, pons.contracts.memeHook as Address),
], bus);

bus.subscribe('launch.new', (e) => {
  log.info('LAUNCH', {
    token: e.tokenAddress,
    quote: e.quoteAsset.symbol,
    deployer: e.deployerAddress,
    threshold: e.graduationThreshold,
  });
});
bus.subscribe('launch.trade', (e) => {
  log.info('TRADE', { token: e.tokenAddress, side: e.side, quote: e.quoteAmount, trader: e.trader });
});
bus.subscribe('launch.graduated', (e) => {
  log.info('GRADUATED', { token: e.tokenAddress, quoteSeeded: e.quoteSeeded });
});

await listener.start();
await new Promise((r) => setTimeout(r, seconds * 1000));
listener.stop();

const tracked = listener.listTracked();
log.info('smoke complete', listener.getScannerStats());
log.info('top tracked curves by progress', {
  sample: tracked
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 5)
    .map((t) => ({
      token: t.tokenAddress.slice(0, 10),
      quote: t.quoteAsset.symbol,
      progressPct: Number((t.progress * 100).toFixed(2)),
      trades: t.tradeCount,
    })),
});
process.exit(0);
