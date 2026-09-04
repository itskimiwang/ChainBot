import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './logger.js';

/**
 * Persistent storage for the deployer graph and the wallet tracker.
 *
 * Uses Node's built-in `node:sqlite` rather than a native addon. That is a deliberate
 * supply-chain decision: this process holds a funded hot wallet, and every native
 * dependency with a postinstall script is another way to lose it. Requires Node to be
 * started with `--experimental-sqlite` on the v22 line.
 */

const log = createLogger('db');

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL keeps the listener's writes from blocking the dashboard's reads. NORMAL sync is
  // the right trade here: this data is reconstructible from chain history, and fsync per
  // commit would stall the hot path at ~15 launches a minute.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  log.debug('opened database', { path });

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    get: <T,>(sql: string, ...params: SqlValue[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T,>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}

/**
 * A migration step: raw SQL, or a function for rewrites SQLite cannot express. Rescaling
 * a fixed-point field inside a JSON payload is the motivating case — the values overflow
 * SQLite's 64-bit INTEGER, so the arithmetic has to happen in bigint.
 */
export type Migration = string | ((db: Db) => void);

/**
 * Minimal forward-only migrations. Each entry runs once, in order, recorded by index.
 * Never edit a shipped migration — append a new one.
 */
export function migrate(db: Db, namespace: string, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    namespace TEXT NOT NULL,
    idx       INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, idx)
  )`);

  const applied = new Set(
    db.all<{ idx: number }>('SELECT idx FROM _migrations WHERE namespace = ?', namespace).map((r) => r.idx),
  );

  for (const [idx, step] of migrations.entries()) {
    if (applied.has(idx)) continue;
    db.transaction(() => {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.run('INSERT INTO _migrations (namespace, idx, applied_at) VALUES (?, ?, ?)', namespace, idx, Date.now());
    });
    log.info('applied migration', { namespace, idx });
  }
}
