import { createLogger, migrate, type Db } from '@rhc/core';
import type { FundingSourceResolver } from '@rhc/deployer-graph';

const log = createLogger('wallet-tracker:funding');

interface CacheRow {
  address: string;
  funder: string | null;
  out_degree: number | null;
  resolved_at: number;
}

/**
 * Lazy, cached funding-source index over ordinary buyers.
 *
 * Phase 3 needs to know whether the wallets buying a token were funded independently or
 * out of the same pocket. Resolving that on demand for every buyer would be far too slow
 * to gate a trade on — each lookup is a rate-limited explorer request, and a busy launch
 * has dozens of buyers within the observation window.
 *
 * So resolution is a background process and reads are cache-only. Whatever is known at
 * decision time is what gets used, and coverage is reported alongside the verdict so the
 * decision engine can tell "these buyers are independent" apart from "we don't know yet"
 * — a distinction that matters, because treating unknown as clean is exactly the hole a
 * wash trader would drive through.
 */
export class FundingIndex {
  private readonly cache = new Map<string, { funder: string | null; outDegree: number | null }>();
  private readonly queued = new Set<string>();
  private inFlight = 0;
  private readonly maxInFlight = 1;

  constructor(
    private readonly db: Db,
    private readonly resolver: FundingSourceResolver,
  ) {
    migrate(this.db, 'funding-index', [
      `CREATE TABLE funding_cache (
         address TEXT PRIMARY KEY,
         funder TEXT,
         out_degree INTEGER,
         resolved_at INTEGER NOT NULL
       );
       CREATE INDEX idx_funding_cache_funder ON funding_cache(funder);`,
    ]);

    for (const row of this.db.all<CacheRow>('SELECT * FROM funding_cache')) {
      this.cache.set(row.address, { funder: row.funder, outDegree: row.out_degree });
    }
    if (this.cache.size > 0) log.info('loaded funding cache', { entries: this.cache.size });
  }

  /** Cache-only. Never blocks; returns undefined when the wallet is not yet resolved. */
  known(address: string): { funder: string | null; outDegree: number | null } | undefined {
    return this.cache.get(address.toLowerCase());
  }

  /** Queue a wallet for background resolution. Safe to call repeatedly. */
  request(address: string): void {
    const key = address.toLowerCase();
    if (this.cache.has(key) || this.queued.has(key) || !this.resolver.available) return;
    this.queued.add(key);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.inFlight >= this.maxInFlight) return;
    const next = this.queued.values().next();
    if (next.done) return;

    const address = next.value;
    this.queued.delete(address);
    this.inFlight += 1;

    try {
      const attribution = await this.resolver.resolve(address);
      const entry = { funder: attribution.funder, outDegree: attribution.funderOutDegree };
      this.cache.set(address, entry);
      this.db.run(
        'INSERT OR REPLACE INTO funding_cache (address, funder, out_degree, resolved_at) VALUES (?, ?, ?, ?)',
        address,
        entry.funder,
        entry.outDegree,
        Date.now(),
      );
    } catch {
      // Leave it unresolved; it will be requested again the next time it is seen.
    } finally {
      this.inFlight -= 1;
      if (this.queued.size > 0) void this.drain();
    }
  }

  get coverage(): { resolved: number; queued: number } {
    return { resolved: this.cache.size, queued: this.queued.size };
  }
}
