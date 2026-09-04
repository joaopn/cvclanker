import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  DEFAULT_JOB_SORTER,
  JOB_SORTER_LABELS,
  JOB_SORTERS,
  type JobSorter,
} from "./constants";

interface JobSorterMenuProps {
  sorter: JobSorter;
  onSorterChange: (sorter: JobSorter) => void;
}

/**
 * The list sorter: an icon at the right end of the filter bar's control row
 * opening a radio menu of the `JOB_SORTERS` options (None / Posted-found /
 * Fewer applicants / Easy apply, fewer candidates).
 * "None" leaves the Filters-popover sort in charge; the icon reads as active
 * whenever anything else is picked.
 */
export function JobSorterMenu({ sorter, onSorterChange }: JobSorterMenuProps) {
  const active = sorter !== DEFAULT_JOB_SORTER;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "h-7 w-7",
            active
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-label="Sort jobs"
          title={
            active ? `Sorted by ${JOB_SORTER_LABELS[sorter]}` : "Sort jobs"
          }
          data-active={active ? "true" : "false"}
        >
          <ArrowUpDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuRadioGroup
          value={sorter}
          onValueChange={(value) => onSorterChange(value as JobSorter)}
        >
          {JOB_SORTERS.map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              className="text-xs"
            >
              {JOB_SORTER_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
