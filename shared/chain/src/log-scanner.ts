import { numberToHex, type Address, type Hex } from 'viem';
import { createLogger, mutex, sleep } from '@rhc/core';
import type { RhcPublicClient } from './client.js';

const log = createLogger('chain:scanner');

/**
 * A raw log as returned by `eth_getLogs`.
 *
 * The scanner deliberately works at this level rather than through viem's typed
 * `getLogs` helper. Curve trades are matched by event signature across many one-off
 * contract addresses, which does not fit the typed helper's shape, and keeping the
 * topic filter explicit makes it obvious what the listener is and is not watching.
 */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

export interface ScanFilter {
  /** Contracts to scan. Empty means the scanner idles rather than scanning the world. */
  addresses: Address[];
  /** topic0 values to match, OR'd together. */
  topics: Hex[];
}

export interface LogScannerOptions {
  client: RhcPublicClient;
  /** Re-evaluated every tick, so the curve set can change without a restart. */
  filter: () => ScanFilter;
  onLogs: (logs: RawLog[]) => Promise<void> | void;
  pollIntervalMs: number;
  /** Max blocks per eth_getLogs page. Public endpoints cap the span and the result size. */
  pageSize: number;
  /**
   * Blocks to stay behind head. Zero by default: on a ~100ms-block Orbit chain with a
   * private sequencer, waiting for confirmations costs more in missed entries than
   * reorgs cost in bad fills. Raise it if the sequencer's ordering guarantees turn out
   * to be weaker than assumed.
   */
  confirmations?: number;
  name: string;
}

/**
 * Polling log reader.
 *
 * `eth_subscribe` would be better, but the public HTTPS endpoint rejects websocket
 * upgrades, so polling is the only transport that works without a dedicated provider.
 * The scanner keeps a block cursor, pages through gaps so a slow tick cannot skip
 * blocks, and never scans without an address filter — an unfiltered topic scan on a
 * chain producing ten blocks a second would return more logs than it could process.
 */
export class LogScanner {
  private cursor = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly serialize = mutex();
  private consecutiveErrors = 0;

  readonly stats = { ticks: 0, logsSeen: 0, pagesFetched: 0, errors: 0, lastBlock: 0, lagBlocks: 0 };

  constructor(private readonly options: LogScannerOptions) {}

  async start(fromBlock: number): Promise<void> {
    this.cursor = fromBlock;
    this.running = true;
    log.info('scanner started', { name: this.options.name, fromBlock });
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get currentBlock(): number {
    return this.cursor;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.serialize(() => this.tick());
      if (!this.running) break;
      await sleep(this.options.pollIntervalMs);
    }
  }

  private async tick(): Promise<void> {
    const { client, filter, onLogs, pageSize, confirmations = 0 } = this.options;
    this.stats.ticks += 1;

    try {
      const head = Number(await client.getBlockNumber()) - confirmations;
      this.stats.lastBlock = head;
      if (head < this.cursor) return;

      const { addresses, topics } = filter();
      if (addresses.length === 0 || topics.length === 0) {
        // Nothing to watch. Jump the cursor forward so a later subscription does not
        // trigger a scan of every block that elapsed while the set was empty.
        this.cursor = head + 1;
        this.stats.lagBlocks = 0;
        return;
      }

      this.stats.lagBlocks = head - this.cursor;

      while (this.cursor <= head && this.running) {
        const toBlock = Math.min(this.cursor + pageSize - 1, head);
        const logs = (await client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: addresses.length === 1 ? addresses[0]! : addresses,
              fromBlock: numberToHex(this.cursor),
              toBlock: numberToHex(toBlock),
              // A nested array in topic position 0 is an OR across topic0 values.
              topics: [topics.length === 1 ? topics[0]! : topics],
            },
          ],
          // viem's request type does not model the topics form of eth_getLogs.
        } as never)) as unknown as RawLog[];

        this.stats.pagesFetched += 1;
        if (logs.length > 0) {
          this.stats.logsSeen += logs.length;
          await onLogs(logs);
        }

        this.cursor = toBlock + 1;
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.stats.errors += 1;
      this.consecutiveErrors += 1;
      // The public endpoint rate-limits under load. Back off rather than hammering it,
      // but keep the cursor put so nothing is skipped.
      const backoff = Math.min(5_000, 200 * 2 ** Math.min(this.consecutiveErrors, 5));
      log.warn('scan tick failed; backing off', {
        name: this.options.name,
        consecutiveErrors: this.consecutiveErrors,
        backoffMs: backoff,
        err: (err as Error).message,
      });
      await sleep(backoff);
    }
  }
}
