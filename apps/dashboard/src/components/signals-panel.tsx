"use client";

import { Filter, Users } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { AddressLink, EmptyState, SectionLabel } from "@/components/primitives";
import { TableSkeleton } from "@/components/positions-panel";
import { formatAge, humanise } from "@/lib/format";
import type { SignalsResponse, WalletSignal } from "@/lib/types";

/**
 * Why the bot did not buy, and what the wash-trade filter made of the demand it saw.
 *
 * The rejection feed is the most useful panel during a paper run: a pipeline that
 * rejects everything for one repeated reason is a misconfigured threshold, not a quiet
 * market, and that distinction is invisible from the P&L alone.
 */
export function SignalsPanel({
  data,
  loading,
  explorer,
}: {
  data: SignalsResponse | null;
  loading: boolean;
  explorer?: string;
}) {
  if (loading && !data) return <TableSkeleton rows={6} />;

  const rejections = data?.rejections ?? [];
  const walletSignals = data?.walletSignals ?? [];
  const topClusters = data?.topClusters ?? [];
  const topWallets = data?.topWallets ?? [];

  const everythingEmpty =
    rejections.length === 0 &&
    walletSignals.length === 0 &&
    topClusters.length === 0 &&
    topWallets.length === 0;

  if (everythingEmpty) {
    return (
      <EmptyState
        icon={Filter}
        title="No decisions made yet"
        hint="Entry rejections, authenticity checks, and the deployer clusters the graph has found all appear here once launches start flowing through the pipeline."
      />
    );
  }

  return (
    <div className="grid gap-0 divide-y divide-border/70 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
      <div className="min-w-0">
        <SectionLabel count={rejections.length}>Entry rejections</SectionLabel>
        {rejections.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            Nothing rejected in this window.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {rejections.map((r, i) => (
              <li
                key={`${r.tokenAddress}-${r.timestamp}-${i}`}
                className="flex items-start gap-3 px-4 py-2"
              >
                <Badge
                  variant="outline"
                  className="mt-0.5 shrink-0 font-mono text-[10px] tracking-wide uppercase"
                >
                  {r.stage}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground/90">{r.reason}</p>
                  <AddressLink address={r.tokenAddress} explorer={explorer} />
                </div>
                <span className="tnum shrink-0 pt-0.5 text-xs text-muted-foreground">
                  {formatAge(r.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <SectionLabel count={walletSignals.length}>Authenticity checks</SectionLabel>
        {walletSignals.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No tracked-wallet buys observed yet. The tracker credits wallets that enter
            early on tokens that go on to graduate, so this list starts empty on a fresh
            database.
          </p>
        ) : (
          <ul className="divide-y divide-border/40 pb-2">
            {walletSignals.map((s, i) => (
              <SignalRow key={`${s.tokenAddress}-${s.timestamp}-${i}`} signal={s} explorer={explorer} />
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0">
        <SectionLabel count={topClusters.length}>Deployer clusters</SectionLabel>
        {topClusters.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No multi-wallet clusters found yet. Clustering needs two deployers funded by
            the same source, which takes a while to accumulate.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {topClusters.map((c) => (
              <li key={c.clusterId} className="flex items-center gap-3 px-4 py-2">
                <Users className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {c.clusterId.replace(/^solo:/, "")}
                </span>
                <span className="tnum shrink-0 text-xs">
                  {c.size} wallets
                  <span className="text-muted-foreground">
                    {" "}
                    · {c.launches} launches · {c.graduated} grad
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <SectionLabel count={topWallets.length}>Tracked wallets</SectionLabel>
        {topWallets.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            The tracked-wallet list is built from observed behaviour rather than seeded
            from a hardcoded list, so it fills in as tokens graduate during the run.
          </p>
        ) : (
          <ul className="divide-y divide-border/40 pb-2">
            {topWallets.map((w) => (
              <li key={w.address} className="flex items-center gap-3 px-4 py-2">
                <AddressLink
                  address={w.address}
                  explorer={explorer}
                  className="min-w-0 flex-1"
                />
                <span className="tnum shrink-0 text-xs text-muted-foreground">
                  {w.profitable_entries}/{w.total_entries} early wins
                </span>
                <span className="tnum w-10 shrink-0 text-right text-xs font-medium text-primary">
                  {w.score.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SignalRow({ signal, explorer }: { signal: WalletSignal; explorer?: string }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase",
            signal.authentic ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss",
          )}
        >
          {signal.authentic ? "authentic" : "spoof-risk"}
        </span>
        <AddressLink address={signal.tokenAddress} explorer={explorer} className="flex-1" />
        <span className="tnum text-xs text-muted-foreground">
          {formatAge(signal.timestamp)}
        </span>
      </div>

      <div className="tnum mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Metric label="Unique buyers" value={String(signal.uniqueBuyerCount)} />
        <Metric label="Velocity" value={`${signal.uniqueBuyerVelocity.toFixed(1)}/min`} />
        <Metric
          label="Gini"
          value={signal.concentrationScore.toFixed(2)}
          warn={signal.concentrationScore > 0.82}
        />
        <Metric
          label="Shared funding"
          value={`${(signal.sharedFundingVolumeShare * 100).toFixed(0)}%`}
          warn={signal.sharedFundingVolumeShare > 0.4}
        />
      </div>

      {signal.rejections.length > 0 ? (
        <p className="mt-1 text-xs text-loss/80">
          {signal.rejections.map(humanise).join(" · ")}
        </p>
      ) : null}
    </li>
  );
}

function Metric({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <span>
      {label}{" "}
      <span className={cn("font-medium", warn ? "text-caution" : "text-foreground/85")}>
        {value}
      </span>
    </span>
  );
}
