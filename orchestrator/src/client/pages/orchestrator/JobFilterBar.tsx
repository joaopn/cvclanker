import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { FitFilterValue, JobFilterChipType, JobSorter } from "./constants";
import {
  FIT_FILTER_CHIP_CLASS,
  FIT_FILTER_LABELS,
  FIT_FILTER_VALUES,
  isFilterFamilyActive,
  JOB_FILTER_CHIP_LABELS,
  PROFILE_FILTER_CHIP_CLASS,
  TITLE_FILTER_CHIP_CLASS,
  UNATTRIBUTED_PROFILE_ID,
  UNATTRIBUTED_PROFILE_LABEL,
} from "./constants";
import { JobSorterMenu } from "./JobSorterMenu";

export interface JobFilterBarProfile {
  id: string;
  name: string;
}

interface JobFilterBarProps {
  // Families offered on this tab (their tickboxes), and the subset currently
  // switched on (their badge rows).
  availableTypes: JobFilterChipType[];
  enabledTypes: JobFilterChipType[];
  onToggleType: (type: JobFilterChipType) => void;
  fitFilter: FitFilterValue[];
  onFitFilterChange: (value: FitFilterValue[]) => void;
  profiles: JobFilterBarProfile[];
  profileFilter: string[];
  onToggleProfile: (profileId: string) => void;
  titles: string[];
  titleFilter: string[];
  onToggleTitle: (title: string) => void;
  // The unmodified facet "+ Filter" control, rendered inline on the tickbox
  // row. Absent on tabs that don't carry facets.
  facetBar?: ReactNode;
  // The sorter icon menu, pinned to the right end of the same row.
  sorter: JobSorter;
  onSorterChange: (sorter: JobSorter) => void;
}

const CHIP_CLASS = "h-7 px-2 text-xs font-medium";

/**
 * The Manage view's filter bar: one control row carrying a tickbox per badge
 * family plus the facet "+ Filter" button, with the sorter icon at its right
 * end, then one badge row per enabled family (fit, profile, job title — in
 * that order).
 *
 * Fit badges keep their per-category colours; the profile and job-title
 * families each use a single hardcoded colour for every badge in the row.
 */
export function JobFilterBar({
  availableTypes,
  enabledTypes,
  onToggleType,
  fitFilter,
  onFitFilterChange,
  profiles,
  profileFilter,
  onToggleProfile,
  titles,
  titleFilter,
  onToggleTitle,
  facetBar,
  sorter,
  onSorterChange,
}: JobFilterBarProps) {
  const isEnabled = (type: JobFilterChipType) =>
    isFilterFamilyActive(availableTypes, enabledTypes, type);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        {availableTypes.map((type) => {
          const id = `job-filter-type-${type}`;
          return (
            <div key={type} className="flex shrink-0 items-center gap-1.5">
              <Checkbox
                id={id}
                checked={enabledTypes.includes(type)}
                onCheckedChange={() => onToggleType(type)}
              />
              <label
                htmlFor={id}
                className="cursor-pointer text-xs font-medium text-muted-foreground"
              >
                {JOB_FILTER_CHIP_LABELS[type]}
              </label>
            </div>
          );
        })}
        {facetBar ? <div className="min-w-0">{facetBar}</div> : null}
        <div className="ml-auto shrink-0">
          <JobSorterMenu sorter={sorter} onSorterChange={onSorterChange} />
        </div>
      </div>

      {isEnabled("fit") ? (
        <FilterChipRow label="Fit filters">
          {FIT_FILTER_VALUES.map((value) => {
            const active = fitFilter.includes(value);
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
                  onFitFilterChange(
                    active
                      ? fitFilter.filter((entry) => entry !== value)
                      : FIT_FILTER_VALUES.filter(
                          (entry) =>
                            fitFilter.includes(entry) || entry === value,
                        ),
                  )
                }
              >
                {FIT_FILTER_LABELS[value]}
              </Button>
            );
          })}
        </FilterChipRow>
      ) : null}

      {isEnabled("profile") ? (
        <FilterChipRow label="Search profile filters">
          {profiles.length === 0 ? (
            <EmptyFamilyHint>No search profiles yet.</EmptyFamilyHint>
          ) : (
            // The sentinel rides at the end of the same row: rows with no
            // attribution (manual imports, anything discovered before the
            // column existed) match no real profile, so without it they are
            // unreachable the moment any profile chip is picked.
            [
              ...profiles.map((profile) => ({
                value: profile.id,
                label: profile.name,
              })),
              {
                value: UNATTRIBUTED_PROFILE_ID,
                label: UNATTRIBUTED_PROFILE_LABEL,
              },
            ].map((chip) => {
              const active = profileFilter.includes(chip.value);
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
                  onClick={() => onToggleProfile(chip.value)}
                >
                  {chip.label}
                </Button>
              );
            })
          )}
        </FilterChipRow>
      ) : null}

      {isEnabled("title") ? (
        <FilterChipRow label="Job title filters">
          {titles.length === 0 ? (
            <EmptyFamilyHint>
              No search terms in any Search Profile yet.
            </EmptyFamilyHint>
          ) : (
            titles.map((title) => {
              const active = titleFilter.includes(title);
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
                  onClick={() => onToggleTitle(title)}
                >
                  {title}
                </Button>
              );
            })
          )}
        </FilterChipRow>
      ) : null}
    </div>
  );
}

function FilterChipRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      aria-label={label}
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {children}
    </fieldset>
  );
}

function EmptyFamilyHint({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}
