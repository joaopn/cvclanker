// How a reference in an HTML-CV bundle maps to a bundle file. The upload
// checks and the renderer both go through here, so a reference the upload
// accepts is one the renderer can answer, and the other way round.
//
// The renderer serves the bundle under a placeholder origin and lets
// Chromium's URL parser resolve every reference, so resolution here is the
// URL parser too (`new URL(ref, base)`): root-relative paths, `..` clamping,
// backslashes and stripped whitespace all behave as they do in the page.

const ORIGIN_HOST = "cv.invalid";

const ORIGIN = `http://${ORIGIN_HOST}/`;

export type ResolvedReference =
  /** A file of the bundle, by its path. */
  | { kind: "local"; path: string }
  /** Inline data; loads nothing. */
  | { kind: "data" }
  /** A fragment of the same document, or an empty reference; loads nothing. */
  | { kind: "fragment" }
  /** Anything with a scheme, or protocol-relative: never fetched. */
  | { kind: "remote"; url: string }
  /** No bundle path could serve it, e.g. a malformed or escaped-slash
   * segment, an empty segment, or an absolute-looking reference that is no
   * URL ("https://"). */
  | { kind: "unresolvable"; reference: string };

/** The URL the renderer serves a bundle file at. */
export function urlForBundlePath(path: string): string {
  return ORIGIN + path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The bundle path a request URL names, or null when it is not a URL the
 * renderer serves. Decoded segment by segment: a segment that decodes to
 * something containing "/" names no bundle file, so a stylesheet requested as
 * `a%2Fb.css` is never served from `a/b.css`, where its own relative
 * references would resolve differently.
 */
export function bundlePathForUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== ORIGIN_HOST ||
    parsed.port !== ""
  ) {
    return null;
  }
  // The pathname starts with "/"; any later empty segment ("a//b", a
  // trailing "/") names no bundle file. Collapsing it would break the
  // contract: Chromium resolves "../x" against "css//a.css" to "css/x".
  const [, ...parts] = parsed.pathname.split("/");
  const segments: string[] = [];
  for (const segment of parts) {
    if (segment === "") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes("/")) return null;
    segments.push(decoded);
  }
  return segments.join("/");
}

/**
 * Classifies a reference written in the bundle file at `containingPath` and,
 * when it is local, resolves it to a bundle path.
 */
export function resolveReference(
  reference: string,
  containingPath: string,
): ResolvedReference {
  // The URL spec's own clean-up: leading/trailing C0 controls and spaces go,
  // tabs and newlines anywhere go.
  const ref = trimC0AndSpace(reference).replace(/[\t\n\r]/g, "");
  if (ref === "" || ref.startsWith("#")) return { kind: "fragment" };
  if (/^data:/i.test(ref)) return { kind: "data" };
  if (isAbsoluteUrl(ref) || /^[\\/]{2}/.test(ref)) {
    return { kind: "remote", url: ref };
  }
  let resolved: string;
  try {
    resolved = new URL(ref, urlForBundlePath(containingPath)).href;
  } catch {
    // e.g. "https://" or "http://a b": absolute in form, but no URL.
    return { kind: "unresolvable", reference };
  }
  const path = bundlePathForUrl(resolved);
  return path === null
    ? { kind: "unresolvable", reference }
    : { kind: "local", path };
}

function trimC0AndSpace(text: string): string {
  const isC0OrSpace = (at: number) => text.charCodeAt(at) <= 0x20;
  let start = 0;
  let end = text.length;
  while (start < end && isC0OrSpace(start)) start++;
  while (end > start && isC0OrSpace(end - 1)) end--;
  return text.slice(start, end);
}

function isAbsoluteUrl(ref: string): boolean {
  try {
    new URL(ref);
    return true;
  } catch {
    return false;
  }
}
