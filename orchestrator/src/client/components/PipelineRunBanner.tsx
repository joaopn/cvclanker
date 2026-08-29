import * as api from "@client/api";
import { subscribeToPipelineProgress } from "@client/lib/progress-stream";
import type {
  CapturedRunJob,
  JobSource,
  PipelineProfileRunStats,
  PipelineProgressEvent,
  PipelineSourceStats,
  RunJobBucket,
  RunTrigger,
} from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  AlertTriangle,
  ExternalLink,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const BUCKET_LABELS: Record<RunJobBucket, string> = {
  scraped: "Scraped",
  imported: "Imported",
  duplicated: "Duplicated",
  rejected: "Rejected",
};

interface PipelineRunBannerProps {
  isRunning: boolean;
  // Which run partition this banner renders. Required rather than defaulted:
  // a manual run and a scheduled one each keep their own retained table, and a
  // mount site that has not said which one it is would silently show the other.
  trigger: RunTrigger;
  // Re-run a single source (built-in extractor or provider instance) using the
  // current saved run settings. Omit to hide the per-row re-run button.
  // `profileId` names the Search Profile whose page the row belongs to, so the
  // re-run resolves its config from that profile and reconciles into that page;
  // omitted on a single run, which has no pages.
  onRerunSource?: (source: JobSource, profileId?: string) => void;
  // Re-run every failed source on the page in view, one after another. Omit
  // to hide the "Retry all" button beside the failure count.
  onRerunSources?: (sources: JobSource[], profileId?: string) => void;
}

export const stepLabels: Record<PipelineProgressEvent["step"], string> = {
  idle: "Ready",
  crawling: "Crawling",
  importing: "Importing",
  scoring: "Scoring",
  live_status: "Live status",
  processing: "Processing",
  completed: "Complete",
  cancelled: "Cancelled",
  failed: "Failed",
};

const stepBadgeClasses: Record<PipelineProgressEvent["step"], string> = {
  idle: "bg-muted text-muted-foreground border-border",
  crawling: "bg-status-info/10 text-status-info-text border-status-info/20",
  importing: "bg-status-info/10 text-status-info-text border-status-info/20",
  scoring: "bg-status-warn/10 text-status-warn-text border-status-warn/20",
  live_status: "bg-status-info/10 text-status-info-text border-status-info/20",
  processing: "bg-primary/10 text-primary border-primary/20",
  completed: "bg-status-good/10 text-status-good-text border-status-good/20",
  cancelled: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
};

type Dismissing = { pending: boolean; run: string | null };

// A shared constant, so re-asserting "nothing is being dismissed" is an
// `Object.is` hit React can bail out of rather than a fresh object every mount.
const NOT_DISMISSING: Dismissing = { pending: false, run: null };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function computePercentage(progress: PipelineProgressEvent): number {
  switch (progress.step) {
    case "crawling": {
      if (progress.crawlingTermsTotal > 0) {
        return clamp(
          5 +
            (progress.crawlingTermsProcessed / progress.crawlingTermsTotal) *
              10,
          5,
          15,
        );
      }
      if (progress.crawlingListPagesTotal > 0) {
        return clamp(
          (progress.crawlingListPagesProcessed /
            progress.crawlingListPagesTotal) *
            15,
          0,
          15,
        );
      }
      if (progress.crawlingListPagesProcessed > 0) return 8;
      return 5;
    }
    case "importing":
      return 20;
    case "scoring": {
      if (progress.jobsScored > 0) {
        return clamp(
          20 +
            (progress.jobsScored / Math.max(progress.jobsDiscovered, 1)) * 30,
          20,
          50,
        );
      }
      return 25;
    }
    // Its own band between scoring and processing. The step can run for
    // minutes, so it reports proportionally rather than parking the bar:
    // a frozen bar over a long step reads as the hang this step was given a
    // name to avoid.
    case "live_status": {
      if (progress.liveStatusTotal && progress.liveStatusTotal > 0) {
        return clamp(
          50 +
            ((progress.liveStatusChecked ?? 0) / progress.liveStatusTotal) * 5,
          50,
          55,
        );
      }
      return 50;
    }
    case "processing": {
      if (progress.totalToProcess > 0) {
        return clamp(
          55 + (progress.jobsProcessed / progress.totalToProcess) * 45,
          55,
          100,
        );
      }
      return 58;
    }
    case "completed":
    case "cancelled":
    case "failed":
      return 100;
    default:
      return 0;
  }
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

const StatusCell: React.FC<{ status: PipelineSourceStats["status"] }> = ({
  status,
}) => {
  switch (status) {
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          Pending
        </span>
      );
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-status-info-text">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Running
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-status-good-text">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Done
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <XCircle className="h-3.5 w-3.5" />
          Failed
        </span>
      );
  }
};

export const PipelineRunBanner: React.FC<PipelineRunBannerProps> = ({
  isRunning,
  trigger,
  onRerunSource,
  onRerunSources,
}) => {
  const [progress, setProgress] = useState<PipelineProgressEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // Dismissal is server-side (`progress.dismissed`): the banner describes the
  // RUN, so hiding it in one tab hides it everywhere and reopening the page
  // does not resurrect one already dealt with.
  //
  // The local flag only covers the round trip, and is TIED TO THE RUN it was
  // clicked on — an untied flag would keep hiding the NEXT run's banner too,
  // since nothing would ever clear it.
  const [dismissing, setDismissing] = useState<Dismissing>(NOT_DISMISSING);
  const [jobsView, setJobsView] = useState<{
    source: string;
    bucket: RunJobBucket;
    label: string;
    profileId?: string;
    profileName?: string;
  } | null>(null);
  // Which profile's page the user paged to by hand. Null means "follow the
  // profile that is running", so a chain left alone always shows live results.
  const [pinnedProfileIndex, setPinnedProfileIndex] = useState<number | null>(
    null,
  );
  const lastChainKeyRef = useRef<string | null>(null);

  // Watching ALWAYS, not only while a run is in flight: the server holds the
  // last run's funnel and replays it, so a run that ended while nobody was
  // looking is still there when someone opens the page. Gating this on
  // `isRunning` meant a finished run — including one that DIED — left no trace
  // on this page, which read as the run having vanished.
  //
  // Through the shared stream, not a socket of its own: the orchestrator data
  // hook already watches this endpoint on the same page, and a second permanent
  // subscription would double both the browser's connections and the server's
  // open responses.
  useEffect(() => {
    // Everything below describes ONE partition's run, so all of it is dropped
    // before binding another. The stream replays only a partition that HAS a
    // retained event, so without this a switch to a quiet one would leave the
    // previous table's run on screen — and the Dismiss button reads
    // `progress.startedAt`, so it would POST the old run's timestamp against
    // the new partition, which the server refuses (no such run) while the
    // client hides the banner anyway.
    //
    // Each of the other three has its own reason to be here, none of which the
    // null progress covers:
    //  - `dismissing` because `run` is null between a run's reset and its first
    //    crawl event, and a pending dismissal clicked in THAT window matches a
    //    null `startedAt` — hiding the incoming partition's banner on a
    //    dismissal it never received.
    //  - `pinnedProfileIndex` because the render-phase reset below keys on the
    //    chain's FIRST profile, and the replay lands in the same commit as the
    //    null — so two chains that open on the same Search Profile (a profile
    //    both scheduled and run by hand: the steady state) never trip it.
    //  - `jobsView` because an open dialog keeps the old table's source while
    //    its query re-keys onto the new partition.
    setProgress(null);
    setDismissing(NOT_DISMISSING);
    setPinnedProfileIndex(null);
    setJobsView(null);
    return subscribeToPipelineProgress({
      trigger,
      onEvent: setProgress,
      onConnectionChange: setIsConnected,
    });
  }, [trigger]);

  const percentage = useMemo(
    () => (progress ? computePercentage(progress) : 0),
    [progress],
  );

  // One page per profile a multi-profile chain has reached; empty for a plain
  // single run, which keeps rendering `sourceStats` directly.
  const profileRuns: PipelineProfileRunStats[] = progress?.profileRuns ?? [];
  // A new chain is a different first profile. Keying the reset on the whole
  // list would clear the user's page every time the chain adds one. Done in
  // render behind a ref rather than in an effect: the ref makes it idempotent
  // under StrictMode, and it lands before paint, so the page never flashes the
  // old chain's selection.
  const chainKey = profileRuns[0]?.profile.id ?? null;
  if (lastChainKeyRef.current !== chainKey) {
    lastChainKeyRef.current = chainKey;
    if (pinnedProfileIndex !== null) setPinnedProfileIndex(null);
  }

  // Tied to the run it was clicked on: an untied flag would go on hiding the
  // NEXT run's banner too, since nothing would ever clear it. Tracked as its
  // own boolean rather than "run !== null", because `startedAt` is absent
  // between a run's reset and its first crawl event — where overloading null
  // made the X do nothing until the server round-tripped.
  const dismissPending =
    dismissing.pending && (progress?.startedAt ?? null) === dismissing.run;
  if (dismissPending || progress?.dismissed) return null;
  // "idle" is a server with no run to describe — a fresh boot, or a restart
  // since the last one. Anything else is a run worth showing, running or not.
  //
  // A chain sits at idle between profiles, and a per-source re-run's reset
  // emits an UNTAGGED idle that drives `isRunning` false: both would blank the
  // banner mid-run along with its retained pages, so a tagged event or any
  // retained page counts as a run in its own right.
  const hasRunToShow =
    progress != null &&
    (progress.step !== "idle" ||
      progress.profileRun != null ||
      (progress.profileRuns?.length ?? 0) > 0);
  if (!isRunning && !hasRunToShow) return null;

  const rawStep = progress?.step ?? "idle";
  const profileRun = progress?.profileRun ?? null;
  // One profile of a chain reaching a terminal step does not end the chain,
  // and `resetProgress` doesn't notify listeners — so that tagged terminal is
  // the last event received until the next profile starts crawling. Showing
  // its label verbatim would park a green "Complete" badge (or a red "Failed")
  // over a run that is still going, for as long as the next profile's setup
  // takes. The chain's own end arrives untagged.
  const step =
    profileRun != null &&
    (rawStep === "completed" || rawStep === "cancelled" || rawStep === "failed")
      ? "crawling"
      : rawStep;
  // A tagged event belongs to one profile of a multi-profile chain, so the run
  // is still active even when that profile's own step reads terminal — this is
  // what keeps the per-source re-run buttons off between profiles.
  const isActive =
    profileRun != null ||
    (step !== "idle" &&
      step !== "completed" &&
      step !== "cancelled" &&
      step !== "failed");

  const activeProfileIndex = profileRun?.index ?? null;
  const displayedPage =
    profileRuns.find(
      (page) => page.profile.index === pinnedProfileIndex, // the user's choice
    ) ??
    profileRuns.find((page) => page.profile.index === activeProfileIndex) ??
    profileRuns.at(-1) ??
    null;
  const displayedPageIndex = displayedPage
    ? profileRuns.indexOf(displayedPage)
    : -1;
  // A single run has no pages, so it is always looking at its own live results.
  const isLivePage =
    displayedPage == null || displayedPage.profile.index === activeProfileIndex;

  const sourceStats = displayedPage
    ? displayedPage.sourceStats
    : (progress?.sourceStats ?? []);
  const failedSources = sourceStats
    .filter((row) => row.status === "failed")
    .map((row) => row.id as JobSource);
  const anyFailures = failedSources.length > 0;
  // Failures are held back while the page in view is still filling in, but a
  // finished profile's page shows them right away even though the chain runs on.
  const showFailureCount = anyFailures && (!isActive || !isLivePage);
  // The per-row re-run gate plus `isRunning`, which a click raises at once —
  // so the button is gone before the stream reports the run it started.
  const showRetryAll =
    showFailureCount && !isActive && !isRunning && !!onRerunSources;
  // A re-run fired from a page carries that page's Search Profile, so it
  // resolves the same run config the page was scraped with and reconciles back
  // into the page. The second argument is OMITTED rather than passed as
  // `undefined` on a single run, which has no pages and keeps resolving its
  // config from the default profile.
  const handleRerunSource = (source: JobSource) => {
    if (!onRerunSource) return;
    if (displayedPage) onRerunSource(source, displayedPage.profile.id);
    else onRerunSource(source);
  };
  const handleRerunFailed = () => {
    if (!onRerunSources) return;
    if (displayedPage) onRerunSources(failedSources, displayedPage.profile.id);
    else onRerunSources(failedSources);
  };

  return (
    <div className="border-b bg-background/60 backdrop-blur">
      <div className="w-full px-4 py-3">
        <Card className="border-0 bg-transparent shadow-none">
          <CardHeader className="space-y-2 p-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <CardTitle className="text-base">Pipeline</CardTitle>
                <Badge
                  variant="outline"
                  className={cn(
                    "uppercase tracking-wide",
                    stepBadgeClasses[step],
                  )}
                >
                  {stepLabels[step]}
                </Badge>
                {displayedPage ? (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label="Previous profile"
                      disabled={displayedPageIndex <= 0}
                      onClick={() =>
                        setPinnedProfileIndex(
                          profileRuns[displayedPageIndex - 1]?.profile.index ??
                            null,
                        )
                      }
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Badge
                      variant="outline"
                      className="max-w-[16rem] border-primary/20 bg-primary/10 text-primary"
                    >
                      <span className="truncate">
                        Profile {displayedPage.profile.index} of{" "}
                        {displayedPage.profile.total} ·{" "}
                        {displayedPage.profile.name}
                      </span>
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label="Next profile"
                      disabled={displayedPageIndex >= profileRuns.length - 1}
                      onClick={() =>
                        setPinnedProfileIndex(
                          profileRuns[displayedPageIndex + 1]?.profile.index ??
                            null,
                        )
                      }
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    {isActive && pinnedProfileIndex !== null && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setPinnedProfileIndex(null)}
                      >
                        Follow live
                      </Button>
                    )}
                  </div>
                ) : (
                  profileRun && (
                    <Badge
                      variant="outline"
                      className="max-w-[16rem] border-primary/20 bg-primary/10 text-primary"
                    >
                      <span className="truncate">
                        Profile {profileRun.index} of {profileRun.total} ·{" "}
                        {profileRun.name}
                      </span>
                    </Badge>
                  )
                )}
                {/* Gated on `isRunning`, though the subscription is now
                    permanent: "Connecting…" beside a finished run's final
                    state describes nothing the user can act on, and an idle
                    reconnect would read as a fault rather than a quiet feed. */}
                {isRunning && (
                  <span className="truncate text-xs text-muted-foreground">
                    {isConnected ? "Live" : "Connecting…"}
                  </span>
                )}
                {showFailureCount && (
                  <span className="inline-flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {failedSources.length} failed
                  </span>
                )}
                {showRetryAll && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs"
                    title="Re-run every failed source, one after another"
                    onClick={handleRerunFailed}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Retry all
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {isActive && <Loader2 className="h-4 w-4 animate-spin" />}
                <span className="tabular-nums">{Math.round(percentage)}%</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss pipeline banner"
                  className="h-7 w-7"
                  onClick={() => {
                    const run = progress?.startedAt ?? null;
                    setDismissing({ pending: true, run });
                    void api
                      .dismissRunBanner(run ?? undefined, trigger)
                      .catch(() => {
                        // Put it back rather than hiding a banner the server
                        // still shows every other viewer.
                        setDismissing(NOT_DISMISSING);
                      });
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <Progress value={percentage} className="h-2" />
          </CardHeader>

          {progress && (
            <CardContent className="space-y-3 p-0 pt-3">
              <div className="space-y-1">
                <p className="text-sm">{progress.message}</p>
                {progress.detail && (
                  <p className="text-sm text-muted-foreground">
                    {progress.detail}
                  </p>
                )}
              </div>

              {/* ABOVE the paged table, and shown whatever the funnel holds.
                  This is the RUN's failure, not the displayed profile's: on a
                  chain it would otherwise sit under whichever page the user
                  happened to be on — attributing "stopped after 1 of 3, rate
                  limited" to a profile that finished cleanly, and repeating
                  itself as they paged. Gating it on an EMPTY funnel also hid
                  the reason for every failure that struck after scraping,
                  which is exactly what a rate limit during scoring looks
                  like: a run-level death with healthy source rows. */}
              {step === "failed" && progress.error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                  {progress.error}
                </div>
              )}

              {sourceStats.length > 0 && (
                <>
                  <Separator />
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-44">Platform</TableHead>
                          <TableHead className="w-28">Status</TableHead>
                          <TableHead className="w-20 text-right">
                            Scraped
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Imported
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Duplicated
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Rejected
                          </TableHead>
                          <TableHead className="w-24 text-right">
                            Duration
                          </TableHead>
                          {onRerunSource && <TableHead className="w-16" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sourceStats.map((row) => (
                          <SourceRow
                            key={row.id}
                            row={row}
                            onRerun={
                              !isActive && onRerunSource
                                ? handleRerunSource
                                : undefined
                            }
                            showRerunColumn={!!onRerunSource}
                            onShowJobs={(bucket) =>
                              setJobsView({
                                source: row.id,
                                bucket,
                                label: row.label,
                                profileId: displayedPage?.profile.id,
                                profileName: displayedPage?.profile.name,
                              })
                            }
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}

              {displayedPage && sourceStats.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No sources have reported for this profile yet.
                </p>
              )}
            </CardContent>
          )}
        </Card>
      </div>

      {jobsView && (
        <RunJobsDialog
          view={jobsView}
          trigger={trigger}
          onClose={() => setJobsView(null)}
        />
      )}
    </div>
  );
};

const CountValue: React.FC<{
  value: number;
  pending: boolean;
  onClick: () => void;
  /** Appended to the button's own tooltip; the cell-level title is shadowed
   * by this button wherever the user actually points. */
  note?: string;
}> = ({ value, pending, onClick, note }) => {
  if (pending) return <>—</>;
  // Zero is the case that matters most here: a source that returned items and
  // could read NONE of them renders a plain 0, which is the original silence
  // this change exists to end. No button (there are no jobs to show), so the
  // note rides on a titled span instead.
  if (value <= 0) {
    return note ? <span title={note}>{value}</span> : <>{value}</>;
  }
  return (
    <button
      type="button"
      className="tabular-nums underline decoration-dotted underline-offset-2 hover:decoration-solid"
      onClick={onClick}
      title={note ? `Show these jobs — ${note}` : "Show these jobs"}
    >
      {value}
    </button>
  );
};

const SourceRow: React.FC<{
  row: PipelineSourceStats;
  onRerun?: (source: JobSource) => void;
  showRerunColumn: boolean;
  onShowJobs: (bucket: RunJobBucket) => void;
}> = ({ row, onRerun, showRerunColumn, onShowJobs }) => {
  // "Rejected" bundles everything found but not kept: pre-import filter drops
  // (location / blocked company) plus import-time rejects (bad data).
  const rejectedTotal = row.jobsFiltered + row.jobsRejected;
  const pending = row.status === "pending";
  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{row.label}</TableCell>
        <TableCell>
          <StatusCell status={row.status} />
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {/* Scraped counts jobs the mapper could read. Anything it could not
              read never became a job, so it has no row for the popup to show
              and rides along as a note instead of its own bucket. The two are
              deliberately NOT summed: scraped is de-duplicated across a run's
              locations while unreadable items are counted every time they come
              back, so a total would be arithmetic the data does not support. */}
          <CountValue
            value={row.jobsScraped}
            pending={pending}
            onClick={() => onShowJobs("scraped")}
            note={
              row.jobsUnmappable > 0
                ? `${row.jobsUnmappable} returned item(s) could not be read and never became jobs — counted once per extractor run, so an extractor covering several sources reports its whole total on this row`
                : undefined
            }
          />
        </TableCell>
        <TableCell
          className="text-right tabular-nums"
          title={
            row.jobsReposted > 0
              ? `${row.jobsImported} new + ${row.jobsReposted} reposted`
              : undefined
          }
        >
          <CountValue
            value={row.jobsImported + row.jobsReposted}
            pending={pending}
            onClick={() => onShowJobs("imported")}
          />
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">
          <CountValue
            value={row.jobsDuplicated}
            pending={pending}
            onClick={() => onShowJobs("duplicated")}
          />
        </TableCell>
        <TableCell
          className={cn(
            "text-right tabular-nums",
            rejectedTotal > 0 ? "text-destructive" : "text-muted-foreground",
          )}
          title={
            rejectedTotal > 0
              ? `${row.jobsFiltered} filtered (location/blocked) + ${row.jobsRejected} rejected (bad data)`
              : undefined
          }
        >
          <CountValue
            value={rejectedTotal}
            pending={pending}
            onClick={() => onShowJobs("rejected")}
          />
        </TableCell>
        <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
          {formatDuration(row.durationMs)}
        </TableCell>
        {showRerunColumn && (
          <TableCell className="text-right">
            {onRerun && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={`Re-run ${row.label}`}
                aria-label={`Re-run ${row.label}`}
                onClick={() => onRerun(row.id as JobSource)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
          </TableCell>
        )}
      </TableRow>
      {row.status === "failed" && row.error && (
        <TableRow className="border-b-0 hover:bg-transparent">
          <TableCell
            colSpan={showRerunColumn ? 8 : 7}
            className="py-1 text-xs text-destructive whitespace-pre-wrap"
          >
            {row.error}
          </TableCell>
        </TableRow>
      )}
    </>
  );
};

function formatDatePosted(value?: string): string {
  if (!value) return "—";
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString().slice(0, 10);
}

const RunJobsDialog: React.FC<{
  view: {
    source: string;
    bucket: RunJobBucket;
    label: string;
    profileId?: string;
    profileName?: string;
  };
  trigger: RunTrigger;
  onClose: () => void;
}> = ({ view, trigger, onClose }) => {
  const query = useQuery({
    // The partition is part of the key, not just of the request: the captures
    // behind these counts are stored per partition, so a shared key would serve
    // one table's cached rows to the other's dialog.
    queryKey: [
      "pipeline-run-jobs",
      trigger,
      view.source,
      view.bucket,
      view.profileId ?? null,
    ],
    queryFn: () =>
      api.getRunJobs(view.source, view.bucket, view.profileId, trigger),
  });

  const jobs: CapturedRunJob[] = query.data?.jobs ?? [];
  const showReason = view.bucket === "rejected";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {`${BUCKET_LABELS[view.bucket]} — ${view.label}`}
            {view.profileName ? ` · ${view.profileName}` : ""}
          </DialogTitle>
          <DialogDescription>
            {query.isLoading
              ? "Loading…"
              : `${jobs.length} job(s) from this run.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-auto">
          {query.isError ? (
            <p className="text-sm text-destructive">Failed to load jobs.</p>
          ) : jobs.length === 0 && !query.isLoading ? (
            <p className="text-sm text-muted-foreground">
              No jobs captured for this bucket in the current run.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Employer</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="whitespace-nowrap">Posted</TableHead>
                  <TableHead>Salary</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Level</TableHead>
                  {showReason && <TableHead>Reason</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job, index) => (
                  <TableRow key={`${job.jobUrl}-${index}`}>
                    <TableCell className="max-w-[18rem]">
                      <a
                        href={job.jobUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium hover:underline"
                      >
                        <span className="truncate">{job.title}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </TableCell>
                    <TableCell>{job.employer}</TableCell>
                    <TableCell>{job.location ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDatePosted(job.datePosted)}
                    </TableCell>
                    <TableCell>{job.salary ?? "—"}</TableCell>
                    <TableCell>{job.jobType ?? "—"}</TableCell>
                    <TableCell>{job.jobLevel ?? "—"}</TableCell>
                    {showReason && <TableCell>{job.reason ?? "—"}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
