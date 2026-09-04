import { logger } from "@infra/logger";
import * as cvRepo from "@server/repositories/cv-documents";
import { upsertJobPdf } from "@server/repositories/job-pdfs";
import { resolveCvSourceFormat } from "@server/services/cv/cv-format";
import {
  ConvertDocxError,
  convertDocxToPdf,
} from "@server/services/cv/docx/convert-docx-pdf";
import {
  RenderDocxError,
  substituteParts,
  zipDocxParts,
} from "@server/services/cv/docx/render-docx";
import {
  RenderTemplateError,
  renderTemplate,
} from "@server/services/cv/render-template";
import {
  RunTectonicError,
  runTectonic,
} from "@server/services/cv/run-tectonic";
import { getEffectiveSettings } from "@server/services/settings";
import {
  composeTailoringFailure,
  formatIdList,
  MAX_DETAIL_LIST_IDS,
  TAILORING_FAILURE_DETAIL_MAX_CHARS,
} from "@shared/tailoring-failure";
import type { CvDocument, CvFieldOverrides } from "@shared/types";

export interface GeneratePdfArgs {
  jobId: string;
  cvDocumentId: string;
  /**
   * Per-field overrides. Empty/missing → render `templatedTex` against
   * `defaultFieldValues` only, producing a PDF equivalent to the original
   * source CV.
   */
  overrides?: CvFieldOverrides;
  /**
   * When true, skip the "overrides produced no change" safeguard. Manual
   * render-on-demand sets this so a user clicking Render with no edits (or
   * after resetting all overrides) can still recompile to a baseline PDF.
   * The tailoring path leaves this false so an LLM no-op patch still fails.
   */
  allowBaselineRender?: boolean;
}

export interface PdfResult {
  success: boolean;
  pdfPath?: string;
  error?: string;
}

/**
 * Render a job's tailored CV and persist it.
 *
 * Both substrates share everything except the middle: load the document,
 * merge defaults + overrides, refuse a no-op tailoring, then render and
 * persist. On a Word profile the artifact is a tailored `.docx` (persisted
 * as `resume_docx`) and the PDF is its unoserver-converted view (persisted
 * as `resume`) — which is why `pdfPath` keeps its `resume_<jobId>.pdf`
 * shape on both paths and every caller and client surface is untouched.
 */
export async function generatePdf(args: GeneratePdfArgs): Promise<PdfResult> {
  const document = await cvRepo.getCvDocumentById(args.cvDocumentId);
  if (!document) {
    return { success: false, error: "CV document not found." };
  }
  const archive = await cvRepo.getCvDocumentArchive(args.cvDocumentId);
  if (!archive) {
    return { success: false, error: "CV archive missing for document." };
  }

  // Render the rendered-template via literal placeholder replacement.
  // The legacy cursor-walk path is retired — it silently dropped overrides
  // whenever the extracted field value didn't match the source byte-for-
  // byte, which produced baseline-identical "tailored" PDFs.
  if (!document.templatedTex || document.templatedTex.trim().length === 0) {
    return {
      success: false,
      error:
        "This CV does not have an extracted template yet. Re-upload the CV from the CV page to rebuild it.",
    };
  }

  const overrides = args.overrides ?? {};
  const effectiveValues: CvFieldOverrides = {
    ...document.defaultFieldValues,
    ...overrides,
  };
  const overrideCount = Object.keys(overrides).length;

  const settings = await getEffectiveSettings();
  const format = resolveCvSourceFormat(settings);

  // Canonical relative filename — persisted on the job purely as an
  // existence flag; the bytes live in job_pdfs and are served from there.
  // Unchanged on the docx path: the converted PDF is persisted under the
  // same `resume` kind, so every consumer keeps working.
  const pdfPath = `resume_${args.jobId}.pdf`;

  if (format === "docx") {
    return renderDocxJobPdf({
      args,
      document,
      archive,
      effectiveValues,
      overrides,
      overrideCount,
      pdfPath,
    });
  }

  let renderedTex: string;
  try {
    renderedTex = renderTemplate(document.templatedTex, effectiveValues);
  } catch (error) {
    if (error instanceof RenderTemplateError) {
      return {
        success: false,
        error: `Could not render the CV template: ${error.message}`,
      };
    }
    throw error;
  }

  const baselineRender = renderTemplate(
    document.templatedTex,
    document.defaultFieldValues,
  );
  const identicalToBaseline = renderedTex === baselineRender;
  logger.info("CV render result", {
    jobId: args.jobId,
    cvDocumentId: args.cvDocumentId,
    format,
    overrideCount,
    cvFieldCount: document.fields.length,
    templatedTexLength: document.templatedTex.length,
    renderedTexLength: renderedTex.length,
    identicalToBaseline,
  });

  const baselineFailure = baselineGuardFailure({
    args,
    overrides,
    overrideCount,
    identicalToBaseline,
    knownFieldIds: document.fields.map((f) => f.id),
  });
  if (baselineFailure) return baselineFailure;

  try {
    const result = await runTectonic({
      renderedTex,
      archive: new Uint8Array(archive),
    });
    await upsertJobPdf({
      jobId: args.jobId,
      kind: "resume",
      data: Buffer.from(result.pdf),
    });
    return { success: true, pdfPath };
  } catch (error) {
    if (error instanceof RunTectonicError) {
      return {
        success: false,
        error: composeTailoringFailure(
          `LaTeX compile failed: ${error.message}`,
          compilerLogTail(error.stderr),
        ),
      };
    }
    throw error;
  }
}

interface DocxRenderArgs {
  args: GeneratePdfArgs;
  document: CvDocument;
  archive: Buffer;
  effectiveValues: CvFieldOverrides;
  overrides: CvFieldOverrides;
  overrideCount: number;
  pdfPath: string;
}

async function renderDocxJobPdf(input: DocxRenderArgs): Promise<PdfResult> {
  const { args, document, archive, effectiveValues, pdfPath } = input;

  // A docx row's `templatedTex` is the JSON envelope the gated pipeline
  // wrote ({"parts": {partName: xml}}). A corrupt envelope throws here by
  // design — it is an implementation-invariant violation, not a user error
  // (same posture as the upload pipeline's stage-4d re-parse).
  const envelope = JSON.parse(document.templatedTex) as {
    parts: Record<string, string>;
  };
  const templatedParts = new Map(Object.entries(envelope.parts));

  let renderedParts: Map<string, string>;
  let baselineParts: Map<string, string>;
  try {
    renderedParts = substituteParts(templatedParts, effectiveValues);
    baselineParts = substituteParts(
      templatedParts,
      document.defaultFieldValues,
    );
  } catch (error) {
    if (error instanceof RenderDocxError) {
      return {
        success: false,
        error: `Could not render the CV template: ${error.message}`,
      };
    }
    throw error;
  }

  // Compare the substituted XML, never the rebuilt zips: zip bytes carry
  // timestamps and are not stable across invocations.
  const identicalToBaseline = [...renderedParts].every(
    ([partName, xml]) => baselineParts.get(partName) === xml,
  );
  logger.info("CV render result", {
    jobId: args.jobId,
    cvDocumentId: args.cvDocumentId,
    format: "docx",
    overrideCount: input.overrideCount,
    cvFieldCount: document.fields.length,
    templatedTexLength: document.templatedTex.length,
    partCount: renderedParts.size,
    identicalToBaseline,
  });

  const baselineFailure = baselineGuardFailure({
    args,
    overrides: input.overrides,
    overrideCount: input.overrideCount,
    identicalToBaseline,
    knownFieldIds: document.fields.map((f) => f.id),
  });
  if (baselineFailure) return baselineFailure;

  let docxBytes: Uint8Array;
  try {
    docxBytes = zipDocxParts(new Uint8Array(archive), renderedParts);
  } catch (error) {
    if (error instanceof RenderDocxError) {
      return {
        success: false,
        error: `Could not render the CV template: ${error.message}`,
      };
    }
    throw error;
  }

  // Convert BEFORE persisting anything: a conversion failure must leave no
  // artifact behind (parity with a tectonic failure on the LaTeX path — no
  // PDF-less success states, and no stranded .docx blob no surface can see).
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await convertDocxToPdf({ docx: docxBytes });
  } catch (error) {
    if (error instanceof ConvertDocxError) {
      return {
        success: false,
        error: composeTailoringFailure(
          `PDF conversion failed: ${error.message}`,
          compilerLogTail(error.stderr),
        ),
      };
    }
    throw error;
  }

  // The .docx first: it is the authoritative artifact, the PDF is its view.
  // The two upserts are not one transaction — a crash between them leaves a
  // stale preview, which the next render heals.
  await upsertJobPdf({
    jobId: args.jobId,
    kind: "resume_docx",
    data: Buffer.from(docxBytes),
  });
  await upsertJobPdf({
    jobId: args.jobId,
    kind: "resume",
    data: Buffer.from(pdfBytes),
  });
  return { success: true, pdfPath };
}

/**
 * Hard-fail when overrides were supplied but the rendered output equals the
 * default-substituted baseline. Either every tailored field was missing from
 * the CV's extracted fields OR every tailored value was identical to the
 * original. Shipping a baseline document as a "tailored" one is forbidden.
 */
function baselineGuardFailure(input: {
  args: GeneratePdfArgs;
  overrides: CvFieldOverrides;
  overrideCount: number;
  identicalToBaseline: boolean;
  knownFieldIds: string[];
}): PdfResult | null {
  const { args, overrideCount, identicalToBaseline } = input;
  if (
    overrideCount === 0 ||
    !identicalToBaseline ||
    args.allowBaselineRender === true
  ) {
    return null;
  }
  logger.error("Tailoring produced no actual change to the CV — failing hard", {
    jobId: args.jobId,
    cvDocumentId: args.cvDocumentId,
    overrideIds: Object.keys(input.overrides).slice(0, 10),
    knownFieldIds: input.knownFieldIds.slice(0, MAX_DETAIL_LIST_IDS),
  });
  const overrideIds = Object.keys(input.overrides);
  return {
    success: false,
    error: composeTailoringFailure(
      `Tailoring produced no actual change to the CV. The ${overrideCount} proposed change(s) either targeted unknown CV fields or matched the original values exactly. Try re-uploading the CV from the CV page.`,
      [
        `Field ids the tailoring wrote (${overrideIds.length}):`,
        ...formatIdList(overrideIds),
        `Field ids the active CV document has (${input.knownFieldIds.length}):`,
        ...formatIdList(input.knownFieldIds),
      ].join("\n"),
    ),
  };
}

/**
 * Lines of compiler log worth keeping. EITHER limit can bind: 40 lines fit the
 * character budget only up to a mean line width of about 48 characters. A
 * tectonic stderr — which is what reaches here, not the far chattier `.log`
 * file — is normally under ten short lines, so neither limit engages; a
 * LibreOffice traceback is long-lined and the character budget cuts it first.
 */
const MAX_LOG_LINES = 40;
/** Room reserved for the "… (N earlier line(s))" marker the tail may prepend. */
const ELISION_BUDGET = 40;

/**
 * The TAIL of a compiler log. LaTeX and LibreOffice both report the fatal error
 * last, after however many pages of font and package chatter they emitted
 * first, so the head is the half with no diagnostic value.
 *
 * This bounds ITSELF to the detail cap, from the end. `composeTailoringFailure`
 * truncates from the START — right for a model payload, whose defect is at the
 * head — so handing it an over-long tail would discard the very lines this
 * function exists to keep, and label the result "truncated" as though nothing
 * of value had gone.
 */
function compilerLogTail(stderr: string | null | undefined): string | null {
  const trimmed = stderr?.trim();
  if (!trimmed) return null;

  const lines = trimmed.split("\n");
  const kept: string[] = [];
  let budget = TAILORING_FAILURE_DETAIL_MAX_CHARS - ELISION_BUDGET;
  for (
    let i = lines.length - 1;
    i >= 0 && kept.length < MAX_LOG_LINES;
    i -= 1
  ) {
    const line = lines[i];
    if (budget - line.length - 1 < 0) break;
    budget -= line.length + 1;
    kept.unshift(line);
  }

  // Nothing fit: a single line longer than the whole budget. Keep its end.
  if (kept.length === 0) {
    return `…${trimmed.slice(-(TAILORING_FAILURE_DETAIL_MAX_CHARS - 1))}`;
  }

  const dropped = lines.length - kept.length;
  const tail = kept.join("\n");
  return dropped > 0 ? `… (${dropped} earlier line(s))\n${tail}` : tail;
}
