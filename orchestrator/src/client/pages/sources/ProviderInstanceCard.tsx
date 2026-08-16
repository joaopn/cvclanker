import * as api from "@client/api";
import type { ProviderInstanceTestResponse } from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type {
  ProviderActorTemplateSummary,
  ProviderInstanceRow,
  SourceConfigGlobalField,
} from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Loader2,
  PlayCircle,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const GLOBAL_FIELD_LABELS: Record<SourceConfigGlobalField, string> = {
  searchTerms: "Search terms",
  city: "City",
  workplaceTypes: "Workplace types",
  country: "Country",
  maxJobsPerTerm: "Max jobs per term (budget)",
  maxAgeDays: "Max job age (days)",
};

interface ProviderInstanceCardProps {
  instance: ProviderInstanceRow;
  template: ProviderActorTemplateSummary | null;
}

export function ProviderInstanceCard({
  instance,
  template,
}: ProviderInstanceCardProps) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(instance.enabled);
  const [label, setLabel] = useState(instance.label);
  const [actorRef, setActorRef] = useState(instance.actorRef);
  const [inputTemplateJson, setInputTemplateJson] = useState(
    instance.inputTemplateJson,
  );
  const [outputMappingJson, setOutputMappingJson] = useState(
    instance.outputMappingJson,
  );
  const [maxJobs, setMaxJobs] = useState<number | undefined>(instance.maxJobs);
  const [maxAgeDays, setMaxAgeDays] = useState<number | undefined>(
    instance.maxAgeDays,
  );
  const [testResult, setTestResult] = useState<ProviderInstanceTestResponse | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setEnabled(instance.enabled);
    setLabel(instance.label);
    setActorRef(instance.actorRef);
    setInputTemplateJson(instance.inputTemplateJson);
    setOutputMappingJson(instance.outputMappingJson);
    setMaxJobs(instance.maxJobs);
    setMaxAgeDays(instance.maxAgeDays);
  }, [instance]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      api.updateProviderInstance(instance.id, {
        label,
        actorRef,
        enabled,
        inputTemplateJson,
        outputMappingJson,
        maxJobs: maxJobs ?? null,
        maxAgeDays: maxAgeDays ?? null,
      }),
    onSuccess: () => {
      toast.success(`Saved ${label}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.providerInstances.all,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Save failed");
    },
  });

  const resetMutation = useMutation({
    mutationFn: async (defaultTemplate: string) =>
      api.updateProviderInstance(instance.id, {
        inputTemplateJson: defaultTemplate,
      }),
    onSuccess: () => {
      toast.success("Reset to template default");
      queryClient.invalidateQueries({
        queryKey: queryKeys.providerInstances.all,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Reset failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => api.deleteProviderInstance(instance.id),
    onSuccess: () => {
      toast.success(`Deleted ${label}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.providerInstances.all,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Delete failed");
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => api.testProviderInstance(instance.id),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.outcome === "error") {
        toast.error(`Test failed: ${result.error}`);
      } else {
        toast.success(`Test mapped ${result.totalMapped} item(s)`);
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Test failed");
    },
  });

  const dirty =
    enabled !== instance.enabled ||
    label !== instance.label ||
    actorRef !== instance.actorRef ||
    inputTemplateJson !== instance.inputTemplateJson ||
    outputMappingJson !== instance.outputMappingJson ||
    (maxJobs ?? null) !== (instance.maxJobs ?? null) ||
    (maxAgeDays ?? null) !== (instance.maxAgeDays ?? null);

  const isTemplate = instance.templateId !== null;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1 flex-1">
            <CardTitle className="flex items-center gap-2">
              <Checkbox
                checked={enabled}
                onCheckedChange={(value) => setEnabled(value === true)}
                aria-label={`Enable ${label}`}
              />
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className="h-8 text-base font-semibold"
              />
            </CardTitle>
            <CardDescription>
              {instance.providerId} · <code>{instance.actorRef}</code>
              {isTemplate ? (
                <span className="ml-1 rounded bg-muted px-1 text-[10px] uppercase tracking-wider">
                  template: {instance.templateId}
                </span>
              ) : (
                <span className="ml-1 rounded bg-muted px-1 text-[10px] uppercase tracking-wider">
                  custom
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex gap-1">
            {template ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setInputTemplateJson(template.defaultInputTemplate);
                  resetMutation.mutate(template.defaultInputTemplate);
                }}
                disabled={resetMutation.isPending}
                title="Reset input template to the curated default (persists immediately)"
              >
                {resetMutation.isPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                )}
                Reset
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              title="Run actor once and preview mapped items"
            >
              {testMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="mr-1 h-3.5 w-3.5" />
              )}
              Test
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMutation.isPending}
              title="Delete this actor"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`actor-ref-${instance.id}`}>
              Actor reference
            </Label>
            <Input
              id={`actor-ref-${instance.id}`}
              value={actorRef}
              onChange={(event) => setActorRef(event.target.value)}
              disabled={isTemplate}
              placeholder="username/actor-name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`max-jobs-${instance.id}`}>
              Max jobs per run (optional)
            </Label>
            <Input
              id={`max-jobs-${instance.id}`}
              type="number"
              min={1}
              value={maxJobs ?? ""}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = Number.parseInt(raw, 10);
                setMaxJobs(
                  raw === "" || !Number.isFinite(parsed) ? undefined : parsed,
                );
              }}
              placeholder="Run-budget default"
              className="max-w-[12rem]"
            />
            <p className="text-xs text-muted-foreground">
              Caps jobs scraped per run for this actor, split evenly across the
              searches it makes (one per city, else country), overriding the
              run-budget calculation. Blank = derive from the run budget.
              Floored at 10 (the actor's minimum). Available to the input
              template as <code>{"{{maxJobs}}"}</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`max-age-${instance.id}`}>
              Max job age in days (optional)
            </Label>
            <Input
              id={`max-age-${instance.id}`}
              type="number"
              min={1}
              max={365}
              value={maxAgeDays ?? ""}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = Number.parseInt(raw, 10);
                setMaxAgeDays(
                  raw === "" || !Number.isFinite(parsed) ? undefined : parsed,
                );
              }}
              placeholder="Global default"
              className="max-w-[12rem]"
            />
            <p className="text-xs text-muted-foreground">
              Only scrape postings newer than this many days, overriding the
              global "Max job age to scrape" setting for this actor. Blank = use
              the global setting (or no limit if it's unset). For LinkedIn it's
              applied via the f_TPR date filter; freeform actors can reference it
              as <code>{"{{maxAgeDays}}"}</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`input-template-${instance.id}`}>
              Input template (JSON)
            </Label>
            <Textarea
              id={`input-template-${instance.id}`}
              value={inputTemplateJson}
              onChange={(event) => setInputTemplateJson(event.target.value)}
              rows={6}
              className="font-mono text-xs"
            />
          </div>

          {!isTemplate ? (
            <div className="space-y-2">
              <Label htmlFor={`output-mapping-${instance.id}`}>
                Output mapping (JSON dot-paths)
              </Label>
              <Textarea
                id={`output-mapping-${instance.id}`}
                value={outputMappingJson}
                onChange={(event) => setOutputMappingJson(event.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Required: <code>jobUrl</code>, <code>title</code>. Optional:{" "}
                <code>employer</code>, <code>location</code>,{" "}
                <code>jobDescription</code>, <code>datePosted</code>,{" "}
                <code>isRemote</code>, <code>applicationLink</code>,{" "}
                <code>salary</code>, <code>jobLevel</code>,{" "}
                <code>jobType</code>.
              </p>
            </div>
          ) : null}

          <div className="space-y-1 rounded-md border border-border/60 bg-muted/30 p-2 text-xs text-muted-foreground">
            <p>
              Available placeholders for the input template above:
            </p>
            <p className="font-mono">
              {(Object.keys(GLOBAL_FIELD_LABELS) as SourceConfigGlobalField[])
                .map((field) => `{{${field}}}`)
                .join("  ")}
            </p>
            <p>
              Each is sourced from the Run modal's globals at run time. Use
              only the ones your actor's input shape needs.
            </p>
          </div>

          <details className="group">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
              <ChevronDown className="inline h-3 w-3 align-text-bottom" />{" "}
              Show raw
            </summary>
            <div className="mt-3 space-y-3 text-xs">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Saved row
                </div>
                <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                  {JSON.stringify(instance, null, 2)}
                </pre>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      <TestResultDialog
        open={testResult !== null}
        onOpenChange={(value) => {
          if (!value) setTestResult(null);
        }}
        result={testResult}
      />

      <Dialog
        open={confirmDelete}
        onOpenChange={(value) => setConfirmDelete(value)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete actor?</DialogTitle>
            <DialogDescription>
              "{label}" will be removed. Existing jobs already imported are
              kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteMutation.mutate();
                setConfirmDelete(false);
              }}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface TestResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: ProviderInstanceTestResponse | null;
}

function TestResultDialog({
  open,
  onOpenChange,
  result,
}: TestResultDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Test result</DialogTitle>
          <DialogDescription>
            Mapped sample items from the actor run. Verify the title / employer
            / url fields look right before enabling.
          </DialogDescription>
        </DialogHeader>
        {result?.outcome === "error" ? (
          <p className="text-sm text-destructive">{result.error}</p>
        ) : result?.outcome === "ok" ? (
          <div className="space-y-3">
            <p className="text-sm">
              {result.totalMapped} item(s) mapped successfully. Showing first{" "}
              {result.samples.length}.
            </p>
            {result.samples.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No items returned by the actor.
              </p>
            ) : (
              <pre className="max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(result.samples, null, 2)}
              </pre>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
