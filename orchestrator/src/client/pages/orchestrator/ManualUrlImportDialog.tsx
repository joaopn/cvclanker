import { toast } from "@client/lib/toast";
import {
  getUrlImportDraft,
  saveManualUrlImport,
} from "@client/lib/url-import-batch";
import type { ManualJobDraft } from "@shared/types";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";

export interface ManualUrlImportTarget {
  batchId: string;
  url: string;
}

type DraftField = keyof ManualJobDraft;
type DraftValues = Record<DraftField, string>;

const REQUIRED_FIELDS = ["title", "employer", "jobDescription"] as const;

const PRIMARY_FIELDS: Array<{ field: DraftField; label: string }> = [
  { field: "title", label: "Title" },
  { field: "employer", label: "Employer" },
  { field: "location", label: "Location" },
  { field: "salary", label: "Salary" },
  { field: "deadline", label: "Deadline" },
  { field: "jobUrl", label: "Job URL" },
];

const MORE_FIELDS: Array<{ field: DraftField; label: string }> = [
  { field: "applicationLink", label: "Application link" },
  { field: "jobType", label: "Job type" },
  { field: "jobLevel", label: "Level" },
  { field: "jobFunction", label: "Function" },
  { field: "disciplines", label: "Disciplines" },
  { field: "degreeRequired", label: "Degree required" },
  { field: "starting", label: "Starting" },
];

const ALL_FIELDS: DraftField[] = [
  ...PRIMARY_FIELDS.map((entry) => entry.field),
  "jobDescription",
  ...MORE_FIELDS.map((entry) => entry.field),
];

function toValues(draft: ManualJobDraft | null, url: string): DraftValues {
  const values = Object.fromEntries(
    ALL_FIELDS.map((field) => [field, draft?.[field] ?? ""]),
  ) as DraftValues;
  if (!values.jobUrl.trim()) values.jobUrl = url;
  return values;
}

function toDraft(values: DraftValues): ManualJobDraft {
  const draft: ManualJobDraft = {};
  for (const field of ALL_FIELDS) {
    const value = values[field].trim();
    if (value) draft[field] = value;
  }
  return draft;
}

interface ManualUrlImportDialogProps {
  target: ManualUrlImportTarget | null;
  onClose: () => void;
  onSaved: () => void;
}

export const ManualUrlImportDialog: React.FC<ManualUrlImportDialogProps> = ({
  target,
  onClose,
  onSaved,
}) => {
  const [loaded, setLoaded] = useState<{
    target: ManualUrlImportTarget;
    values: DraftValues;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  // The row last opened keeps rendering while the dialog animates closed, so
  // the form does not collapse to the spinner on its way out.
  const lastTargetRef = useRef(target);
  if (target) lastTargetRef.current = target;
  const shown = target ?? lastTargetRef.current;
  const targetRef = useRef(target);
  targetRef.current = target;
  // Closing the sheet unmounts this form, possibly without a render that sees
  // the cleared target; a save answering after that must not count as open.
  useEffect(
    () => () => {
      targetRef.current = null;
    },
    [],
  );
  // Values loaded for another row never show under this one.
  const values = loaded && loaded.target === shown ? loaded.values : null;

  useEffect(() => {
    if (!target) return;
    let current = true;
    getUrlImportDraft(target.batchId, target.url)
      .catch(() => null)
      .then((draft) => {
        if (current) setLoaded({ target, values: toValues(draft, target.url) });
      });
    return () => {
      current = false;
    };
  }, [target]);

  const missingRequired =
    values === null ||
    REQUIRED_FIELDS.some((field) => values[field].trim().length === 0);

  const setField = (field: DraftField, value: string) => {
    setLoaded((prev) =>
      prev ? { ...prev, values: { ...prev.values, [field]: value } } : prev,
    );
  };

  const handleSave = async () => {
    if (!target || !values || missingRequired) return;
    const saved = target;
    setSaving(true);
    try {
      const result = await saveManualUrlImport({
        batchId: saved.batchId,
        url: saved.url,
        job: toDraft(values),
      });
      toast.success(
        result.status === "duplicate" ? "Already imported" : "Job saved",
      );
      onSaved();
      // Only the row that was saved closes: the sheet can be closed and
      // reopened on another row while a save is still in flight.
      if (targetRef.current === saved) onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't save the job",
      );
    } finally {
      setSaving(false);
    }
  };

  const renderInput = ({
    field,
    label,
  }: {
    field: DraftField;
    label: string;
  }) => (
    <div key={field} className="space-y-1">
      <Label htmlFor={`manual-import-${field}`}>
        {label}
        {(REQUIRED_FIELDS as readonly string[]).includes(field) && " *"}
      </Label>
      <Input
        id={`manual-import-${field}`}
        aria-required={(REQUIRED_FIELDS as readonly string[]).includes(field)}
        value={values?.[field] ?? ""}
        onChange={(event) => setField(field, event.target.value)}
      />
    </div>
  );

  return (
    // No closing while a save is in flight: its answer would land on a closed
    // form, or on the next row's.
    <Dialog
      open={target !== null}
      onOpenChange={(next) => !next && !saving && onClose()}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add job manually</DialogTitle>
          <DialogDescription className="break-all">
            {shown?.url}
          </DialogDescription>
        </DialogHeader>

        {values === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading what was fetched…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {PRIMARY_FIELDS.map(renderInput)}
            </div>
            <div className="space-y-1">
              <Label htmlFor="manual-import-jobDescription">
                Description *
              </Label>
              <Textarea
                id="manual-import-jobDescription"
                aria-required
                value={values.jobDescription}
                onChange={(event) =>
                  setField("jobDescription", event.target.value)
                }
                className="min-h-[200px] text-sm"
              />
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                More fields
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {MORE_FIELDS.map(renderInput)}
              </div>
            </details>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={missingRequired || saving}
          >
            Save job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
