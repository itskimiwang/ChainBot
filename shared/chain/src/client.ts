import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  webSocket,
  type PublicClient,
  type Transport,
} from 'viem';
import type { AppConfig } from '@rhc/core';
import { createLogger } from '@rhc/core';

const log = createLogger('chain');

/**
 * Robinhood Chain, built from config rather than a hardcoded chain object so the id,
 * explorer, and endpoints stay in one reviewed place.
 *
 * Multicall3 sits at the canonical CREATE2 address here (verified on mainnet), which
 * matters more than it usually would: each bonding curve needs six state reads to price
 * a trade, and at ~15 launches a minute that is the difference between one batched call
 * and a rate-limit ban on the public endpoint.
 */
export function defineRobinhoodChain(config: AppConfig) {
  const { chain } = config.chain;
  return defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: {
      default: {
        http: [config.rpcHttpUrl],
        ...(config.rpcWsUrl ? { webSocket: [config.rpcWsUrl] } : {}),
      },
    },
    blockExplorers: {
      default: { name: chain.explorer.name, url: chain.explorer.url, apiUrl: chain.explorer.apiUrl },
    },
    contracts: {
      multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    },
  });
}

export type RhcPublicClient = PublicClient;

export function createRhcPublicClient(config: AppConfig): RhcPublicClient {
  const chain = defineRobinhoodChain(config);

  const transports: Transport[] = [
    http(config.rpcHttpUrl, {
      // Deliberately low: an event listener that stalls 30s on one call has already
      // missed the trade. Better to fail fast and let the poll loop catch up.
      timeout: 8_000,
      retryCount: 2,
      retryDelay: 150,
      batch: { wait: 8 },
    }),
  ];
  if (config.rpcWsUrl) transports.unshift(webSocket(config.rpcWsUrl, { timeout: 8_000, retryCount: 2 }));

  return createPublicClient({
    chain,
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
    batch: {
      // Curve reads fan out per token; batching them keeps the public endpoint usable.
      multicall: { wait: 10, batchSize: 512 },
    },
  }) as RhcPublicClient;
}

export async function assertChainIdentity(client: RhcPublicClient, expectedId: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expectedId) {
    throw new Error(
      `RPC endpoint reports chain id ${actual} but config expects ${expectedId}. ` +
        'Refusing to continue: contract addresses are chain-specific and using them against the wrong chain risks funds.',
    );
  }
  log.info('chain identity verified', { chainId: actual });
}
