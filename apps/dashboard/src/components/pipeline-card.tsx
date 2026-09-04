"use client";

import * as React from "react";
import { cn } from "cn";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/format";
import type { BotState } from "@/lib/types";

/**
 * Throughput at each stage, top to bottom.
 *
 * The counts are cumulative for the process lifetime and the drop between adjacent rows
 * is the point: it shows where the funnel actually narrows, which is the fastest way to
 * tell a badly-tuned threshold from a quiet market.
 */
export function PipelineCard({ state }: { state: BotState | null }) {
  if (!state) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <div className="space-y-2 px-4 pb-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  const s = state.stats;
  const stages: Array<{
    label: string;
    value: number;
    detail: string;
    tone?: "warn" | "bad";
  }> = [
    {
      label: "Launches seen",
      value: s.listener.launchesSeen,
      detail: `${formatCount(s.listener.launchesSkipped)} skipped on quote asset`,
    },
    {
      label: "Curves tracked",
      value: s.listener.trackedCurves,
      detail: `${formatCount(s.listener.tradesSeen)} trades · ${formatCount(s.listener.graduations)} graduated`,
    },
    {
      label: "Vetted",
      value: s.vetting.vetted,
      detail: `${formatCount(s.vetting.passed)} sellable · ${formatCount(s.vetting.honeypots)} honeypots`,
      tone: s.vetting.simulationUnavailable > 0 ? "warn" : undefined,
    },
    {
      label: "Demand signals",
      value: s.walletTracker.signalsEmitted,
      detail: `${formatCount(s.walletTracker.authentic)} authentic · ${formatCount(s.walletTracker.rejected)} filtered`,
    },
    {
      label: "Entries evaluated",
      value: s.decision.evaluated,
      detail: `${formatCount(s.decision.rejected)} rejected`,
    },
    {
      label: "Positions opened",
      value: s.decision.scoutEntries + s.decision.confirmEntries,
      detail: `${formatCount(s.decision.scoutEntries)} scout · ${formatCount(s.decision.confirmEntries)} confirm`,
    },
    {
      label: "Orders filled",
      value: s.execution.filled,
      detail: `${formatCount(s.execution.rejected)} risk-rejected · ${formatCount(s.execution.failed)} failed`,
      tone: s.execution.failed > 0 ? "bad" : undefined,
    },
  ];

  const peak = Math.max(1, ...stages.map((stage) => stage.value));
  const lag = state.stats.listener.curves?.lagBlocks ?? state.stats.listener.factory?.lagBlocks ?? 0;
  const scanErrors =
    (s.listener.factory?.errors ?? 0) + (s.listener.curves?.errors ?? 0);

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Pipeline throughput</CardTitle>
        <CardDescription className="text-xs">
          Cumulative since start. Each row is a stage; the gap to the row below is what
          that stage filtered out.
        </CardDescription>
      </CardHeader>

      <ul className="border-t border-border/70">
        {stages.map((stage) => (
          <li key={stage.label} className="px-4 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-foreground/90">{stage.label}</span>
              <span
                className={cn(
                  "tnum text-sm font-medium",
                  stage.tone === "bad" && "text-loss",
                  stage.tone === "warn" && "text-caution",
                )}
              >
                {formatCount(stage.value)}
              </span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-700",
                  stage.tone === "bad"
                    ? "bg-loss/70"
                    : stage.tone === "warn"
                      ? "bg-caution/70"
                      : "bg-primary/60",
                )}
                style={{ width: `${(stage.value / peak) * 100}%` }}
              />
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{stage.detail}</p>
          </li>
        ))}
      </ul>

      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border/70 px-4 pt-3 text-xs">
        <Detail label="RPC tier" value={state.chain.rpcTier} warn={state.chain.rpcTier === "public"} />
        <Detail
          label="Scanner lag"
          value={`${formatCount(lag)} blocks`}
          warn={lag > 200}
        />
        <Detail
          label="Scan errors"
          value={formatCount(scanErrors)}
          warn={scanErrors > 0}
        />
        <Detail
          label="Funding lookups"
          value={`${formatCount(s.walletTracker.fundingCoverage.resolved)} done · ${formatCount(s.walletTracker.fundingCoverage.queued)} queued`}
        />
        <Detail label="Deployers known" value={formatCount(s.deployerGraph.deployersKnown)} />
        <Detail label="Clusters" value={formatCount(s.deployerGraph.clusters)} />
      </div>

      {!state.chain.sequencerOrderingConfirmed ? (
        <p className="mx-4 mb-1 rounded-md bg-caution/10 px-3 py-2 text-xs text-caution">
          Sequencer ordering is not confirmed in{" "}
          <code className="font-mono">config/chain.json</code>. Latency-sensitive entries
          assume first-come-first-served; verify against the chain docs before relying on
          speed as an edge.
        </p>
      ) : null}
    </Card>
  );
}

function Detail({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-muted-foreground">{label}</p>
      <p className={cn("tnum truncate font-medium", warn ? "text-caution" : "text-foreground/90")}>
        {value}
      </p>
    </div>
  );
}
