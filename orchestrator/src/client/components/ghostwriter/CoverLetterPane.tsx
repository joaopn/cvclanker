import * as api from "@client/api";
import { useActiveCoverLetter } from "@client/hooks/useActiveCoverLetter";
import type { Job } from "@shared/types";
import { useMutation } from "@tanstack/react-query";
import { Copy, Loader2, Mail, Save } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "@client/lib/toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn, copyTextToClipboard } from "@/lib/utils";
import { CoverLetterEditTab } from "./CoverLetterEditTab";
import { CoverLetterPdfPane } from "./CoverLetterPdfPane";

type CoverLetterPaneProps = {
  job: Job;
  onJobUpdated?: () => void | Promise<void>;
};

type Tab = "edit" | "pdf";

/**
 * Per-job cover-letter editor with Edit/PDF tab toggle. Mirror of `CvPane`:
 * the Edit|PDF strip is hoisted into each body component so the editor's
 * toolbar can share its row.
 *
 * Edit tab — when an active cover-letter document exists, `CoverLetterEditTab`
 * renders the full per-field editor (Fields/Raw) over
 * `coverLetterFieldOverrides`. Without a document, falls back to a plain
 * draft textarea bound to the legacy `coverLetterDraft` column.
 *
 * PDF tab — `CoverLetterPdfPane` iframes `/pdfs/cover_letter_<jobId>.pdf`,
 * cache-busted on `job.updatedAt`.
 */
export const CoverLetterPane: React.FC<CoverLetterPaneProps> = ({
  job,
  onJobUpdated,
}) => {
  const { coverLetter, bodyFieldId } = useActiveCoverLetter();
  const [tab, setTab] = useState<Tab>("edit");
  const renderedOnceRef = useRef(false);
  const hasPdf = Boolean(job.coverLetterPdfPath);

  const handleRendered = () => {
    renderedOnceRef.current = true;
    setTab("pdf");
  };

  const tabSwitch = (
    <div className="flex items-center gap-1">
      <TabButton active={tab === "edit"} onClick={() => setTab("edit")}>
        Edit
      </TabButton>
      <TabButton
        active={tab === "pdf"}
        onClick={() => setTab("pdf")}
        disabled={!hasPdf && !renderedOnceRef.current}
      >
        PDF
      </TabButton>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab === "edit" ? (
        coverLetter ? (
          <CoverLetterEditTab
            job={job}
            coverLetter={coverLetter}
            bodyFieldId={bodyFieldId}
            onJobUpdated={onJobUpdated ?? (() => {})}
            onRendered={handleRendered}
            tabSwitch={tabSwitch}
          />
        ) : (
          <LegacyDraftTab
            job={job}
            onJobUpdated={onJobUpdated}
            tabSwitch={tabSwitch}
          />
        )
      ) : (
        <CoverLetterPdfPane job={job} tabSwitch={tabSwitch} />
      )}
    </div>
  );
};

/**
 * No cover-letter template uploaded yet: a plain textarea bound to the legacy
 * `coverLetterDraft` column. Generate / Render PDF need a document, so only
 * Copy / Save are offered here.
 */
const LegacyDraftTab: React.FC<{
  job: Job;
  onJobUpdated?: () => void | Promise<void>;
  tabSwitch: React.ReactNode;
}> = ({ job, onJobUpdated, tabSwitch }) => {
  const persisted = job.coverLetterDraft ?? "";
  const [draft, setDraft] = useState(persisted);

  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const isDirty = draft !== persisted;

  const saveMutation = useMutation({
    mutationFn: async () => api.updateJob(job.id, { coverLetterDraft: draft }),
    onSuccess: async () => {
      toast.success("Cover letter saved");
      await onJobUpdated?.();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to save cover letter",
      );
    },
  });

  const copy = async () => {
    if (!draft.trim()) return;
    try {
      await copyTextToClipboard(draft);
      toast.success("Copied cover letter");
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {tabSwitch}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={copy}
            disabled={!draft.trim()}
          >
            <Copy className="h-3 w-3" />
            Copy
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!isDirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </Button>
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2 rounded-md border border-status-warn/30 bg-status-warn/10 px-2 py-1.5 text-xs text-status-warn-text">
        <Mail className="h-3.5 w-3.5" />
        No cover-letter template uploaded — upload one from the Cover Letter
        page to edit fields and Generate / Render a PDF.
      </div>

      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Ask the chat to draft a cover letter, then click 'Use as draft' on the reply — or paste/edit directly here."
        className="h-full min-h-[320px] flex-1 resize-none font-mono text-xs leading-relaxed"
      />
    </div>
  );
};

const TabButton: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, disabled, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      active
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:bg-muted/40",
    )}
  >
    {children}
  </button>
);
