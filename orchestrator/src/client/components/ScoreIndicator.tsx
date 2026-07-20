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

// Opaque, theme-independent badge colors: the dark-scheme tints (Tailwind hue
// over the #3b4252 card) baked to fixed hex so chips render identically in both
// themes; vivid text stays on the fixed Tailwind palette.
export const PILL_CLASS: Record<SuitabilityCategory, string> = {
  very_good_fit: "bg-[#3b5459] text-emerald-300 border-[#396560]",
  good_fit: "bg-[#3b4c61] text-sky-300 border-[#385f80]",
  bad_fit: "bg-[#3e4657] text-[#d8dee9] border-[#404859]",
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
