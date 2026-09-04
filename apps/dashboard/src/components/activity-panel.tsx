"use client";

import * as React from "react";
import { ArrowDownLeft, ArrowUpRight, GraduationCap, ScrollText } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { AddressLink, EmptyState, SectionLabel } from "@/components/primitives";
import { TableSkeleton } from "@/components/positions-panel";
import { formatAge, formatClock, formatUnits, humanise, shortAddress } from "@/lib/format";
import type { ActivityResponse, LogRecord } from "@/lib/types";

export function ActivityPanel({
  data,
  loading,
  explorer,
}: {
  data: ActivityResponse | null;
  loading: boolean;
  explorer?: string;
}) {
  if (loading && !data) return <TableSkeleton rows={6} />;

  const fills = data?.fills ?? [];
  const exits = data?.exits ?? [];
  const graduations = data?.graduations ?? [];
  const logs = data?.logs ?? [];

  return (
    <div className="grid gap-0 divide-y divide-border/70 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
      <div className="min-w-0">
        <SectionLabel count={fills.length}>Fills</SectionLabel>
        {fills.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No fills yet. Paper fills are priced against real curve reserves, so they carry
            the same slippage a live order would have taken.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {fills.map((f, i) => (
              <li
                key={`${f.intentId}-${f.timestamp}-${i}`}
                className="flex items-center gap-3 px-4 py-2"
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded",
                    f.side === "buy" ? "bg-profit/12 text-profit" : "bg-loss/12 text-loss",
                  )}
                >
                  {f.side === "buy" ? (
                    <ArrowDownLeft className="size-3" />
                  ) : (
                    <ArrowUpRight className="size-3" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="tnum truncate text-sm">
                    {f.side === "buy" ? "Bought" : "Sold"}{" "}
                    <span className="font-medium">
                      {formatUnits(f.quoteAmount, f.quoteAsset.decimals, 5)}{" "}
                      {f.quoteAsset.symbol}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      of {shortAddress(f.tokenAddress, 6, 4)}
                    </span>
                  </p>
                  <p className="tnum text-xs text-muted-foreground">
                    {f.venue === "curve" ? "Bonding curve" : "Uniswap v4"} ·{" "}
                    {f.slippageBps.toFixed(0)} bps slippage
                    {f.mode === "paper" ? " · simulated" : ""}
                  </p>
                </div>
                {f.txHash ? (
                  <AddressLink
                    address={f.txHash}
                    explorer={explorer}
                    kind="tx"
                    className="shrink-0"
                  />
                ) : null}
                <span className="tnum shrink-0 text-xs text-muted-foreground">
                  {formatAge(f.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <SectionLabel count={exits.length}>Exit signals</SectionLabel>
        {exits.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No exits triggered yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {exits.map((e, i) => (
              <li
                key={`${e.positionId}-${e.timestamp}-${i}`}
                className="flex items-center gap-3 px-4 py-2"
              >
                <Badge variant="outline" className="shrink-0 text-[11px]">
                  {humanise(e.reason)}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="tnum truncate text-sm text-foreground/90">{e.detail}</p>
                  <AddressLink address={e.tokenAddress} explorer={explorer} />
                </div>
                <span className="tnum shrink-0 text-xs">
                  {(e.fraction * 100).toFixed(0)}% @ {e.currentMultiple.toFixed(2)}×
                </span>
              </li>
            ))}
          </ul>
        )}

        <SectionLabel count={graduations.length}>Graduations</SectionLabel>
        {graduations.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No curve has graduated to a Uniswap v4 pool during this session.
          </p>
        ) : (
          <ul className="divide-y divide-border/40 pb-2">
            {graduations.map((g, i) => (
              <li
                key={`${g.tokenAddress}-${i}`}
                className="flex items-center gap-3 px-4 py-2"
              >
                <GraduationCap className="size-3.5 shrink-0 text-caution" />
                <div className="min-w-0 flex-1">
                  <AddressLink address={g.tokenAddress} explorer={explorer} />
                  <p className="tnum text-xs text-muted-foreground">
                    Seeded {formatUnits(g.quoteSeeded, g.quoteAsset.decimals, 4)}{" "}
                    {g.quoteAsset.symbol} into a locked v4 pool
                  </p>
                </div>
                <span className="tnum shrink-0 text-xs text-muted-foreground">
                  {formatAge(g.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex min-w-0 flex-col">
        <SectionLabel count={logs.length}>Process log</SectionLabel>
        {logs.length === 0 ? (
          <EmptyState icon={ScrollText} title="No log records buffered" />
        ) : (
          <div className="max-h-[36rem] flex-1 overflow-y-auto pb-2 font-mono text-xs">
            {logs.map((record, i) => (
              <LogLine key={`${record.time}-${i}`} record={record} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LogLine({ record }: { record: LogRecord }) {
  const fields = record.fields ? Object.entries(record.fields) : [];
  return (
    <div className="flex gap-2 px-4 py-1 hover:bg-muted/40">
      <span className="shrink-0 text-muted-foreground/60">
        {formatClock(Date.parse(record.time))}
      </span>
      <span
        className={cn(
          "w-10 shrink-0 uppercase",
          record.level === "error" && "text-loss",
          record.level === "warn" && "text-caution",
          record.level === "info" && "text-muted-foreground",
          record.level === "debug" && "text-muted-foreground/50",
        )}
      >
        {record.level}
      </span>
      <span className="w-24 shrink-0 truncate text-primary/70">{record.scope}</span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground/90">{record.msg}</span>
        {fields.length > 0 ? (
          <span className="ml-2 text-muted-foreground/70">
            {fields
              .map(([key, value]) => `${key}=${formatLogValue(value)}`)
              .join(" ")}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function formatLogValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 38)}…` : value;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
  return String(value);
}
