import { LlmService } from "@server/services/llm/service";
import type { JsonSchemaDefinition } from "@server/services/llm/types";
import { resolveLlmModel } from "@server/services/modelSelection";
import { loadPrompt } from "@server/services/prompts";
import { CV_FIELD_ROLES, type CvField } from "@shared/types";
import { extractMarkerIds } from "./render-template";

/**
 * 5e CV substrate: the LLM produces a templated `.tex` + a fields list
 * + a personal brief in a single call. The server then validates the
 * marker / field consistency before handing off to the upload pipeline
 * for compile + content-equivalence checking.
 *
 * `fieldsJson` is JSON-encoded as a string for strict structured-output
 * compatibility — same workaround as cv-adjust.
 */
const TEMPLATE_EXTRACT_SCHEMA: JsonSchemaDefinition = {
  name: "cv_template_extract_result",
  schema: {
    type: "object",
    properties: {
      templatedTex: {
        type: "string",
        description:
          "The user's source LaTeX with every tailorable span replaced by a `«field-id»` marker (Unicode guillemets). Structural text stays verbatim.",
      },
      fieldsJson: {
        type: "string",
        description:
          "Stringified JSON array of CvField entries: [{ id, role, value }]. Each id appears once as a `«id»` marker in templatedTex; each marker has a corresponding entry. The server JSON.parses this.",
      },
      personalBrief: {
        type: "string",
        description:
          "First-person 100–400 word candidate summary drawn from the LaTeX prose.",
      },
    },
    required: ["templatedTex", "fieldsJson", "personalBrief"],
    additionalProperties: false,
  },
};

const ROLE_SET = new Set<string>(CV_FIELD_ROLES);

export class TemplateExtractError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(message: string, code: string, detail?: unknown) {
    super(message);
    this.name = "TemplateExtractError";
    this.code = code;
    this.detail = detail;
  }
}

export interface TemplateExtractPreviousAttempt {
  templatedTex: string;
  fields: CvField[];
  /** What broke last time. */
  failureKind: "compile" | "content-diff";
  /** Tectonic stderr when the templated tex didn't compile. */
  compileStderr?: string;
  /** `pdftotext` diff when the templated tex compiled but content diverged. */
  contentDiff?: string;
}

export interface TemplateExtractArgs {
  flattenedTex: string;
  assetReferences: string[];
  /**
   * 5e.3a: per-CV LLM system prompt override. When provided (non-empty),
   * replaces the cv-template-extract YAML's system prompt entirely. The
   * user message (asset list + source CV + retry block) is always
   * server-controlled. Empty / undefined → use the YAML default.
   */
  extractionPrompt?: string;
  /**
   * Retry context. When present, the LLM is asked to correct its previous
   * output rather than restart from scratch — the prior template + the
   * tectonic / pdftotext failure are appended to the user message.
   */
  previousAttempt?: TemplateExtractPreviousAttempt;
}

export interface TemplateExtractResult {
  templatedTex: string;
  fields: CvField[];
  personalBrief: string;
}

const PREV_BLOCK_TRUNCATE_TEX = 8000;
const PREV_BLOCK_TRUNCATE_AUX = 2000;

function truncate(value: string | undefined, max: number): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…(truncated)`;
}

export function buildPreviousAttemptBlock(
  prev: TemplateExtractPreviousAttempt | undefined,
): string {
  if (!prev) return "";
  const sections: string[] = [];
  sections.push("\n----- PREVIOUS ATTEMPT (failed; correct it, do not restart) -----");
  sections.push(
    `\nFailure kind: ${prev.failureKind === "compile" ? "templated tex did not compile" : "templated tex compiled but PDF content diverges from the original"}`,
  );
  sections.push("\nPrevious templatedTex you produced:");
  sections.push("```");
  sections.push(truncate(prev.templatedTex, PREV_BLOCK_TRUNCATE_TEX));
  sections.push("```");
  if (prev.failureKind === "compile" && prev.compileStderr) {
    sections.push("\nTectonic stderr (last bytes):");
    sections.push("```");
    sections.push(truncate(prev.compileStderr, PREV_BLOCK_TRUNCATE_AUX));
    sections.push("```");
  }
  if (prev.failureKind === "content-diff" && prev.contentDiff) {
    sections.push("\nContent diff vs original PDF (lines starting with `-` are missing from your templated render; lines starting with `+` are spurious):");
    sections.push("```");
    sections.push(truncate(prev.contentDiff, PREV_BLOCK_TRUNCATE_AUX));
    sections.push("```");
  }
  sections.push(
    "\nProduce a corrected `templatedTex` + `fieldsJson` + `personalBrief`. Match braces, preserve every glyph from the source, and keep the marker syntax discipline.",
  );
  return sections.join("\n");
}

/**
 * Returns the YAML system prompt as a plain string. Used by the
 * `GET /api/cv/extraction-prompt-default` endpoint so the client can
 * pre-fill the per-CV prompt textarea on upload / editor load.
 *
 * Variables in the system body are passed through unsubstituted because
 * none currently apply (interpolation only happens in the user message).
 * If we ever add system-side variables, this resolver needs to render
 * them with neutral defaults so the surfaced text is usable as-is.
 */
export async function getExtractionPromptDefault(): Promise<string> {
  const prompt = await loadPrompt("cv-template-extract", {
    flattenedTex: "",
    assetReferencesList: "",
    previousAttemptBlock: "",
  });
  return prompt.system;
}

export async function llmTemplateExtract(
  args: TemplateExtractArgs,
): Promise<TemplateExtractResult> {
  const model = await resolveLlmModel("tailoring");
  const prompt = await loadPrompt("cv-template-extract", {
    flattenedTex: args.flattenedTex,
    assetReferencesList:
      args.assetReferences.length > 0
        ? args.assetReferences.join("\n")
        : "(none)",
    previousAttemptBlock: buildPreviousAttemptBlock(args.previousAttempt),
  });

  // 5e.3a: when the caller supplied a per-CV override, replace the YAML
  // system prompt entirely. The user message stays server-controlled
  // (asset list + source + retry block).
  const systemContent =
    args.extractionPrompt && args.extractionPrompt.trim().length > 0
      ? args.extractionPrompt
      : prompt.system;

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: prompt.user });

  const result = await llm.callJson<{
    templatedTex: unknown;
    fieldsJson: unknown;
    personalBrief: unknown;
  }>({
    model,
    messages,
    jsonSchema: TEMPLATE_EXTRACT_SCHEMA,
    maxRetries: 1,
    label: "extract CV template",
  });

  if (!result.success) {
    throw new TemplateExtractError(
      `LLM extraction failed: ${result.error}`,
      "LLM_FAILED",
    );
  }

  const { templatedTex, fieldsJson, personalBrief } = result.data;

  if (typeof templatedTex !== "string" || templatedTex.trim().length === 0) {
    throw new TemplateExtractError(
      "LLM returned empty or non-string templatedTex.",
      "EMPTY_TEMPLATE",
    );
  }
  if (typeof fieldsJson !== "string" || fieldsJson.trim().length === 0) {
    throw new TemplateExtractError(
      "LLM returned empty or non-string fieldsJson.",
      "INVALID_FIELDS",
    );
  }
  if (typeof personalBrief !== "string") {
    throw new TemplateExtractError(
      "LLM returned non-string personalBrief.",
      "INVALID_BRIEF",
    );
  }

  let fieldsRaw: unknown;
  try {
    fieldsRaw = JSON.parse(fieldsJson);
  } catch (error) {
    throw new TemplateExtractError(
      `LLM returned fieldsJson that is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_FIELDS_JSON",
    );
  }
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
    throw new TemplateExtractError(
      "LLM returned no fields. The renderer needs at least one field for tailoring.",
      "EMPTY_FIELDS",
    );
  }

  const fields: CvField[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < fieldsRaw.length; i++) {
    const entry = fieldsRaw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TemplateExtractError(
        `Field at index ${i} is not an object.`,
        "INVALID_FIELD_SHAPE",
      );
    }
    const { id, role, value } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) {
      throw new TemplateExtractError(
        `Field at index ${i} has missing or empty id.`,
        "INVALID_FIELD_ID",
      );
    }
    if (seen.has(id)) {
      throw new TemplateExtractError(
        `Duplicate field id "${id}" at index ${i}.`,
        "DUPLICATE_FIELD_ID",
      );
    }
    seen.add(id);
    if (typeof role !== "string" || !ROLE_SET.has(role)) {
      throw new TemplateExtractError(
        `Field "${id}" has unknown role "${String(role)}".`,
        "INVALID_FIELD_ROLE",
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new TemplateExtractError(
        `Field "${id}" has missing or empty value.`,
        "INVALID_FIELD_VALUE",
      );
    }
    fields.push({ id, role: role as CvField["role"], value });
  }

  // Marker / field consistency. Every marker has a corresponding field
  // and every field has a corresponding marker. Mismatches surface as
  // hard errors rather than silently dropping spans.
  const markerIds = extractMarkerIds(templatedTex);
  const fieldIds = new Set(fields.map((field) => field.id));
  for (const id of markerIds) {
    if (!fieldIds.has(id)) {
      throw new TemplateExtractError(
        `Template marker "«${id}»" has no corresponding field. The template references a span the fields list doesn't supply a value for.`,
        "ORPHAN_MARKER",
        { fieldId: id },
      );
    }
  }
  for (const id of fieldIds) {
    if (!markerIds.has(id)) {
      throw new TemplateExtractError(
        `Field "${id}" has no corresponding marker in templatedTex. Either add a «${id}» marker or drop the field.`,
        "ORPHAN_FIELD",
        { fieldId: id },
      );
    }
  }

  return {
    templatedTex,
    fields,
    personalBrief,
  };
}
