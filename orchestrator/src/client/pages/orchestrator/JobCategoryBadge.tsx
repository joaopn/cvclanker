/**
 * The fit-classification pill (Great / Very good / Good / Bad) a scored job
 * carries. Shared so every surface that lists jobs — the Manage list rows, the
 * company-jobs dialog — labels a classification the same way.
 */

import type { SuitabilityCategory } from "@shared/types.js";
import { cn } from "@/lib/utils";

// Opaque badge colors. The HUE is theme-independent (fixed Tailwind -500
// values in --badge-* , src/index.css) so a status keeps one identity across
// every palette; only --badge-base, the surface the tint is flattened over, is
// per-theme, which is what keeps a chip sitting flush on its card instead of
// floating as a differently-toned rectangle. Chips stay opaque — never swap
// these back to translucent /NN tints or to the semantic -text tokens, both of
// which desaturate against the card. Vivid text stays on the fixed Tailwind
// palette and is deliberately NOT re-based.
const CATEGORY_PILL_CLASS: Record<SuitabilityCategory, string> = {
  great_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-purple))] text-violet-300 border border-[color:color-mix(in_oklab,var(--badge-base)_65%,var(--badge-purple))]",
  very_good_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-good))] text-emerald-300 border border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-good))]",
  good_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-info))] text-sky-300 border border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-info))]",
  bad_fit:
    "bg-[color-mix(in_oklab,var(--badge-base)_60%,var(--badge-muted))] text-[#d8dee9] border border-[color:color-mix(in_oklab,var(--badge-base)_40%,var(--badge-muted))]",
};

const CATEGORY_PILL_LABEL: Record<SuitabilityCategory, string> = {
  great_fit: "Great",
  very_good_fit: "Very good",
  good_fit: "Good",
  bad_fit: "Bad",
};

interface JobCategoryBadgeProps {
  category: SuitabilityCategory;
  className?: string;
}

export const JobCategoryBadge = ({
  category,
  className,
}: JobCategoryBadgeProps) => (
  <span
    className={cn(
      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
      CATEGORY_PILL_CLASS[category],
      className,
    )}
  >
    {CATEGORY_PILL_LABEL[category]}
  </span>
);
