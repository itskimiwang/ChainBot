import { createLogger, retry, sleep, type AppConfig } from '@rhc/core';
import type { FundingSourceKind } from '@rhc/types';

const log = createLogger('deployer-graph:funding');

export interface FundingAttribution {
  funder: string | null;
  kind: FundingSourceKind;
  fundedAtMs: number | null;
  /** Distinct addresses this funder has sent to. High counts mean a CEX or a dispenser. */
  funderOutDegree: number | null;
}

export interface FundingSourceResolver {
  readonly name: string;
  readonly available: boolean;
  resolve(address: string): Promise<FundingAttribution>;
}

/**
 * Funding attribution via the chain's Blockscout instance.
 *
 * "Who paid for this wallet's first transaction" is a history question, and history
 * queries are exactly what a JSON-RPC endpoint is bad at — answering it from RPC alone
 * would mean scanning the chain backwards. Blockscout already indexes it, so the graph
 * asks it directly.
 *
 * Requests are serialised behind a small delay because this is a public explorer, not a
 * paid API, and the graph is a background service with no deadline. Blocking a trade on
 * this would be the wrong trade-off; the decision engine reads whatever the graph has
 * and scores an unresolved deployer as unknown rather than waiting.
 */
export class BlockscoutFundingResolver implements FundingSourceResolver {
  readonly name = 'blockscout';
  available = true;

  private readonly baseUrl: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly outDegreeCache = new Map<string, number>();

  constructor(config: AppConfig) {
    this.baseUrl = config.chain.chain.explorer.url;
  }

  async resolve(address: string): Promise<FundingAttribution> {
    return this.enqueue(async () => {
      try {
        // Ascending order puts the wallet's first activity first, so the earliest
        // inbound transfer is the wallet's origin funding.
        const txs = await this.txlist(address, 'asc', 20);
        const inbound = txs.find(
          (t) => t.to?.toLowerCase() === address.toLowerCase() && BigInt(t.value ?? '0') > 0n,
        );

        if (!inbound?.from) {
          return { funder: null, kind: 'unknown', fundedAtMs: null, funderOutDegree: null };
        }

        const funder = inbound.from.toLowerCase();
        const outDegree = await this.outDegree(funder);
        return {
          funder,
          kind: classify(outDegree, inbound.contractAddress),
          fundedAtMs: Number(inbound.timeStamp ?? 0) * 1000,
          funderOutDegree: outDegree,
        };
      } catch (err) {
        log.debug('funding lookup failed', { address, err: (err as Error).message });
        return { funder: null, kind: 'unknown', fundedAtMs: null, funderOutDegree: null };
      }
    });
  }

  /**
   * How many distinct addresses a funder has paid out to.
   *
   * This is what separates a hot wallet belonging to one person from a shared source. A
   * funder that has paid a handful of addresses links those wallets into a meaningful
   * cluster; an exchange withdrawal address has paid thousands and links nothing, so
   * clustering on it would merge unrelated deployers into one enormous false cluster.
   */
  private async outDegree(funder: string): Promise<number> {
    const cached = this.outDegreeCache.get(funder);
    if (cached != null) return cached;

    const txs = await this.txlist(funder, 'desc', 200);
    const recipients = new Set(
      txs.filter((t) => t.from?.toLowerCase() === funder && t.to).map((t) => t.to!.toLowerCase()),
    );
    this.outDegreeCache.set(funder, recipients.size);
    return recipients.size;
  }

  private async txlist(
    address: string,
    sort: 'asc' | 'desc',
    offset: number,
  ): Promise<Array<{ from?: string; to?: string; value?: string; timeStamp?: string; contractAddress?: string }>> {
    const url =
      `${this.baseUrl}/api?module=account&action=txlist&address=${address}` +
      `&page=1&offset=${offset}&sort=${sort}`;

    const body = await retry(
      async () => {
        const response = await fetch(url, {
          // The default fetch user-agent is rejected by the explorer's edge.
          headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 429) throw new Error('rate limited');
        if (!response.ok) throw new Error(`http ${response.status}`);
        return (await response.json()) as { message?: string; result?: unknown };
      },
      { attempts: 3, baseDelayMs: 600, maxDelayMs: 4_000 },
    );

    return Array.isArray(body.result) ? (body.result as never[]) : [];
  }

  /** Serialise lookups; the explorer is a shared public resource. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const value = await fn();
      await sleep(250);
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/** Resolver used when no history source is configured. Never guesses. */
export class NullFundingResolver implements FundingSourceResolver {
  readonly name = 'none';
  readonly available = false;
  async resolve(): Promise<FundingAttribution> {
    return { funder: null, kind: 'unknown', fundedAtMs: null, funderOutDegree: null };
  }
}

/**
 * A funder that has paid very many distinct addresses is infrastructure — an exchange,
 * a bridge, a faucet — and says nothing about who controls the deployer.
 */
export const HUB_OUT_DEGREE_THRESHOLD = 50;

function classify(outDegree: number, contractAddress?: string): FundingSourceKind {
  if (contractAddress) return 'contract';
  if (outDegree >= HUB_OUT_DEGREE_THRESHOLD) return 'cex';
  if (outDegree >= 10) return 'bridge';
  return 'wallet';
}

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
