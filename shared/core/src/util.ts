import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowMs(): number {
  return Date.now();
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Exponential backoff with jitter. The public RPC is rate-limited, so a burst of curve
 * reads will occasionally get throttled; retrying in lockstep would just re-collide.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseDelayMs = 250, maxDelayMs = 5_000, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) break;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      onRetry?.(attempt + 1, err);
      await sleep(backoff * (0.5 + Math.random() * 0.5));
    }
  }
  throw lastError;
}

/** Fixed-capacity FIFO. Keeps rolling windows from growing without bound. */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  /** Drop entries the predicate rejects. Used to age out a time window. */
  prune(keep: (item: T) => boolean): void {
    this.items = this.items.filter(keep);
  }

  toArray(): T[] {
    return this.items.slice();
  }

  get length(): number {
    return this.items.length;
  }
}

/**
 * Serialises calls so one slow pass cannot overlap the next. The listener poll loop and
 * the exit engine's mark refresh both re-enter on a timer, and overlapping runs would
 * double-process events or double-submit an exit.
 */
export function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T,>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn, fn);
    chain = result.catch(() => undefined);
    return result;
  };
}

/** JSON.stringify that survives bigint, for logging and API responses. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
}
