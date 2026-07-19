/**
 * Suitability category display component.
 */

import {
  SUITABILITY_CATEGORY_LABELS,
  type SuitabilityCategory,
} from "@shared/types.js";
import type React from "react";

import { cn } from "@/lib/utils";

interface FitIndicatorProps {
  category: SuitabilityCategory | null;
  className?: string;
}

export const PILL_CLASS: Record<SuitabilityCategory, string> = {
  very_good_fit:
    "bg-status-good/15 text-status-good-text border-status-good/30",
  good_fit: "bg-status-info/10 text-status-info-text border-status-info/30",
  bad_fit: "bg-muted/40 text-muted-foreground border-border/60",
};

export const FitIndicator: React.FC<FitIndicatorProps> = ({
  category,
  className,
}) => {
  if (category === null) {
    return (
      <span className={cn("text-sm text-muted-foreground", className)}>
        Not scored
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        PILL_CLASS[category],
        className,
      )}
    >
      {SUITABILITY_CATEGORY_LABELS[category]}
    </span>
  );
};
