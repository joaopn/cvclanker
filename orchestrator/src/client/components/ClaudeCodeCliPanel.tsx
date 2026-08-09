import * as api from "@client/api";
import { CheckCircle2, Download, Loader2, RotateCcw } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type ClaudeCodeCliPanelProps = {
  isBusy: boolean;
};

/**
 * Manages the Claude Code CLI installation inside the container. The CLI's
 * auto-updater is deliberately disabled (the subprocess is locked down), so
 * this panel is the one place updates happen — explicitly, on the user's
 * click. A runtime update lasts until the next image rebuild, where the
 * Dockerfile's pinned version wins again.
 */
export const ClaudeCodeCliPanel: React.FC<ClaudeCodeCliPanelProps> = ({
  isBusy,
}) => {
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof api.getClaudeCodeCliStatus>
  > | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [updatingTo, setUpdatingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    setError(null);
    try {
      setStatus(await api.getClaudeCodeCliStatus());
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load the CLI status.",
      );
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  const updateCli = useCallback(async (version: string) => {
    setUpdatingTo(version);
    setError(null);
    try {
      setStatus(await api.updateClaudeCodeCli({ version }));
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Failed to update the CLI.",
      );
      // A failed npm install can still have changed the installation (e.g. a
      // timeout mid-swap) — re-probe so "Installed" never shows stale state.
      try {
        setStatus(await api.getClaudeCodeCliStatus());
      } catch {
        // The error banner above already covers the failure.
      }
    } finally {
      setUpdatingTo(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const installed = status?.installed ?? null;
  const latest = status?.latest ?? null;
  const pinned = status?.pinned ?? null;
  const isUpToDate = Boolean(installed && latest && installed === latest);
  const isPinnedBuild = Boolean(installed && pinned && installed === pinned);
  const isUpdating = updatingTo !== null;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium">Claude Code CLI</div>
        {isLoadingStatus ? (
          <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking
          </div>
        ) : installed ? (
          <Badge
            className="gap-1 border-status-good/30 bg-status-good/15 text-status-good-text"
            variant="outline"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Installed
          </Badge>
        ) : status ? (
          <Badge
            className="border-destructive/40 bg-destructive/10 text-destructive"
            variant="outline"
          >
            Not installed
          </Badge>
        ) : null}
      </div>

      <div className="space-y-1 text-xs text-muted-foreground">
        <div>
          Installed:{" "}
          <span className="font-mono text-foreground">
            {installed ?? (isLoadingStatus ? "…" : "not found")}
          </span>
          {isPinnedBuild
            ? " (the version this build was verified against)"
            : null}
        </div>
        <div>
          Latest:{" "}
          <span className="font-mono text-foreground">
            {latest ?? (isLoadingStatus ? "…" : "registry unavailable")}
          </span>
          {isUpToDate ? " — up to date" : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void updateCli("latest")}
          disabled={isBusy || isUpdating || isLoadingStatus || isUpToDate}
        >
          {updatingTo === "latest" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {updatingTo === "latest" ? "Updating..." : "Update to latest"}
        </Button>
        {pinned && installed !== pinned ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void updateCli(pinned)}
            disabled={isBusy || isUpdating || isLoadingStatus}
          >
            {updatingTo === pinned ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            {updatingTo === pinned
              ? "Reinstalling..."
              : `Reinstall verified ${pinned}`}
          </Button>
        ) : null}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Updates replace the CLI inside the running container until the next
        image rebuild. Avoid updating while jobs are tailoring.
      </p>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
};
