/** Diagnostic: which seeded quote assets does the factory actually approve? */
import { ChainReader, createRhcPublicClient } from '@rhc/chain';
import { loadConfig } from '@rhc/core';
import type { Address } from 'viem';

const config = loadConfig();
const client = createRhcPublicClient(config);
const reader = new ChainReader(client);
const factory = config.chain.launchpads.find((l) => l.id === 'pons-v2')!.contracts.factory as Address;

for (const seed of config.chain.quoteAssets.seed) {
  const economics = await reader.readPairTokenEconomics(factory, seed.address as Address);
  if (!economics) {
    console.log(`${seed.symbol.padEnd(6)} READ FAILED`);
    continue;
  }
  if (!economics.approved) {
    console.log(`${seed.symbol.padEnd(6)} NOT APPROVED  thr=${economics.graduationThreshold} dec=${economics.decimals}`);
  }
}
console.log('done');
process.exit(0);
