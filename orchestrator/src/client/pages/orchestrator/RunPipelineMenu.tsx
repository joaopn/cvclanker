import * as api from "@client/api";
import type { ExtractorSourceId } from "@shared/extractors";
import { SCRAPE_WINDOW_MAX_DAYS } from "@shared/scrape-window.js";
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
}) => {
  const [open, setOpen] = useState(false);
  // Source scoping cannot ride a chain: the run route refuses `sources`
  // alongside `profileIds`, so the buttons are hidden rather than sent and
  // rejected.
  const isChain = selectedProfileIds.length > 1;
  const profileId = isChain ? undefined : selectedProfileIds[0];

  // Skipped entirely for a chain: the options describe ONE profile, and asking
  // without an id would answer for the DEFAULT profile — whose sources and cap
  // have nothing to do with the profiles being chained. Gating the Run button
  // on that set left it permanently disabled whenever the default profile had
  // no runnable source.
  const optionsQuery = useQuery({
    queryKey: ["run-options", profileId ?? null],
    queryFn: () => api.getRunOptions(profileId),
    enabled: open && !isChain,
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
  const [seededFor, setSeededFor] = useState<string | null>(null);

  /**
   * Seed once per opening, not on every payload: react-query returns the SAME
   * object reference when a refetch is deep-equal, so keying the reset on the
   * data would wipe the user's ticks exactly when something moved (a run
   * advancing a watermark) and keep them when nothing did — the same gesture
   * with two outcomes.
   */
  useEffect(() => {
    if (!open) {
      setSeededFor(null);
      return;
    }
    if (!optionsQuery.data || seededFor === (profileId ?? "")) return;
    setSeededFor(profileId ?? "");
    setSelectedKeys(new Set(runnable.map((source) => source.key)));
    // The Profile's own flag decides which button opens pressed; its max job
    // age is the window it would otherwise have run, so it seeds the input.
    setManualWindow(!optionsQuery.data.defaultSinceLastRun);
    setWindowInput(String(optionsQuery.data.capDays ?? 1));
  }, [open, optionsQuery.data, runnable, profileId, seededFor]);

  const windowDays = useMemo(() => {
    if (!manualWindow) return null;
    const parsed = Number.parseInt(windowInput, 10);
    // Bounded by the same constant the request schema uses, so an out-of-range
    // value is refused here rather than coming back as a raw Zod 400 in a toast.
    return Number.isFinite(parsed) &&
      parsed > 0 &&
      parsed <= SCRAPE_WINDOW_MAX_DAYS
      ? parsed
      : null;
  }, [manualWindow, windowInput]);

  const issues = useMemo(
    () => findWindowIssues({ windowDays, sources, selectedKeys }),
    [windowDays, sources, selectedKeys],
  );
  const blocking = issues.filter((issue) => issue.blocking);

  const capDays = optionsQuery.data?.capDays ?? null;
  const windowInvalid = manualWindow && windowDays === null;
  const canRun =
    (isChain || (!optionsQuery.isLoading && selectedKeys.size > 0)) &&
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
      // The mode is ALWAYS sent. Omitting it would fall through to the
      // Profile's own flag, so the button labelled "Since last run" would do
      // nothing on any Profile that has not ticked it — which is the default.
      ...(windowDays !== null
        ? { scrapeWindowDays: windowDays, scrapeSinceLastRun: false }
        : { scrapeSinceLastRun: true }),
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
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
                  // The PROFILE's ceiling. A provider instance carrying its own
                  // max age is judged against that instead, so this is named
                  // rather than presented as the run's single limit.
                  <span className="text-[11px] text-muted-foreground">
                    Profile max {capDays}d
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
                                  // "covered to", not "last scraped": the mark
                                  // moves only when a run closed the gap, so a
                                  // narrow run leaves it deliberately behind.
                                  source.lastScrapedAt
                                    ? `covered to ${describeLastScraped(source.lastScrapedAt)}`
                                    : "never covered",
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
