import * as api from "@client/api";
import { ApiClientError } from "@client/api";
import {
  CompileLogViewer,
  AttemptLogViewer,
} from "@client/components/cv/CompileLogViewer";
import { PageHeader } from "@client/components/layout";
import { ActivityLogButton } from "@client/components/ActivityLogButton";
import { LlmStatusButton } from "@client/components/LlmStatusButton";
import { useSettings } from "@client/hooks/useSettings";
import { getCvFormatCopy } from "@client/lib/cv-format-copy";
import { queryKeys } from "@client/lib/queryKeys";
import type {
  CvDocument,
  CvDocumentSummary,
  CvUploadPipelineAttempt,
} from "@shared/types";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@client/lib/toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Stable mutation keys so the gated upload + re-extract mutations are
 * discoverable globally via `useMutationState`. The CvPage and its
 * children read these to keep the "extracting…" spinner visible across
 * navigation: when the user drops a zip, navigates away mid-upload, and
 * comes back, the local `useMutation` observer is gone (component
 * remounted) but the mutation is still running in the queryClient
 * cache. Filtering by these keys lets the page detect that and re-show
 * the pending UI instead of flashing back to an empty drop zone.
 */
const UPLOAD_MUTATION_KEY = ["cv-document", "upload-template"] as const;
const RE_EXTRACT_MUTATION_KEY = (cvId: string) =>
  ["cv-document", "re-extract-template", cvId] as const;

type UploadFailureDetails = {
  stage: "flatten" | "compile-original" | "extract-loop";
  flattenCode?: string;
  originalCompileStderr?: string;
  attempts?: CvUploadPipelineAttempt[];
};

export function CvPage() {
  const queryClient = useQueryClient();
  const { cvSourceFormat } = useSettings();
  const copy = getCvFormatCopy(cvSourceFormat);

  const summariesQuery = useQuery<CvDocumentSummary[]>({
    queryKey: queryKeys.cvDocuments.list(),
    queryFn: api.listCvDocuments,
    refetchOnMount: "always",
  });

  const activeId = summariesQuery.data?.[0]?.id ?? null;
  const detailQuery = useQuery<CvDocument>({
    queryKey: activeId
      ? queryKeys.cvDocuments.detail(activeId)
      : ["cv-documents", "detail", "none"],
    queryFn: () => {
      if (!activeId) throw new Error("No active CV");
      return api.getCvDocument(activeId);
    },
    enabled: Boolean(activeId),
    refetchOnMount: "always",
  });

  return (
    <>
      <PageHeader
        icon={FileText}
        title="My CV"
        subtitle={copy.uploadSubtitle}
        actions={
          <div className="flex items-center gap-2">
            <ActivityLogButton />
            <LlmStatusButton />
          </div>
        }
      />
      <main className="container mx-auto px-4 py-6 pb-12">
        {summariesQuery.isLoading ? (
          <LoadingShell />
        ) : !activeId ? (
          <UploadCard
            onUploaded={async () => {
              await queryClient.invalidateQueries({
                queryKey: queryKeys.cvDocuments.all,
              });
            }}
          />
        ) : detailQuery.isLoading || !detailQuery.data ? (
          <LoadingShell />
        ) : (
          <CvEditor cv={detailQuery.data} />
        )}
      </main>
    </>
  );
}

function LoadingShell() {
  return (
    <div className="flex items-center justify-center py-24 text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
      Loading CV…
    </div>
  );
}

function extractFailureDetails(error: unknown): UploadFailureDetails | null {
  if (!(error instanceof ApiClientError) || !error.details) return null;
  const details = error.details as Record<string, unknown>;
  if (typeof details.stage !== "string") return null;
  return {
    stage: details.stage as UploadFailureDetails["stage"],
    flattenCode:
      typeof details.flattenCode === "string" ? details.flattenCode : undefined,
    originalCompileStderr:
      typeof details.originalCompileStderr === "string"
        ? details.originalCompileStderr
        : undefined,
    attempts: Array.isArray(details.attempts)
      ? (details.attempts as CvUploadPipelineAttempt[])
      : undefined,
  };
}

function UploadCard({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const { cvSourceFormat } = useSettings();
  const copy = getCvFormatCopy(cvSourceFormat);
  const acceptedExtensions = copy.acceptedExtensions;
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<UploadFailureDetails | null>(
    null,
  );
  const [latestAttempts, setLatestAttempts] = useState<
    CvUploadPipelineAttempt[] | null
  >(null);
  const [extractionPrompt, setExtractionPrompt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const defaultPromptQuery = useQuery<string>({
    queryKey: queryKeys.cvDocuments.extractionPromptDefault(),
    queryFn: api.fetchExtractionPromptDefault,
  });

  // Pre-fill the textarea once the server default arrives. The user can
  // then edit any of it before clicking Upload.
  useEffect(() => {
    if (defaultPromptQuery.data && extractionPrompt === null) {
      setExtractionPrompt(defaultPromptQuery.data);
    }
  }, [defaultPromptQuery.data, extractionPrompt]);

  const handleResetPrompt = useCallback(() => {
    if (defaultPromptQuery.data) {
      setExtractionPrompt(defaultPromptQuery.data);
    }
  }, [defaultPromptQuery.data]);

  const uploadMutation = useMutation({
    mutationKey: UPLOAD_MUTATION_KEY,
    mutationFn: async (file: File) => {
      const baseName = file.name.replace(/\.[^.]+$/, "") || "CV";
      return api.uploadCvDocumentTemplate({
        file,
        filename: file.name,
        name: baseName,
        extractionPrompt: extractionPrompt ?? undefined,
      });
    },
    onSuccess: async (result) => {
      const attemptsCount = result.attempts.length;
      toast.success(
        attemptsCount === 1
          ? "CV accepted on the first attempt"
          : `CV accepted after ${attemptsCount} attempts`,
      );
      setLatestAttempts(result.attempts);
      await onUploaded();
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to upload CV";
      setErrorMessage(message);
      setErrorDetails(extractFailureDetails(err));
      toast.error(message);
    },
  });

  // Cross-mount pending detection: if a previous mount started an upload
  // and the user navigated away, the mutation is still running in the
  // queryClient cache. Read the global mutation state by key so the
  // spinner UI persists across navigation back to /cv.
  const pendingFromCache = useMutationState({
    filters: { mutationKey: UPLOAD_MUTATION_KEY, status: "pending" },
  });
  const inFlight = pending || pendingFromCache.length > 0;

  const handleFile = useCallback(
    async (file: File) => {
      setErrorMessage(null);
      setErrorDetails(null);
      setLatestAttempts(null);
      const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
      if (!acceptedExtensions.includes(ext)) {
        const message = `Only ${acceptedExtensions.join(" or ")} files are accepted.`;
        setErrorMessage(message);
        toast.error(message);
        return;
      }
      setPending(true);
      try {
        await uploadMutation.mutateAsync(file);
      } finally {
        setPending(false);
      }
    },
    [acceptedExtensions, uploadMutation],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload your CV</CardTitle>
        <CardDescription>{copy.uploadDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
          className={`flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-16 text-sm transition-colors ${
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/30 hover:border-primary"
          }`}
          disabled={inFlight}
        >
          {inFlight ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-8 w-8 text-muted-foreground" />
          )}
          <div className="text-center">
            <div className="font-medium">
              {inFlight
                ? copy.uploadingLabel
                : "Click to upload or drag a file here"}
            </div>
            <div className="text-xs text-muted-foreground">{copy.dropHint}</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={acceptedExtensions.join(",")}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
        </button>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="upload-extraction-prompt">
              Extraction prompt{" "}
              <span className="text-xs font-normal text-muted-foreground">
                (the system prompt for this upload — pre-filled with the
                default; edit to change extraction policy)
              </span>
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResetPrompt}
              disabled={
                inFlight ||
                !defaultPromptQuery.data ||
                extractionPrompt === defaultPromptQuery.data
              }
            >
              Reset to default
            </Button>
          </div>
          <Textarea
            id="upload-extraction-prompt"
            value={extractionPrompt ?? ""}
            onChange={(event) => setExtractionPrompt(event.target.value)}
            placeholder={
              defaultPromptQuery.isLoading
                ? "Loading default prompt…"
                : "(default prompt unavailable — see server logs)"
            }
            className="min-h-[260px] font-mono text-xs"
            spellCheck={false}
            disabled={inFlight || defaultPromptQuery.isLoading}
          />
        </div>

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Upload failed</AlertTitle>
            <AlertDescription>
              <div className="space-y-3">
                <p className="text-sm">{errorMessage}</p>
                {errorDetails?.stage === "compile-original" &&
                errorDetails.originalCompileStderr ? (
                  <CompileLogViewer
                    stderr={errorDetails.originalCompileStderr}
                    label={copy.sourceStderrLabel}
                    defaultOpen
                    variant="warning"
                  />
                ) : null}
                {errorDetails?.stage === "extract-loop" &&
                errorDetails.attempts ? (
                  <AttemptLogViewer attempts={errorDetails.attempts} />
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {latestAttempts && latestAttempts.length > 1 ? (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>
              Accepted after {latestAttempts.length} attempts
            </AlertTitle>
            <AlertDescription>
              <div className="mt-2">
                <AttemptLogViewer attempts={latestAttempts} />
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CvEditor({ cv }: { cv: CvDocument }) {
  const queryClient = useQueryClient();
  const { cvSourceFormat } = useSettings();
  const copy = getCvFormatCopy(cvSourceFormat);
  const [name, setName] = useState(cv.name);
  const [personalBrief, setPersonalBrief] = useState(cv.personalBrief);
  const [reExtractAttempts, setReExtractAttempts] = useState<
    CvUploadPipelineAttempt[] | null
  >(null);
  const [reExtractError, setReExtractError] = useState<string | null>(null);
  const [reExtractDetails, setReExtractDetails] =
    useState<UploadFailureDetails | null>(null);

  const defaultPromptQuery = useQuery<string>({
    queryKey: queryKeys.cvDocuments.extractionPromptDefault(),
    queryFn: api.fetchExtractionPromptDefault,
  });

  // Initial textarea value: stored prompt if user has customized,
  // otherwise the server default (so the user always sees the actual
  // prompt that will run).
  const initialPrompt = cv.extractionPrompt || defaultPromptQuery.data || "";
  const [extractionPrompt, setExtractionPrompt] = useState(initialPrompt);

  useEffect(() => {
    setName(cv.name);
    setPersonalBrief(cv.personalBrief);
  }, [cv.id, cv.updatedAt, cv.name, cv.personalBrief]);

  // Update the textarea when (a) the persisted CV changes (e.g. after a
  // successful re-extract) or (b) the server default lands and the CV has
  // no custom prompt.
  useEffect(() => {
    const next = cv.extractionPrompt || defaultPromptQuery.data || "";
    setExtractionPrompt(next);
  }, [cv.id, cv.updatedAt, cv.extractionPrompt, defaultPromptQuery.data]);

  const isDirty = name !== cv.name || personalBrief !== cv.personalBrief;
  // Dirty when the textarea differs from what's persisted (or from the
  // default if nothing was persisted). Saving stores whatever's in the
  // textarea; if it equals the default we still record it so the prompt
  // is locked at this snapshot — explicit Reset clears back to "use
  // current server default".
  const promptDirty =
    extractionPrompt !== (cv.extractionPrompt || defaultPromptQuery.data || "");

  const invalidateAll = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.cvDocuments.all,
    });
  }, [queryClient]);

  const saveMutation = useMutation({
    mutationFn: async (input: { name: string; personalBrief: string }) =>
      api.updateCvDocument(cv.id, input),
    onSuccess: async () => {
      toast.success("CV saved");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save failed");
    },
  });

  const reExtractMutation = useMutation({
    mutationKey: RE_EXTRACT_MUTATION_KEY(cv.id),
    mutationFn: () =>
      api.reExtractCvDocumentTemplate(cv.id, {
        // Always send the current textarea value — the server persists
        // it before running the pipeline so a failed re-extract still
        // saves the latest edit.
        extractionPrompt,
      }),
    onSuccess: async (result) => {
      toast.success(
        `Re-extracted (${result.attempts.length} attempt${result.attempts.length === 1 ? "" : "s"})`,
      );
      setReExtractAttempts(result.attempts);
      setReExtractError(null);
      setReExtractDetails(null);
      await invalidateAll();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Re-extract failed";
      setReExtractError(message);
      setReExtractDetails(extractFailureDetails(err));
      setReExtractAttempts(null);
      toast.error(message);
    },
  });

  // Cross-mount pending detection — same pattern as UploadCard. If the
  // user re-extracts and navigates away, the re-extract is still
  // running in the queryClient cache when they come back.
  const pendingReExtractsFromCache = useMutationState({
    filters: {
      mutationKey: RE_EXTRACT_MUTATION_KEY(cv.id),
      status: "pending",
    },
  });
  const isReExtracting =
    reExtractMutation.isPending || pendingReExtractsFromCache.length > 0;

  const savePromptMutation = useMutation({
    mutationFn: async () => api.updateCvDocument(cv.id, { extractionPrompt }),
    onSuccess: async () => {
      toast.success("Prompt saved");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save prompt failed");
    },
  });

  const resetPromptMutation = useMutation({
    mutationFn: async () =>
      api.updateCvDocument(cv.id, { extractionPrompt: "" }),
    onSuccess: async () => {
      toast.success("Reset to server default");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCvDocument(cv.id),
    onSuccess: async () => {
      toast.success("CV deleted");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const regenerateBriefMutation = useMutation({
    mutationFn: () => api.regenerateCvBrief(cv.id),
    onSuccess: async (next) => {
      setPersonalBrief(next.personalBrief);
      toast.success("Personal brief regenerated");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(
        err instanceof Error ? err.message : "Regenerate brief failed",
      );
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      name: name.trim() || cv.name,
      personalBrief,
    });
  };

  const handleDiscard = () => {
    setName(cv.name);
    setPersonalBrief(cv.personalBrief);
  };

  const isLegacyCv = cv.templatedTex.length === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex-1 space-y-2">
            <CardTitle>{cv.name}</CardTitle>
            <CardDescription>
              Uploaded {new Date(cv.createdAt).toLocaleString()} · last edited{" "}
              {new Date(cv.updatedAt).toLocaleString()}
            </CardDescription>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {isLegacyCv ? (
                <span className="rounded-full border border-status-warn/30 bg-status-warn/10 px-2 py-0.5 text-status-warn-text">
                  Older CV format — re-extract to enable tailoring
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-status-good/30 bg-status-good/10 px-2 py-0.5 text-status-good-text">
                  <CheckCircle2 className="h-3 w-3" />
                  Matches original CV
                </span>
              )}
              {cv.compileAttempts > 0 ? (
                <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-muted-foreground">
                  Compiled in {cv.compileAttempts} attempt
                  {cv.compileAttempts === 1 ? "" : "s"}
                </span>
              ) : null}
              {cv.fields.length > 0 ? (
                <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-muted-foreground">
                  {cv.fields.length} fields
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => reExtractMutation.mutate()}
              disabled={isReExtracting}
            >
              {isReExtracting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Re-extract
            </Button>
            <Button asChild type="button" variant="outline" size="sm">
              <a
                href={`/api/cv/${cv.id}/render-preview`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download className="mr-2 h-4 w-4" />
                Templated PDF
              </a>
            </Button>
            <Button asChild type="button" variant="ghost" size="sm">
              <a
                href={`/api/cv/${cv.id}/render-original-preview`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Original PDF
              </a>
            </Button>
            <DeleteCvButton
              isPending={deleteMutation.isPending}
              onConfirm={() => deleteMutation.mutate()}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="cv-name">Name</Label>
            <Input
              id="cv-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {reExtractError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Re-extract failed</AlertTitle>
          <AlertDescription>
            <div className="space-y-3">
              <p className="text-sm">{reExtractError}</p>
              {reExtractDetails?.stage === "compile-original" &&
              reExtractDetails.originalCompileStderr ? (
                <CompileLogViewer
                  stderr={reExtractDetails.originalCompileStderr}
                  label={copy.sourceStderrLabel}
                  defaultOpen
                  variant="warning"
                />
              ) : null}
              {reExtractDetails?.stage === "extract-loop" &&
              reExtractDetails.attempts ? (
                <AttemptLogViewer attempts={reExtractDetails.attempts} />
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {reExtractAttempts && reExtractAttempts.length > 1 ? (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>
            Accepted after {reExtractAttempts.length} attempts
          </AlertTitle>
          <AlertDescription>
            <div className="mt-2">
              <AttemptLogViewer attempts={reExtractAttempts} />
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Extraction prompt</CardTitle>
          <CardDescription>
            The full LLM system prompt used to extract this CV — pre-filled with
            the server default, edit any of it. The user message (asset list,
            source, retry context) is server-controlled. Save persists;
            Re-extract saves and re-runs the pipeline. Reset to default clears
            your override so future re-extracts use whatever the server's
            current default is.
            {cv.extractionPrompt ? (
              <span className="ml-1 text-status-warn-text">
                (using a custom override; reset to track server updates.)
              </span>
            ) : (
              <span className="ml-1 text-muted-foreground">
                (using the server default — no override saved.)
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={extractionPrompt}
            onChange={(event) => setExtractionPrompt(event.target.value)}
            spellCheck={false}
            className="min-h-[260px] font-mono text-xs"
            placeholder={
              defaultPromptQuery.isLoading
                ? "Loading default prompt…"
                : "(default prompt unavailable — see server logs)"
            }
            disabled={
              savePromptMutation.isPending ||
              resetPromptMutation.isPending ||
              isReExtracting ||
              defaultPromptQuery.isLoading
            }
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => resetPromptMutation.mutate()}
              disabled={
                !cv.extractionPrompt ||
                resetPromptMutation.isPending ||
                savePromptMutation.isPending ||
                isReExtracting
              }
            >
              {resetPromptMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Reset to default
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => savePromptMutation.mutate()}
              disabled={
                !promptDirty || savePromptMutation.isPending || isReExtracting
              }
            >
              {savePromptMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => reExtractMutation.mutate()}
              disabled={isReExtracting}
            >
              {isReExtracting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Re-extract with this prompt
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Personal brief</CardTitle>
            <CardDescription>
              Long-form, first-person background that powers per-job tailoring.
              Paste in extra context the CV doesn't carry — side projects, tools
              you've used in passing, transcripts of long-running chats. The
              brief is the source of truth for tailoring; the CV's templated tex
              is the render target. Re-extract preserves what you've written
              here.
            </CardDescription>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={regenerateBriefMutation.isPending}
              >
                {regenerateBriefMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Regenerate brief
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate personal brief?</AlertDialogTitle>
                <AlertDialogDescription>
                  This replaces the current brief with a fresh LLM summary of
                  the CV's prose. Anything you've written or pasted in here will
                  be lost.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => regenerateBriefMutation.mutate()}
                >
                  Regenerate
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardHeader>
        <CardContent>
          <Textarea
            value={personalBrief}
            onChange={(event) => setPersonalBrief(event.target.value)}
            spellCheck
            className="min-h-[260px] text-sm"
            placeholder="I'm a …"
            disabled={regenerateBriefMutation.isPending}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Extracted fields ({cv.fields.length})</CardTitle>
          <CardDescription>{copy.fieldsDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          {cv.fields.length === 0 ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No fields extracted</AlertTitle>
              <AlertDescription>
                The CV is uploaded but extraction returned no fields. Click
                "Re-extract" above to retry.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="max-h-[480px] space-y-2 overflow-y-auto rounded border border-border/60 p-3 font-mono text-xs">
              {cv.fields.map((field) => (
                <div
                  key={field.id}
                  className="flex flex-col gap-1 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      {field.role}
                    </span>
                    <span className="text-muted-foreground">{field.id}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-foreground">
                    {field.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{copy.compileLogTitle}</CardTitle>
          <CardDescription>{copy.compileLogDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <CompileLogViewer
            stderr={cv.lastCompileStderr}
            label="Most recent compile"
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={handleDiscard}
          disabled={!isDirty || saveMutation.isPending}
        >
          Discard changes
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save changes
        </Button>
      </div>
    </div>
  );
}

function DeleteCvButton({
  isPending,
  onConfirm,
}: {
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="mr-2 h-4 w-4" />
          )}
          Delete CV
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this CV?</AlertDialogTitle>
          <AlertDialogDescription>
            The original archive, extracted fields, and personal brief will be
            removed. Jobs that already reference this CV keep their tailored
            field overrides but cannot be re-rendered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
