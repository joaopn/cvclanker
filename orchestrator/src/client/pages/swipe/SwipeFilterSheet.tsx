/**
 * Bottom filter and sort menu for the Swipe deck: a drawer sliding up from
 * the bottom edge with a Sort row and one badge row per filter family (Fit /
 * Profile / Job title), every badge always shown. Tapping a badge toggles it; empty
 * families narrow nothing. Reuses the Manage filter bar's chip colours and
 * the Manage list sorter's values and labels, so a badge — and a sort — mean
 * the same thing on both surfaces.
 */

import type React from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import {
  FIT_FILTER_CHIP_CLASS,
  FIT_FILTER_LABELS,
  FIT_FILTER_VALUES,
  JOB_SORTER_LABELS,
  JOB_SORTERS,
  type JobSorter,
  PROFILE_FILTER_CHIP_CLASS,
  TITLE_FILTER_CHIP_CLASS,
  UNATTRIBUTED_PROFILE_ID,
  UNATTRIBUTED_PROFILE_LABEL,
} from "../orchestrator/constants";
import { hasActiveSwipeFilters, type SwipeFilterState } from "./swipeFilters";

const CHIP_CLASS = "h-8 px-2.5 text-xs font-medium";

// The sort chips are a control, not a badge family: they carry the semantic
// surface tokens rather than a hue, so nothing reads them as a fourth thing
// to filter by (and no unclaimed badge hue is spent on them).
const SORTER_CHIP_CLASS = {
  // Both states pin their own hover — ghost's `hover:bg-accent` has nothing to
  // lose the merge to otherwise, and a phone latches :hover on the chip you
  // just tapped, which is exactly the selected one.
  active:
    "border border-border bg-secondary text-secondary-foreground hover:bg-secondary hover:text-secondary-foreground",
  inactive:
    "border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
};

export interface SwipeFilterProfile {
  id: string;
  name: string;
}

interface SwipeFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: SwipeFilterState;
  onFiltersChange: (filters: SwipeFilterState) => void;
  /** The Manage list sorter, reused verbatim — see `applySwipeSort`. */
  sorter: JobSorter;
  onSorterChange: (sorter: JobSorter) => void;
  profiles: SwipeFilterProfile[];
  titles: string[];
}

const toggle = (selected: string[], value: string): string[] =>
  selected.includes(value)
    ? selected.filter((entry) => entry !== value)
    : [...selected, value];

/** The sheet's badge rows — exported for tests (rendered portal-free). */
export const SwipeFilterSections: React.FC<
  Pick<
    SwipeFilterSheetProps,
    | "filters"
    | "onFiltersChange"
    | "sorter"
    | "onSorterChange"
    | "profiles"
    | "titles"
  >
> = ({
  filters,
  onFiltersChange,
  sorter,
  onSorterChange,
  profiles,
  titles,
}) => (
  <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-6">
    {/* Sorting, not filtering: it hides nothing, so it has no effect on the
        trigger's active dot and is not what "Clear filters" clears. Its own
        None chip is its reset. */}
    <FilterSection label="Sort" ariaLabel="Sort order" groupRole="radiogroup">
      {JOB_SORTERS.map((value) => {
        const active = sorter === value;
        return (
          <Button
            key={value}
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              CHIP_CLASS,
              active ? SORTER_CHIP_CLASS.active : SORTER_CHIP_CLASS.inactive,
            )}
            // The filter families are multi-select toggles; picking a sort
            // unpicks the others, so these carry radio semantics instead —
            // the same thing the Manage sorter's menu announces.
            role="radio"
            aria-checked={active}
            onClick={() => onSorterChange(value)}
          >
            {JOB_SORTER_LABELS[value]}
          </Button>
        );
      })}
    </FilterSection>

    <FilterSection label="Fit">
      {FIT_FILTER_VALUES.map((value) => {
        const active = filters.fit.includes(value);
        const classes = FIT_FILTER_CHIP_CLASS[value];
        return (
          <Button
            key={value}
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              CHIP_CLASS,
              active ? classes.active : classes.inactive,
            )}
            aria-pressed={active}
            onClick={() =>
              onFiltersChange({
                ...filters,
                fit: FIT_FILTER_VALUES.filter((entry) =>
                  entry === value ? !active : filters.fit.includes(entry),
                ),
              })
            }
          >
            {FIT_FILTER_LABELS[value]}
          </Button>
        );
      })}
    </FilterSection>

    <FilterSection label="Profile">
      {profiles.length === 0 ? (
        <EmptyFamilyHint>No search profiles yet.</EmptyFamilyHint>
      ) : (
        // The sentinel rides at the end of the row: rows with no attribution
        // (manual imports, anything discovered before the column existed)
        // match no real profile, so without it they are unreachable the
        // moment any profile badge is picked.
        [
          ...profiles.map((profile) => ({
            value: profile.id,
            label: profile.name,
          })),
          { value: UNATTRIBUTED_PROFILE_ID, label: UNATTRIBUTED_PROFILE_LABEL },
        ].map((chip) => {
          const active = filters.profile.includes(chip.value);
          return (
            <Button
              key={chip.value}
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                CHIP_CLASS,
                active
                  ? PROFILE_FILTER_CHIP_CLASS.active
                  : PROFILE_FILTER_CHIP_CLASS.inactive,
              )}
              aria-pressed={active}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  profile: toggle(filters.profile, chip.value),
                })
              }
            >
              {chip.label}
            </Button>
          );
        })
      )}
    </FilterSection>

    <FilterSection label="Job title">
      {titles.length === 0 ? (
        <EmptyFamilyHint>
          No search terms in any Search Profile yet.
        </EmptyFamilyHint>
      ) : (
        titles.map((title) => {
          const active = filters.title.includes(title);
          return (
            <Button
              key={title}
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                CHIP_CLASS,
                active
                  ? TITLE_FILTER_CHIP_CLASS.active
                  : TITLE_FILTER_CHIP_CLASS.inactive,
              )}
              aria-pressed={active}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  title: toggle(filters.title, title),
                })
              }
            >
              {title}
            </Button>
          );
        })
      )}
    </FilterSection>
  </div>
);

export const SwipeFilterSheet: React.FC<SwipeFilterSheetProps> = ({
  open,
  onOpenChange,
  filters,
  onFiltersChange,
  sorter,
  onSorterChange,
  profiles,
  titles,
}) => (
  <Drawer open={open} onOpenChange={onOpenChange}>
    {/* Capped so long profile / search-term rows scroll inside the sheet
        instead of pushing the header off the top of a phone viewport. */}
    <DrawerContent className="max-h-[90dvh]">
      <DrawerHeader className="flex flex-row items-center justify-between gap-2 text-left">
        <div className="grid gap-1">
          <DrawerTitle>Filters &amp; sorting</DrawerTitle>
          <DrawerDescription>
            Pick badges to narrow the deck, or change its order. Empty badge
            rows show everything.
          </DrawerDescription>
        </div>
        {/* Named for what it clears: the sort is reset by its own None chip,
            so no button resets state its label does not mention. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!hasActiveSwipeFilters(filters)}
          onClick={() => onFiltersChange({ fit: [], profile: [], title: [] })}
        >
          Clear filters
        </Button>
      </DrawerHeader>
      <SwipeFilterSections
        filters={filters}
        onFiltersChange={onFiltersChange}
        sorter={sorter}
        onSorterChange={onSorterChange}
        profiles={profiles}
        titles={titles}
      />
    </DrawerContent>
  </Drawer>
);

function FilterSection({
  label,
  ariaLabel,
  groupRole,
  children,
}: {
  label: string;
  /** Defaults to "<label> filters" — the Sort row is not a filter. */
  ariaLabel?: string;
  groupRole?: "radiogroup";
  children: React.ReactNode;
}) {
  // One named element per section: the fieldset is the group, and the Sort row
  // overrides its role so the name lands on the radiogroup itself rather than
  // on a wrapper the radios sit inside.
  return (
    <fieldset
      role={groupRole}
      aria-label={ariaLabel ?? `${label} filters`}
      className="flex flex-col gap-1.5"
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </fieldset>
  );
}

function EmptyFamilyHint({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}
