import { posix } from "node:path";
import AdmZip from "adm-zip";

const MAX_DEPTH = 10;
const DEFAULT_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_INCLUDE_COUNT = 100;

const INPUT_PATTERN = /\\(?:input|include)\{([^}]+)\}/g;
const ASSET_PATTERN =
  /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}|\\(?:setmainfont|setsansfont|setmonofont|newfontfamily)(?:\[[^\]]*\])?\{([^}]+)\}/g;

export const DEFAULT_ENTRYPOINT_PRIORITY = [
  "main.tex",
  "cv.tex",
  "resume.tex",
  "document.tex",
] as const;

export interface FlattenInputArgs {
  archive: Uint8Array;
  filename: string;
  /**
   * Ordered list of preferred entrypoint basenames (case-insensitive). The
   * first match against the archive's `\documentclass`-bearing files wins.
   * Falls back to shortest path when no preferred match is found.
   * Defaults to `DEFAULT_ENTRYPOINT_PRIORITY` (CV-style entrypoints).
   */
  entrypointPriority?: readonly string[];
  /**
   * Cap on total bytes of expanded LaTeX (after `\input{}` resolution).
   * Callers should source this from `settings.maxExpandedLatexBytes` so the
   * limit is user-configurable. Defaults to 50 MB when omitted.
   */
  maxExpandedBytes?: number;
}

export interface FlattenInputResult {
  /** Single LaTeX string with all `\input{}` / `\include{}` directives resolved. */
  flattenedTex: string;
  /** Entrypoint path inside the archive (or filename for single-tex uploads). */
  entrypoint: string;
  /** Asset references discovered while flattening — e.g. images, fonts. */
  assetReferences: string[];
}

export class FlattenInputError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FlattenInputError";
    this.code = code;
  }
}

export function flattenInput(args: FlattenInputArgs): FlattenInputResult {
  const buf = Buffer.from(args.archive);
  const priority = args.entrypointPriority ?? DEFAULT_ENTRYPOINT_PRIORITY;
  const maxExpandedBytes = args.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
  if (looksLikeZip(buf)) {
    return flattenZip(buf, priority, maxExpandedBytes);
  }
  return flattenSingleTex(buf, args.filename);
}

function looksLikeZip(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function flattenSingleTex(buf: Buffer, filename: string): FlattenInputResult {
  const tex = buf.toString("utf8");
  const trimmed = tex.trimStart();
  if (!trimmed) {
    throw new FlattenInputError("Uploaded file is empty.", "EMPTY_INPUT");
  }
  for (const match of tex.matchAll(INPUT_PATTERN)) {
    if (isInLatexComment(tex, match.index ?? 0)) continue;
    throw new FlattenInputError(
      "Single-file upload contains \\input{}/\\include{}; upload as a zip with the referenced files.",
      "UNRESOLVED_INPUT",
    );
  }
  return {
    flattenedTex: tex,
    entrypoint: filename,
    assetReferences: collectAssets(tex),
  };
}

function flattenZip(
  buf: Buffer,
  entrypointPriority: readonly string[],
  maxExpandedBytes: number,
): FlattenInputResult {
  const zip = new AdmZip(buf);
  const files = new Map<string, string>();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = posix.normalize(entry.entryName.replaceAll("\\", "/"));
    if (name.startsWith("..") || name.startsWith("/")) {
      throw new FlattenInputError(
        `Refusing zip entry with unsafe path "${entry.entryName}".`,
        "UNSAFE_PATH",
      );
    }
    if (name.endsWith(".tex")) {
      files.set(name, entry.getData().toString("utf8"));
    }
  }

  if (files.size === 0) {
    throw new FlattenInputError(
      "Zip archive contains no .tex files.",
      "NO_TEX",
    );
  }

  const entrypoint = pickEntrypoint(files, entrypointPriority);
  const visited = new Set<string>();
  const assets: string[] = [];
  let includeCount = 0;
  let totalSize = 0;

  function expand(path: string, depth: number): string {
    if (depth > MAX_DEPTH) {
      throw new FlattenInputError(
        `\\input depth exceeded ${MAX_DEPTH} at "${path}".`,
        "DEPTH_EXCEEDED",
      );
    }
    if (visited.has(path)) {
      throw new FlattenInputError(`Cycle detected at "${path}".`, "CYCLE");
    }
    const source = files.get(path);
    if (source === undefined) {
      throw new FlattenInputError(
        `Referenced file "${path}" not present in archive.`,
        "MISSING_FILE",
      );
    }
    visited.add(path);

    collectAssets(source).forEach((asset) => {
      if (!assets.includes(asset)) assets.push(asset);
    });

    const baseDir = posix.dirname(path);
    const matches = [...source.matchAll(INPUT_PATTERN)];
    let expanded = "";
    let cursor = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      if (isInLatexComment(source, start)) continue;
      expanded += source.slice(cursor, start);
      includeCount += 1;
      if (includeCount > MAX_INCLUDE_COUNT) {
        throw new FlattenInputError(
          `\\input count exceeded ${MAX_INCLUDE_COUNT}.`,
          "TOO_MANY_INCLUDES",
        );
      }
      const rel = match[1];
      const target = resolveInputPath(baseDir, rel, files);
      expanded += expand(target, depth + 1);
      visited.delete(target);
      cursor = start + match[0].length;
    }
    expanded += source.slice(cursor);

    totalSize += Buffer.byteLength(expanded, "utf8");
    if (totalSize > maxExpandedBytes) {
      throw new FlattenInputError(
        `Expanded LaTeX exceeded ${maxExpandedBytes} bytes.`,
        "SIZE_EXCEEDED",
      );
    }
    return expanded;
  }

  const flattenedTex = expand(entrypoint, 0);
  return { flattenedTex, entrypoint, assetReferences: assets };
}

function pickEntrypoint(
  files: Map<string, string>,
  entrypointPriority: readonly string[],
): string {
  const documentClassMatches: string[] = [];
  for (const [name, source] of files) {
    if (/\\documentclass\b/.test(source)) documentClassMatches.push(name);
  }
  const candidates =
    documentClassMatches.length > 0 ? documentClassMatches : [...files.keys()];

  for (const preferred of entrypointPriority) {
    const hit = candidates.find(
      (name) => posix.basename(name).toLowerCase() === preferred.toLowerCase(),
    );
    if (hit) return hit;
  }
  candidates.sort((a, b) => a.split("/").length - b.split("/").length);
  return candidates[0];
}

function resolveInputPath(
  baseDir: string,
  rel: string,
  files: Map<string, string>,
): string {
  const cleaned = rel.trim();
  if (cleaned.startsWith("/")) {
    throw new FlattenInputError(
      `Refusing absolute \\input path "${rel}".`,
      "ABSOLUTE_INPUT",
    );
  }
  const joined = posix.normalize(posix.join(baseDir, cleaned));
  if (joined.startsWith("..")) {
    throw new FlattenInputError(
      `Refusing \\input path traversal "${rel}".`,
      "INPUT_TRAVERSAL",
    );
  }
  if (files.has(joined)) return joined;
  const withExt = `${joined}.tex`;
  if (files.has(withExt)) return withExt;
  throw new FlattenInputError(
    `\\input target "${rel}" not present in archive.`,
    "MISSING_FILE",
  );
}

function collectAssets(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(ASSET_PATTERN)) {
    if (isInLatexComment(source, match.index ?? 0)) continue;
    const ref = (match[1] ?? match[2] ?? "").trim();
    if (ref) found.add(ref);
  }
  return [...found];
}

/**
 * Returns true when the character at `index` falls after an unescaped `%`
 * on the same line — i.e. inside a LaTeX line comment. A `%` is unescaped
 * when preceded by an even number of consecutive backslashes (zero counts).
 */
export function isInLatexComment(source: string, index: number): boolean {
  let lineStart = index;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  let backslashes = 0;
  for (let i = lineStart; i < index; i++) {
    const ch = source[i];
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === "%" && backslashes % 2 === 0) return true;
    backslashes = 0;
  }
  return false;
}
