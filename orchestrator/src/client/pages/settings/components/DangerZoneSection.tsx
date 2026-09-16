import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import {
  ALL_JOB_STATUSES,
  STATUS_DESCRIPTIONS,
} from "@client/pages/settings/constants";
import {
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_LABELS,
  type JobStatus,
  type SuitabilityCategory,
} from "@shared/types";
import { AlertTriangle, Trash2 } from "lucide-react";

import type React from "react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type DangerZoneSectionProps = {
  statusesToClear: JobStatus[];
  toggleStatusToClear: (status: JobStatus) => void;
  handleClearByStatuses: () => void;
  handleClearDatabase: () => void;
  handleClearByCategory?: (category: SuitabilityCategory) => void;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

export const DangerZoneSection: React.FC<DangerZoneSectionProps> = ({
  statusesToClear,
  toggleStatusToClear,
  handleClearByStatuses,
  handleClearDatabase,
  handleClearByCategory,
  isLoading,
  isSaving,
  layoutMode,
}) => {
  const [selectedCategory, setSelectedCategory] =
    useState<SuitabilityCategory | "">("");
  const isValidCategory = selectedCategory !== "";
  const historyStatusesSelected = statusesToClear.filter(
    (status) => status === "closed" || status === "skipped",
  );
  return (
    <SettingsSectionFrame
      mode={layoutMode}
      tone="danger"
      title={
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-base font-semibold tracking-wider">
            Danger Zone
          </span>
        </div>
      }
      value="danger-zone"
    >
      <div className="space-y-4 pt-2">
        <div className="p-3 rounded-md space-y-4">
          <div className="space-y-0.5">
            <div className="text-sm font-semibold text-destructive">
              Clear Jobs by Status
            </div>
            <div className="text-xs text-muted-foreground">
              Select which job statuses you want to clear. Clearing{" "}
              <span className="font-medium text-foreground">closed</span> or{" "}
              <span className="font-medium text-foreground">skipped</span>{" "}
              deletes application history (outcomes, applied/closed timestamps);
              this is irreversible.
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ALL_JOB_STATUSES.map((status) => {
              const isSelected = statusesToClear.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => toggleStatusToClear(status)}
                  disabled={isLoading || isSaving}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 ${
                    isSelected
                      ? "border-destructive bg-destructive/10"
                      : "border-border"
                  }`}
                >
                  <div
                    className={`mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                      isSelected
                        ? "border-destructive"
                        : "border-muted-foreground"
                    }`}
                  >
                    {isSelected && (
                      <div className="h-2 w-2 rounded-full bg-destructive" />
                    )}
                  </div>
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium capitalize">
                      {status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {STATUS_DESCRIPTIONS[status]}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={isLoading || isSaving || statusesToClear.length === 0}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Clear Selected ({statusesToClear.length})
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear jobs by status?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete all jobs with the following statuses:{" "}
                  {statusesToClear.join(", ")}. This action cannot be undone.
                  {historyStatusesSelected.length > 0 ? (
                    <span className="mt-2 block font-medium text-destructive">
                      Includes {historyStatusesSelected.join(" + ")} —
                      application history (outcomes, applied/closed timestamps)
                      will be lost.
                    </span>
                  ) : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleClearByStatuses}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Clear {statusesToClear.length} status
                  {statusesToClear.length !== 1 ? "es" : ""}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <Separator />

        {/* Clear Jobs Below Score */}
        {handleClearByCategory && (
          <div className="p-3 rounded-md space-y-4">
            <div className="space-y-0.5">
              <div className="text-sm font-semibold text-destructive">
                Clear Jobs by Fit Category
              </div>
              <div className="text-xs text-muted-foreground">
                Remove all jobs whose suitability is at or below the selected
                category. Live jobs and anything you ever applied to are
                preserved, wherever they now sit.
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label
                  htmlFor="clear-category"
                  className="text-sm font-medium mb-1.5 block"
                >
                  Fit category
                </label>
                <select
                  id="clear-category"
                  value={selectedCategory}
                  onChange={(e) =>
                    setSelectedCategory(
                      e.target.value as SuitabilityCategory | "",
                    )
                  }
                  disabled={isLoading || isSaving}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Select a category…</option>
                  {SUITABILITY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {SUITABILITY_CATEGORY_LABELS[category]} and worse
                    </option>
                  ))}
                </select>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="default"
                    disabled={isLoading || isSaving || !isValidCategory}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear{" "}
                    {isValidCategory
                      ? SUITABILITY_CATEGORY_LABELS[selectedCategory]
                      : "..."}{" "}
                    and worse
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Clear jobs at or below "
                      {isValidCategory
                        ? SUITABILITY_CATEGORY_LABELS[selectedCategory]
                        : ""}
                      "?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all jobs whose suitability
                      category is at or below "
                      {isValidCategory
                        ? SUITABILITY_CATEGORY_LABELS[selectedCategory]
                        : ""}
                      ". Live jobs and anything you ever applied to are
                      preserved, wherever they now sit. This action cannot be
                      undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        if (isValidCategory) {
                          handleClearByCategory(selectedCategory);
                          setSelectedCategory("");
                        }
                      }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Clear jobs
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        <Separator />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between p-3 rounded-md">
          <div className="space-y-0.5">
            <div className="text-sm font-semibold text-destructive">
              Clear Entire Database
            </div>
            <div className="text-xs text-muted-foreground">
              Delete all jobs and pipeline runs from the database.
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={isLoading || isSaving}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Clear Database
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all jobs?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes all jobs and pipeline runs from the database.
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleClearDatabase}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Clear database
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </SettingsSectionFrame>
  );
};
