"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityPanel } from "@/components/activity-panel";
import { EvaluationCard } from "@/components/evaluation-card";
import { HeaderBar } from "@/components/header-bar";
import { LaunchesPanel } from "@/components/launches-panel";
import { OverviewCards } from "@/components/overview-cards";
import { PanelError } from "@/components/primitives";
import { PipelineCard } from "@/components/pipeline-card";
import { PositionsPanel } from "@/components/positions-panel";
import { SignalsPanel } from "@/components/signals-panel";
import { BOT_API, usePoll } from "@/lib/api";
import { formatAge } from "@/lib/format";
import type {
  ActivityResponse,
  BotState,
  LaunchesResponse,
  PositionsResponse,
  SignalsResponse,
} from "@/lib/types";

/**
 * Operator console.
 *
 * Four independent polls rather than one aggregate endpoint: state drives the header and
 * has to stay responsive, while the launch table is the heaviest payload and does not
 * need the same cadence. Splitting them also means one slow query cannot stall the
 * numbers an operator is watching while deciding whether to hit Kill.
 */
export function Console() {
  const state = usePoll<BotState>("/api/state", 2000);
  const positions = usePoll<PositionsResponse>("/api/positions", 2000);
  const launches = usePoll<LaunchesResponse>("/api/launches", 4000);
  const signals = usePoll<SignalsResponse>("/api/signals", 4000);
  const activity = usePoll<ActivityResponse>("/api/activity", 3000);

  const explorer = state.data?.chain.explorer;
  const connected = state.error === null && state.data !== null;

  const refreshAll = React.useCallback(() => {
    state.refresh();
    positions.refresh();
    launches.refresh();
    signals.refresh();
    activity.refresh();
  }, [state, positions, launches, signals, activity]);

  return (
    <div className="flex min-h-full flex-col">
      <HeaderBar state={state.data} connected={connected} onMutated={refreshAll} />

      <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-4 px-4 py-4 sm:px-6">
        {state.error && !state.data ? (
          <Card>
            <PanelError message={state.error} onRetry={refreshAll} />
          </Card>
        ) : (
          <>
            {state.error ? (
              <div className="rounded-md border border-caution/30 bg-caution/10 px-3 py-2 text-xs text-caution">
                Lost contact with the bot at {BOT_API}
                {state.updatedAt ? ` ${formatAge(state.updatedAt)} ago` : ""}. Showing the
                last values received — they are not current.
              </div>
            ) : null}

            <OverviewCards state={state.data} />

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <Card className="min-w-0 gap-0 py-0">
                <Tabs defaultValue="positions" className="gap-0">
                  <TabsList
                    variant="line"
                    className="h-auto w-full justify-start gap-4 overflow-x-auto rounded-none border-b border-border/70 px-4 py-2"
                  >
                    <TabsTrigger value="positions" className="flex-none px-1">
                      Positions
                      <Count value={positions.data?.open.length} />
                    </TabsTrigger>
                    <TabsTrigger value="launches" className="flex-none px-1">
                      Launches
                      <Count value={launches.data?.tracked.length} />
                    </TabsTrigger>
                    <TabsTrigger value="signals" className="flex-none px-1">
                      Signals
                      <Count value={signals.data?.rejections.length} />
                    </TabsTrigger>
                    <TabsTrigger value="activity" className="flex-none px-1">
                      Activity
                      <Count value={activity.data?.fills.length} />
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="positions">
                    <PositionsPanel
                      data={positions.data}
                      loading={positions.loading}
                      explorer={explorer}
                    />
                  </TabsContent>
                  <TabsContent value="launches">
                    <LaunchesPanel
                      data={launches.data}
                      loading={launches.loading}
                      explorer={explorer}
                    />
                  </TabsContent>
                  <TabsContent value="signals">
                    <SignalsPanel
                      data={signals.data}
                      loading={signals.loading}
                      explorer={explorer}
                    />
                  </TabsContent>
                  <TabsContent value="activity">
                    <ActivityPanel
                      data={activity.data}
                      loading={activity.loading}
                      explorer={explorer}
                    />
                  </TabsContent>
                </Tabs>
              </Card>

              <div className="min-w-0 space-y-4">
                <EvaluationCard report={state.data?.evaluation ?? null} />
                <PipelineCard state={state.data} />
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="mx-auto w-full max-w-[1600px] px-4 pb-6 text-xs text-muted-foreground sm:px-6">
        Reading {BOT_API}
        {state.updatedAt ? ` · updated ${formatAge(state.updatedAt)} ago` : ""}
        {state.data
          ? ` · quote assets ${state.data.quoteAssets.map((a) => a.symbol).join(", ")}`
          : ""}
      </footer>
    </div>
  );
}

function Count({ value }: { value: number | undefined }) {
  if (!value) return null;
  return (
    <span className="tnum rounded bg-muted px-1 text-[10px] text-muted-foreground">
      {value}
    </span>
  );
}
