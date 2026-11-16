import type { CvField, CvFieldOverrides, CvSourceFormat } from "@shared/types";
import { cvFieldText } from "./html/field-text";

export interface AtsCoverageResult {
  matched: string[];
  skipped: string[];
}

/**
 * Re-partition a known JD keyword set by literal presence in the CV text.
 *
 * The keyword universe is the union of a job's prior `tailoringMatched` +
 * `tailoringSkipped` (the keywords the tailoring LLM identified). This is a
 * pure string match — no LLM — so a keyword the model surfaced semantically
 * via a synonym may fall back to `skipped` here. Matching is case-insensitive
 * substring; input order is preserved and duplicates are collapsed.
 */
export function recomputeAtsCoverage(
  cvText: string,
  keywords: string[],
): AtsCoverageResult {
  const haystack = cvText.toLowerCase();
  const matched: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    const keyword = raw.trim();
    if (keyword.length === 0) continue;
    const normalized = keyword.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (haystack.includes(normalized)) matched.push(keyword);
    else skipped.push(keyword);
  }
  return { matched, skipped };
}

/**
 * The plain-text blob used for matching: each CV field's current value
 * (per-job override else source default) as text, newline-joined. No render —
 * substring matching only needs the field text (an HTML value's tags dropped
 * and entities decoded, so `<b>Apache</b> <b>Kafka</b>` matches "Apache Kafka").
 */
export function buildCvText(
  fields: CvField[],
  overrides: CvFieldOverrides,
  format: CvSourceFormat,
): string {
  return fields
    .map((field) => cvFieldText(overrides[field.id] ?? field.value, format))
    .join("\n");
}
