import * as api from "@client/api";
import type { ExtractorSourceId } from "@shared/extractors";
import type { RunOptionSource } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  buildRunSelection,
  describeLastScraped,
  findWindowIssues,
  runnableSources,
} from "./runMenu";

export interface RunPipelineMenuProps {
  /** Profiles this run would use. Source scoping needs exactly one. */
  selectedProfileIds: string[];
  onRun: (config: {
    sources?: ExtractorSourceId[];
    providerInstanceIds?: string[];
    scrapeWindowDays?: number;
    scrapeSinceLastRun?: boolean;
  }) => void;
  disabled?: boolean;
}

const windowSupportNote: Record<RunOptionSource["windowSupport"], string> = {
  run_window: "",
  own_max_age: "uses its own max job age",
  ignores: "ignores max job age",
};

/**
 * The Run button's popover: which sources to run, and how far back to scrape.
 *
 * Subtractive by construction — it opens with everything the run would already
 * use, so unticking narrows and nothing here can widen a run beyond what the
 * Search Profile configures.
 */
export const RunPipelineMenu: React.FC<RunPipelineMenuProps> = ({
  selectedProfileIds,
  onRun,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  // Source scoping cannot ride a chain: the run route refuses `sources`
  // alongside `profileIds`, so the buttons are hidden rather than sent and
  // rejected.
  const isChain = selectedProfileIds.length > 1;
  const profileId = isChain ? undefined : selectedProfileIds[0];

  const optionsQuery = useQuery({
    queryKey: ["run-options", profileId ?? null],
    queryFn: () => api.getRunOptions(profileId),
    enabled: open,
    staleTime: 0,
  });

  const sources = useMemo(
    () => optionsQuery.data?.sources ?? [],
    [optionsQuery.data],
  );
  const runnable = useMemo(() => runnableSources(sources), [sources]);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [manualWindow, setManualWindow] = useState(false);
  const [windowInput, setWindowInput] = useState("1");

  // Re-seeded whenever the offered set changes: every runnable source ticked,
  // and the mode the Profile is configured for.
  useEffect(() => {
    if (!optionsQuery.data) return;
    setSelectedKeys(new Set(runnable.map((source) => source.key)));
    setManualWindow(false);
  }, [optionsQuery.data, runnable]);

  const windowDays = useMemo(() => {
    if (!manualWindow) return null;
    const parsed = Number.parseInt(windowInput, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [manualWindow, windowInput]);

  const issues = useMemo(
    () => findWindowIssues({ windowDays, sources, selectedKeys }),
    [windowDays, sources, selectedKeys],
  );
  const blocking = issues.filter((issue) => issue.blocking);

  const capDays = optionsQuery.data?.capDays ?? null;
  const windowInvalid = manualWindow && windowDays === null;
  const canRun =
    !optionsQuery.isLoading &&
    selectedKeys.size > 0 &&
    blocking.length === 0 &&
    !windowInvalid;

  const toggle = (key: string) =>
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleRun = () => {
    const selection = isChain ? {} : buildRunSelection(sources, selectedKeys);
    setOpen(false);
    onRun({
      ...selection,
      ...(windowDays !== null
        ? { scrapeWindowDays: windowDays, scrapeSinceLastRun: false }
        : {}),
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button size="sm" className="gap-2">
          <Play className="h-4 w-4" />
          <span className="hidden sm:inline">Run pipeline</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-3" align="end">
        {optionsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading run options…
          </div>
        ) : optionsQuery.isError ? (
          <p className="py-2 text-sm text-destructive">
            Could not load run options.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Scrape from
                </Label>
                {capDays === null ? (
                  <span className="text-[11px] text-muted-foreground">
                    No ceiling configured
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Max {capDays}d
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={manualWindow ? "outline" : "default"}
                  className="flex-1"
                  onClick={() => setManualWindow(false)}
                >
                  Since last run
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={manualWindow ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setManualWindow(true)}
                >
                  Last N days
                </Button>
              </div>
              {manualWindow && (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    value={windowInput}
                    aria-label="Days to scrape"
                    onChange={(event) => setWindowInput(event.target.value)}
                    className="h-8 w-24"
                  />
                  <span className="text-xs text-muted-foreground">
                    days back
                  </span>
                </div>
              )}
            </section>

            {isChain ? (
              <p className="text-xs text-muted-foreground">
                Running {selectedProfileIds.length} profiles one after another.
                Each uses its own sources; pick a single profile to choose them.
              </p>
            ) : (
              <section className="flex flex-col gap-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Sources
                </Label>
                {sources.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    This search profile has no sources selected.
                  </p>
                )}
                <div className="flex flex-col gap-1">
                  {sources.map((source) => {
                    const dead = !runnable.includes(source);
                    const selected = selectedKeys.has(source.key);
                    const note = windowSupportNote[source.windowSupport];
                    return (
                      <button
                        key={source.key}
                        type="button"
                        disabled={dead}
                        onClick={() => toggle(source.key)}
                        className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                          dead
                            ? "cursor-not-allowed border-dashed opacity-60"
                            : selected
                              ? "border-primary bg-primary/10"
                              : "border-border hover:bg-muted"
                        }`}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {source.label}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {dead
                              ? (source.incompatible[0]?.reasons[0] ??
                                "Not available for this location")
                              : [
                                  describeLastScraped(source.lastScrapedAt),
                                  note,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                          </span>
                        </span>
                        {source.platforms.length > 1 && (
                          <Badge variant="secondary" className="shrink-0">
                            {source.platforms.length}
                          </Badge>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {issues.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs">
                {issues.map((issue) => (
                  <li
                    key={`${issue.sourceKey}-${issue.blocking}`}
                    className={
                      issue.blocking
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {issue.label} {issue.message}
                  </li>
                ))}
              </ul>
            )}

            <Button
              type="button"
              size="sm"
              disabled={!canRun}
              onClick={handleRun}
              className="gap-2"
            >
              <Play className="h-4 w-4" />
              Run
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
