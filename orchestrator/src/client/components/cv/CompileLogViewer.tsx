import type { CvUploadPipelineAttempt } from "@shared/types";
import { AlertTriangle, CheckCircle2, FileText } from "lucide-react";
import type React from "react";
import { useState } from "react";

/**
 * Collapsible viewer for a tectonic stderr blob. Used in three places
 * (per phase-5e):
 *
 *   1. Inside `AttemptLogViewer` for each failed upload attempt.
 *   2. On the post-acceptance CV editor as the most-recent compile log.
 *   3. Inline in the job tailor panel when a per-job render fails.
 *
 * The viewer is intentionally dumb: it renders `<pre>` inside a
 * `<details>`. No syntax highlighting, no line wrapping tricks — tectonic
 * stderr is meant to be skimmed for "! Missing }" / "! File foo.cls
 * not found" style errors.
 */
export const CompileLogViewer: React.FC<{
  stderr: string | null | undefined;
  /** Defaults to "Compile log". */
  label?: string;
  /** Defaults to false (collapsed). */
  defaultOpen?: boolean;
  /**
   * When true, render with the warning-toned styling (used for failed
   * compiles). Defaults to false (neutral muted styling).
   */
  variant?: "neutral" | "warning";
}> = ({ stderr, label = "Compile log", defaultOpen = false, variant = "neutral" }) => {
  const trimmed = stderr?.trim() ?? "";
  if (!trimmed) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
        No compile output recorded.
      </div>
    );
  }
  const tone =
    variant === "warning"
      ? "border-status-warn/30 bg-status-warn/10 text-status-warn-text"
      : "border-border/60 bg-muted/10";
  return (
    <details
      className={`group rounded-md border ${tone}`}
      open={defaultOpen}
    >
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium">
        <span className="inline-flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" />
          {label}
          <span className="text-[10px] opacity-70">
            ({trimmed.split("\n").length} lines)
          </span>
        </span>
      </summary>
      <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all border-t border-border/40 p-3 text-[11px] leading-relaxed">
        {trimmed}
      </pre>
    </details>
  );
};

/**
 * Tabbed-ish viewer for the per-attempt log of a failed (or
 * many-attempt-but-eventually-successful) upload pipeline run. Click an
 * attempt header to expand its detail.
 */
export const AttemptLogViewer: React.FC<{
  attempts: CvUploadPipelineAttempt[];
}> = ({ attempts }) => {
  const [openAttempt, setOpenAttempt] = useState<number | null>(
    attempts.length > 0 ? attempts.length : null,
  );

  if (attempts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {attempts.map((attempt) => {
          const isOpen = openAttempt === attempt.attempt;
          const isFailure = attempt.failureKind !== null;
          return (
            <button
              key={attempt.attempt}
              type="button"
              onClick={() =>
                setOpenAttempt(isOpen ? null : attempt.attempt)
              }
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                isOpen
                  ? "border-primary bg-primary/5"
                  : "border-border/60 hover:border-primary/50"
              }`}
            >
              {isFailure ? (
                <AlertTriangle className="h-3 w-3 text-status-warn-text" />
              ) : (
                <CheckCircle2 className="h-3 w-3 text-status-good-text" />
              )}
              Attempt {attempt.attempt}
              {isFailure ? (
                <span className="rounded-sm bg-status-warn/15 px-1 text-[10px] uppercase tracking-wide text-status-warn-text">
                  {attempt.failureKind}
                </span>
              ) : (
                <span className="rounded-sm bg-status-good/15 px-1 text-[10px] uppercase tracking-wide text-status-good-text">
                  accepted
                </span>
              )}
            </button>
          );
        })}
      </div>

      {openAttempt !== null
        ? (() => {
            const attempt = attempts.find((a) => a.attempt === openAttempt);
            if (!attempt) return null;
            return (
              <div className="space-y-2">
                {attempt.failureMessage ? (
                  <div className="rounded-md border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-xs text-status-warn-text">
                    {attempt.failureMessage}
                  </div>
                ) : null}
                {attempt.compileStderr ? (
                  <CompileLogViewer
                    stderr={attempt.compileStderr}
                    label="Tectonic stderr"
                    defaultOpen
                    variant={attempt.failureKind === "compile" ? "warning" : "neutral"}
                  />
                ) : null}
                {attempt.contentDiff ? (
                  <CompileLogViewer
                    stderr={attempt.contentDiff}
                    label="pdftotext content diff"
                    defaultOpen
                    variant="warning"
                  />
                ) : null}
              </div>
            );
          })()
        : null}
    </div>
  );
};
