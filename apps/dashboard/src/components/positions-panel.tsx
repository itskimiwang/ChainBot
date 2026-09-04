"use client";

import * as React from "react";
import { Wallet } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  AddressLink,
  EmptyState,
  SectionLabel,
  StageBadge,
} from "@/components/primitives";
import {
  formatAge,
  formatMultiple,
  formatUnits,
  formatUsd,
  humanise,
} from "@/lib/format";
import type { Position, PositionsResponse } from "@/lib/types";

export function PositionsPanel({
  data,
  loading,
  explorer,
}: {
  data: PositionsResponse | null;
  loading: boolean;
  explorer?: string;
}) {
  if (loading && !data) return <TableSkeleton rows={4} />;

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const stranded = data?.stranded ?? [];

  if (open.length === 0 && closed.length === 0 && stranded.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="No positions yet"
        hint="The decision engine opens a scout position once a launch clears vetting, has an acceptable deployer score, and shows real demand. Watch the Launches tab to see what is being considered."
      />
    );
  }

  return (
    <div className="divide-y divide-border/70">
      <div>
        <SectionLabel count={open.length}>Open</SectionLabel>
        {open.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            Nothing open right now.
          </p>
        ) : (
          <Table className="[&_td]:px-4">
            <TableHeader>
              <TableRow className="border-border/70 hover:bg-transparent">
                <Th>Token</Th>
                <Th>Stage</Th>
                <Th align="right">Invested</Th>
                <Th align="right">Multiple</Th>
                <Th align="right">Peak</Th>
                <Th align="right">Unrealised</Th>
                <Th>Ladder</Th>
                <Th align="right">Age</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {open.map((p) => (
                <TableRow key={p.positionId} className="border-border/50">
                  <TableCell>
                    <TokenCell position={p} explorer={explorer} />
                  </TableCell>
                  <TableCell>
                    <StageBadge stage={p.stage} />
                  </TableCell>
                  <TableCell className="tnum text-right">
                    {formatUnits(p.quoteInvested, p.quoteAsset.decimals, 4)}{" "}
                    <span className="text-xs text-muted-foreground">
                      {p.quoteAsset.symbol}
                    </span>
                  </TableCell>
                  <TableCell
                    className={cn(
                      "tnum text-right font-medium",
                      (p.currentMultiple ?? 1) >= 1 ? "text-profit" : "text-loss",
                    )}
                  >
                    {formatMultiple(p.currentMultiple)}
                  </TableCell>
                  <TableCell className="tnum text-right text-muted-foreground">
                    {formatMultiple(p.peakMultiple)}
                  </TableCell>
                  <TableCell className="tnum text-right">
                    <QuoteDelta
                      value={p.unrealizedPnlQuote}
                      decimals={p.quoteAsset.decimals}
                      symbol={p.quoteAsset.symbol}
                    />
                  </TableCell>
                  <TableCell>
                    <LadderPips filled={p.ladderStepsFilled} />
                  </TableCell>
                  <TableCell className="tnum text-right text-xs text-muted-foreground">
                    {formatAge(p.openedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {stranded.length > 0 ? (
        <div>
          <SectionLabel count={stranded.length}>Stranded</SectionLabel>
          <p className="px-4 pb-2 text-xs text-caution">
            These curves stopped accepting sells before the exit fired. Selling needs the
            Uniswap v4 route, which is not implemented, so they are carried at zero and no
            longer hold a position slot.{" "}
            {data?.strandedCostUsd
              ? `${formatUsd(data.strandedCostUsd)} of cost basis is written off.`
              : ""}
          </p>
          <Table className="[&_td]:px-4">
            <TableHeader>
              <TableRow className="border-border/70 hover:bg-transparent">
                <Th>Token</Th>
                <Th>Stage</Th>
                <Th align="right">Cost basis</Th>
                <Th align="right">Peak</Th>
                <Th align="right">Stranded</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stranded.map((p) => (
                <TableRow key={p.positionId} className="border-border/50 bg-caution/[0.04]">
                  <TableCell>
                    <TokenCell position={p} explorer={explorer} />
                  </TableCell>
                  <TableCell>
                    <StageBadge stage={p.stage} />
                  </TableCell>
                  <TableCell className="tnum text-right">
                    {formatUnits(p.quoteInvested, p.quoteAsset.decimals, 4)}{" "}
                    <span className="text-xs text-muted-foreground">
                      {p.quoteAsset.symbol}
                    </span>
                  </TableCell>
                  <TableCell className="tnum text-right text-muted-foreground">
                    {formatMultiple(p.peakMultiple)}
                  </TableCell>
                  <TableCell className="tnum text-right text-xs text-muted-foreground">
                    {p.closedAt ? `${formatAge(p.closedAt)} ago` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div>
        <SectionLabel count={closed.length}>Closed</SectionLabel>
        {closed.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No closed trades yet. The go/no-go gate needs these before it can return a
            verdict.
          </p>
        ) : (
          <Table className="[&_td]:px-4">
            <TableHeader>
              <TableRow className="border-border/70 hover:bg-transparent">
                <Th>Token</Th>
                <Th>Stage</Th>
                <Th>Exit reason</Th>
                <Th align="right">Peak</Th>
                <Th align="right">Realised</Th>
                <Th align="right">Held</Th>
                <Th align="right">Closed</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {closed.map((p) => (
                <TableRow key={p.positionId} className="border-border/50">
                  <TableCell>
                    <TokenCell position={p} explorer={explorer} />
                  </TableCell>
                  <TableCell>
                    <StageBadge stage={p.stage} />
                  </TableCell>
                  <TableCell>
                    <ExitReasonBadge reason={p.exitReason} />
                  </TableCell>
                  <TableCell className="tnum text-right text-muted-foreground">
                    {formatMultiple(p.peakMultiple)}
                  </TableCell>
                  <TableCell className="tnum text-right">
                    <QuoteDelta
                      value={p.realizedPnlQuote}
                      decimals={p.quoteAsset.decimals}
                      symbol={p.quoteAsset.symbol}
                    />
                  </TableCell>
                  <TableCell className="tnum text-right text-xs text-muted-foreground">
                    {p.closedAt ? formatAge(p.openedAt, p.closedAt) : "—"}
                  </TableCell>
                  <TableCell className="tnum text-right text-xs text-muted-foreground">
                    {p.closedAt ? `${formatAge(p.closedAt)} ago` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function TokenCell({ position, explorer }: { position: Position; explorer?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">{position.symbol}</span>
      <AddressLink address={position.tokenAddress} explorer={explorer} />
    </div>
  );
}

/** P&L denominated in the launch's quote asset, which is not always ETH on this chain. */
function QuoteDelta({
  value,
  decimals,
  symbol,
}: {
  value: string;
  decimals: number;
  symbol: string;
}) {
  let raw: bigint;
  try {
    raw = BigInt(value);
  } catch {
    return <span className="text-muted-foreground">—</span>;
  }
  const negative = raw < 0n;
  const text = formatUnits((negative ? -raw : raw).toString(), decimals, 5);
  return (
    <span className={negative ? "text-loss" : raw > 0n ? "text-profit" : "text-muted-foreground"}>
      {negative ? "−" : raw > 0n ? "+" : ""}
      {text} <span className="text-xs opacity-70">{symbol}</span>
    </span>
  );
}

function LadderPips({ filled }: { filled: number[] }) {
  const total = 4;
  return (
    <div
      className="flex items-center gap-1"
      title={
        filled.length > 0
          ? `Take-profit rungs filled: ${filled.join(", ")}`
          : "No take-profit rungs filled yet"
      }
    >
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-full",
            filled.includes(i) ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

function ExitReasonBadge({ reason }: { reason: Position["exitReason"] }) {
  if (!reason) return <span className="text-muted-foreground">—</span>;
  const good = reason === "take-profit-ladder" || reason === "graduation-exit";
  const bad =
    reason === "hard-stop" || reason === "curve-depth-stop" || reason === "risk-manager-flatten";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[11px]",
        good && "border-profit/35 text-profit",
        bad && "border-loss/35 text-loss",
        !good && !bad && "text-muted-foreground",
      )}
    >
      {humanise(reason)}
    </Badge>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <TableHead
      className={cn(
        "px-4 text-[10px] font-medium tracking-wider text-muted-foreground uppercase",
        align === "right" && "text-right",
      )}
    >
      {children}
    </TableHead>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
