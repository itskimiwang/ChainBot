/**
 * Live check of the honeypot round-trip simulator against real, recent launches.
 *
 *   node --experimental-sqlite --import tsx scripts/smoke-vetting.ts
 */
import { decodeEventLog, numberToHex, type Address } from 'viem';
import {
  ChainReader,
  createRhcPublicClient,
  ponsV2FactoryAbi,
  QuoteAssetRegistry,
  quoteBuy,
  TOPIC0,
} from '@rhc/chain';
import { createLogger, formatUnits, loadConfig } from '@rhc/core';
import { RoundTripSimulator } from '@rhc/vetting';

const log = createLogger('smoke-vetting');
const config = loadConfig();
const client = createRhcPublicClient(config);
const reader = new ChainReader(client);
const factory = config.chain.launchpads.find((l) => l.id === 'pons-v2')!.contracts.factory as Address;
const registry = new QuoteAssetRegistry(config, reader, factory);
await registry.resolveAll();

const head = await reader.getBlockNumber();
const logs = (await client.request({
  method: 'eth_getLogs',
  params: [
    {
      address: factory,
      topics: [TOPIC0.TokenLaunched],
      fromBlock: numberToHex(head - 20_000),
      toBlock: numberToHex(head),
    },
  ],
} as never)) as unknown as Array<{ data: `0x${string}`; topics: `0x${string}`[] }>;

log.info('found recent launches', { count: logs.length });

const simulator = new RoundTripSimulator(client);
let checked = 0;

// Walk backwards from the most recent: newer curves are likelier to still be trading.
for (const raw of logs.reverse()) {
  if (checked >= 6) break;

  const decoded = decodeEventLog({ abi: ponsV2FactoryAbi, data: raw.data, topics: raw.topics as never });
  if (decoded.eventName !== 'TokenLaunched') continue;
  const args = decoded.args as unknown as { token: Address; curve: Address; pairToken: Address };

  const quoteAsset = await registry.resolve(args.pairToken);
  if (!quoteAsset) continue;
  if (!['ETH', 'USDG'].includes(quoteAsset.symbol)) continue;

  const state = await reader.readCurve(args.curve);
  if (!state || state.graduated || state.sellableTokens === 0n) continue;

  checked += 1;

  // Size the probe trade the way the vetting service does: a fixed USD notional.
  const quoteIn = quoteAsset.symbol === 'USDG' ? 25_000_000n : 12_500_000_000_000_000n;

  const predicted = quoteBuy(state, quoteIn, 0n);
  const result = await simulator.simulate({
    curveAddress: args.curve,
    tokenAddress: args.token,
    quoteAsset,
    quoteIn,
  });

  log.info(`round trip #${checked}`, {
    token: args.token,
    quote: quoteAsset.symbol,
    spend: formatUnits(quoteIn, quoteAsset.decimals),
    ok: result.ok,
    failedLeg: result.failedLeg,
    revert: result.revertReason?.slice(0, 80) ?? null,
    tokensOutSimulated: result.tokensOut.toString(),
    tokensOutPredicted: predicted.tokensOut.toString(),
    // The local curve math should reproduce the contract exactly. Any gap means the
    // paper engine would price fills differently from live.
    mathMatches: result.tokensOut === predicted.tokensOut,
    returned: formatUnits(result.quoteReturned, quoteAsset.decimals),
    retentionBps: result.retentionBps,
  });
}

log.info('done', { checked });
process.exit(0);
