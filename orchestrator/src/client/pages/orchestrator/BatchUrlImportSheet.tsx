import * as api from "@client/api";
import type { BatchUrlImportItemResult } from "@shared/types";
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

type RowStatus = "pending" | "in_flight" | "saved" | "duplicate" | "failed";

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
  pending: "pending",
  in_flight: "fetching",
  saved: "saved",
  duplicate: "duplicate",
  failed: "failed",
};

const STATUS_VARIANT: Record<
  RowStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  in_flight: "secondary",
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
  const [rows, setRows] = useState<UrlRow[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [completed, setCompleted] = useState(0);
  const [succeeded, setSucceeded] = useState(0);
  const [duplicates, setDuplicates] = useState(0);
  const [failed, setFailed] = useState(0);
  const [requested, setRequested] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const completionFiredRef = useRef(false);

  const parsed = useMemo(() => parseUrls(textValue), [textValue]);

  const resetForm = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTextValue("");
    setRows([]);
    setPhase("idle");
    setCompleted(0);
    setSucceeded(0);
    setDuplicates(0);
    setFailed(0);
    setRequested(0);
    completionFiredRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const startImport = useCallback(
    async (urls: string[]) => {
      if (urls.length === 0) return;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      completionFiredRef.current = false;
      setPhase("running");
      setRequested(urls.length);
      setCompleted(0);
      setSucceeded(0);
      setDuplicates(0);
      setFailed(0);
      setRows(urls.map((url) => ({ url, status: "pending" })));

      const applyResult = (result: BatchUrlImportItemResult) => {
        setRows((prev) =>
          prev.map((row) => {
            if (row.url !== result.url) return row;
            if (result.ok) {
              return {
                ...row,
                status: result.status === "created" ? "saved" : "duplicate",
                jobId: result.jobId,
                title: result.title,
                employer: result.employer,
                errorCode: undefined,
                errorMessage: undefined,
                usage: result.usage ?? null,
              };
            }
            return {
              ...row,
              status: "failed",
              errorCode: result.code,
              errorMessage: result.message,
              usage: result.usage ?? null,
            };
          }),
        );
      };

      try {
        await api.streamBatchUrlImport(
          { urls },
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "started") {
                setRows((prev) =>
                  prev.map((row, idx) =>
                    idx < urls.length ? { ...row, status: "in_flight" } : row,
                  ),
                );
              } else if (event.type === "progress") {
                applyResult(event.result);
                setCompleted(event.completed);
                setSucceeded(event.succeeded);
                setDuplicates(event.duplicates);
                setFailed(event.failed);
              } else if (event.type === "completed") {
                event.results.forEach(applyResult);
                setCompleted(event.results.length);
                setSucceeded(event.succeeded);
                setDuplicates(event.duplicates);
                setFailed(event.failed);
                setPhase("done");

                void Promise.resolve(onCompletedRef.current()).catch(() => {});
                completionFiredRef.current = true;

                if (event.failed === 0) {
                  const created = event.succeeded;
                  const dup = event.duplicates;
                  toast.success(
                    dup === 0
                      ? `${created} ${created === 1 ? "job" : "jobs"} imported`
                      : `${created} imported, ${dup} duplicate${dup === 1 ? "" : "s"}`,
                  );
                  onOpenChange(false);
                  resetForm();
                }
              } else if (event.type === "error") {
                toast.error(event.message);
                setPhase("done");
              }
            },
          },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : "Batch import failed";
        toast.error(message);
        setPhase("done");
      }
    },
    [onOpenChange, resetForm],
  );

  const handleSubmit = useCallback(() => {
    if (parsed.valid.length === 0) {
      toast.error("Paste at least one valid URL");
      return;
    }
    if (parsed.valid.length > 50) {
      toast.error("Up to 50 URLs per batch");
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

  const isInFlight = phase === "running";
  const showResults = phase !== "idle" && rows.length > 0;
  const allDone = phase === "done";
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const totalTokens = rows.reduce(
    (acc, row) => acc + (row.usage?.totalTokens ?? 0),
    0,
  );
  const totalMillions = totalTokens / 1_000_000;

  const headerTitle =
    phase === "idle"
      ? "Import URLs"
      : isInFlight
        ? `Importing ${completed}/${requested}`
        : failedCount > 0
          ? `Done with ${failedCount} failure${failedCount === 1 ? "" : "s"}`
          : `Imported ${succeeded + duplicates}`;

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
                disabled={parsed.valid.length === 0}
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
                  {completed}/{requested}
                </Badge>
                <Badge variant="default">{succeeded} saved</Badge>
                <Badge variant="secondary">{duplicates} duplicate</Badge>
                <Badge variant={failed > 0 ? "destructive" : "outline"}>
                  {failed} failed
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
                    streaming...
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

              {allDone && (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" onClick={resetForm} className="gap-2">
                    Start over
                  </Button>
                  {failedCount > 0 && (
                    <Button
                      variant="outline"
                      onClick={handleRetryFailed}
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
        {row.status === "in_flight" || row.status === "pending" ? (
          <Loader2
            className={`h-3.5 w-3.5 ${
              row.status === "in_flight"
                ? "animate-spin text-muted-foreground"
                : "text-muted-foreground/60"
            }`}
          />
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
