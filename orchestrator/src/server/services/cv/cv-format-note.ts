import { renderFragment } from "@server/services/prompts";
import type { CvSourceFormat } from "@shared/types";

/**
 * The one home of the format → prompt-fragment mapping, mirroring
 * `cv-format.ts` for the `?? "latex"` rule and the client's
 * `getCvFormatCopy`. Both tailoring surfaces (`cv-adjust` and
 * `ghostwriter-system`) render the note here and pass it in as
 * `{{cvFormatNote}}`; no other prompt is given that variable.
 */
const FRAGMENT_BY_FORMAT: Record<CvSourceFormat, string> = {
  latex: "cv-format-latex",
  docx: "cv-format-docx",
  html: "cv-format-html",
};

export async function getCvFormatNote(format: CvSourceFormat): Promise<string> {
  return renderFragment(FRAGMENT_BY_FORMAT[format]);
}
