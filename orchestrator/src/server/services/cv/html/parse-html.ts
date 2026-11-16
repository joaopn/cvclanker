import { TokenType, tokenize } from "@csstools/css-tokenizer";
import { DOMParser } from "@xmldom/xmldom";
import {
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  defaultTreeAdapter,
  parse,
  serialize,
  type TreeAdapter,
} from "parse5";
import type { HtmlBundle } from "./bundle";
import { resolveReference } from "./bundle-url";
import { displayName } from "./zip-reader";

// The upload-time check of an HTML CV: simple HTML only (no scripts, no
// embedded documents), nothing loaded from the network, every file the page
// uses present in the upload — and the clean-up that leaves a page whose
// rendering cannot depend on anything outside the bundle.

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type DocumentType = DefaultTreeAdapterTypes.DocumentType;

const MARKER_CHARS = /[⟦⟧]/;

// The WHATWG Encoding Standard's labels for UTF-8.
const UTF8_LABELS = new Set([
  "unicode-1-1-utf-8",
  "unicode11utf8",
  "unicode20utf8",
  "utf-8",
  "utf8",
  "x-unicode20utf8",
]);

const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** HTML attributes whose value is a URL that can carry `javascript:`. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "longdesc",
  "usemap",
  "ping",
  "data",
]);

const EMBEDDING_ELEMENTS = new Set([
  "iframe",
  "object",
  "embed",
  "frame",
  "frameset",
  "form",
]);

const SVG_ANIMATION_ELEMENTS = new Set([
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
]);

/** SVG presentation attributes that take a `url()`. */
const SVG_URL_ATTRIBUTES = new Set([
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);

const BACKGROUND_ELEMENTS = new Set([
  "body",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

// A person, or the agent that made the page, reads these lists; past this
// many the rest are more of the same, and the message stays readable.
const MAX_LISTED = 20;

// Chromium's HTML parser stops nesting at 512 open elements; deeper markup is
// rebuilt differently from what parse5 builds (and parse5's serializer
// recurses, so far deeper nesting overflows the stack).
const MAX_DEPTH = 512;

// A CV page has a few hundred elements. Without a cap, 21 KB of markup built
// a million elements (formatting elements are rebuilt per block), and parse
// cost grows with elements × depth. Parsing cost that remains after both caps
// (text and end tags searching the open-element stack, and more) is bounded
// by running the whole check in a worker with a deadline
// (check-html-worker.ts).
const MAX_ELEMENTS = 10_000;

export type HtmlRejectCode =
  | "NOT_UTF8"
  | "NON_UTF8_CHARSET"
  | "SCRIPT"
  | "NOSCRIPT"
  | "EVENT_HANDLER"
  | "JAVASCRIPT_URL"
  | "EMBEDDED_CONTENT"
  | "SVG_ANIMATION"
  | "SHADOW_ROOT"
  | "SELECT"
  | "META_REFRESH"
  | "BASE_ELEMENT"
  | "MARKER_COLLISION"
  | "REMOTE_REFERENCES"
  | "MISSING_FILES"
  | "DATA_STYLESHEET"
  | "STYLESHEET_EXTENSION"
  | "SVG_EXTENSION"
  | "UNSAFE_SVG"
  | "UNSTABLE_MARKUP"
  | "TOO_MANY_ELEMENTS"
  | "NESTING_TOO_DEEP"
  | "CHECK_TOO_COSTLY";

export class HtmlRejectError extends Error {
  readonly code: HtmlRejectCode;
  constructor(message: string, code: HtmlRejectCode) {
    super(message);
    this.name = "HtmlRejectError";
    this.code = code;
  }
}

export interface CheckedHtmlBundle {
  /** The bundle with its entry page cleaned up. */
  bundle: HtmlBundle;
  /** The cleaned entry page as text. */
  entryHtml: string;
}

/** The files the check reads as text (the rest it only sniffs). */
export function isTextBundleFile(path: string): boolean {
  return /\.(?:html?|css|svg)$/i.test(path);
}

/**
 * Checks an uploaded HTML CV and returns it cleaned up, or throws an
 * HtmlRejectError saying what to fix. Unbounded in time and memory: callers
 * use checkHtmlBundleBounded (check-html-worker.ts), which runs this in a
 * worker with a deadline and a heap cap.
 */
export function checkHtmlBundleUnbounded(
  bundle: HtmlBundle,
): CheckedHtmlBundle {
  const entryBytes = bundle.files.get(bundle.entry);
  if (!entryBytes) throw new Error(`bundle entry "${bundle.entry}" is missing`);
  const text = decodeUtf8(entryBytes, bundle.entry, "NOT_UTF8");
  rejectMarkers(text, bundle.entry);
  for (const [path, data] of bundle.files) {
    if (path !== bundle.entry && isTextBundleFile(path)) {
      const fileText = new TextDecoder("utf-8").decode(data);
      rejectMarkers(fileText, path);
    }
  }

  // Pass 1: parse and clean up.
  const first = parsePage(text, bundle.entry);
  cleanUp(first.document);
  const entryHtml = serializePage(first);
  // The serializer writes text and attribute values decoded (escaping only
  // the few characters markup needs, never ⟦ or ⟧), so this sees every
  // marker the stored page holds, however the upload spelled it.
  rejectMarkers(entryHtml, bundle.entry);

  // Pass 2: everything Chromium acts on is checked on the cleaned page as it
  // parses again — the bytes Chromium will parse — and that page must need
  // no further clean-up and read back to itself. Markup the parser rebuilds
  // differently on a second read (the "mutation XSS" family) could
  // otherwise carry elements no check or clean-up saw.
  const second = parsePage(entryHtml, bundle.entry);
  const scan = new ReferenceScan(bundle);
  walk(second.document, (node) => {
    if ("tagName" in node) checkElement(node as Element, bundle.entry, scan);
  });
  scan.finish();
  cleanUp(second.document);
  if (serializePage(second) !== entryHtml) {
    reject(
      "UNSTABLE_MARKUP",
      "The page's markup does not read back the same way after it is cleaned up, so it cannot be checked reliably. This comes from elements in places HTML does not allow (inside tables, or inside <math> or <svg>); simplify the markup there.",
    );
  }

  const files = new Map(bundle.files);
  files.set(bundle.entry, new TextEncoder().encode(entryHtml));
  return { bundle: { ...bundle, files }, entryHtml };
}

interface ParsedPage {
  document: DefaultTreeAdapterTypes.Document;
  /** Each doctype's original text, so serialising keeps it verbatim. */
  doctypes: Map<DocumentType, string>;
}

function parsePage(text: string, entry: string): ParsedPage {
  const document = parse(text, {
    scriptingEnabled: false,
    sourceCodeLocationInfo: true,
    treeAdapter: boundedTreeAdapter(entry),
  });
  const doctypes = new Map<DocumentType, string>();
  for (const child of document.childNodes) {
    if (child.nodeName !== "#documentType") continue;
    const location = (child as DocumentType).sourceCodeLocation;
    if (location) {
      doctypes.set(
        child as DocumentType,
        text.slice(location.startOffset, location.endOffset),
      );
    }
  }
  return { document, doctypes };
}

/**
 * parse5's default tree adapter, counting the elements it creates and the
 * depth of its open-element stack as it parses, so markup that would build a
 * vast tree or nest past Chromium's limit is refused before it is built.
 * (Counting tags in the source is not enough: "</br>" and "</p>" create
 * elements, and formatting elements are rebuilt for every block they span.)
 */
function boundedTreeAdapter(entry: string): TreeAdapter<DefaultTreeAdapterMap> {
  let elements = 0;
  let depth = 0;
  return {
    ...defaultTreeAdapter,
    createElement: (tagName, namespaceURI, attrs) => {
      elements++;
      if (elements > MAX_ELEMENTS) {
        reject(
          "TOO_MANY_ELEMENTS",
          `"${displayName(entry)}" makes more than ${MAX_ELEMENTS} elements; a CV page needs far fewer — simplify it.`,
        );
      }
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    onItemPush: () => {
      depth++;
      if (depth > MAX_DEPTH) {
        reject(
          "NESTING_TOO_DEEP",
          `"${displayName(entry)}" nests elements more than ${MAX_DEPTH} deep; simplify it.`,
        );
      }
    },
    onItemPop: () => {
      depth--;
    },
  };
}

function serializePage(page: ParsedPage): string {
  // The parser drops one newline right after <pre>, <textarea> and
  // <listing>, and parse5's serializer does not write it back, so a page
  // with a blank first line there would change on every parse. Writing one
  // back when the content starts with a newline makes it read back to itself.
  walk(page.document, (node) => {
    if (!("tagName" in node)) return;
    const element = node as Element;
    if (
      element.namespaceURI !== HTML_NS ||
      !["pre", "textarea", "listing"].includes(element.tagName)
    ) {
      return;
    }
    const first = element.childNodes[0];
    if (
      first?.nodeName === "#text" &&
      (first as DefaultTreeAdapterTypes.TextNode).value.startsWith("\n")
    ) {
      (first as DefaultTreeAdapterTypes.TextNode).value =
        `\n${(first as DefaultTreeAdapterTypes.TextNode).value}`;
    }
  });
  const treeAdapter = {
    ...defaultTreeAdapter,
    getDocumentTypeNodeName: (node: DocumentType) => {
      const original = page.doctypes.get(node);
      return original === undefined
        ? defaultTreeAdapter.getDocumentTypeNodeName(node)
        : doctypeBody(original);
    },
  };
  return serialize(page.document, { treeAdapter });
}

function checkElement(
  element: Element,
  entry: string,
  scan: ReferenceScan,
): void {
  const name = element.tagName.toLowerCase();
  const isSvg = element.namespaceURI === SVG_NS;
  const isHtml = element.namespaceURI === HTML_NS;
  const where = `<${displayName(element.tagName)}>`;

  if (name === "script") {
    reject(
      "SCRIPT",
      `The page has a ${where} element; scripts are not supported — remove it.`,
    );
  }
  if (isHtml && name === "noscript") {
    reject(
      "NOSCRIPT",
      "The page has a <noscript> element; remove it (scripts are not supported, so its content would be shown inconsistently).",
    );
  }
  if (isHtml && EMBEDDING_ELEMENTS.has(name)) {
    reject(
      "EMBEDDED_CONTENT",
      `The page has a ${where} element; embedded documents and forms are not supported — remove it.`,
    );
  }
  if (isHtml && name === "select") {
    reject(
      "SELECT",
      "The page has a <select> element; remove it (it renders inconsistently in a PDF).",
    );
  }
  if (isHtml && name === "base") {
    reject(
      "BASE_ELEMENT",
      "The page has a <base> element; remove it and link files by relative paths.",
    );
  }
  if (isSvg && SVG_ANIMATION_ELEMENTS.has(name)) {
    reject(
      "SVG_ANIMATION",
      `The page has an SVG ${where} animation; remove it.`,
    );
  }
  if (
    isHtml &&
    name === "template" &&
    element.attrs.some(
      (attr) => attr.name === "shadowrootmode" || attr.name === "shadowroot",
    )
  ) {
    reject(
      "SHADOW_ROOT",
      "The page uses a declarative shadow root (<template shadowrootmode>); remove it.",
    );
  }
  if (isHtml && name === "meta") {
    const equiv = attribute(element, "http-equiv")?.trim().toLowerCase();
    if (equiv === "refresh") {
      reject(
        "META_REFRESH",
        'The page has a <meta http-equiv="refresh">; remove it.',
      );
    }
    checkCharset(element);
  }

  for (const attr of element.attrs) {
    const attrName = attr.name.toLowerCase();
    if (attrName.startsWith("on")) {
      reject(
        "EVENT_HANDLER",
        `The page has a ${displayName(attr.name)} attribute on ${where}; scripts are not supported — remove it.`,
      );
    }
    if (URL_ATTRIBUTES.has(attrName)) {
      const urls =
        attrName === "srcset" ? parseSrcset(attr.value) : [attr.value];
      if (urls.some(isJavascriptUrl)) {
        reject(
          "JAVASCRIPT_URL",
          `The page has a javascript: link on ${where}; remove it.`,
        );
      }
    }
    if (attrName === "style") scan.css(attr.value, entry);
    if (isSvg && SVG_URL_ATTRIBUTES.has(attrName)) {
      scan.css(attr.value, entry);
    }
  }

  if (isHtml) {
    if (name === "img") {
      scan.resource(attribute(element, "src"), entry);
      for (const url of parseSrcset(attribute(element, "srcset") ?? "")) {
        scan.resource(url, entry);
      }
    }
    if (name === "source") {
      scan.resource(attribute(element, "src"), entry);
      for (const url of parseSrcset(attribute(element, "srcset") ?? "")) {
        scan.resource(url, entry);
      }
    }
    if (name === "video") {
      scan.resource(attribute(element, "src"), entry);
      scan.resource(attribute(element, "poster"), entry);
    }
    if (name === "audio" || name === "track") {
      scan.resource(attribute(element, "src"), entry);
    }
    if (
      name === "input" &&
      attribute(element, "type")?.trim().toLowerCase() === "image"
    ) {
      scan.resource(attribute(element, "src"), entry);
    }
    if (BACKGROUND_ELEMENTS.has(name)) {
      scan.resource(attribute(element, "background"), entry);
    }
    if (name === "link" && relTokens(element).includes("stylesheet")) {
      scan.stylesheet(attribute(element, "href"), entry);
    }
    if (name === "style") {
      scan.css(textContent(element), entry);
    }
  }
  if (isSvg) {
    if (name === "image" || name === "use" || name === "feimage") {
      for (const attr of element.attrs) {
        if (attr.name === "href") {
          if (isJavascriptUrl(attr.value)) {
            reject(
              "JAVASCRIPT_URL",
              `The page has a javascript: link on ${where}; remove it.`,
            );
          }
          scan.resource(attr.value, entry);
        }
      }
    }
    if (name === "style") {
      scan.css(textContent(element), entry);
    }
  }
}

function checkCharset(meta: Element): void {
  const charset = attribute(meta, "charset");
  let label: string | undefined;
  if (charset !== undefined) {
    label = charset;
  } else if (
    attribute(meta, "http-equiv")?.trim().toLowerCase() === "content-type"
  ) {
    label = /charset\s*=\s*["']?([^"';\s]+)/i.exec(
      attribute(meta, "content") ?? "",
    )?.[1];
  }
  // An empty label is ignored, as browsers ignore it.
  if (
    label !== undefined &&
    label.trim() !== "" &&
    !UTF8_LABELS.has(label.trim().toLowerCase())
  ) {
    reject(
      "NON_UTF8_CHARSET",
      `The page declares the character set "${displayName(label.trim())}"; save it as UTF-8 and declare <meta charset="utf-8">.`,
    );
  }
}

/** Collects every file the page and its stylesheets and SVGs load. */
class ReferenceScan {
  private readonly remote = new Set<string>();
  private readonly missing = new Map<string, string>();
  private readonly visitedCss = new Set<string>();

  constructor(private readonly bundle: HtmlBundle) {}

  resource(reference: string | undefined, from: string): void {
    if (reference === undefined) return;
    const resolved = resolveReference(reference, from);
    switch (resolved.kind) {
      case "data":
      case "fragment":
        return;
      case "remote":
        this.remote.add(resolved.url);
        return;
      case "unresolvable":
        this.miss(reference, from);
        return;
      case "local": {
        const data = this.bundle.files.get(resolved.path);
        if (!data) {
          this.miss(resolved.path, from);
          return;
        }
        if (!/\.svg$/i.test(resolved.path) && looksLikeSvg(data)) {
          reject(
            "SVG_EXTENSION",
            `"${displayName(resolved.path)}" is an SVG image but is not named .svg; rename it so it can be displayed.`,
          );
        }
        return;
      }
    }
  }

  stylesheet(reference: string | undefined, from: string): void {
    if (reference === undefined) return;
    const resolved = resolveReference(reference, from);
    switch (resolved.kind) {
      case "fragment":
        return;
      case "data":
        reject(
          "DATA_STYLESHEET",
          `"${displayName(from)}" embeds a stylesheet as a data: URL; put it in a .css file instead.`,
        );
        return;
      case "remote":
        this.remote.add(resolved.url);
        return;
      case "unresolvable":
        this.miss(reference, from);
        return;
      case "local": {
        const data = this.bundle.files.get(resolved.path);
        if (!data) {
          this.miss(resolved.path, from);
          return;
        }
        if (!/\.css$/i.test(resolved.path)) {
          reject(
            "STYLESHEET_EXTENSION",
            `The stylesheet "${displayName(resolved.path)}" is not named .css; rename it so it can be applied.`,
          );
        }
        if (this.visitedCss.has(resolved.path)) return;
        this.visitedCss.add(resolved.path);
        this.css(decodeUtf8(data, resolved.path, "NOT_UTF8"), resolved.path);
        return;
      }
    }
  }

  /** Scans CSS text written in the file at `from`. */
  css(text: string, from: string): void {
    for (const { reference, isImport } of cssReferences(text)) {
      if (isImport) this.stylesheet(reference, from);
      else this.resource(reference, from);
    }
  }

  finish(): void {
    for (const [path, data] of this.bundle.files) {
      if (/\.svg$/i.test(path)) this.checkSvgFile(path, data);
    }
    if (this.remote.size > 0) {
      reject(
        "REMOTE_REFERENCES",
        `This CV loads files from the internet, which CV Clanker does not do. Upload a zip containing the page and these files, linked by relative paths: ${listed([...this.remote])}`,
      );
    }
    if (this.missing.size > 0) {
      reject(
        "MISSING_FILES",
        `The page uses files the upload does not contain: ${listed(
          [...this.missing].map(
            ([path, from]) =>
              `${displayName(path)} (used by ${displayName(from)})`,
          ),
        )}`,
      );
    }
  }

  private miss(path: string, from: string): void {
    if (!this.missing.has(path)) this.missing.set(path, from);
  }

  private checkSvgFile(path: string, data = this.bundle.files.get(path)): void {
    if (!data) return;
    const text = decodeUtf8(data, path, "UNSAFE_SVG");
    if (/<!ENTITY/i.test(text)) {
      reject(
        "UNSAFE_SVG",
        `"${displayName(path)}" declares XML entities; export it again as plain SVG (most editors offer "SVG" rather than "SVG 1.1 with entities").`,
      );
    }
    let svg: ReturnType<DOMParser["parseFromString"]>;
    try {
      svg = new DOMParser({
        onError: (level, message) => {
          if (level !== "warning") throw new Error(message);
        },
      }).parseFromString(text, "image/svg+xml");
    } catch {
      reject(
        "UNSAFE_SVG",
        `"${displayName(path)}" is not a well-formed SVG file.`,
      );
    }
    const elements = svg.getElementsByTagName("*");
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const local = (element.localName ?? element.nodeName).toLowerCase();
      if (local === "script" || local === "foreignobject") {
        reject(
          "UNSAFE_SVG",
          `"${displayName(path)}" contains <${displayName(element.localName ?? "")}>; remove it.`,
        );
      }
      if (SVG_ANIMATION_ELEMENTS.has(local)) {
        reject(
          "UNSAFE_SVG",
          `"${displayName(path)}" contains an animation (<${displayName(element.localName ?? "")}>); remove it.`,
        );
      }
      for (let j = 0; j < element.attributes.length; j++) {
        const attr = element.attributes[j];
        const attrLocal = (attr.localName ?? attr.name).toLowerCase();
        rejectMarkers(attr.value, path);
        if (attrLocal.startsWith("on")) {
          reject(
            "UNSAFE_SVG",
            `"${displayName(path)}" has a ${displayName(attr.name)} attribute; remove it.`,
          );
        }
        if (attr.name === "xml:base") {
          reject(
            "UNSAFE_SVG",
            `"${displayName(path)}" has an xml:base attribute; remove it.`,
          );
        }
        if (attrLocal === "href") {
          if (isJavascriptUrl(attr.value)) {
            reject(
              "UNSAFE_SVG",
              `"${displayName(path)}" has a javascript: link; remove it.`,
            );
          }
          if (local !== "a") this.resource(attr.value, path);
        }
        if (attrLocal === "style" || SVG_URL_ATTRIBUTES.has(attrLocal)) {
          this.css(attr.value, path);
        }
      }
      if (local === "style") {
        this.css(element.textContent ?? "", path);
      }
    }
  }
}

/** The references in CSS text: url()s, @import targets, image-set() strings. */
function cssReferences(
  text: string,
): { reference: string; isImport: boolean }[] {
  const found: { reference: string; isImport: boolean }[] = [];
  // Open functions and parentheses, innermost last; a string is a reference
  // when it sits directly inside url(), src() or image-set().
  const stack: string[] = [];
  let pendingImport = false;
  let skippingNamespace = false;
  for (const token of tokenize({ css: text })) {
    const type = token[0];
    if (skippingNamespace) {
      // An at-rule ends at ";" or with its block.
      if (type === TokenType.Semicolon || type === TokenType.OpenCurly) {
        skippingNamespace = false;
      }
      continue;
    }
    switch (type) {
      case TokenType.AtKeyword: {
        const keyword = token[4].value.toLowerCase();
        pendingImport = keyword === "import";
        skippingNamespace = keyword === "namespace";
        break;
      }
      case TokenType.URL:
        found.push({
          reference: token[4].value,
          isImport: pendingImport && stack.length === 0,
        });
        pendingImport = false;
        break;
      case TokenType.BadURL:
        found.push({ reference: token[1], isImport: false });
        break;
      case TokenType.Function:
        stack.push(token[4].value.toLowerCase());
        break;
      case TokenType.OpenParen:
        stack.push("(");
        break;
      case TokenType.CloseParen:
        stack.pop();
        break;
      case TokenType.String: {
        const value = token[4].value;
        const inside = stack[stack.length - 1];
        if (pendingImport && stack.length === 0) {
          found.push({ reference: value, isImport: true });
          pendingImport = false;
        } else if (inside === "url" || inside === "src") {
          found.push({
            reference: value,
            isImport: pendingImport && stack.length === 1,
          });
          if (stack.length === 1) pendingImport = false;
        } else if (inside === "image-set" || inside === "-webkit-image-set") {
          found.push({ reference: value, isImport: false });
        }
        break;
      }
      case TokenType.Semicolon:
      case TokenType.OpenCurly:
        pendingImport = false;
        break;
      default:
        break;
    }
  }
  return found;
}

/** The URLs in a srcset value, per the HTML spec's parsing algorithm. */
function parseSrcset(value: string): string[] {
  const urls: string[] = [];
  let at = 0;
  const isSpace = (char: string) => /[\t\n\f\r ]/.test(char);
  while (at < value.length) {
    while (at < value.length && (isSpace(value[at]) || value[at] === ",")) at++;
    if (at >= value.length) break;
    const start = at;
    while (at < value.length && !isSpace(value[at])) at++;
    let url = value.slice(start, at);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      // Skip the descriptors up to the next comma outside parentheses.
      let depth = 0;
      while (at < value.length) {
        const char = value[at];
        if (char === "(") depth++;
        else if (char === ")") depth = Math.max(0, depth - 1);
        else if (char === "," && depth === 0) break;
        at++;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

function cleanUp(document: ParentNode): void {
  // Removals are collected and applied once per parent: filtering a parent's
  // children per removal is quadratic in its child count.
  const removed = new Set<Node>();
  walk(document, (node) => {
    if (!("tagName" in node)) return;
    const element = node as Element;
    const name = element.tagName.toLowerCase();
    if (element.namespaceURI === HTML_NS && name === "link") {
      if (!relTokens(element).includes("stylesheet")) {
        removed.add(element);
        return;
      }
      // Only the stylesheet and alternate tokens survive: a kept "preload"
      // token, with its as/imagesrcset/imagesizes, would make Chromium fetch
      // files nothing checked; integrity would make it drop a local
      // stylesheet whose bytes differ from the hash (a copied CDN tag).
      const rel = relTokens(element).filter(
        (token) => token === "stylesheet" || token === "alternate",
      );
      element.attrs = element.attrs
        .filter(
          (attr) =>
            !["integrity", "as", "imagesrcset", "imagesizes"].includes(
              attr.name,
            ),
        )
        .map((attr) =>
          attr.name === "rel" ? { ...attr, value: rel.join(" ") } : attr,
        );
    }
    if (
      element.namespaceURI === HTML_NS &&
      name === "meta" &&
      attribute(element, "http-equiv")?.trim().toLowerCase() ===
        "content-security-policy"
    ) {
      removed.add(element);
      return;
    }
    element.attrs = element.attrs.filter(
      (attr) =>
        !(
          attr.name === "loading" && attr.value.trim().toLowerCase() === "lazy"
        ),
    );
  });
  const parents = new Set<ParentNode>();
  for (const node of removed) {
    const parent = (node as Element).parentNode;
    if (parent) parents.add(parent);
  }
  for (const parent of parents) {
    parent.childNodes = parent.childNodes.filter(
      (child) => !removed.has(child),
    );
  }
}

/** Visits every node, `<template>` contents included; safe to remove the visited node. */
function walk(root: ParentNode, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    visit(node);
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** A node's children, with a `<template>`'s contents first. */
function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  const content = (node as DefaultTreeAdapterTypes.Template).content;
  if (content) children.push(content);
  // A loop, not push(...childNodes): a spread passes every child as an
  // argument and overflows the stack on a few hundred thousand of them.
  if ("childNodes" in node)
    for (const child of node.childNodes) children.push(child);
  return children;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function relTokens(element: Element): string[] {
  return (attribute(element, "rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
}

function textContent(element: Element): string {
  return element.childNodes
    .map((child) =>
      child.nodeName === "#text"
        ? (child as DefaultTreeAdapterTypes.TextNode).value
        : "",
    )
    .join("");
}

/** `<!DOCTYPE html PUBLIC …>` → `html PUBLIC …`, what the serializer wraps. */
function doctypeBody(original: string): string {
  return original.replace(/^<!doctype[\t\n\f\r ]*/i, "").replace(/>$/, "");
}

function isJavascriptUrl(value: string): boolean {
  // The URL spec strips leading C0 controls and spaces, and tabs and newlines
  // anywhere, before reading the scheme. Only the scheme's characters are
  // read, so a megabyte-long attribute is not copied.
  const scheme = "javascript:";
  let at = 0;
  while (at < value.length && value.charCodeAt(at) <= 0x20) at++;
  let matched = 0;
  for (; at < value.length && matched < scheme.length; at++) {
    const code = value.charCodeAt(at);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== scheme.charCodeAt(matched)) return false;
    matched++;
  }
  return matched === scheme.length;
}

/** True when a file's first bytes are an SVG document's (linear scan). */
function looksLikeSvg(data: Uint8Array): boolean {
  const text = Buffer.from(
    data.buffer,
    data.byteOffset,
    Math.min(data.byteLength, 4096),
  ).toString("latin1");
  let at = text.startsWith("\u00EF\u00BB\u00BF") ? 3 : 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    const rest = text.slice(at, at + 9).toLowerCase();
    let end = -1;
    if (rest.startsWith("<!--")) end = text.indexOf("-->", at + 4) + 3;
    else if (rest.startsWith("<?xml")) end = text.indexOf("?>", at + 5) + 2;
    else if (rest.startsWith("<!doctype")) {
      // A doctype's internal subset ("[...]") may itself contain ">".
      const open = text.indexOf("[", at + 9);
      const close = text.indexOf(">", at + 9);
      end =
        open !== -1 && open < close
          ? text.indexOf(">", text.indexOf("]", open) + 1) + 1
          : close + 1;
    } else break;
    if (end <= at) return false;
    at = end;
  }
  return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/i.test(text.slice(at, at + 64));
}

function decodeUtf8(
  data: Uint8Array,
  path: string,
  code: HtmlRejectCode,
): string {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(data);
    return text;
  } catch {
    reject(
      code,
      `"${displayName(path)}" is not valid UTF-8; save it as UTF-8 and upload it again.`,
    );
  }
}

function rejectMarkers(text: string, path: string): void {
  if (MARKER_CHARS.test(text)) {
    reject(
      "MARKER_COLLISION",
      `"${displayName(path)}" contains the characters ⟦ or ⟧, which CV Clanker reserves; remove them.`,
    );
  }
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED
    ? `${shown}, and ${items.length - MAX_LISTED} more.`
    : `${shown}.`;
}

function reject(code: HtmlRejectCode, message: string): never {
  throw new HtmlRejectError(message, code);
}
