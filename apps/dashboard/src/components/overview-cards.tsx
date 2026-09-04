"use client";

import * as React from "react";
import { cn } from "cn";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Delta } from "@/components/primitives";
import { formatCount, formatPct, formatUsd } from "@/lib/format";
import type { BotState } from "@/lib/types";

export function OverviewCards({ state }: { state: BotState | null }) {
  if (!state) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} size="sm" className="gap-2">
            <div className="px-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-6 w-24" />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  const pnlUsd = state.equityUsd - state.startingEquityUsd;
  const pnlPct =
    state.startingEquityUsd > 0 ? (pnlUsd / state.startingEquityUsd) * 100 : 0;
  const { risk, evaluation } = state;
  const exposureUsed = risk.maxConcurrentPositions
    ? risk.openPositions / risk.maxConcurrentPositions
    : 0;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat
        label="Equity"
        value={formatUsd(state.equityUsd)}
        foot={
          <span className="flex items-center gap-1.5">
            <Delta value={pnlUsd} />
            <span className="text-muted-foreground/50">·</span>
            <Delta value={pnlPct} kind="pct" />
          </span>
        }
      />

      <Stat
        label="Open positions"
        value={`${risk.openPositions} / ${risk.maxConcurrentPositions}`}
        foot={
          <span className="flex items-center gap-2">
            <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary/70"
                style={{ width: `${Math.min(1, exposureUsed) * 100}%` }}
              />
            </span>
            <span className="text-muted-foreground">
              {formatCount(risk.tradesToday)} trades today
            </span>
          </span>
        }
      />

      <Stat
        label="Session P&L"
        value={<Delta value={pnlUsd} className="text-2xl font-semibold" />}
        foot={
          <span className="text-muted-foreground">
            {evaluation.wins}W / {evaluation.losses}L ·{" "}
            {evaluation.trades > 0 ? formatPct(evaluation.winRate * 100, 0) : "no"} win rate
          </span>
        }
      />

      <Stat
        label="Max drawdown"
        value={formatPct(evaluation.maxDrawdownPct)}
        tone={evaluation.maxDrawdownPct > 0 ? "warn" : "neutral"}
        foot={
          <span className="text-muted-foreground">
            Day {formatPct(risk.dailyDrawdownPct)} of{" "}
            {formatUsd(Number(risk.dailyLossLimitQuote))} limit
          </span>
        }
      />

      <Stat
        label="Go / no-go"
        value={
          <span
            className={cn(
              "text-2xl font-semibold",
              evaluation.verdict === "go" && "text-profit",
              evaluation.verdict === "no-go" && "text-loss",
              evaluation.verdict === "in-progress" && "text-caution",
            )}
          >
            {VERDICT_LABEL[evaluation.verdict]}
          </span>
        }
        foot={
          <span className="text-muted-foreground">
            {evaluation.criteria.filter((c) => c.met).length}/{evaluation.criteria.length}{" "}
            criteria met
          </span>
        }
      />
    </div>
  );
}

const VERDICT_LABEL = {
  go: "Go",
  "no-go": "No-go",
  "in-progress": "Running",
} as const;

function Stat({
  label,
  value,
  foot,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  foot?: React.ReactNode;
  tone?: "neutral" | "warn";
}) {
  return (
    <Card
      size="sm"
      className={cn("gap-1.5", tone === "warn" && "ring-caution/25")}
    >
      <div className="px-3">
        <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
          {label}
        </p>
        <div className="tnum mt-1 text-2xl leading-none font-semibold">{value}</div>
        {foot ? <div className="tnum mt-2 text-xs">{foot}</div> : null}
      </div>
    </Card>
  );
}
