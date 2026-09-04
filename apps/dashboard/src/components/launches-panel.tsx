"use client";

import * as React from "react";
import { Radar, ShieldCheck, ShieldX, ShieldQuestion } from "lucide-react";
import { cn } from "cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  AddressLink,
  CurveProgress,
  EmptyState,
  ScoreMeter,
} from "@/components/primitives";
import { TableSkeleton } from "@/components/positions-panel";
import { formatAge, formatBps, formatCount, humanise, shortAddress } from "@/lib/format";
import type { LaunchesResponse, TrackedLaunch, VettingResult } from "@/lib/types";

/**
 * Every curve the listener currently tracks, sorted by how close it is to graduation.
 *
 * This is the funnel view: what the bot can see, what vetting made of it, and what the
 * deployer graph knows about who launched it. A token appearing here with a green shield
 * and a good deployer score but no position means the decision engine rejected it for a
 * reason visible in the Signals tab.
 */
export function LaunchesPanel({
  data,
  loading,
  explorer,
}: {
  data: LaunchesResponse | null;
  loading: boolean;
  explorer?: string;
}) {
  if (loading && !data) return <TableSkeleton rows={8} />;

  const tracked = data?.tracked ?? [];

  if (tracked.length === 0) {
    return (
      <EmptyState
        icon={Radar}
        title="No live curves tracked"
        hint="The listener subscribes to the Pons factory and then to each new bonding curve. Curves are evicted after a period with no trades, so an empty list means the chain is quiet right now."
      />
    );
  }

  return (
    <Table className="[&_td]:px-4">
      <TableHeader>
        <TableRow className="border-border/70 hover:bg-transparent">
          <Th>Token</Th>
          <Th>Vetting</Th>
          <Th className="w-40">Graduation</Th>
          <Th align="right">Trades</Th>
          <Th>Deployer</Th>
          <Th>Cluster</Th>
          <Th align="right">Age</Th>
          <Th align="right">Last trade</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tracked.map((launch) => (
          <LaunchRow key={launch.tokenAddress} launch={launch} explorer={explorer} />
        ))}
      </TableBody>
    </Table>
  );
}

function LaunchRow({ launch, explorer }: { launch: TrackedLaunch; explorer?: string }) {
  const near = launch.progress >= 0.85;
  return (
    <TableRow className={cn("border-border/50", near && "bg-caution/[0.04]")}>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            {launch.symbol ?? shortAddress(launch.tokenAddress)}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              /{launch.quoteAsset}
            </span>
          </span>
          <AddressLink address={launch.tokenAddress} explorer={explorer} />
        </div>
      </TableCell>

      <TableCell>
        <VettingCell result={launch.vetting} />
      </TableCell>

      <TableCell className="w-40">
        <CurveProgress value={launch.progress} />
      </TableCell>

      <TableCell className="tnum text-right text-sm">
        {formatCount(launch.tradeCount)}
      </TableCell>

      <TableCell>
        <ScoreMeter
          score={launch.deployer.score}
          confidence={launch.deployer.confidence}
          label={launch.deployer.reasons.join(" · ")}
        />
      </TableCell>

      <TableCell>
        <ClusterCell launch={launch} />
      </TableCell>

      <TableCell className="tnum text-right text-xs text-muted-foreground">
        {formatAge(launch.launchedAt)}
      </TableCell>

      <TableCell className="tnum text-right text-xs text-muted-foreground">
        {launch.lastTradeAt ? formatAge(launch.lastTradeAt) : "—"}
      </TableCell>
    </TableRow>
  );
}

function VettingCell({ result }: { result: VettingResult | null }) {
  if (!result) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldQuestion className="size-3.5" />
        Pending
      </span>
    );
  }

  if (result.passVetting) {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-profit"
        title={`Checks run: ${result.checksRun.join(", ")}`}
      >
        <ShieldCheck className="size-3.5" />
        Sellable
        {result.sellTax > 0 ? (
          <span className="text-muted-foreground">· {formatBps(result.sellTax)} sell</span>
        ) : null}
      </span>
    );
  }

  const headline = result.failures[0];
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-loss"
      title={result.failures.map(humanise).join(" · ")}
    >
      <ShieldX className="size-3.5" />
      {headline ? humanise(headline) : "Failed"}
      {result.failures.length > 1 ? (
        <span className="text-muted-foreground">+{result.failures.length - 1}</span>
      ) : null}
    </span>
  );
}

function ClusterCell({ launch }: { launch: TrackedLaunch }) {
  const { deployer } = launch;
  const solo = deployer.clusterId.startsWith("solo:");

  if (deployer.isKnownRugCluster) {
    return (
      <Badge variant="outline" className="border-loss/40 text-[11px] text-loss">
        Rug cluster · {deployer.clusterSize}
      </Badge>
    );
  }

  if (solo) {
    return (
      <span className="text-xs text-muted-foreground">
        {deployer.priorLaunchCount > 0
          ? `Solo · ${deployer.priorLaunchCount} prior`
          : "Unlinked wallet"}
      </span>
    );
  }

  return (
    <span
      className="text-xs text-foreground/80"
      title={`Funding source: ${deployer.fundingSource ?? "unknown"} (${deployer.fundingSourceKind})`}
    >
      {deployer.clusterSize} wallets · {deployer.clusterLaunchCount} launches
      {deployer.clusterLaunchCount > 0 ? (
        <span className="text-muted-foreground">
          {" "}
          · {(deployer.clusterSuccessRate * 100).toFixed(0)}% grad
        </span>
      ) : null}
    </span>
  );
}

function Th({
  children,
  align = "left",
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <TableHead
      className={cn(
        "px-4 text-[10px] font-medium tracking-wider text-muted-foreground uppercase",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}
