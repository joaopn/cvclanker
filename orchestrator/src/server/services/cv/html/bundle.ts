import { zipSync } from "fflate";
import { DEFAULT_MAX_PART_COUNT } from "../docx/constants";
import {
  displayName,
  listZipEntries,
  looksLikeZip,
  readZipEntry,
  type ZipEntry,
  ZipReadError,
} from "./zip-reader";

// An uploaded HTML CV as a set of files: a single HTML file, or a zip holding
// the page and everything it uses. Shape is kept — the tailored copy goes back
// to the user the way they uploaded it.

/** The name a single-file upload is stored under inside the bundle. */
export const SINGLE_FILE_ENTRY = "index.html";

// Linux's PATH_MAX (4096, counting the terminating NUL) and NAME_MAX: a
// longer path could not be extracted from the zip handed back, and very long
// near-identical names also degrade the Maps this file keys by name (V8
// hashes long strings by length alone).
const MAX_PATH_BYTES = 4095;
const MAX_SEGMENT_BYTES = 255;

export type HtmlBundleShape = "file" | "bundle";

export interface HtmlBundle {
  shape: HtmlBundleShape;
  /** Bundle paths (posix, no leading slash) → bytes. */
  files: Map<string, Uint8Array>;
  /** Path of the HTML page, a key of `files`. */
  entry: string;
}

export type HtmlBundleErrorCode =
  | "NOT_HTML"
  | "BAD_ZIP"
  | "ZIP_BOMB"
  | "UNSAFE_PATH"
  | "DUPLICATE_ENTRY"
  | "NO_ENTRY"
  | "AMBIGUOUS_ENTRY";

export class HtmlBundleError extends Error {
  readonly code: HtmlBundleErrorCode;
  constructor(message: string, code: HtmlBundleErrorCode) {
    super(message);
    this.name = "HtmlBundleError";
    this.code = code;
  }
}

export interface OpenHtmlBundleOptions {
  /** Cap on the total uncompressed size of a zip's files. */
  maxExpandedBytes: number;
  /** Cap on a zip's entry count. Default: DEFAULT_MAX_PART_COUNT. */
  maxEntries?: number;
}

/**
 * True when the bytes start like an HTML document: an optional UTF-8 BOM,
 * then whitespace, comments and an XML prolog, then `<!doctype html` or
 * `<html`. Parsing alone cannot tell — an HTML parser accepts any bytes.
 * Works on bytes (whitespace as HTML defines it), without decoding the file.
 */
export function hasHtmlSignature(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  for (;;) {
    at = skipHtmlWhitespace(buf, at);
    if (startsWithAscii(buf, at, "<!--")) {
      // "<!-->" and "<!--->" are complete (empty) comments.
      if (buf[at + 4] === 0x3e) at += 5;
      else if (buf[at + 4] === 0x2d && buf[at + 5] === 0x3e) at += 6;
      else {
        const end = buf.indexOf("-->", at + 4, "latin1");
        if (end === -1) return false;
        at = end + 3;
      }
    } else if (startsWithAscii(buf, at, "<?xml")) {
      const end = buf.indexOf("?>", at + 5, "latin1");
      if (end === -1) return false;
      at = end + 2;
    } else {
      break;
    }
  }
  let after: number;
  if (startsWithAscii(buf, at, "<!doctype", true)) {
    const name = skipHtmlWhitespace(buf, at + 9);
    if (name === at + 9 || !startsWithAscii(buf, name, "html", true)) {
      return false;
    }
    after = name + 4;
  } else if (startsWithAscii(buf, at, "<html", true)) {
    after = at + 5;
  } else {
    return false;
  }
  return (
    after >= buf.length ||
    isHtmlWhitespace(buf[after]) ||
    buf[after] === 0x3e ||
    buf[after] === 0x2f
  );
}

function isHtmlWhitespace(byte: number): boolean {
  // Tab, LF, FF, CR, space.
  return (
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

function skipHtmlWhitespace(buf: Buffer, at: number): number {
  let i = at;
  while (i < buf.length && isHtmlWhitespace(buf[i])) i++;
  return i;
}

function startsWithAscii(
  buf: Buffer,
  at: number,
  text: string,
  ignoreCase = false,
): boolean {
  if (at + text.length > buf.length) return false;
  for (let i = 0; i < text.length; i++) {
    let byte = buf[at + i];
    if (ignoreCase && byte >= 0x41 && byte <= 0x5a) byte += 0x20;
    if (byte !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function openHtmlBundle(
  bytes: Uint8Array,
  opts: OpenHtmlBundleOptions,
): HtmlBundle {
  return openBundle(bytes, {
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_PART_COUNT,
    maxExpandedBytes: opts.maxExpandedBytes,
    stripTopFolder: true,
  });
}

/**
 * Opens an archive this server stored (packHtmlBundle of a checked upload)
 * as it was packed: its single top folder was stripped once at upload, so
 * stripping again would move every path (and the entry) under the page's
 * root-relative references; and its size was bounded at upload, while the
 * cleaned page it holds may be a little larger than the uploaded one.
 */
export function openStoredHtmlBundle(bytes: Uint8Array): HtmlBundle {
  return openBundle(bytes, {
    maxEntries: DEFAULT_MAX_PART_COUNT,
    maxExpandedBytes: Number.POSITIVE_INFINITY,
    stripTopFolder: false,
  });
}

interface OpenBundleRules {
  maxEntries: number;
  maxExpandedBytes: number;
  stripTopFolder: boolean;
}

function openBundle(bytes: Uint8Array, rules: OpenBundleRules): HtmlBundle {
  if (!looksLikeZip(bytes)) {
    if (!hasHtmlSignature(bytes)) {
      throw new HtmlBundleError(
        "This file is not recognised as an HTML CV: it must start with <!doctype html> or <html>.",
        "NOT_HTML",
      );
    }
    return {
      shape: "file",
      files: new Map([[SINGLE_FILE_ENTRY, bytes]]),
      entry: SINGLE_FILE_ENTRY,
    };
  }
  try {
    return openZipBundle(bytes, rules);
  } catch (error) {
    if (error instanceof ZipReadError) {
      throw new HtmlBundleError(error.message, error.code);
    }
    throw error;
  }
}

/** The bytes to hand back to the user: the page itself, or a zip. */
export function packHtmlBundle(bundle: HtmlBundle): Uint8Array {
  if (bundle.shape === "file") {
    const page = bundle.files.get(bundle.entry);
    if (!page) throw new Error(`bundle entry "${bundle.entry}" is missing`);
    return page;
  }
  const paths = [...bundle.files.keys()].sort();
  // fflate writes zip timestamps with local-time getters, so a date built in
  // the current local time (here, not at module load) packs to the same bytes
  // in every time zone.
  const mtime = new Date(2000, 0, 1);
  return zipSync(
    Object.fromEntries(
      paths.map((path) => [
        path,
        [bundle.files.get(path) as Uint8Array, { mtime }],
      ]),
    ),
  );
}

function openZipBundle(bytes: Uint8Array, rules: OpenBundleRules): HtmlBundle {
  const entries = listZipEntries(bytes, { maxEntries: rules.maxEntries });

  const kept: { path: string; entry: ZipEntry }[] = [];
  // Keyed by the NFC-normalised, lower-cased name: the tailored zip goes back
  // to the user, and names differing only by case collide when extracted on
  // macOS or Windows, and only by Unicode form on macOS.
  const byPath = new Map<string, string>();
  let declaredTotal = 0;
  for (const entry of entries) {
    const path = normalizeEntryName(entry.name);
    if (path === null) continue;
    const key = path.normalize("NFC").toLowerCase();
    const earlier = byPath.get(key);
    if (earlier !== undefined) {
      throw new HtmlBundleError(
        `The zip holds "${displayName(earlier)}" and "${displayName(entry.name)}", which name the same file.`,
        "DUPLICATE_ENTRY",
      );
    }
    byPath.set(key, entry.name);
    declaredTotal += entry.size;
    kept.push({ path, entry });
  }
  // A file and a folder of the same name (`site` and `site/index.html`)
  // cannot both be extracted from the zip handed back. In sorted order the
  // keys starting with "site/" form one run, beginning where "site/" would
  // sort, so one binary search per key finds it — unlike building every
  // ancestor of a name with thousands of segments, which is quadratic.
  const keys = [...byPath.keys()].sort();
  for (const key of keys) {
    const under = `${key}/`;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (keys[mid] < under) low = mid + 1;
      else high = mid;
    }
    if (keys[low]?.startsWith(under)) {
      throw new HtmlBundleError(
        `The zip holds a file "${displayName(byPath.get(key) ?? key)}" and a folder of the same name.`,
        "DUPLICATE_ENTRY",
      );
    }
  }
  if (declaredTotal > rules.maxExpandedBytes) {
    throw new HtmlBundleError(
      `The zip's files add up to ${declaredTotal} bytes (limit ${rules.maxExpandedBytes}).`,
      "ZIP_BOMB",
    );
  }

  // readZipEntry returns exactly the declared size or refuses the entry, so
  // the declared total checked above bounds what is inflated.
  const prefix = rules.stripTopFolder
    ? commonTopFolder(kept.map((k) => k.path))
    : "";
  const files = new Map<string, Uint8Array>();
  for (const { path, entry } of kept) {
    files.set(path.slice(prefix.length), readZipEntry(bytes, entry));
  }
  return { shape: "bundle", files, entry: pickEntry(files) };
}

/**
 * A zip entry name as a bundle path; null for directories and OS junk.
 * Throws UNSAFE_PATH for absolute names, any `..` part, a `__proto__` part,
 * and paths too long to extract.
 */
function normalizeEntryName(name: string): string | null {
  const slashed = name.replaceAll("\\", "/");
  if (slashed.endsWith("/")) return null;
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw unsafe(name);
  }
  const segments = slashed
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  // Files are packed back into a zip through object keys, where "__proto__"
  // is no ordinary key.
  if (segments.includes("..") || segments.includes("__proto__")) {
    throw unsafe(name);
  }
  if (segments.length === 0) return null;
  const base = segments[segments.length - 1];
  if (
    segments[0] === "__MACOSX" ||
    base === ".DS_Store" ||
    base.startsWith("._") ||
    base === "Thumbs.db" ||
    base.toLowerCase() === "desktop.ini"
  ) {
    return null;
  }
  // Measured on the normalised path (before any common top folder is
  // stripped, so at worst a little early), after junk is dropped: a macOS
  // "__MACOSX/…/._name" twin is longer than its file but never kept.
  const path = segments.join("/");
  if (
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
    segments.some((segment) => Buffer.byteLength(segment) > MAX_SEGMENT_BYTES)
  ) {
    throw tooLong(name);
  }
  return path;
}

/** "folder/" when every path sits under one top-level folder, else "". */
function commonTopFolder(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0].split("/")[0];
  return paths.every((path) => path.startsWith(`${first}/`)) ? `${first}/` : "";
}

/**
 * The HTML page to render: among `.html`/`.htm` files that start like HTML,
 * the shallowest depth that has any; there, `index.html`, else `index.htm`,
 * else the only page.
 */
function pickEntry(files: Map<string, Uint8Array>): string {
  const pages = [...files.entries()]
    .filter(([path, data]) => /\.html?$/i.test(path) && hasHtmlSignature(data))
    .map(([path]) => path);
  if (pages.length === 0) {
    throw new HtmlBundleError(
      "The zip has no HTML page: none of its .html files starts with <!doctype html> or <html>.",
      "NO_ENTRY",
    );
  }
  const depth = (path: string) => path.split("/").length;
  const shallowest = Math.min(...pages.map(depth));
  const candidates = pages.filter((path) => depth(path) === shallowest);
  const named = (name: string) =>
    candidates.filter(
      (path) => (path.split("/").pop() ?? "").toLowerCase() === name,
    );
  for (const choice of [named("index.html"), named("index.htm"), candidates]) {
    if (choice.length === 1) return choice[0];
    if (choice.length > 1) {
      throw new HtmlBundleError(
        `The zip has ${choice.length} HTML pages at the same level (${choice.length === 2 ? "" : "such as "}"${displayName(choice[0])}" and "${displayName(choice[1])}"); keep one, named index.html.`,
        "AMBIGUOUS_ENTRY",
      );
    }
  }
  // Unreachable: candidates is never empty.
  throw new HtmlBundleError("The zip has no HTML page.", "NO_ENTRY");
}

function tooLong(name: string): HtmlBundleError {
  return new HtmlBundleError(
    `The zip entry "${displayName(name)}" has a name too long to extract (over ${MAX_PATH_BYTES} bytes, or a part over ${MAX_SEGMENT_BYTES}).`,
    "UNSAFE_PATH",
  );
}

function unsafe(name: string): HtmlBundleError {
  return new HtmlBundleError(
    `The zip entry "${displayName(name)}" has an unsafe path.`,
    "UNSAFE_PATH",
  );
}
