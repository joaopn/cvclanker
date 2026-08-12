import * as api from "@client/api";
import { PILL_CLASS } from "@client/components/ScoreIndicator";
import { useScoringBench } from "@client/hooks/useScoringBench";
import { toast } from "@client/lib/toast";
import {
  FIT_FILTER_CHIP_CLASS,
  FIT_FILTER_LABELS,
  FIT_FILTER_VALUES,
} from "@client/pages/orchestrator/constants";
import { BenchDisagreementDialog } from "@client/pages/settings/components/BenchDisagreementDialog";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import {
  buildStoredCells,
  categoryCounts,
  cellKey,
  configSubtitle,
  costMultiplier,
  findDisagreements,
  formatPercent,
  indexCells,
  STORED_COLUMN,
  STORED_COLUMN_ID,
  summarizeConfig,
} from "@shared/scoring-bench";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
} from "@shared/settings-registry";
import {
  type BenchCell,
  type BenchSampleCategory,
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_LABELS,
} from "@shared/types";
import { useMutation } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
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
  /** Kept as typed text: an empty box means "no estimate", not zero. */
  inputCost: string;
  outputCost: string;
};

const DEFAULT_SAMPLE_SIZE = 20;
const JOBS_PER_PAGE = 20;

// Radix SelectItem forbids an empty value, so "let the CLI decide" rides a
// sentinel and maps back to null — same trick as the effort control in Models.
const CLI_DEFAULT_EFFORT = "cli-default";

let draftCounter = 0;
function newDraft(model = "", label = ""): ConfigDraft {
  draftCounter += 1;
  return {
    key: `draft-${draftCounter}`,
    label,
    model,
    effort: null,
    inputCost: "",
    outputCost: "",
  };
}

function formatTokens(value: number | null): string {
  return value === null ? "—" : Math.round(value).toLocaleString();
}

function formatCost(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0";
  // Sub-cent totals are normal on a small sample of a cheap model, so the
  // precision follows the magnitude rather than rounding them to 0.00 — but
  // below this floor `toPrecision` would switch to exponential notation, which
  // is unreadable in a numeric column.
  if (value < 0.0001) return "<0.0001";
  return value >= 1 ? value.toFixed(2) : value.toPrecision(2);
}

function formatMultiplier(value: number | null): string {
  if (value === null) return "—";
  if (value >= 10) return `${Math.round(value)}×`;
  // A flagship-vs-mini ratio is routinely a few thousandths, and two decimals
  // would print it as 0.00× — indistinguishable from free.
  if (value < 0.01) return `${value.toPrecision(2)}×`;
  return `${value.toFixed(2)}×`;
}

/** Empty or unparseable stays null — a price is absent, never zero. */
function parseRate(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
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
  const [sampleCategories, setSampleCategories] = useState<
    BenchSampleCategory[]
  >([...FIT_FILTER_VALUES]);
  const [page, setPage] = useState(0);
  const pagedRunRef = useRef<string | null>(null);

  if (run && pagedRunRef.current !== run.id) {
    pagedRunRef.current = run.id;
    setPage(0);
  }

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
    referenceConfigId &&
    (run?.configs.some((c) => c.id === referenceConfigId) ||
      referenceConfigId === STORED_COLUMN_ID)
      ? referenceConfigId
      : (run?.configs[0]?.id ?? null);

  // What is already saved on each job rides along as one more column, so the
  // summary, the agreement rates and the disagreement list all treat it the
  // same way they treat a model — no branch anywhere for "the database".
  const columns = useMemo(
    () => (run ? [...run.configs, STORED_COLUMN] : []),
    [run],
  );

  const allCells = useMemo(
    () => (run ? [...run.cells, ...buildStoredCells(run.jobs)] : []),
    [run],
  );

  const cellIndex = useMemo(() => indexCells(allCells), [allCells]);

  const summaries = useMemo(
    () =>
      columns.map((config) =>
        summarizeConfig({
          configId: config.id,
          referenceConfigId: activeReferenceId,
          cells: allCells,
          index: cellIndex,
          rates: {
            input: config.inputCostPerMillion,
            output: config.outputCostPerMillion,
          },
        }),
      ),
    [columns, allCells, activeReferenceId, cellIndex],
  );

  const referenceSummary = summaries.find(
    (summary) => summary.configId === activeReferenceId,
  );

  // Grouped once: `categoryCounts` would otherwise re-scan every cell for each
  // column, on every streamed result, over a sample the user may have made
  // arbitrarily large.
  const cellsByConfig = useMemo(() => {
    const byConfig = new Map<string, BenchCell[]>();
    for (const cell of allCells) {
      const bucket = byConfig.get(cell.configId);
      if (bucket) bucket.push(cell);
      else byConfig.set(cell.configId, [cell]);
    }
    return byConfig;
  }, [allCells]);

  const counts = useMemo(
    () =>
      columns.map((config) =>
        categoryCounts(cellsByConfig.get(config.id) ?? [], config.id),
      ),
    [columns, cellsByConfig],
  );

  const disagreements = useMemo(() => {
    if (!run) return [];
    return findDisagreements({
      jobs: run.jobs,
      configs: columns,
      cells: allCells,
      index: cellIndex,
    });
  }, [run, columns, allCells, cellIndex]);

  const pageCount = run ? Math.ceil(run.jobs.length / JOBS_PER_PAGE) : 0;
  // Results stream in and a new run replaces the sample, so the page can end up
  // past the end; clamping on read beats an effect that fights the user.
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const pageJobs = run
    ? run.jobs.slice(safePage * JOBS_PER_PAGE, (safePage + 1) * JOBS_PER_PAGE)
    : [];

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
      inputCostPerMillion: parseRate(draft.inputCost),
      outputCostPerMillion: parseRate(draft.outputCost),
    }));

    if (configs.length === 0) {
      toast.error("Add at least one configuration.");
      return;
    }

    if (sampleCategories.length === 0) {
      toast.error("Pick at least one fit category to sample from.");
      return;
    }

    // A typed-but-unparseable price would otherwise be indistinguishable from
    // an empty box, and the user would only find out after paying for the run.
    const badPrice = drafts.find(
      (draft) =>
        (draft.inputCost.trim() !== "" &&
          parseRate(draft.inputCost) === null) ||
        (draft.outputCost.trim() !== "" &&
          parseRate(draft.outputCost) === null),
    );
    if (badPrice) {
      toast.error(
        `"${badPrice.label || "A configuration"}" has a price that isn't a non-negative number.`,
      );
      return;
    }

    setReferenceConfigId(null);
    setPage(0);
    cancelMutation.reset();
    startMutation.mutate(
      { sampleSize: parsedSize, categories: sampleCategories, configs },
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

        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">
            Sample from — all selected means no restriction
          </legend>
          <div className="flex flex-wrap items-center gap-1">
            {FIT_FILTER_VALUES.map((value) => {
              const active = sampleCategories.includes(value);
              const classes = FIT_FILTER_CHIP_CLASS[value];
              return (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isRunning}
                  className={cn(
                    "h-7 px-2 text-xs font-medium",
                    active ? classes.active : classes.inactive,
                  )}
                  aria-pressed={active}
                  onClick={() =>
                    setSampleCategories((prev) =>
                      prev.includes(value)
                        ? prev.filter((entry) => entry !== value)
                        : // Rebuilt from the canonical order rather than
                          // appended, so the chips read the same way every time.
                          FIT_FILTER_VALUES.filter(
                            (entry) => prev.includes(entry) || entry === value,
                          ),
                    )
                  }
                >
                  {FIT_FILTER_LABELS[value]}
                </Button>
              );
            })}
          </div>
        </fieldset>

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
              <div className="space-y-1">
                <Label
                  htmlFor={`benchInputCost-${draft.key}`}
                  className={index === 0 ? undefined : "sr-only"}
                >
                  In /M
                </Label>
                <Input
                  id={`benchInputCost-${draft.key}`}
                  value={draft.inputCost}
                  inputMode="decimal"
                  placeholder="—"
                  onChange={(event) =>
                    setDrafts((prev) =>
                      prev.map((entry) =>
                        entry.key === draft.key
                          ? { ...entry, inputCost: event.target.value }
                          : entry,
                      ),
                    )
                  }
                  disabled={isRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor={`benchOutputCost-${draft.key}`}
                  className={index === 0 ? undefined : "sr-only"}
                >
                  Out /M
                </Label>
                <Input
                  id={`benchOutputCost-${draft.key}`}
                  value={draft.outputCost}
                  inputMode="decimal"
                  placeholder="—"
                  onChange={(event) =>
                    setDrafts((prev) =>
                      prev.map((entry) =>
                        entry.key === draft.key
                          ? { ...entry, outputCost: event.target.value }
                          : entry,
                      ),
                    )
                  }
                  disabled={isRunning}
                  className="w-24"
                />
              </div>
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

        <p className="text-xs text-muted-foreground">
          In /M and Out /M are your price per million input and output tokens,
          in whatever currency you like. Leave them empty for no cost estimate.
          Cached-input discounts are not modelled, and an estimate marked with
          an asterisk covers only the half the provider reported usage for.
        </p>

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
                  {columns.map((config) => (
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
              <caption className="border-b bg-muted/40 p-2 text-left text-xs font-medium text-muted-foreground">
                Summary — {run.jobs.length} job
                {run.jobs.length === 1 ? "" : "s"} sampled
                {run.sampleCategories.length > 0 &&
                run.sampleCategories.length < FIT_FILTER_VALUES.length
                  ? ` from ${run.sampleCategories
                      .map((category) => FIT_FILTER_LABELS[category])
                      .join(", ")}`
                  : ""}
              </caption>
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="p-2 font-medium">
                    Configuration
                  </th>
                  {SUITABILITY_CATEGORIES.map((category) => (
                    <th
                      key={category}
                      scope="col"
                      className="p-2 text-right font-medium whitespace-nowrap"
                    >
                      {SUITABILITY_CATEGORY_LABELS[category]}
                    </th>
                  ))}
                  <th scope="col" className="p-2 text-right font-medium">
                    Same
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    ±1 tier
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    Compared
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    Avg in
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    Avg out
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    Est. cost
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    × ref
                  </th>
                  <th
                    scope="col"
                    className="p-2 text-right font-medium whitespace-nowrap"
                  >
                    Avg time
                  </th>
                  <th scope="col" className="p-2 text-right font-medium">
                    Failed
                  </th>
                </tr>
              </thead>
              <tbody>
                {columns.map((config, index) => {
                  const summary = summaries[index];
                  const isReference = config.id === activeReferenceId;
                  return (
                    <tr key={config.id} className="border-b last:border-b-0">
                      <th scope="row" className="p-2 text-left font-normal">
                        <div className="font-medium whitespace-nowrap">
                          {config.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {configSubtitle(config)}
                        </div>
                      </th>
                      {SUITABILITY_CATEGORIES.map((category) => (
                        <td
                          key={category}
                          className="p-2 text-right tabular-nums"
                        >
                          {counts[index]?.[category] ?? 0}
                        </td>
                      ))}
                      <td className="p-2 text-right tabular-nums">
                        {isReference
                          ? "reference"
                          : formatPercent(summary?.agreement ?? null)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {isReference
                          ? "—"
                          : formatPercent(summary?.withinOneTier ?? null)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {isReference ? "—" : (summary?.comparable ?? 0)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {formatTokens(summary?.avgPromptTokens ?? null)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {formatTokens(summary?.avgCompletionTokens ?? null)}
                      </td>
                      <td
                        className="p-2 text-right tabular-nums"
                        title={
                          summary?.partialEstimate
                            ? "Covers only the half the provider reported usage for."
                            : undefined
                        }
                      >
                        {formatCost(summary?.estimatedCost ?? null)}
                        {summary?.partialEstimate ? "*" : ""}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {isReference
                          ? // "1×" against nothing would contradict the "—" in
                            // the cost cell beside it.
                            summary?.estimatedCostPerJob == null
                            ? "—"
                            : "1×"
                          : formatMultiplier(
                              summary
                                ? costMultiplier(summary, referenceSummary)
                                : null,
                            )}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {summary?.avgDurationMs == null
                          ? "—"
                          : `${(summary.avgDurationMs / 1000).toFixed(1)}s`}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {summary?.failed ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left">
                  <th scope="col" className="p-2 font-medium">
                    Job
                  </th>
                  {columns.map((config) => (
                    <th key={config.id} scope="col" className="p-2 font-medium">
                      <div className="whitespace-nowrap">{config.label}</div>
                      <div className="text-xs font-normal text-muted-foreground">
                        {configSubtitle(config)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageJobs.map((job) => (
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
                    {columns.map((config) => {
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
          {pageCount > 1 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Showing {safePage * JOBS_PER_PAGE + 1}–
                {safePage * JOBS_PER_PAGE + pageJobs.length} of{" "}
                {run.jobs.length}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Page {safePage + 1} of {pageCount}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={safePage === 0}
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Avg in / avg out are tokens per job as the provider reports them —
            Claude Code counts cache reads as input, so its input figure reads
            high, and a provider that reports nothing shows "—". Est. cost
            prices this run's classified jobs at your rates; × ref compares cost
            per job against the reference column. Compared is how many jobs both
            that column and the reference classified — the denominator behind
            Same and ±1 tier. The saved column is whatever is on the job today,
            which may predate the current scoring policy.
          </p>
        </div>
      ) : null}

      <BenchDisagreementDialog
        open={disagreementsOpen}
        onOpenChange={setDisagreementsOpen}
        rows={disagreements}
        configs={columns}
      />
    </SettingsSectionFrame>
  );
};
