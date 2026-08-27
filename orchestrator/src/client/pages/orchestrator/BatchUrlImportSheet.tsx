import {
  cancelUrlImportBatch,
  getUrlImportBatch,
  refreshUrlImportBatch,
  startUrlImportBatch,
  subscribeToUrlImportBatch,
} from "@client/lib/url-import-batch";
import { BATCH_URL_IMPORT_MAX_URLS } from "@shared/types";
import {
  CheckCircle2,
  Copy,
  Link as LinkIcon,
  Loader2,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@client/lib/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

// No `in_flight`: the snapshot says which URLs have SETTLED, not which of the
// three concurrent fetches are in the air right now. Unsettled rows all render
// the same way, which is what they did before anyway.
type RowStatus = "pending" | "saved" | "duplicate" | "failed";

interface UrlRowUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  totalMillions: number | null;
}

interface UrlRow {
  url: string;
  status: RowStatus;
  jobId?: string;
  title?: string;
  employer?: string;
  errorCode?: string;
  errorMessage?: string;
  usage?: UrlRowUsage | null;
}

function formatTokens(usage: UrlRowUsage | null | undefined): string | null {
  if (!usage) return null;
  if (usage.totalTokens === null) return null;
  const total = usage.totalTokens.toLocaleString();
  const millions =
    usage.totalMillions !== null ? usage.totalMillions.toFixed(6) : "—";
  const parts: string[] = [];
  if (usage.promptTokens !== null) {
    parts.push(`in ${usage.promptTokens.toLocaleString()}`);
  }
  if (usage.completionTokens !== null) {
    parts.push(`out ${usage.completionTokens.toLocaleString()}`);
  }
  const breakdown = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  return `${total} tokens${breakdown} · ${millions} M`;
}

interface BatchUrlImportSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void | Promise<void>;
}

interface ParsedUrls {
  valid: string[];
  invalid: number;
  duplicates: number;
}

function parseUrls(input: string): ParsedUrls {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let invalid = 0;
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const line of lines) {
    try {
      const parsed = new URL(line);
      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      valid.push(line);
    } catch {
      invalid += 1;
    }
  }
  const duplicates = lines.length - valid.length - invalid;
  return { valid, invalid, duplicates };
}

function truncateUrl(url: string): string {
  if (url.length <= 70) return url;
  return `${url.slice(0, 50)}…${url.slice(-15)}`;
}

const STATUS_LABEL: Record<RowStatus, string> = {
  pending: "fetching",
  saved: "saved",
  duplicate: "duplicate",
  failed: "failed",
};

const STATUS_VARIANT: Record<
  RowStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "secondary",
  saved: "default",
  duplicate: "secondary",
  failed: "destructive",
};

export const BatchUrlImportSheet: React.FC<BatchUrlImportSheetProps> = ({
  open,
  onOpenChange,
  onCompleted,
}) => {
  const [textValue, setTextValue] = useState("");
  // The server's record is the source of truth: it is what a second device
  // reads, and what this one re-reads after a reload. Nothing about the run is
  // accumulated locally any more.
  const [batch, setBatch] = useState(() => getUrlImportBatch());
  // Which import this tab started, so a replacement by another device can be
  // named rather than silently painted over this tab's URLs.
  const [myBatchId, setMyBatchId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  // Terminal is REPORTED only for a transition this tab watched. The finished
  // record is retained so a device arriving afterwards can read which URLs
  // failed — without this guard, reopening the sheet an hour later would fire
  // the completion path again and close the sheet the instant it opened.
  const watchedRunningRef = useRef<string | null>(null);

  const parsed = useMemo(() => parseUrls(textValue), [textValue]);

  useEffect(() => {
    const sync = () => setBatch(getUrlImportBatch());
    const unsubscribe = subscribeToUrlImportBatch(sync);
    const discover = () => {
      void refreshUrlImportBatch().catch(() => {
        // A failed poll is not worth a toast; the next signal retries.
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") discover();
    };

    // Mount alone is not enough: this component is mounted for the life of the
    // page, so a tab open since this morning would never learn about an import
    // started on another device — and would then meet a 409 it could not
    // explain. These are the moments someone picks work up on another device.
    discover();
    window.addEventListener("focus", discover);
    window.addEventListener("online", discover);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", discover);
      window.removeEventListener("online", discover);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Fire the completion side effects once, and only for an import this sheet
  // saw running.
  useEffect(() => {
    if (!batch) {
      // The record is gone without ever going terminal — the server lost it.
      // Silence here would just make a 40-URL run vanish from the table.
      if (watchedRunningRef.current !== null) {
        watchedRunningRef.current = null;
        toast.warning("Lost track of the URL import.");
      }
      return;
    }
    if (batch.status === "running") {
      watchedRunningRef.current = batch.batchId;
      return;
    }
    if (watchedRunningRef.current !== batch.batchId) return;
    watchedRunningRef.current = null;

    void Promise.resolve(onCompletedRef.current()).catch(() => {});
    if (batch.failed === 0 && batch.status === "completed") {
      const created = batch.succeeded;
      const dup = batch.duplicates;
      toast.success(
        dup === 0
          ? `${created} ${created === 1 ? "job" : "jobs"} imported`
          : `${created} imported, ${dup} duplicate${dup === 1 ? "" : "s"}`,
      );
      onOpenChange(false);
    }
  }, [batch, onOpenChange]);

  const rows = useMemo<UrlRow[]>(() => {
    if (!batch) return [];
    const byUrl = new Map(batch.results.map((result) => [result.url, result]));
    // Rows come from the REQUESTED list, not from the results: a tab attaching
    // at 10/50 has ten results, and building rows from those would show ten
    // URLs and retry against a truncated list.
    return batch.urls.map((url): UrlRow => {
      const result = byUrl.get(url);
      if (!result) return { url, status: "pending" };
      if (result.ok) {
        return {
          url,
          status: result.status === "created" ? "saved" : "duplicate",
          jobId: result.jobId,
          title: result.title,
          employer: result.employer,
          usage: result.usage ?? null,
        };
      }
      return {
        url,
        status: "failed",
        errorCode: result.code,
        errorMessage: result.message,
        usage: result.usage ?? null,
      };
    });
  }, [batch]);

  const resetForm = useCallback(() => {
    setTextValue("");
    setMyBatchId(null);
    // Clears the retained record from view only; the server keeps it until the
    // next import replaces it.
    setDismissed(true);
  }, []);

  const startImport = useCallback(async (urls: string[]) => {
    if (urls.length === 0) return;
    setStarting(true);
    setDismissed(false);
    try {
      const batchId = await startUrlImportBatch(urls);
      setMyBatchId(batchId);
      watchedRunningRef.current = batchId;
      setBatch(getUrlImportBatch());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Batch import failed";
      toast.error(message);
      // Most likely a 409 from an import started elsewhere. Re-read so the
      // user is looking at that run — with its Stop button — instead of a
      // paste form that will keep refusing them.
      void refreshUrlImportBatch().catch(() => {});
    } finally {
      setStarting(false);
    }
  }, []);

  const handleStop = useCallback(() => {
    void cancelUrlImportBatch().catch(() => {
      toast.error("Couldn't stop the import");
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (parsed.valid.length === 0) {
      toast.error("Paste at least one valid URL");
      return;
    }
    if (parsed.valid.length > BATCH_URL_IMPORT_MAX_URLS) {
      toast.error(`Up to ${BATCH_URL_IMPORT_MAX_URLS} URLs per batch`);
      return;
    }
    void startImport(parsed.valid);
  }, [parsed.valid, startImport]);

  const handleRetryFailed = useCallback(() => {
    const failedUrls = rows
      .filter((row) => row.status === "failed")
      .map((row) => row.url);
    if (failedUrls.length === 0) return;
    void startImport(failedUrls);
  }, [rows, startImport]);

  const isInFlight = batch?.status === "running";
  const showResults = !dismissed && rows.length > 0;
  const allDone = Boolean(batch) && !isInFlight;
  // Showing a run this tab did not start — either it never started one, or
  // another device has since replaced it. Either way, say so rather than
  // passing someone else's URLs off as this tab's run.
  const startedElsewhere = Boolean(batch && batch.batchId !== myBatchId);
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const totalTokens = rows.reduce(
    (acc, row) => acc + (row.usage?.totalTokens ?? 0),
    0,
  );
  const totalMillions = totalTokens / 1_000_000;

  const headerTitle = !showResults
    ? "Import URLs"
    : isInFlight
      ? `Importing ${batch?.completed ?? 0}/${batch?.requested ?? 0}`
      : failedCount > 0
        ? `Done with ${failedCount} failure${failedCount === 1 ? "" : "s"}`
        : `Imported ${(batch?.succeeded ?? 0) + (batch?.duplicates ?? 0)}`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground" />
              {headerTitle}
            </SheetTitle>
            <SheetDescription>
              Paste a list of job URLs (one per line). Each URL is fetched and
              parsed into a job row.
            </SheetDescription>
          </SheetHeader>

          <Separator className="my-4" />

          {!showResults && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <div className="space-y-2">
                <label
                  htmlFor="batch-urls"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Job URLs
                </label>
                <Textarea
                  id="batch-urls"
                  value={textValue}
                  onChange={(event) => setTextValue(event.target.value)}
                  placeholder={
                    "https://example.com/job-a\nhttps://example.com/job-b"
                  }
                  className="min-h-[280px] font-mono text-sm leading-relaxed"
                />
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {parsed.valid.length} URL
                    {parsed.valid.length === 1 ? "" : "s"} detected
                  </span>
                  {parsed.duplicates > 0 && (
                    <span>{parsed.duplicates} duplicate(s) ignored</span>
                  )}
                  {parsed.invalid > 0 && (
                    <span className="text-destructive">
                      {parsed.invalid} invalid line(s)
                    </span>
                  )}
                </div>
              </div>

              <Button
                onClick={handleSubmit}
                disabled={parsed.valid.length === 0 || starting}
                className="h-10 gap-2"
              >
                <LinkIcon className="h-4 w-4" />
                Fetch jobs
              </Button>
            </div>
          )}

          {showResults && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline">
                  {batch?.completed ?? 0}/{batch?.requested ?? 0}
                </Badge>
                <Badge variant="default">{batch?.succeeded ?? 0} saved</Badge>
                <Badge variant="secondary">
                  {batch?.duplicates ?? 0} duplicate
                </Badge>
                <Badge
                  variant={(batch?.failed ?? 0) > 0 ? "destructive" : "outline"}
                >
                  {batch?.failed ?? 0} failed
                </Badge>
                {totalTokens > 0 && (
                  <Badge variant="outline" className="font-mono">
                    {totalTokens.toLocaleString()} tokens ·{" "}
                    {totalMillions.toFixed(6)} M
                  </Badge>
                )}
                {isInFlight && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    running
                  </span>
                )}
                {startedElsewhere && (
                  <span className="text-muted-foreground">
                    showing an import started elsewhere
                  </span>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60">
                <ul className="divide-y divide-border/60">
                  {rows.map((row) => (
                    <UrlRowView key={row.url} row={row} />
                  ))}
                </ul>
              </div>

              {isInFlight && (
                <div className="flex items-center justify-end gap-2">
                  {/* The import outlives this sheet now, so closing it is no
                      longer a way to stop one. */}
                  <Button
                    variant="outline"
                    onClick={handleStop}
                    className="gap-2"
                  >
                    Stop
                  </Button>
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                </div>
              )}

              {allDone && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" onClick={resetForm} className="gap-2">
                    Start over
                  </Button>
                  {failedCount > 0 && (
                    <Button
                      variant="outline"
                      onClick={handleRetryFailed}
                      disabled={starting}
                      className="gap-2"
                    >
                      Retry failed only
                    </Button>
                  )}
                  <Button onClick={() => onOpenChange(false)}>Close</Button>
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

const UrlRowView: React.FC<{ row: UrlRow }> = ({ row }) => {
  const copyUrl = () => {
    void navigator.clipboard.writeText(row.url).then(
      () => toast.success("URL copied"),
      () => {},
    );
  };

  return (
    <li className="flex items-start gap-3 px-3 py-2 text-xs">
      <div className="mt-0.5 shrink-0">
        {row.status === "pending" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : row.status === "failed" ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-status-good-text" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {truncateUrl(row.url)}
          </span>
          <button
            type="button"
            onClick={copyUrl}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
            aria-label="Copy URL"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
        {row.title && (
          <div className="truncate text-foreground">
            {row.title}
            <span className="text-muted-foreground"> · {row.employer}</span>
          </div>
        )}
        {row.status === "failed" && row.errorMessage && (
          <div className="text-destructive">
            {row.errorCode}: {row.errorMessage}
          </div>
        )}
        {formatTokens(row.usage) && (
          <div className="font-mono text-[10px] text-muted-foreground">
            {formatTokens(row.usage)}
          </div>
        )}
      </div>
      <Badge variant={STATUS_VARIANT[row.status]} className="shrink-0">
        {STATUS_LABEL[row.status]}
      </Badge>
    </li>
  );
};
