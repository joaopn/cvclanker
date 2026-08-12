import * as api from "@client/api";
import { PILL_CLASS } from "@client/components/ScoreIndicator";
import { useScoringBench } from "@client/hooks/useScoringBench";
import { toast } from "@client/lib/toast";
import { BenchDisagreementDialog } from "@client/pages/settings/components/BenchDisagreementDialog";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import {
  cellKey,
  findDisagreements,
  formatPercent,
  indexCells,
  summarizeConfig,
} from "@shared/scoring-bench";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
} from "@shared/settings-registry";
import { SUITABILITY_CATEGORY_LABELS } from "@shared/types";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Play, Plus, Square, Trash2 } from "lucide-react";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ModelBenchmarkingPanelProps = {
  layoutMode?: "accordion" | "panel";
  /** The configured provider, so the effort control only shows where it works. */
  provider?: string | null;
  /** Model configured for scoring today — seeds the first row. */
  scoringModel?: string;
};

type ConfigDraft = {
  key: string;
  label: string;
  model: string;
  effort: ClaudeCodeEffortLevel | null;
};

const DEFAULT_SAMPLE_SIZE = 20;

// Radix SelectItem forbids an empty value, so "let the CLI decide" rides a
// sentinel and maps back to null — same trick as the effort control in Models.
const CLI_DEFAULT_EFFORT = "cli-default";

let draftCounter = 0;
function newDraft(model = "", label = ""): ConfigDraft {
  draftCounter += 1;
  return { key: `draft-${draftCounter}`, label, model, effort: null };
}

export const ModelBenchmarkingPanel: React.FC<ModelBenchmarkingPanelProps> = ({
  layoutMode,
  provider,
  scoringModel,
}) => {
  const { run, connected } = useScoringBench();
  const [sampleSize, setSampleSize] = useState(String(DEFAULT_SAMPLE_SIZE));
  const [drafts, setDrafts] = useState<ConfigDraft[]>(() => [
    newDraft(scoringModel ?? "", "Reference"),
    newDraft("", "Candidate"),
  ]);
  // Settings arrive after the first paint, so the seeded reference row would
  // stay blank on a cold load. Hydrate it once, then never fight the user's
  // edits (the ref-gated render-phase seed used by PromptEditor).
  const seededModelRef = useRef(Boolean(scoringModel));
  if (!seededModelRef.current && scoringModel) {
    seededModelRef.current = true;
    setDrafts((prev) =>
      prev.map((draft, index) =>
        index === 0 && draft.model === ""
          ? { ...draft, model: scoringModel }
          : draft,
      ),
    );
  }
  const [referenceConfigId, setReferenceConfigId] = useState<string | null>(
    null,
  );
  const [disagreementsOpen, setDisagreementsOpen] = useState(false);

  const supportsEffort = provider === "claude_code";
  const isRunning = run?.status === "running";

  const startMutation = useMutation({
    mutationFn: api.startScoringBenchRun,
    onError: (error: Error) => toast.error(error.message),
  });
  const cancelMutation = useMutation({
    mutationFn: api.cancelScoringBenchRun,
    onError: (error: Error) => toast.error(error.message),
  });

  // The reference defaults to the first column, but only once results exist —
  // before that there is nothing to compare against.
  const activeReferenceId =
    referenceConfigId && run?.configs.some((c) => c.id === referenceConfigId)
      ? referenceConfigId
      : (run?.configs[0]?.id ?? null);

  const cellIndex = useMemo(() => indexCells(run?.cells ?? []), [run?.cells]);

  const summaries = useMemo(() => {
    if (!run) return [];
    return run.configs.map((config) =>
      summarizeConfig({
        configId: config.id,
        referenceConfigId: activeReferenceId,
        cells: run.cells,
        index: cellIndex,
      }),
    );
  }, [run, activeReferenceId, cellIndex]);

  const disagreements = useMemo(() => {
    if (!run) return [];
    return findDisagreements({
      jobs: run.jobs,
      configs: run.configs,
      cells: run.cells,
      index: cellIndex,
    });
  }, [run, cellIndex]);

  const handleRun = () => {
    const parsedSize = Number.parseInt(sampleSize, 10);
    if (!Number.isFinite(parsedSize) || parsedSize < 1) {
      toast.error("Enter how many jobs to sample (1 or more).");
      return;
    }
    // A blank model is kept, not filtered out: the server reads it as "the
    // model scoring uses today", which is the only way to compare efforts on
    // claude_code (whose configured model is legitimately empty).
    const configs = drafts.map((draft) => ({
      label: draft.label.trim(),
      model: draft.model.trim(),
      effort: supportsEffort ? draft.effort : null,
    }));

    if (configs.length === 0) {
      toast.error("Add at least one configuration.");
      return;
    }

    setReferenceConfigId(null);
    cancelMutation.reset();
    startMutation.mutate(
      { sampleSize: parsedSize, configs },
      {
        onSuccess: () =>
          toast.success(
            `Benchmarking ${configs.length} configuration${configs.length === 1 ? "" : "s"} on ${parsedSize} job${parsedSize === 1 ? "" : "s"}.`,
          ),
      },
    );
  };

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      value="model-benchmarking"
      title="Model Benchmarking"
    >
      <p className="text-sm text-muted-foreground">
        Classify a random sample of live jobs with several model configurations
        at once and compare the results. Runs on your configured provider, uses
        the current scoring policy, and writes nothing — no job's saved fit is
        touched.
      </p>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="benchSampleSize">Jobs to sample</Label>
            <Input
              id="benchSampleSize"
              type="number"
              min={1}
              value={sampleSize}
              onChange={(event) => setSampleSize(event.target.value)}
              disabled={isRunning}
              className="w-32"
            />
          </div>
          <p className="pb-2 text-xs text-muted-foreground">
            Drawn at random from jobs that aren't closed and have a description
            long enough to judge.
          </p>
        </div>

        <div className="space-y-2">
          {drafts.map((draft, index) => (
            <div key={draft.key} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label
                  htmlFor={`benchLabel-${draft.key}`}
                  className={index === 0 ? undefined : "sr-only"}
                >
                  Label
                </Label>
                <Input
                  id={`benchLabel-${draft.key}`}
                  value={draft.label}
                  placeholder={`Config ${index + 1}`}
                  onChange={(event) =>
                    setDrafts((prev) =>
                      prev.map((entry) =>
                        entry.key === draft.key
                          ? { ...entry, label: event.target.value }
                          : entry,
                      ),
                    )
                  }
                  disabled={isRunning}
                  className="w-40"
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor={`benchModel-${draft.key}`}
                  className={index === 0 ? undefined : "sr-only"}
                >
                  Model
                </Label>
                <Input
                  id={`benchModel-${draft.key}`}
                  value={draft.model}
                  placeholder="model id"
                  onChange={(event) =>
                    setDrafts((prev) =>
                      prev.map((entry) =>
                        entry.key === draft.key
                          ? { ...entry, model: event.target.value }
                          : entry,
                      ),
                    )
                  }
                  disabled={isRunning}
                  className="w-64"
                />
              </div>
              {supportsEffort ? (
                <div className="space-y-1">
                  <Label
                    htmlFor={`benchEffort-${draft.key}`}
                    className={index === 0 ? undefined : "sr-only"}
                  >
                    Effort
                  </Label>
                  <Select
                    value={draft.effort ?? CLI_DEFAULT_EFFORT}
                    onValueChange={(value) =>
                      setDrafts((prev) =>
                        prev.map((entry) =>
                          entry.key === draft.key
                            ? {
                                ...entry,
                                effort:
                                  value === CLI_DEFAULT_EFFORT
                                    ? null
                                    : (value as ClaudeCodeEffortLevel),
                              }
                            : entry,
                        ),
                      )
                    }
                    disabled={isRunning}
                  >
                    <SelectTrigger
                      id={`benchEffort-${draft.key}`}
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CLI_DEFAULT_EFFORT}>
                        CLI default
                      </SelectItem>
                      {CLAUDE_CODE_EFFORT_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove configuration ${index + 1}`}
                disabled={isRunning || drafts.length === 1}
                onClick={() =>
                  setDrafts((prev) =>
                    prev.filter((entry) => entry.key !== draft.key),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isRunning}
            onClick={() => setDrafts((prev) => [...prev, newDraft()])}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add configuration
          </Button>
          {isRunning ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              // Cancelling only raises a flag: calls already with the provider
              // still have to come back, which on a slow model is tens of
              // seconds of a button that would otherwise look ignored.
              disabled={cancelMutation.isPending || cancelMutation.isSuccess}
              onClick={() => cancelMutation.mutate()}
            >
              <Square className="mr-1.5 h-4 w-4" />
              {cancelMutation.isSuccess ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={startMutation.isPending}
              onClick={handleRun}
            >
              {startMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-4 w-4" />
              )}
              Run benchmark
            </Button>
          )}
          {isRunning ? (
            <span className="text-xs text-muted-foreground">
              {
                run.cells.filter(
                  (cell) => cell.status === "done" || cell.status === "error",
                ).length
              }
              {" / "}
              {run.cells.length} classifications done
            </span>
          ) : null}
          {connected || !run ? null : (
            <span className="text-xs text-destructive">
              Not receiving updates — the run continues on the server; reload to
              re-attach.
            </span>
          )}
        </div>
      </div>

      {run?.status === "stopped" && run.stoppedReason ? (
        <Alert variant="destructive">
          <AlertTitle>Benchmark stopped</AlertTitle>
          <AlertDescription>{run.stoppedReason}</AlertDescription>
        </Alert>
      ) : null}

      {run && run.jobs.length === 0 && run.status !== "running" ? (
        <Alert>
          <AlertTitle>No jobs to sample</AlertTitle>
          <AlertDescription>
            Nothing matched: a job must be open (not closed) and carry a
            description long enough to judge.
          </AlertDescription>
        </Alert>
      ) : null}

      {run && run.jobs.length > 0 ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="benchReference" className="text-xs">
                Compare against
              </Label>
              <Select
                value={activeReferenceId ?? undefined}
                onValueChange={setReferenceConfigId}
              >
                <SelectTrigger id="benchReference" className="h-8 w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {run.configs.map((config) => (
                    <SelectItem key={config.id} value={config.id}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {disagreements.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDisagreementsOpen(true)}
              >
                Review {disagreements.length} disagreement
                {disagreements.length === 1 ? "" : "s"}
              </Button>
            ) : null}
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left">
                  <th className="p-2 font-medium">Job</th>
                  {run.configs.map((config, index) => (
                    <th key={config.id} className="p-2 font-medium">
                      <div className="whitespace-nowrap">{config.label}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {config.model || "provider default"}
                        {config.effort ? ` · ${config.effort}` : ""}
                      </div>
                      <ConfigSummaryLine
                        summary={summaries[index]}
                        isReference={config.id === activeReferenceId}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {run.jobs.map((job) => (
                  <tr key={job.id} className="border-b last:border-b-0">
                    <td className="max-w-xs p-2 align-top">
                      <div className="truncate font-medium" title={job.title}>
                        {job.title}
                      </div>
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={job.employer}
                      >
                        {job.employer}
                      </div>
                    </td>
                    {run.configs.map((config) => {
                      const cell = cellIndex.get(cellKey(job.id, config.id));
                      return (
                        <td key={config.id} className="p-2 align-top">
                          {cell?.category ? (
                            <span
                              className={cn(
                                "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                                PILL_CLASS[cell.category],
                              )}
                            >
                              {SUITABILITY_CATEGORY_LABELS[cell.category]}
                            </span>
                          ) : cell?.status === "error" ? (
                            <span
                              className="text-xs text-destructive"
                              title={cell.error ?? undefined}
                            >
                              Failed
                            </span>
                          ) : cell?.status === "running" ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Average tokens is per job, prompt + completion as the provider
            reports them — Claude Code counts cache reads as input, so its
            numbers read high, and providers that report nothing show "—".
          </p>
        </div>
      ) : null}

      <BenchDisagreementDialog
        open={disagreementsOpen}
        onOpenChange={setDisagreementsOpen}
        rows={disagreements}
        configs={run?.configs ?? []}
      />
    </SettingsSectionFrame>
  );
};

const ConfigSummaryLine: React.FC<{
  summary?: {
    agreement: number | null;
    withinOneTier: number | null;
    comparable: number;
    failed: number;
    avgTotalTokens: number | null;
    avgDurationMs: number | null;
  };
  isReference: boolean;
}> = ({ summary, isReference }) => {
  if (!summary) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs font-normal text-muted-foreground">
      {isReference ? (
        <div>reference</div>
      ) : (
        <div>
          {formatPercent(summary.agreement)} same
          {summary.comparable > 0
            ? ` · ${formatPercent(summary.withinOneTier)} ±1 tier`
            : ""}
        </div>
      )}
      <div>
        {summary.avgTotalTokens === null
          ? "— avg tokens"
          : `${Math.round(summary.avgTotalTokens).toLocaleString()} avg tokens`}
        {summary.avgDurationMs === null
          ? ""
          : ` · ${(summary.avgDurationMs / 1000).toFixed(1)}s avg`}
        {summary.failed > 0 ? ` · ${summary.failed} failed` : ""}
      </div>
    </div>
  );
};
