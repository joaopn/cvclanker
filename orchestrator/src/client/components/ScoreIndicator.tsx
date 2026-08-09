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

// Opaque badge colors. The HUE is theme-independent (fixed Tailwind -500
// values in --badge-* , src/index.css) so a status keeps one identity across
// every palette; only --badge-base, the surface the tint is flattened over, is
// per-theme, which is what keeps a chip sitting flush on its card instead of
// floating as a differently-toned rectangle. Chips stay opaque — never swap
// these back to translucent /NN tints or to the semantic -text tokens, both of
// which desaturate against the card. Vivid text stays on the fixed Tailwind
// palette and is deliberately NOT re-based.
export const PILL_CLASS: Record<SuitabilityCategory, string> = {
  great_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-purple))] text-violet-300 border-[color:color-mix(in_oklab,var(--badge-base)_65%,var(--badge-purple))]",
  very_good_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-good))] text-emerald-300 border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-good))]",
  good_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-info))] text-sky-300 border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-info))]",
  bad_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_60%,var(--badge-muted))] text-[#d8dee9] border-[color:color-mix(in_oklab,var(--badge-base)_40%,var(--badge-muted))]",
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
