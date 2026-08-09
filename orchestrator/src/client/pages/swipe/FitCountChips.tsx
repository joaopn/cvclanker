/**
 * Inbox breakdown shown above the deck: one fit-category chip per category
 * present, reusing the deck card's exact fit-chip colors, with the live count
 * of remaining cards in that category.
 */

import { PILL_CLASS } from "@client/components/ScoreIndicator";
import {
  SUITABILITY_CATEGORY_LABELS,
  type Job,
  type SuitabilityCategory,
} from "@shared/types.js";
import type React from "react";
import { cn } from "@/lib/utils";

type Bucket = SuitabilityCategory | "unscored";

const ORDER: Bucket[] = [
  "great_fit",
  "very_good_fit",
  "good_fit",
  "bad_fit",
  "unscored",
];
const UNSCORED_CLASS = "bg-muted/40 text-muted-foreground border-border/60";

export const FitCountChips: React.FC<{ jobs: Job[] }> = ({ jobs }) => {
  const counts: Record<Bucket, number> = {
    great_fit: 0,
    very_good_fit: 0,
    good_fit: 0,
    bad_fit: 0,
    unscored: 0,
  };
  for (const job of jobs) {
    counts[job.suitabilityCategory ?? "unscored"] += 1;
  }

  const present = ORDER.filter((bucket) => counts[bucket] > 0);
  if (present.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {present.map((bucket) => (
        <span
          key={bucket}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
            bucket === "unscored" ? UNSCORED_CLASS : PILL_CLASS[bucket],
          )}
        >
          {bucket === "unscored"
            ? "Not scored"
            : SUITABILITY_CATEGORY_LABELS[bucket]}
          <span className="tabular-nums">{counts[bucket]}</span>
        </span>
      ))}
    </div>
  );
};
