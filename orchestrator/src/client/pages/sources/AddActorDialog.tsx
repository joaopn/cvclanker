import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type {
  CreateProviderInstanceInput,
  ProviderActorTemplateSummary,
  ProviderInstanceRow,
} from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface AddActorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  templates: ProviderActorTemplateSummary[];
  /**
   * The Sources page creates actors DISABLED (you Test one before enabling it).
   * The onboarding wizard has no Test surface and treats its tick as "use this
   * actor", so it creates them enabled.
   */
  defaultEnabled?: boolean;
  onCreated?: (instance: ProviderInstanceRow) => void;
}

const FREEFORM_INPUT_STARTER = JSON.stringify(
  {
    keywords: "{{searchTerms}}",
    location: "{{city}}",
    limit: "{{maxJobs}}",
  },
  null,
  2,
);

const FREEFORM_OUTPUT_STARTER = JSON.stringify(
  {
    jobUrl: "applyUrl",
    title: "title",
    employer: "companyName",
    location: "location",
    jobDescription: "description",
    datePosted: "postedAt",
    isRemote: "isRemote",
  },
  null,
  2,
);

type Mode = "template" | "custom";

export function AddActorDialog({
  open,
  onOpenChange,
  providerId,
  templates,
  defaultEnabled = false,
  onCreated,
}: AddActorDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(
    templates.length > 0 ? "template" : "custom",
  );
  const [templateId, setTemplateId] = useState<string>(
    templates[0]?.id ?? "",
  );
  const [label, setLabel] = useState("");
  const [actorRef, setActorRef] = useState("");
  const [inputTemplateJson, setInputTemplateJson] =
    useState(FREEFORM_INPUT_STARTER);
  const [outputMappingJson, setOutputMappingJson] = useState(
    FREEFORM_OUTPUT_STARTER,
  );
  const [maxJobs, setMaxJobs] = useState<number | undefined>(undefined);
  const [maxAgeDays, setMaxAgeDays] = useState<number | undefined>(undefined);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templateId, templates],
  );

  useEffect(() => {
    if (!open) return;
    if (mode === "template" && selectedTemplate) {
      setLabel(selectedTemplate.displayName);
      setActorRef(selectedTemplate.actorRef);
      setInputTemplateJson(selectedTemplate.defaultInputTemplate);
      setOutputMappingJson("{}");
    }
  }, [open, mode, selectedTemplate]);

  const mutation = useMutation({
    mutationFn: async (input: CreateProviderInstanceInput) =>
      api.createProviderInstance(input),
    onSuccess: (created) => {
      toast.success("Actor added");
      queryClient.invalidateQueries({
        queryKey: queryKeys.providerInstances.all,
      });
      onCreated?.(created);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Save failed");
    },
  });

  const onSubmit = () => {
    const trimmedLabel = label.trim();
    const trimmedActor = actorRef.trim();
    if (!trimmedLabel || !trimmedActor) {
      toast.error("Label and actor reference are required");
      return;
    }
    if (mode === "template" && !selectedTemplate) {
      toast.error("Pick a template or switch to custom mode");
      return;
    }
    try {
      JSON.parse(inputTemplateJson);
    } catch {
      toast.error("Input template is not valid JSON");
      return;
    }
    if (mode === "custom") {
      try {
        JSON.parse(outputMappingJson);
      } catch {
        toast.error("Output mapping is not valid JSON");
        return;
      }
    }

    mutation.mutate({
      providerId,
      actorRef: trimmedActor,
      label: trimmedLabel,
      templateId: mode === "template" ? (selectedTemplate?.id ?? null) : null,
      enabled: defaultEnabled,
      inputTemplateJson,
      outputMappingJson: mode === "template" ? "{}" : outputMappingJson,
      mappings:
        mode === "template" ? (selectedTemplate?.defaultMappings ?? {}) : {},
      maxJobs,
      maxAgeDays,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Apify actor</DialogTitle>
          <DialogDescription>
            Pick a curated template for a known-good actor, or paste a custom
            actor ref with your own input + output mapping.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as Mode)}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem
                value="template"
                disabled={templates.length === 0}
              />
              From template ({templates.length})
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="custom" />
              Custom actor
            </label>
          </RadioGroup>

          {mode === "template" ? (
            <div className="space-y-2">
              <Label>Template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTemplate ? (
                <p className="text-xs text-muted-foreground">
                  {selectedTemplate.description}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="add-actor-label">Label</Label>
            <Input
              id="add-actor-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="LinkedIn (Apify)"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-actor-ref">Actor reference</Label>
            <Input
              id="add-actor-ref"
              value={actorRef}
              onChange={(event) => setActorRef(event.target.value)}
              placeholder="username/actor-name"
              disabled={mode === "template"}
            />
            <p className="text-xs text-muted-foreground">
              From the actor's Apify URL: e.g. <code>curious_coder/linkedin-jobs-scraper</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-actor-input">Input template (JSON)</Label>
            <Textarea
              id="add-actor-input"
              value={inputTemplateJson}
              onChange={(event) => setInputTemplateJson(event.target.value)}
              rows={6}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Placeholders:{" "}
              <code>{"{{searchTerms}}"}</code>{" "}
              <code>{"{{city}}"}</code>{" "}
              <code>{"{{country}}"}</code>{" "}
              <code>{"{{workplaceTypes}}"}</code>{" "}
              <code>{"{{maxJobsPerTerm}}"}</code>
              . Each placeholder must be the entire string value of its JSON
              field; arrays/numbers substitute structurally.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-actor-max-jobs">
              Max jobs per run (optional)
            </Label>
            <Input
              id="add-actor-max-jobs"
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
              Caps jobs scraped per run for this actor, split across the
              searches it makes, overriding the run-budget calculation (also
              available as <code>{"{{maxJobs}}"}</code>). Blank = derive from
              the run budget.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-actor-max-age">
              Max job age in days (optional)
            </Label>
            <Input
              id="add-actor-max-age"
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
              global "Max job age to scrape" setting (also available as{" "}
              <code>{"{{maxAgeDays}}"}</code>). Blank = use the global setting.
            </p>
          </div>

          {mode === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="add-actor-output">Output mapping (JSON)</Label>
              <Textarea
                id="add-actor-output"
                value={outputMappingJson}
                onChange={(event) => setOutputMappingJson(event.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Map each <code>CreateJobInput</code> field to a dot-path in the
                actor's output item. <code>jobUrl</code> and{" "}
                <code>title</code> are required; the rest are optional.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Add actor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
