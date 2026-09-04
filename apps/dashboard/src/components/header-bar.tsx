"use client";

import * as React from "react";
import {
  Activity,
  CircleSlash,
  Loader2,
  Pause,
  Play,
  ShieldAlert,
  Waves,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { apiPost } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import type { BotState } from "@/lib/types";

type ControlAction = "pause" | "resume" | "kill" | "flatten";

export function HeaderBar({
  state,
  connected,
  onMutated,
}: {
  state: BotState | null;
  connected: boolean;
  onMutated: () => void;
}) {
  const [pending, setPending] = React.useState<ControlAction | null>(null);
  const halted = state?.risk.halted ?? false;

  async function run(action: ControlAction, confirmMessage?: string) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setPending(action);
    try {
      await apiPost(`/api/control/${action}`);
      toast.success(CONTROL_COPY[action].done);
      onMutated();
    } catch (err) {
      toast.error(CONTROL_COPY[action].failed, {
        description: (err as Error).message,
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/12 ring-1 ring-primary/25">
            <Waves className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm leading-tight font-semibold">
              Robinhood Chain meme bot
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {state
                ? `${state.chain.name} · ${state.chain.id} · ${state.launchpads.find((l) => l.primary)?.name ?? "no launchpad"}`
                : "Connecting to operator API…"}
            </p>
          </div>
        </div>

        <ModeBadge mode={state?.mode} />

        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="text-right">
            <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Equity
            </p>
            <p className="tnum text-sm leading-tight font-semibold">
              {state ? formatUsd(state.equityUsd) : "—"}
            </p>
          </div>

          <Separator orientation="vertical" className="hidden h-8 sm:block" />

          <ConnectionPill connected={connected} halted={halted} />

          <div className="flex items-center gap-1.5">
            {halted ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void run("resume")}
              >
                {pending === "resume" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null || !state}
                onClick={() => void run("pause")}
              >
                {pending === "pause" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Pause data-icon="inline-start" />
                )}
                Pause
              </Button>
            )}

            <Button
              size="sm"
              variant="secondary"
              disabled={pending !== null || !state}
              onClick={() =>
                void run(
                  "flatten",
                  "Sell every open position at the current mark. Entries stay enabled. Continue?",
                )
              }
            >
              {pending === "flatten" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <CircleSlash data-icon="inline-start" />
              )}
              Flatten
            </Button>

            <Button
              size="sm"
              variant="destructive"
              disabled={pending !== null || !state}
              onClick={() =>
                void run(
                  "kill",
                  "KILL SWITCH: flatten every position and block all new entries until manually resumed. Continue?",
                )
              }
            >
              {pending === "kill" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ShieldAlert data-icon="inline-start" />
              )}
              Kill
            </Button>
          </div>
        </div>
      </div>

      {state?.risk.halted ? (
        <div className="border-t border-loss/25 bg-loss/10">
          <p className="mx-auto max-w-[1600px] px-4 py-1.5 text-xs text-loss sm:px-6">
            Trading halted — {state.risk.haltReason ?? "no reason recorded"}.
            {state.risk.killSwitchEngaged
              ? " Kill switch file is present; Resume clears it."
              : ""}
          </p>
        </div>
      ) : null}
    </header>
  );
}

function ModeBadge({ mode }: { mode: BotState["mode"] | undefined }) {
  if (!mode) return null;
  const live = mode === "live";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 gap-1.5 px-2.5 font-mono text-[11px] tracking-wider uppercase",
        live
          ? "border-loss/50 bg-loss/15 text-loss"
          : "border-caution/40 bg-caution/10 text-caution",
      )}
      title={
        live
          ? "Live mode: the execution service signs and broadcasts real transactions."
          : "Paper mode: reads real mainnet state and prices real fills, but never signs a transaction."
      }
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          live ? "bg-loss pulse-dot" : "bg-caution",
        )}
      />
      {live ? "Live capital" : "Paper"}
    </Badge>
  );
}

function ConnectionPill({ connected, halted }: { connected: boolean; halted: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={connected ? "Polling the operator API" : "No response from the operator API"}
    >
      {connected ? (
        <span
          className={cn(
            "size-1.5 rounded-full",
            halted ? "bg-caution" : "bg-primary pulse-dot",
          )}
        />
      ) : (
        <Activity className="size-3.5 text-loss" />
      )}
      <span className="hidden sm:inline">{connected ? "Live feed" : "Disconnected"}</span>
    </div>
  );
}

const CONTROL_COPY: Record<ControlAction, { done: string; failed: string }> = {
  pause: { done: "Entries paused", failed: "Could not pause" },
  resume: { done: "Trading resumed", failed: "Could not resume" },
  kill: { done: "Kill switch engaged — positions flattened", failed: "Kill switch failed" },
  flatten: { done: "Flatten requested for all open positions", failed: "Could not flatten" },
};
