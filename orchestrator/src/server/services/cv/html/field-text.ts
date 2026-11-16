import type { CvSourceFormat } from "@shared/types";
import { stripToText } from "./inline-markup";

/**
 * A CV field value as text, for whatever reads the CV rather than renders
 * it (ATS matching, search-term suggestion, cover letters, interview Q&A):
 * an HTML value's tags dropped and entities decoded, any other value as is.
 */
export function cvFieldText(value: string, format: CvSourceFormat): string {
  return format === "html" ? stripToText(value) : value;
}
