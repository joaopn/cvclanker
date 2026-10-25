import type { CvField } from "@shared/types";

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

export class RenderCvError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RenderCvError";
    this.code = code;
  }
}

/**
 * Render a CV that has no templated source: the flattened source as uploaded,
 * byte for byte, after checking it against forbidden patterns (`\write18`,
 * abs-path `\input{}`, etc.).
 */
export function renderCv(flattenedTex: string): string {
  for (const guard of FORBIDDEN_PATTERNS) {
    if (guard.pattern.test(flattenedTex)) {
      throw new RenderCvError(
        `Rendered output contains forbidden pattern: ${guard.description}.`,
        "FORBIDDEN_PATTERN",
      );
    }
  }

  return flattenedTex;
}

/**
 * Validate that every field's `value` is locatable in `flattenedTex` when
 * walked sequentially. The LLM is required to emit fields in document
 * order; this checks that constraint at extraction time so a bad
 * extraction is surfaced immediately.
 *
 * Returns the index of the first field that fails validation, or `null`
 * when every field's value is reachable from the running cursor.
 */
export function findUnreachableField(
  flattenedTex: string,
  fields: CvField[],
): number | null {
  let cursor = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const idx = flattenedTex.indexOf(field.value, cursor);
    if (idx === -1) return i;
    cursor = idx + field.value.length;
  }
  return null;
}
