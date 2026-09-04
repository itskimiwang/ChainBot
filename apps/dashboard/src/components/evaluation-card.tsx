"use client";

import { Check, Minus } from "lucide-react";
import { cn } from "cn";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/format";
import type { EvaluationReport } from "@/lib/types";

/**
 * The paper-to-live gate.
 *
 * The criteria come from `config/bot.json` and were written before the run started. This
 * panel only reports them, and it shows every criterion including the ones that pass, so
 * the decision to flip modes stays a lookup rather than a read of the P&L number.
 */
export function EvaluationCard({ report }: { report: EvaluationReport | null }) {
  if (!report) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <div className="space-y-2 px-4 pb-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  const progress = Math.min(1, report.elapsedHours / report.windowHours);
  const metCount = report.criteria.filter((c) => c.met).length;

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Paper → live gate</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase",
              report.verdict === "go" && "bg-profit/15 text-profit",
              report.verdict === "no-go" && "bg-loss/15 text-loss",
              report.verdict === "in-progress" && "bg-caution/15 text-caution",
            )}
          >
            {report.verdict}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          {metCount} of {report.criteria.length} criteria met. All must pass before the
          mode flag is flipped by hand.
        </CardDescription>
      </CardHeader>

      <div className="px-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Evaluation window</span>
          <span className="tnum">
            {formatDuration(report.elapsedHours)} / {formatDuration(report.windowHours)}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/70 transition-all duration-700"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      <ul className="divide-y divide-border/70 border-t border-border/70">
        {report.criteria.map((criterion) => (
          <li
            key={criterion.id}
            className="flex items-center gap-3 px-4 py-2 text-sm"
          >
            <CriterionIcon met={criterion.met} />
            <span className="min-w-0 flex-1 truncate text-foreground/90">
              {criterion.label}
            </span>
            <span className="tnum shrink-0 text-xs text-muted-foreground">
              {criterion.target}
            </span>
            <span
              className={cn(
                "tnum w-16 shrink-0 text-right text-xs font-medium",
                criterion.met ? "text-profit" : "text-caution",
              )}
            >
              {criterion.actual}
            </span>
          </li>
        ))}
      </ul>

      {report.verdict === "go" ? (
        <p className="mx-4 mb-1 rounded-md bg-profit/10 px-3 py-2 text-xs text-profit">
          Every criterion passed. Flipping to live is a manual edit of{" "}
          <code className="font-mono">mode</code> in{" "}
          <code className="font-mono">config/bot.json</code> plus a restart — on purpose.
        </p>
      ) : null}
    </Card>
  );
}

function CriterionIcon({ met }: { met: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full",
        met ? "bg-profit/15 text-profit" : "bg-muted text-muted-foreground",
      )}
      aria-label={met ? "Met" : "Not met"}
    >
      {met ? <Check className="size-2.5" /> : <Minus className="size-2.5" />}
    </span>
  );
}
