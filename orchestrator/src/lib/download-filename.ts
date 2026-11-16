import { foldDiacritics } from "@shared/location-support";
import { safeFilenamePart } from "./utils";

type DownloadDocumentKind = "resume" | "cover";
export type DownloadExtension = "pdf" | "docx" | "html" | "zip";

const NAME_CHARACTER = /[\p{L}\p{N}]/u;
const LATIN_LETTER = /[a-z]/i;

const words = (value: string) =>
  value.split(/\s+/).filter((word) => NAME_CHARACTER.test(word));

const trimToAlphanumeric = (value: string) =>
  value.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");

/**
 * `<Last>_<Initials>` from a full name, or null when the last name has no
 * Latin letter or digit. Words with no letter or number are ignored. The last
 * word is the last name unless a comma marks it ("García Márquez, Gabriel");
 * every other word, split on dashes and dots, contributes the first Latin
 * letter of each part.
 */
export function candidateNamePrefix(
  name: string | null | undefined,
): string | null {
  const folded = foldDiacritics(name ?? "");
  const comma = folded.indexOf(",");
  let lastName: string;
  let givenNames: string[];
  if (comma !== -1) {
    lastName = words(folded.slice(0, comma)).join(" ");
    givenNames = words(folded.slice(comma + 1).replaceAll(",", " "));
  } else {
    givenNames = words(folded);
    lastName = givenNames.pop() ?? "";
  }
  lastName = trimToAlphanumeric(lastName);
  if (!lastName) return null;
  const initials = givenNames
    .flatMap((word) => word.split(/[.\p{Pd}]+/u))
    .map((part) => part.match(LATIN_LETTER)?.[0]?.toUpperCase() ?? "")
    .join("");
  const last = safeFilenamePart(lastName);
  return initials ? `${last}_${initials}` : last;
}

export function buildDownloadFilename({
  candidateName,
  kind,
  employer,
  ext,
}: {
  candidateName: string | null | undefined;
  kind: DownloadDocumentKind;
  employer: string | null | undefined;
  ext: DownloadExtension;
}): string {
  const prefix = candidateNamePrefix(candidateName);
  const company = safeFilenamePart(foldDiacritics(employer ?? ""));
  return `${prefix ? `${prefix}_` : ""}${kind}_${company}.${ext}`;
}
