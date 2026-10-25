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
