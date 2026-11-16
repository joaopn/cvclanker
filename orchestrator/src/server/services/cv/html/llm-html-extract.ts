import { LlmService } from "@server/services/llm/service";
import type { JsonSchemaDefinition } from "@server/services/llm/types";
import { resolveLlmModel } from "@server/services/modelSelection";
import { loadPrompt } from "@server/services/prompts";
import { CV_FIELD_ROLES, type CvFieldRole } from "@shared/types";
import type { SegmentText } from "./html-worker-tasks";
import type { HtmlFieldSpan } from "./splice-markers";

/**
 * HTML-CV substrate: span selection over the page's visible text (the
 * analog of llm-docx-extract.ts). The LLM names verbatim spans of the
 * numbered segments; it never writes HTML or markers (a retry may quote
 * some of the page's markup to explain a failure). Span location,
 * uniqueness and element boundaries are NOT validated here: spliceMarkers is
 * the one enforcer, and the pipeline feeds its refusal back as a retry. This
 * module validates shape only.
 *
 * `fieldsJson` is JSON-encoded as a string for strict structured-output
 * compatibility — same workaround as cv-docx-extract / cv-adjust.
 */
const HTML_EXTRACT_SCHEMA: JsonSchemaDefinition = {
  name: "cv_html_extract_result",
  schema: {
    type: "object",
    properties: {
      fieldsJson: {
        type: "string",
        description:
          "Stringified JSON array of field entries: [{ id, role, value, segmentId }]. Each value is a verbatim contiguous substring of segment segmentId's text. The server JSON.parses this.",
      },
      personalBrief: {
        type: "string",
        description:
          "First-person 100–400 word candidate summary drawn from the CV's prose.",
      },
    },
    required: ["fieldsJson", "personalBrief"],
    additionalProperties: false,
  },
};

const ROLE_SET = new Set<string>(CV_FIELD_ROLES);

export class HtmlExtractError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "HtmlExtractError";
    this.code = code;
  }
}

/** The LLM's field output: a span plus its role. */
export interface HtmlExtractField extends HtmlFieldSpan {
  role: CvFieldRole;
}

export interface HtmlExtractPreviousAttempt {
  /** The full field list the previous attempt selected. */
  fields: HtmlExtractField[];
  /** What broke last time. */
  failureKind: "splice" | "render" | "content-diff";
  /** The splice refusal, the render failure, or where the page differed. */
  detail: string;
}

export interface HtmlExtractArgs {
  segments: SegmentText[];
  /**
   * Per-CV system prompt override (the `extractionPrompt` column). When
   * non-empty it replaces the cv-html-extract system prompt; the user
   * message (segments and retry block) is always the server's.
   */
  extractionPrompt?: string;
  /** Retry context: the previous selection and why it failed. */
  previousAttempt?: HtmlExtractPreviousAttempt;
}

export interface HtmlExtractResult {
  fields: HtmlExtractField[];
  personalBrief: string;
}

const PREV_BLOCK_TRUNCATE_FIELDS = 8000;
const PREV_BLOCK_TRUNCATE_DETAIL = 2000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…(truncated)`;
}

const FAILURE_KIND_SENTENCES: Record<
  HtmlExtractPreviousAttempt["failureKind"],
  string
> = {
  splice:
    "a selected span could not be marked in the page (not found verbatim, ambiguous, overlapping another, splitting a formatted element, covering markup a field cannot hold, or using an id with characters other than ASCII letters and digits, ., _ and -)",
  render: "the page with the fields' own values put back could not be built",
  "content-diff":
    "putting the fields' own values back into the page did not reproduce the original page exactly",
};

export function buildHtmlPreviousAttemptBlock(
  prev: HtmlExtractPreviousAttempt | undefined,
): string {
  if (!prev) return "";
  const sections: string[] = [];
  sections.push(
    "\n----- PREVIOUS ATTEMPT (failed; correct it, do not restart) -----",
  );
  sections.push(`\nFailure kind: ${FAILURE_KIND_SENTENCES[prev.failureKind]}`);
  sections.push("\nPrevious fields you selected:");
  sections.push("```");
  sections.push(
    truncate(JSON.stringify(prev.fields, null, 2), PREV_BLOCK_TRUNCATE_FIELDS),
  );
  sections.push("```");
  if (prev.detail) {
    sections.push("\nFailure detail:");
    sections.push("```");
    sections.push(truncate(prev.detail, PREV_BLOCK_TRUNCATE_DETAIL));
    sections.push("```");
  }
  sections.push(
    "\nProduce a corrected `fieldsJson` + `personalBrief`. Every value must be a verbatim, contiguous, uniquely-locatable substring of its segment's text that does not start or end partway into a formatted part.",
  );
  return sections.join("\n");
}

/** The cv-html-extract system prompt, for the per-CV prompt editor's default. */
export async function getHtmlExtractionPromptDefault(): Promise<string> {
  const prompt = await loadPrompt("cv-html-extract", {
    segmentsList: "",
    previousAttemptBlock: "",
  });
  return prompt.system;
}

function formatSegmentsList(segments: SegmentText[]): string {
  return segments.map((s) => `[${s.segmentId}] ${s.text}`).join("\n");
}

export async function llmHtmlExtract(
  args: HtmlExtractArgs,
): Promise<HtmlExtractResult> {
  const model = await resolveLlmModel("tailoring");
  const prompt = await loadPrompt("cv-html-extract", {
    segmentsList: formatSegmentsList(args.segments),
    previousAttemptBlock: buildHtmlPreviousAttemptBlock(args.previousAttempt),
  });

  const systemContent =
    args.extractionPrompt && args.extractionPrompt.trim().length > 0
      ? args.extractionPrompt
      : prompt.system;

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: prompt.user });

  const result = await llm.callJson<{
    fieldsJson: unknown;
    personalBrief: unknown;
  }>({
    model,
    messages,
    jsonSchema: HTML_EXTRACT_SCHEMA,
    maxRetries: 1,
    label: "extract CV html spans",
  });

  if (!result.success) {
    throw new HtmlExtractError(
      `LLM extraction failed: ${result.error}`,
      "LLM_FAILED",
    );
  }

  const { fieldsJson, personalBrief } = result.data;
  if (typeof fieldsJson !== "string" || fieldsJson.trim().length === 0) {
    throw new HtmlExtractError(
      "LLM returned empty or non-string fieldsJson.",
      "INVALID_FIELDS",
    );
  }
  if (typeof personalBrief !== "string") {
    throw new HtmlExtractError(
      "LLM returned non-string personalBrief.",
      "INVALID_BRIEF",
    );
  }

  let fieldsRaw: unknown;
  try {
    fieldsRaw = JSON.parse(fieldsJson);
  } catch (error) {
    throw new HtmlExtractError(
      `LLM returned fieldsJson that is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_FIELDS_JSON",
    );
  }
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
    throw new HtmlExtractError(
      "LLM returned no fields. Tailoring needs at least one field.",
      "EMPTY_FIELDS",
    );
  }

  const segmentIds = new Set(args.segments.map((s) => s.segmentId));
  const fields: HtmlExtractField[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < fieldsRaw.length; i++) {
    const entry = fieldsRaw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HtmlExtractError(
        `Field at index ${i} is not an object.`,
        "INVALID_FIELD_SHAPE",
      );
    }
    const { id, role, value, segmentId } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) {
      throw new HtmlExtractError(
        `Field at index ${i} has missing or empty id.`,
        "INVALID_FIELD_ID",
      );
    }
    if (seen.has(id)) {
      throw new HtmlExtractError(
        `Duplicate field id "${id}" at index ${i}.`,
        "DUPLICATE_FIELD_ID",
      );
    }
    seen.add(id);
    if (typeof role !== "string" || !ROLE_SET.has(role)) {
      throw new HtmlExtractError(
        `Field "${id}" has unknown role "${String(role)}".`,
        "INVALID_FIELD_ROLE",
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new HtmlExtractError(
        `Field "${id}" has missing or empty value.`,
        "INVALID_FIELD_VALUE",
      );
    }
    if (typeof segmentId !== "number" || !segmentIds.has(segmentId)) {
      throw new HtmlExtractError(
        `Field "${id}" has segmentId ${String(segmentId)}, which is not a segment number.`,
        "INVALID_SEGMENT_ID",
      );
    }
    fields.push({ id, role: role as CvFieldRole, value, segmentId });
  }

  return { fields, personalBrief };
}
