"use client";

import * as React from "react";
import { ArrowUpRight, Inbox, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { formatSignedPct, formatSignedUsd, shortAddress } from "@/lib/format";

/** A monospaced address that links out to the chain explorer when one is configured. */
export function AddressLink({
  address,
  explorer,
  kind = "address",
  label,
  className,
  lead = 6,
  tail = 4,
}: {
  address: string | null | undefined;
  explorer?: string;
  kind?: "address" | "tx";
  label?: string;
  className?: string;
  lead?: number;
  tail?: number;
}) {
  const text = label ?? shortAddress(address, lead, tail);
  if (!address) return <span className={cn("text-muted-foreground", className)}>—</span>;
  if (!explorer) {
    return <span className={cn("font-mono text-xs", className)}>{text}</span>;
  }
  return (
    <a
      href={`${explorer.replace(/\/$/, "")}/${kind === "tx" ? "tx" : "address"}/${address}`}
      target="_blank"
      rel="noreferrer noopener"
      title={address}
      className={cn(
        "group inline-flex items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      {text}
      <ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-70" />
    </a>
  );
}

/** Signed money or percentage. The sign carries the meaning; colour only reinforces it. */
export function Delta({
  value,
  kind = "usd",
  className,
  digits,
}: {
  value: number;
  kind?: "usd" | "pct";
  className?: string;
  digits?: number;
}) {
  const text =
    kind === "usd"
      ? formatSignedUsd(value, digits ?? 2)
      : formatSignedPct(value, digits ?? 2);
  return (
    <span
      className={cn(
        "tnum",
        value > 0 && "text-profit",
        value < 0 && "text-loss",
        value === 0 && "text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  icon: Icon = Inbox,
}: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon className="size-5 text-muted-foreground/60" />
      <p className="text-sm text-foreground/80">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <TriangleAlert className="size-5 text-caution" />
      <p className="text-sm text-foreground/90">{message}</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        The bot process may not be running. Start it with{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">npm run dev:bot</code>.
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
        >
          Retry now
        </button>
      ) : null}
    </div>
  );
}

/**
 * Curve fill toward the graduation threshold.
 *
 * Deliberately not the shadcn `Progress`: this renders once per table row and the
 * threshold marker at 100% is the whole point — a curve at 92% is about to open real
 * Uniswap v4 liquidity, which is a different situation from one at 20%.
 */
export function CurveProgress({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const near = pct >= 85;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="relative h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progress toward graduation"
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            near ? "bg-caution" : "bg-primary/70",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn("tnum w-10 shrink-0 text-right text-xs", near ? "text-caution" : "text-muted-foreground")}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

/** 0..1 score rendered as a compact meter. Used for deployer and authenticity scores. */
export function ScoreMeter({
  score,
  confidence,
  label,
}: {
  score: number;
  confidence?: number;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, score)) * 100;
  const tone = pct >= 60 ? "bg-primary" : pct >= 40 ? "bg-caution" : "bg-loss";
  return (
    <div className="flex items-center gap-2" title={label}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="tnum text-xs text-muted-foreground">
        {score.toFixed(2)}
        {confidence !== undefined ? (
          // Score without confidence is a trap: a brand-new deployer scores neutral.
          <span className="text-muted-foreground/60"> ±{(1 - confidence).toFixed(1)}</span>
        ) : null}
      </span>
    </div>
  );
}

export function StageBadge({ stage }: { stage: "scout" | "confirm" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[10px] tracking-wide uppercase",
        stage === "confirm" ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
      )}
    >
      {stage}
    </Badge>
  );
}

/** Section heading used above tables inside panels. */
export function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {children}
      </h3>
      {count !== undefined ? (
        <span className="tnum text-xs text-muted-foreground/60">{count}</span>
      ) : null}
    </div>
  );
}
