import { PILL_CLASS } from "@client/components/ScoreIndicator";
import { configSubtitle, type DisagreementRow } from "@shared/scoring-bench";
import { type BenchConfig, SUITABILITY_CATEGORY_LABELS } from "@shared/types";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type BenchDisagreementDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: DisagreementRow[];
  configs: BenchConfig[];
};

/**
 * The second half of a benchmark: a table says the models disagreed, this says
 * WHY. Each config's own reasoning sits next to its category, because the
 * question "is the cheap model wrong, or just stricter?" is only answerable
 * from the prose.
 */
export const BenchDisagreementDialog: React.FC<
  BenchDisagreementDialogProps
> = ({ open, onOpenChange, rows, configs }) => {
  const [index, setIndex] = useState(0);

  // Results stream in while the dialog is open, so the list can shrink under
  // the cursor; clamping beats rendering an empty pane.
  useEffect(() => {
    if (index > rows.length - 1) setIndex(Math.max(0, rows.length - 1));
  }, [rows.length, index]);

  const row = rows[index];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{row ? row.job.title : "No disagreements"}</DialogTitle>
          <DialogDescription>
            {row
              ? `${row.job.employer} — disagreement ${index + 1} of ${rows.length}`
              : "Every configuration landed on the same category."}
          </DialogDescription>
        </DialogHeader>

        {row ? (
          <>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {configs.map((config) => {
                const cell = row.cells.find(
                  (entry) => entry.configId === config.id,
                );
                return (
                  <div key={config.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium">
                          {config.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {configSubtitle(config)}
                        </div>
                      </div>
                      {cell?.category ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                            PILL_CLASS[cell.category],
                          )}
                        >
                          {SUITABILITY_CATEGORY_LABELS[cell.category]}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {cell?.status === "error" ? "Failed" : "No result"}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                      {cell?.reason ?? cell?.error ?? "—"}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2">
              {row.job.jobUrl ? (
                <a
                  href={row.job.jobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Open listing
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => setIndex((value) => Math.max(0, value - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index >= rows.length - 1}
                  onClick={() =>
                    setIndex((value) => Math.min(rows.length - 1, value + 1))
                  }
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
