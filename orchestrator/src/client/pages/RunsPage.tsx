/**
 * The Runs surface: automatic run schedules, and what each one last did.
 *
 * Deliberately separate from Manage: a scheduled run keeps its own retained
 * table (the progress store is partitioned by trigger), so neither view can
 * show the other's run.
 */

import * as api from "@client/api";
import { PageHeader } from "@client/components/layout";
import { ViewToggle } from "@client/components/ViewToggle";
import { toast } from "@client/lib/toast";
import type { RunSchedule } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  draftFrom,
  emptyDraft,
  type ScheduleDraft,
  ScheduleEditorDialog,
} from "./runs/ScheduleEditorDialog";

const schedulesKey = ["schedules"] as const;

function describeCadence(schedule: RunSchedule, timeZone: string): string {
  const days =
    schedule.daysOfWeek === null
      ? "every day"
      : schedule.daysOfWeek
          .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
          .join(", ");
  if (schedule.cadenceKind === "daily_at") {
    return `Daily at ${schedule.timeOfDay} ${timeZone} · ${days}`;
  }
  return `Every ${schedule.intervalHours}h · ${days}`;
}

function formatInstant(value: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}

const statusTone: Record<string, string> = {
  success: "bg-status-good/10 text-status-good-text border-status-good/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  skipped: "bg-muted text-muted-foreground border-border",
};

export const RunsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{
    id: string | null;
    draft: ScheduleDraft;
  } | null>(null);

  const schedulesQuery = useQuery({
    queryKey: schedulesKey,
    queryFn: () => api.getSchedules(),
    refetchInterval: 30_000,
  });
  const profilesQuery = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.getProfiles(),
  });
  const runOptionsQuery = useQuery({
    queryKey: ["run-options"],
    queryFn: () => api.getRunOptions(),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: schedulesKey });

  const saveMutation = useMutation({
    mutationFn: async (input: { id: string | null; draft: ScheduleDraft }) => {
      const payload = {
        ...input.draft,
        intervalHours:
          input.draft.cadenceKind === "every_n_hours"
            ? input.draft.intervalHours
            : null,
        timeOfDay:
          input.draft.cadenceKind === "daily_at" ? input.draft.timeOfDay : null,
        sources:
          input.draft.sourceMode === "custom" ? input.draft.sources : null,
        providerInstanceIds:
          input.draft.sourceMode === "custom"
            ? input.draft.providerInstanceIds
            : null,
        scrapeWindowDays: null,
        scrapeSinceLastRun: null,
      };
      return input.id
        ? api.updateSchedule(input.id, payload)
        : api.createSchedule(payload);
    },
    onSuccess: () => {
      setEditing(null);
      void invalidate();
      toast.success("Schedule saved");
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Save failed"),
  });

  const toggleMutation = useMutation({
    mutationFn: (schedule: RunSchedule) =>
      api.updateSchedule(schedule.id, {
        ...draftFrom(schedule),
        enabled: !schedule.enabled,
        intervalHours: schedule.intervalHours,
        timeOfDay: schedule.timeOfDay,
        sources: schedule.sources,
        providerInstanceIds: schedule.providerInstanceIds,
        scrapeWindowDays: schedule.scrapeWindowDays,
        scrapeSinceLastRun: schedule.scrapeSinceLastRun,
      }),
    onSuccess: () => void invalidate(),
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not update"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      void invalidate();
      toast.success("Schedule deleted");
    },
  });

  const runNowMutation = useMutation({
    mutationFn: (id: string) => api.runScheduleNow(id),
    onSuccess: () => {
      void invalidate();
      toast.success("Run started");
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not start"),
  });

  const resumeMutation = useMutation({
    mutationFn: () => api.resumeScheduling(),
    onSuccess: () => {
      void invalidate();
      toast.success("Scheduling resumed");
    },
  });

  const data = schedulesQuery.data;
  const timeZone = data?.timeZone ?? "UTC";
  const schedules = data?.schedules ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <PageHeader
        title="CV Clanker"
        subtitle="Runs"
        titleSlot={<ViewToggle />}
        fullWidth
        actions={
          <Button
            type="button"
            onClick={() => setEditing({ id: null, draft: emptyDraft() })}
          >
            <Plus className="mr-1 h-4 w-4" />
            New schedule
          </Button>
        }
      />

      <main className="w-full space-y-4 px-4 py-6">
        {data?.pausedReason && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">
                  Automatic runs are paused
                </p>
                <p className="text-sm text-muted-foreground">
                  {data.pausedReason}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => resumeMutation.mutate()}
                disabled={resumeMutation.isPending}
              >
                Resume scheduling
              </Button>
            </CardContent>
          </Card>
        )}

        {schedulesQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading schedules…</p>
        )}

        {!schedulesQuery.isLoading && schedules.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="font-medium">No schedules yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                A schedule runs the pipeline on its own, so the free scrapers
                keep pulling fresh jobs without anyone pressing Run.
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-3">
          {schedules.map((schedule) => (
            <Card key={schedule.id}>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0 pb-3">
                <div className="min-w-0">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {schedule.name}
                    {schedule.lastStatus && (
                      <Badge
                        variant="outline"
                        className={statusTone[schedule.lastStatus]}
                      >
                        {schedule.lastStatus}
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {describeCadence(schedule, timeZone)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Switch
                    checked={schedule.enabled}
                    onCheckedChange={() => toggleMutation.mutate(schedule)}
                    aria-label={
                      schedule.enabled ? "Disable schedule" : "Enable schedule"
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Run now"
                    title="Run now"
                    disabled={runNowMutation.isPending}
                    onClick={() => runNowMutation.mutate(schedule.id)}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Edit schedule"
                    onClick={() =>
                      setEditing({
                        id: schedule.id,
                        draft: draftFrom(schedule),
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Delete schedule"
                    onClick={() => deleteMutation.mutate(schedule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2 pt-0 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Next run
                  </p>
                  <p>
                    {schedule.enabled
                      ? formatInstant(schedule.nextFireAt)
                      : "Paused"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Last run
                  </p>
                  <p>{formatInstant(schedule.lastFiredAt)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Profiles
                  </p>
                  <p>{schedule.profileIds.length}</p>
                </div>
                {schedule.lastDetail && (
                  <p className="text-muted-foreground sm:col-span-3">
                    {schedule.lastDetail}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </main>

      {editing && (
        <ScheduleEditorDialog
          open
          draft={editing.draft}
          timeZone={timeZone}
          profiles={profilesQuery.data?.profiles ?? []}
          runOptionSources={runOptionsQuery.data?.sources ?? []}
          saving={saveMutation.isPending}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={() => saveMutation.mutate(editing)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
};
