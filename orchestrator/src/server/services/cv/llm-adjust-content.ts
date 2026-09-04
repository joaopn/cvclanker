import { logger } from "@infra/logger";
import { LlmService } from "@server/services/llm/service";
import type { JsonSchemaDefinition } from "@server/services/llm/types";
import { resolveLlmModel } from "@server/services/modelSelection";
import { loadPrompt } from "@server/services/prompts";
import { getEffectiveSettings } from "@server/services/settings";
import {
  getWritingStyle,
  stripLanguageDirectivesFromConstraints,
  type WritingStyle,
} from "@server/services/writing-style";
import {
  composeTailoringFailure,
  formatIdList,
} from "@shared/tailoring-failure";
import {
  CHAT_STYLE_MANUAL_LANGUAGE_LABELS,
  type ChatStyleManualLanguage,
  type CvField,
  type CvFieldOverrides,
} from "@shared/types";
import { resolveCvSourceFormat } from "./cv-format";
import { getCvFormatNote } from "./cv-format-note";

/**
 * `patchesJson` is a JSON-encoded string instead of an array of objects —
 * strict structured-output mode (OpenAI) requires `additionalProperties:
 * false` on every object schema, which interacts poorly when patches share
 * the same flat shape. Encoding as a JSON string sidesteps the constraint;
 * the server validates each entry after parsing.
 */
const ADJUST_SCHEMA: JsonSchemaDefinition = {
  name: "cv_adjust_result",
  schema: {
    type: "object",
    properties: {
      patchesJson: {
        type: "string",
        description:
          "Stringified JSON array of patches: [{ fieldId, newValue }]. Each fieldId must reference a CvField in the input list. The server JSON.parses this and validates each entry.",
      },
      matched: {
        type: "array",
        items: { type: "string" },
        description:
          "JD keywords actually surfaced via the proposed patches with backing evidence in the brief.",
      },
      skipped: {
        type: "array",
        items: { type: "string" },
        description:
          "JD keywords considered but dropped because the brief lacks evidence.",
      },
    },
    required: ["patchesJson", "matched", "skipped"],
    additionalProperties: false,
  },
};

export interface AdjustFieldPatch {
  fieldId: string;
  newValue: string;
}

export interface AdjustContentArgs {
  personalBrief: string;
  jobDescription: string;
  currentFields: CvField[];
  currentOverrides: CvFieldOverrides;
  /**
   * Field ids the user has locked against LLM tailoring. The model is told
   * these are read-only context (still rendered as evidence for ATS matches),
   * and the server drops any patches that target a locked id post-LLM.
   */
  lockedFieldIds?: string[];
  /** Optional — used as the LLM-queue subject line and for diagnostic logging. */
  jobId?: string;
  jobTitle?: string;
  jobEmployer?: string;
}

export type AdjustContentResult =
  | {
      success: true;
      patches: AdjustFieldPatch[];
      matched: string[];
      skipped: string[];
    }
  | {
      success: false;
      error: string;
      /** Set when the failure is the configured tailored-content cap. */
      cap?: { field: string; observed: number; max: number };
    };

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\\(?:immediate\s*)?write18\b/,
    description: "\\write18 (shell-escape)",
  },
  { pattern: /\\openout\b/, description: "\\openout (file write)" },
  { pattern: /\\input\s*\{\s*\//, description: "\\input{} with absolute path" },
  {
    pattern: /\\input\s*\{\s*\.\.\//,
    description: "\\input{} with parent-traversal path",
  },
];

function buildFieldsView(
  fields: CvField[],
  overrides: CvFieldOverrides,
  lockedFieldIds: Set<string>,
): Array<{ id: string; role: string; value: string; locked: boolean }> {
  return fields.map((field) => ({
    id: field.id,
    role: field.role,
    value: overrides[field.id] ?? field.value,
    locked: lockedFieldIds.has(field.id),
  }));
}

export async function llmAdjustContent(
  args: AdjustContentArgs,
): Promise<AdjustContentResult> {
  const [model, writingStyle, settings] = await Promise.all([
    resolveLlmModel("tailoring"),
    getWritingStyle(),
    getEffectiveSettings(),
  ]);
  const cvFormatNote = await getCvFormatNote(resolveCvSourceFormat(settings));

  const lockedFieldIds = new Set(args.lockedFieldIds ?? []);
  // The LLM sees locked fields with their user-edited override (so it can
  // use those values as ATS-matching evidence), but unlocked fields show
  // source defaults — those are the spans the LLM is allowed to rewrite,
  // and showing prior tailored values would anchor it on its own output.
  const visibleOverrides: CvFieldOverrides = {};
  for (const [fid, val] of Object.entries(args.currentOverrides)) {
    if (lockedFieldIds.has(fid)) visibleOverrides[fid] = val;
  }
  const fieldsView = buildFieldsView(
    args.currentFields,
    visibleOverrides,
    lockedFieldIds,
  );

  const prompt = await loadPrompt("cv-adjust", {
    personalBrief: args.personalBrief || "(empty — no candidate brief on file)",
    jobDescription: args.jobDescription || "(empty)",
    fieldsJson: JSON.stringify(fieldsView, null, 2),
    cvFormatNote,
    ...buildWritingStyleVars(writingStyle),
  });

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) messages.push({ role: "system", content: prompt.system });
  messages.push({ role: "user", content: prompt.user });

  const subject =
    args.jobTitle && args.jobEmployer
      ? `${args.jobTitle} @ ${args.jobEmployer}`
      : args.jobTitle || args.jobEmployer || undefined;

  const result = await llm.callJson<{
    patchesJson: unknown;
    matched: unknown;
    skipped: unknown;
  }>({
    model,
    messages,
    jsonSchema: ADJUST_SCHEMA,
    maxRetries: 1,
    label: "tailor CV",
    subject,
    jobId: args.jobId,
  });

  if (!result.success) {
    return {
      success: false,
      error: composeTailoringFailure(
        `LLM call failed: ${result.error}`,
        // The code is what separates a rate limit from a misconfigured key —
        // the distinction `classifyLlmError` exists to recover, and the one a
        // user needs to know which of the two to go and fix.
        `Provider error code: ${result.code}. Model: ${model}.`,
      ),
    };
  }

  const { patchesJson, matched, skipped } = result.data;
  if (typeof patchesJson !== "string" || patchesJson.trim().length === 0) {
    return {
      success: false,
      error: composeTailoringFailure(
        typeof patchesJson === "string"
          ? "The model returned an empty list of changes."
          : "The model returned the list of changes in an unexpected type.",
        describePayload("patchesJson", patchesJson),
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(patchesJson);
    // Measured against a real failing job (2026-09-04): models DOUBLE-ENCODE
    // this field — `patchesJson` arrives as a JSON string whose content is
    // itself the JSON array text, so one parse yields a string rather than the
    // array, and the job then failed "unexpected shape" on every retry for
    // ever. Unwrap exactly one extra layer: a legitimate patch list is an
    // array, never a string, so this cannot mask a genuinely malformed
    // payload — that still falls through to the checks below.
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
  } catch (error) {
    return {
      success: false,
      error: composeTailoringFailure(
        `The model returned a malformed list of changes: ${error instanceof Error ? error.message : String(error)}`,
        describePayload("patchesJson", patchesJson),
      ),
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      success: false,
      error: composeTailoringFailure(
        "The model returned the list of changes in an unexpected shape.",
        [
          `Expected a JSON array of { fieldId, newValue }.`,
          `Parsed value was ${describeType(parsed)}.`,
          describeKeys(parsed),
          describePayload("patchesJson", patchesJson),
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      ),
    };
  }

  const fieldIds = new Set(args.currentFields.map((field) => field.id));
  const patches: AdjustFieldPatch[] = [];
  const droppedUnknownFieldIds: string[] = [];
  const droppedLockedFieldIds: string[] = [];
  let droppedMalformed = 0;
  let droppedForbidden = 0;
  let droppedNoChange = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      droppedMalformed += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const fieldId = record.fieldId;
    const newValue = record.newValue;
    if (typeof fieldId !== "string") {
      droppedMalformed += 1;
      continue;
    }
    if (!fieldIds.has(fieldId)) {
      droppedUnknownFieldIds.push(fieldId);
      continue;
    }
    if (lockedFieldIds.has(fieldId)) {
      droppedLockedFieldIds.push(fieldId);
      continue;
    }
    if (typeof newValue !== "string") {
      droppedMalformed += 1;
      continue;
    }
    if (FORBIDDEN_PATTERNS.some((guard) => guard.pattern.test(newValue))) {
      droppedForbidden += 1;
      continue;
    }
    const original = args.currentFields.find((f) => f.id === fieldId)?.value;
    if (original !== undefined && newValue === original) {
      droppedNoChange += 1;
      continue;
    }
    patches.push({ fieldId, newValue });
  }

  logger.info("Tailoring patches resolved", {
    jobId: args.jobId ?? null,
    rawCount: parsed.length,
    appliedCount: patches.length,
    droppedUnknownFieldIds: droppedUnknownFieldIds.slice(0, 10),
    droppedUnknownCount: droppedUnknownFieldIds.length,
    droppedLockedFieldIds: droppedLockedFieldIds.slice(0, 10),
    droppedLockedCount: droppedLockedFieldIds.length,
    lockedFieldCount: lockedFieldIds.size,
    droppedMalformed,
    droppedForbidden,
    droppedNoChange,
    knownFieldIdSample: Array.from(fieldIds).slice(0, 5),
    matchedCount: Array.isArray(matched) ? matched.length : 0,
    skippedCount: Array.isArray(skipped) ? skipped.length : 0,
  });

  // Hard-fail any path where the LLM produced no usable changes. A
  // tailoring run that ships zero changes means the rendered PDF would be
  // byte-identical to the baseline CV — silently dropping that as a
  // success is forbidden.
  if (patches.length === 0) {
    const reasons: string[] = [];
    if (parsed.length === 0) reasons.push("the model proposed no changes");
    if (droppedUnknownFieldIds.length > 0) {
      reasons.push(
        `${droppedUnknownFieldIds.length} change(s) targeted unknown CV fields (e.g. ${droppedUnknownFieldIds
          .slice(0, 3)
          .map((id) => `"${id}"`)
          .join(", ")})`,
      );
    }
    if (droppedLockedFieldIds.length > 0) {
      reasons.push(
        `${droppedLockedFieldIds.length} change(s) targeted locked CV fields (e.g. ${droppedLockedFieldIds
          .slice(0, 3)
          .map((id) => `"${id}"`)
          .join(", ")})`,
      );
    }
    if (droppedMalformed > 0) {
      reasons.push(`${droppedMalformed} change(s) were malformed`);
    }
    if (droppedForbidden > 0) {
      reasons.push(
        `${droppedForbidden} change(s) contained forbidden LaTeX patterns`,
      );
    }
    if (droppedNoChange > 0) {
      reasons.push(
        `${droppedNoChange} change(s) re-emitted the original value`,
      );
    }
    if (reasons.length === 0) {
      reasons.push("no changes survived validation (cause unknown)");
    }
    const detail: string[] = [];
    if (droppedUnknownFieldIds.length > 0) {
      detail.push(
        `Proposed field ids the active CV does not have (${droppedUnknownFieldIds.length}):`,
        ...formatIdList(droppedUnknownFieldIds),
      );
    }
    if (droppedLockedFieldIds.length > 0) {
      detail.push(
        `Proposed field ids that are locked (${droppedLockedFieldIds.length}):`,
        ...formatIdList(droppedLockedFieldIds),
      );
    }
    detail.push(
      `The active CV has ${args.currentFields.length} field(s):`,
      ...formatIdList(args.currentFields.map((f) => f.id)),
    );
    return {
      success: false,
      error: composeTailoringFailure(
        `Tailoring produced no usable changes — ${reasons.join("; ")}.`,
        detail.join("\n"),
      ),
    };
  }

  // Post-LLM size check. Snapshot what tailoredFields would look like AFTER
  // applying the patches and reject if the serialized size exceeds the
  // user's configured cap. The user can lift the cap or trim their CV.
  const maxTailoredContentChars = settings.maxTailoredContentChars.value;
  const overridesPreview: CvFieldOverrides = { ...args.currentOverrides };
  for (const patch of patches) {
    overridesPreview[patch.fieldId] = patch.newValue;
  }
  const serialized = JSON.stringify(overridesPreview);
  if (serialized.length > maxTailoredContentChars) {
    const biggest = Object.entries(overridesPreview)
      .map(([fid, value]) => ({ fid, size: value.length }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);
    return {
      success: false,
      error: composeTailoringFailure(
        `Tailored content exceeds the configured limit (${serialized.length} > ${maxTailoredContentChars} chars). Lift maxTailoredContentChars in Settings or trim your CV.`,
        [
          `${Object.keys(overridesPreview).length} field(s) would be stored, ${serialized.length} chars serialized. Largest:`,
          ...biggest.map((entry) => `  ${entry.fid} — ${entry.size} chars`),
        ].join("\n"),
      ),
      cap: {
        field: "tailoredFields",
        observed: serialized.length,
        max: maxTailoredContentChars,
      },
    };
  }

  return {
    success: true,
    patches,
    matched: stringArray(matched),
    skipped: stringArray(skipped),
  };
}

/**
 * How much of a rejected payload to quote. Independently bounded from the
 * detail block's own cap so a snippet cannot crowd out the structured lines
 * that sit beside it — those name the defect, the snippet only illustrates it.
 */
const PAYLOAD_SNIPPET_MAX_CHARS = 600;

const TYPE_ARTICLES: Record<string, string> = {
  object: "an object",
  undefined: "undefined",
  string: "a string",
  number: "a number",
  boolean: "a boolean",
};

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return TYPE_ARTICLES[typeof value] ?? `a ${typeof value}`;
}

/** The keys of a rejected object — the fastest read on a model that wrapped the array. */
function describeKeys(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return "It was an object with no keys.";
  return `Its keys were: ${keys
    .slice(0, 20)
    .map((key) => `"${key}"`)
    .join(", ")}${keys.length > 20 ? ", …" : ""}`;
}

/**
 * A head snippet of what the model actually sent. The head rather than the
 * tail because a wrapper key or a stray prose preamble — the two shapes that
 * land here — both appear at the start.
 */
function describePayload(label: string, value: unknown): string {
  if (typeof value !== "string") {
    return `${label} was ${describeType(value)}, not a string.`;
  }
  const snippet =
    value.length > PAYLOAD_SNIPPET_MAX_CHARS
      ? `${value.slice(0, PAYLOAD_SNIPPET_MAX_CHARS)}…`
      : value;
  return `${label} (${value.length} chars) was:\n${snippet}`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function buildWritingStyleVars(style: WritingStyle): Record<string, string> {
  const language: ChatStyleManualLanguage =
    style.languageMode === "manual" ? style.manualLanguage : "english";
  const effectiveConstraints = stripLanguageDirectivesFromConstraints(
    style.constraints,
  );
  return {
    outputLanguage: CHAT_STYLE_MANUAL_LANGUAGE_LABELS[language],
    tone: style.tone,
    formality: style.formality,
    constraintsSentence: effectiveConstraints
      ? `Writing constraints: ${effectiveConstraints}`
      : "",
    avoidTermsSentence: style.doNotUse
      ? `Avoid these terms: ${style.doNotUse}`
      : "",
  };
}
