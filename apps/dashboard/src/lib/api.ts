"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The bot's operator API binds to loopback by default (see `config/bot.json`). The
 * dashboard is a pure client of it: every request originates in the browser, so this
 * value has to be reachable from the operator's machine, not from the Next server.
 */
export const BOT_API =
  process.env.NEXT_PUBLIC_BOT_API?.replace(/\/$/, "") ?? "http://127.0.0.1:43117";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BOT_API}${path}`, { signal, cache: "no-store" });
  if (!res.ok) throw new ApiError(`${path} returned ${res.status}`, res.status);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BOT_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new ApiError(`${path} returned ${res.status}`, res.status);
  return (await res.json()) as T;
}

export interface PollResult<T> {
  data: T | null;
  /** True only before the first successful response, so refreshes do not flash skeletons. */
  loading: boolean;
  error: string | null;
  /** Wall-clock of the last successful response, for the staleness indicator. */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Poll one endpoint on an interval.
 *
 * Deliberately not SWR or React Query: there are four endpoints, no mutations to
 * invalidate, and no cache to share. What this does need — and what makes it worth
 * writing out — is that a failed poll keeps the last good data on screen instead of
 * blanking the console, since a momentarily unreachable bot is not the same thing as a
 * bot with no positions.
 */
export function usePoll<T>(path: string, intervalMs = 2000): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Avoids a stale in-flight response overwriting a newer one after a manual refresh.
  const generation = useRef(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const mine = ++generation.current;

    const tick = async () => {
      try {
        const next = await apiGet<T>(path, controller.signal);
        if (cancelled || generation.current !== mine) return;
        setData(next);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (cancelled || (err as Error).name === "AbortError") return;
        setError(
          err instanceof ApiError
            ? err.message
            : `Cannot reach the bot at ${BOT_API}`,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [path, intervalMs, nonce]);

  return { data, loading, error, updatedAt, refresh };
}
