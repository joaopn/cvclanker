import type { CoverLetterDocument } from "./types/cover-letter-document";
import type { CvFieldOverrides } from "./types/cv-content";

/**
 * The per-job baseline for a cover-letter document's fields.
 *
 * A cover-letter document's `defaultFieldValues` are the uploaded letter
 * verbatim — the upload gate re-renders the template with them and requires a
 * zero pdftotext diff against the original PDF, and the extract rejects any
 * empty field value, so they can never be blank. That is right for the
 * document (the standalone Cover Letter page edits the template itself) and
 * wrong for a job: the body is prose the user wrote for some other
 * application, so every job would open, render and be chatted about carrying
 * a letter that belongs to nobody.
 *
 * So the body field — the single `role: "body"` field the extract guarantees —
 * gets a per-job baseline of EMPTY, and every other field keeps its default.
 * A baseline rather than a stored `""` override: nothing is persisted until
 * the user or Generate writes a real body, which is what keeps "Reset all"
 * meaning "back to empty" instead of restoring the boilerplate, keeps a
 * freshly-opened job undirty, and leaves the Generate prompt's field view
 * seeing the template body it reads to infer each field's shape.
 *
 * Body-only is deliberate. Per `prompts/coverletter-template-extract.yaml`
 * the greeting lives INSIDE the body field and the candidate's own name,
 * contact block, date and signature are not templatable at all, so on a
 * typical template the body is the only tailorable field. A template that
 * does separate a recipient or a role-title span keeps those defaults: the
 * generate prompt reads each field's current value to infer the shape its
 * patch must match, and treats "leave the upload-time default in place" as
 * its safe fallback.
 */
export function coverLetterJobBaseline(
  document: CoverLetterDocument,
): CvFieldOverrides {
  const bodyField = document.fields.find((field) => field.role === "body");
  if (!bodyField) return { ...document.defaultFieldValues };
  return { ...document.defaultFieldValues, [bodyField.id]: "" };
}
