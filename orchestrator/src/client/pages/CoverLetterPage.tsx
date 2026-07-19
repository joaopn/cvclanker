import * as api from "@client/api";
import { ApiClientError } from "@client/api";
import {
  AttemptLogViewer,
  CompileLogViewer,
} from "@client/components/cv/CompileLogViewer";
import { PageHeader } from "@client/components/layout";
import { ActivityLogButton } from "@client/components/ActivityLogButton";
import { LlmStatusButton } from "@client/components/LlmStatusButton";
import { queryKeys } from "@client/lib/queryKeys";
import type {
  CoverLetterDocument,
  CoverLetterDocumentSummary,
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
  Loader2,
  Mail,
  RefreshCw,
  Save,
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

const ACCEPTED_EXTENSIONS = [".tex", ".zip"];

const UPLOAD_MUTATION_KEY = [
  "cover-letter-document",
  "upload-template",
] as const;
const RE_EXTRACT_MUTATION_KEY = (clId: string) =>
  ["cover-letter-document", "re-extract-template", clId] as const;

type UploadFailureDetails = {
  stage: "flatten" | "compile-original" | "extract-loop";
  flattenCode?: string;
  originalCompileStderr?: string;
  attempts?: CvUploadPipelineAttempt[];
};

export function CoverLetterPage() {
  const queryClient = useQueryClient();

  const summariesQuery = useQuery<CoverLetterDocumentSummary[]>({
    queryKey: queryKeys.coverLetterDocuments.list(),
    queryFn: api.listCoverLetters,
    refetchOnMount: "always",
  });

  const activeId = summariesQuery.data?.[0]?.id ?? null;
  const detailQuery = useQuery<CoverLetterDocument>({
    queryKey: activeId
      ? queryKeys.coverLetterDocuments.detail(activeId)
      : ["cover-letter-documents", "detail", "none"],
    queryFn: () => {
      if (!activeId) throw new Error("No active cover letter");
      return api.getCoverLetter(activeId);
    },
    enabled: Boolean(activeId),
    refetchOnMount: "always",
  });

  return (
    <>
      <PageHeader
        icon={Mail}
        title="My Cover Letter"
        subtitle="Upload your LaTeX cover letter; the server flattens, extracts, and renders it. Use it as the per-job draft template."
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
                queryKey: queryKeys.coverLetterDocuments.all,
              });
            }}
          />
        ) : detailQuery.isLoading || !detailQuery.data ? (
          <LoadingShell />
        ) : (
          <CoverLetterEditor doc={detailQuery.data} />
        )}
      </main>
    </>
  );
}

function LoadingShell() {
  return (
    <div className="flex items-center justify-center py-24 text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
      Loading cover letter…
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
    queryKey: queryKeys.coverLetterDocuments.extractionPromptDefault(),
    queryFn: api.fetchCoverLetterExtractionPromptDefault,
  });

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
      const baseName = file.name.replace(/\.[^.]+$/, "") || "Cover letter";
      return api.uploadCoverLetterTemplate({
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
          ? "Cover letter accepted on the first attempt"
          : `Cover letter accepted after ${attemptsCount} attempts`,
      );
      setLatestAttempts(result.attempts);
      await onUploaded();
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : "Failed to upload cover letter";
      setErrorMessage(message);
      setErrorDetails(extractFailureDetails(err));
      toast.error(message);
    },
  });

  const handleFile = useCallback(
    async (file: File) => {
      setErrorMessage(null);
      setErrorDetails(null);
      setLatestAttempts(null);
      const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        const message = `Only ${ACCEPTED_EXTENSIONS.join(" or ")} files are accepted.`;
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
    [uploadMutation],
  );

  const pendingFromCache = useMutationState({
    filters: { mutationKey: UPLOAD_MUTATION_KEY, status: "pending" },
  });
  const inFlight = pending || pendingFromCache.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload your cover letter</CardTitle>
        <CardDescription>
          Drop a .tex file or a .zip archive containing coverletter.tex (or
          letter.tex / cover-letter.tex / cover.tex) plus any included files,
          fonts, and images. The server flattens it, compiles it, then asks the
          LLM to produce a templated version. The upload is only accepted if (a)
          your source compiles, (b) the templated version compiles, (c) the
          substituted PDF's text matches the original, and (d) the LLM marks
          exactly one field as the body. Up to 3 LLM retries — beyond that the
          upload is rejected with the per-attempt log.
        </CardDescription>
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
                ? "Uploading, compiling, and extracting…"
                : "Click to upload or drag a file here"}
            </div>
            <div className="text-xs text-muted-foreground">
              .tex or .zip (max 10 MB)
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(",")}
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
            <Label htmlFor="upload-cl-extraction-prompt">
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
            id="upload-cl-extraction-prompt"
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
                    label="Tectonic stderr (your cover letter's source)"
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

function CoverLetterEditor({ doc }: { doc: CoverLetterDocument }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(doc.name);
  const [reExtractAttempts, setReExtractAttempts] = useState<
    CvUploadPipelineAttempt[] | null
  >(null);
  const [reExtractError, setReExtractError] = useState<string | null>(null);
  const [reExtractDetails, setReExtractDetails] =
    useState<UploadFailureDetails | null>(null);

  const defaultPromptQuery = useQuery<string>({
    queryKey: queryKeys.coverLetterDocuments.extractionPromptDefault(),
    queryFn: api.fetchCoverLetterExtractionPromptDefault,
  });

  const initialPrompt = doc.extractionPrompt || defaultPromptQuery.data || "";
  const [extractionPrompt, setExtractionPrompt] = useState(initialPrompt);

  useEffect(() => {
    setName(doc.name);
  }, [doc.id, doc.updatedAt, doc.name]);

  useEffect(() => {
    const next = doc.extractionPrompt || defaultPromptQuery.data || "";
    setExtractionPrompt(next);
  }, [doc.id, doc.updatedAt, doc.extractionPrompt, defaultPromptQuery.data]);

  const isDirty = name !== doc.name;
  const promptDirty =
    extractionPrompt !==
    (doc.extractionPrompt || defaultPromptQuery.data || "");

  const invalidateAll = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.coverLetterDocuments.all,
    });
  }, [queryClient]);

  const saveMutation = useMutation({
    mutationFn: async (input: { name: string }) =>
      api.updateCoverLetter(doc.id, input),
    onSuccess: async () => {
      toast.success("Cover letter saved");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save failed");
    },
  });

  const reExtractMutation = useMutation({
    mutationKey: RE_EXTRACT_MUTATION_KEY(doc.id),
    mutationFn: () =>
      api.reExtractCoverLetterTemplate(doc.id, {
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

  const pendingReExtractsFromCache = useMutationState({
    filters: {
      mutationKey: RE_EXTRACT_MUTATION_KEY(doc.id),
      status: "pending",
    },
  });
  const isReExtracting =
    reExtractMutation.isPending || pendingReExtractsFromCache.length > 0;

  const savePromptMutation = useMutation({
    mutationFn: async () => api.updateCoverLetter(doc.id, { extractionPrompt }),
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
      api.updateCoverLetter(doc.id, { extractionPrompt: "" }),
    onSuccess: async () => {
      toast.success("Reset to server default");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCoverLetter(doc.id),
    onSuccess: async () => {
      toast.success("Cover letter deleted");
      await invalidateAll();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const handleSave = () => {
    saveMutation.mutate({ name: name.trim() || doc.name });
  };

  const handleDiscard = () => {
    setName(doc.name);
  };

  const bodyField = doc.fields.find((field) => field.role === "body") ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex-1 space-y-2">
            <CardTitle>{doc.name}</CardTitle>
            <CardDescription>
              Uploaded {new Date(doc.createdAt).toLocaleString()} · last edited{" "}
              {new Date(doc.updatedAt).toLocaleString()}
            </CardDescription>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full border border-status-good/30 bg-status-good/10 px-2 py-0.5 text-status-good-text">
                <CheckCircle2 className="h-3 w-3" />
                Matches original cover letter
              </span>
              {doc.compileAttempts > 0 ? (
                <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-muted-foreground">
                  Compiled in {doc.compileAttempts} attempt
                  {doc.compileAttempts === 1 ? "" : "s"}
                </span>
              ) : null}
              {doc.fields.length > 0 ? (
                <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-muted-foreground">
                  {doc.fields.length} fields
                </span>
              ) : null}
              {bodyField ? (
                <span className="rounded-full border border-status-info/30 bg-status-info/10 px-2 py-0.5 text-status-info-text">
                  body: {bodyField.id}
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
                href={`/api/coverletter/${doc.id}/render-preview`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download className="mr-2 h-4 w-4" />
                Templated PDF
              </a>
            </Button>
            <Button asChild type="button" variant="ghost" size="sm">
              <a
                href={`/api/coverletter/${doc.id}/render-original-preview`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Original PDF
              </a>
            </Button>
            <DeleteCoverLetterButton
              isPending={deleteMutation.isPending}
              onConfirm={() => deleteMutation.mutate()}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="cl-name">Name</Label>
            <Input
              id="cl-name"
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
                  label="Tectonic stderr (source)"
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
            The full LLM system prompt used to extract this cover letter —
            pre-filled with the server default, edit any of it. The user message
            (asset list, source, retry context) is server-controlled. Save
            persists; Re-extract saves and re-runs the pipeline. Reset to
            default clears your override so future re-extracts use whatever the
            server's current default is.
            {doc.extractionPrompt ? (
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
                !doc.extractionPrompt ||
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
        <CardHeader>
          <CardTitle>Extracted fields ({doc.fields.length})</CardTitle>
          <CardDescription>
            Spans of the source LaTeX that per-job generation can override.
            Exactly one field is the body — the Generate path writes it, and the
            right-pane textarea binds to its override on the tailoring panel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {doc.fields.length === 0 ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No fields extracted</AlertTitle>
              <AlertDescription>
                The cover letter is uploaded but extraction returned no fields.
                Click "Re-extract" above to retry.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="max-h-[480px] space-y-2 overflow-y-auto rounded border border-border/60 p-3 font-mono text-xs">
              {doc.fields.map((field) => (
                <div
                  key={field.id}
                  className="flex flex-col gap-1 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        field.role === "body"
                          ? "rounded-sm bg-status-info/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-info-text"
                          : "rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
                      }
                    >
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
          <CardTitle>Compile log</CardTitle>
          <CardDescription>
            Tectonic stderr from the most recent successful template compile.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompileLogViewer
            stderr={doc.lastCompileStderr}
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

function DeleteCoverLetterButton({
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
          Delete cover letter
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this cover letter?</AlertDialogTitle>
          <AlertDialogDescription>
            The original archive, extracted fields, and template will be
            removed. Jobs that already reference this cover letter keep their
            per-job overrides but cannot be re-rendered.
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
