import * as api from "@client/api";
import { ApiClientError } from "@client/api";
import { CompileLogViewer } from "@client/components/cv/CompileLogViewer";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type { CvDocument } from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

type SaveFailure = {
  message: string;
  stderr?: string;
  missing?: string[];
  unknown?: string[];
  commented?: string[];
  texErrors?: string[];
};

function toSaveFailure(error: unknown): SaveFailure {
  const message = error instanceof Error ? error.message : "Save failed";
  if (!(error instanceof ApiClientError) || !error.details) return { message };
  const details = error.details as Record<string, unknown>;
  const strings = (value: unknown) =>
    Array.isArray(value) && value.length > 0
      ? value.filter((v): v is string => typeof v === "string")
      : undefined;
  return {
    message,
    stderr: typeof details.stderr === "string" ? details.stderr : undefined,
    missing: strings(details.missing),
    unknown: strings(details.unknown),
    commented: strings(details.commented),
    texErrors: strings(details.texErrors),
  };
}

export function CvTemplateEditor({ cv }: { cv: CvDocument }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(cv.templatedTex);
  const [failure, setFailure] = useState<SaveFailure | null>(null);

  useEffect(() => {
    setDraft(cv.templatedTex);
    setFailure(null);
  }, [cv.templatedTex]);

  const saveMutation = useMutation({
    mutationFn: () => api.updateCvTemplate(cv.id, draft),
    onSuccess: async () => {
      setFailure(null);
      toast.success("Template saved");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.cvDocuments.all,
      });
    },
    onError: (err: unknown) => {
      const next = toSaveFailure(err);
      setFailure(next);
      toast.error(next.message);
    },
  });

  const isDirty = draft !== cv.templatedTex;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Templated LaTeX</CardTitle>
        <CardDescription>
          The template every PDF of this CV is rendered from. Edit the layout
          here (a line break, spacing, a font size) without re-uploading. Keep
          every «field» marker, outside any % comment — tailoring writes into
          them. Save compiles the template first and keeps nothing that adds a
          LaTeX error; it does not compare the result with your original CV, so
          check the Templated PDF after saving. Re-extract replaces these edits,
          and PDFs already generated for jobs keep the old layout until they are
          generated again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          aria-label="Templated LaTeX"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          className="min-h-[420px] font-mono text-xs"
          disabled={saveMutation.isPending}
        />
        {failure ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Template not saved</AlertTitle>
            <AlertDescription>
              <div className="space-y-2">
                <p className="text-sm">{failure.message}</p>
                {failure.missing ? (
                  <p className="text-sm">
                    Missing markers: {failure.missing.join(", ")}
                  </p>
                ) : null}
                {failure.unknown ? (
                  <p className="text-sm">
                    Unknown markers: {failure.unknown.join(", ")}
                  </p>
                ) : null}
                {failure.commented ? (
                  <p className="text-sm">
                    Markers only inside a comment:{" "}
                    {failure.commented.join(", ")}
                  </p>
                ) : null}
                {failure.texErrors ? (
                  <p className="text-sm">
                    New LaTeX errors: {failure.texErrors.join("; ")}
                  </p>
                ) : null}
                {failure.stderr ? (
                  <CompileLogViewer
                    stderr={failure.stderr}
                    label="Compile log"
                    defaultOpen
                    variant="warning"
                  />
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(cv.templatedTex);
              setFailure(null);
            }}
            disabled={!isDirty || saveMutation.isPending}
          >
            Discard
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save template
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
