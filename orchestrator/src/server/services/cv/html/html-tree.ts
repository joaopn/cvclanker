import {
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  defaultTreeAdapter,
  parse,
  parseFragment,
  serialize,
  serializeOuter,
  type TreeAdapter,
} from "parse5";

// Parsing and serialising an HTML-CV page the same way everywhere: the upload
// check, splicing, and every per-job render. Bounded (elements, nesting), the
// original doctype kept, and a page that reads back to itself.

export type Node = DefaultTreeAdapterTypes.Node;
export type Element = DefaultTreeAdapterTypes.Element;
export type ParentNode = DefaultTreeAdapterTypes.ParentNode;
export type TextNode = DefaultTreeAdapterTypes.TextNode;
export type DocumentType = DefaultTreeAdapterTypes.DocumentType;

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";

// Chromium's HTML parser stops nesting at 512 open elements; deeper markup is
// rebuilt differently from what parse5 builds (and parse5's serializer
// recurses, so far deeper nesting overflows the stack).
export const MAX_DEPTH = 512;

// A CV page has a few hundred elements. Without a cap, 21 KB of markup built
// a million elements (formatting elements are rebuilt per block), and parse
// cost grows with elements × depth. Parsing cost that remains after both caps
// (text and end tags searching the open-element stack, and more) is bounded
// by running the parse in a worker with a deadline (html-worker.ts) — so
// every parse of a stored page must run in that worker too.
export const MAX_ELEMENTS = 10_000;

/** A page past MAX_ELEMENTS or MAX_DEPTH; callers word it for their context. */
export class PageTooComplexError extends Error {
  readonly code: "TOO_MANY_ELEMENTS" | "NESTING_TOO_DEEP";
  constructor(code: "TOO_MANY_ELEMENTS" | "NESTING_TOO_DEEP") {
    super(
      code === "TOO_MANY_ELEMENTS"
        ? `more than ${MAX_ELEMENTS} elements`
        : `elements nested more than ${MAX_DEPTH} deep`,
    );
    this.name = "PageTooComplexError";
    this.code = code;
  }
}

export interface ParsedPage {
  document: DefaultTreeAdapterTypes.Document;
  /** Each doctype's original text, so serialising keeps it verbatim. */
  doctypes: Map<DocumentType, string>;
}

/** Parses a page with the element and depth caps; throws PageTooComplexError. */
export function parsePage(text: string): ParsedPage {
  const document = parse(text, {
    scriptingEnabled: false,
    sourceCodeLocationInfo: true,
    treeAdapter: boundedTreeAdapter(),
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
 * Parses markup as the children of `context`, as the browser would read it
 * there, with the element and depth caps (counted for this fragment alone);
 * throws PageTooComplexError. The returned nodes still have the fragment as
 * their parent.
 */
export function parseFragmentBounded(context: Element, markup: string): Node[] {
  return parseFragment(context, markup, {
    scriptingEnabled: false,
    treeAdapter: boundedTreeAdapter(),
  }).childNodes;
}

/** Serialises a page with its original doctype, reading back to itself. */
export function serializePage(page: ParsedPage): string {
  return serialize(page.document, {
    // As it was parsed: <noscript> content is markup, escaped like any other.
    scriptingEnabled: false,
    treeAdapter: serializingAdapter(page),
  });
}

/** Serialises nodes in place (their parent decides the escaping). */
export function serializeNodes(nodes: Node[]): string {
  const treeAdapter = serializingAdapter(undefined);
  return nodes
    .map((node) =>
      serializeOuter(node as Element, { scriptingEnabled: false, treeAdapter }),
    )
    .join("");
}

/**
 * parse5's default tree adapter, counting the elements it creates and the
 * depth of its open-element stack as it parses, so markup that would build a
 * vast tree or nest past Chromium's limit is refused before it is built.
 * (Counting tags in the source is not enough: "</br>" and "</p>" create
 * elements, and formatting elements are rebuilt for every block they span.)
 */
function boundedTreeAdapter(): TreeAdapter<DefaultTreeAdapterMap> {
  let elements = 0;
  let depth = 0;
  return {
    ...defaultTreeAdapter,
    createElement: (tagName, namespaceURI, attrs) => {
      elements++;
      if (elements > MAX_ELEMENTS) {
        throw new PageTooComplexError("TOO_MANY_ELEMENTS");
      }
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    onItemPush: () => {
      depth++;
      if (depth > MAX_DEPTH) throw new PageTooComplexError("NESTING_TOO_DEEP");
    },
    onItemPop: () => {
      depth--;
    },
  };
}

/**
 * The adapter the serializer reads through: the original doctype text, and
 * the newline the parser drops right after <pre>, <textarea> and <listing>
 * written back when their content starts with one — parse5's serializer does
 * not, so without it such a page would change on every parse. Reading, not
 * mutating, so a tree can be serialised any number of times.
 */
function serializingAdapter(
  page: ParsedPage | undefined,
): TreeAdapter<DefaultTreeAdapterMap> {
  return {
    ...defaultTreeAdapter,
    getDocumentTypeNodeName: (node: DocumentType) => {
      const original = page?.doctypes.get(node);
      return original === undefined
        ? defaultTreeAdapter.getDocumentTypeNodeName(node)
        : doctypeBody(original);
    },
    getTextNodeContent: (node: TextNode) => {
      const parent = node.parentNode as Element | null;
      if (
        parent &&
        "tagName" in parent &&
        parent.namespaceURI === HTML_NS &&
        (parent.tagName === "pre" ||
          parent.tagName === "textarea" ||
          parent.tagName === "listing") &&
        parent.childNodes[0] === node &&
        node.value.startsWith("\n")
      ) {
        return `\n${node.value}`;
      }
      return node.value;
    },
  };
}

/** `<!DOCTYPE html PUBLIC …>` → `html PUBLIC …`, what the serializer wraps. */
function doctypeBody(original: string): string {
  return original.replace(/^<!doctype[\t\n\f\r ]*/i, "").replace(/>$/, "");
}

/** Visits every node, `<template>` contents included; safe to remove the visited node. */
export function walk(root: ParentNode, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    visit(node);
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** A node's children, with a `<template>`'s contents first. */
export function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  const content = (node as DefaultTreeAdapterTypes.Template).content;
  if (content) children.push(content);
  // A loop, not push(...childNodes): a spread passes every child as an
  // argument and overflows the stack on a few hundred thousand of them.
  if ("childNodes" in node) {
    for (const child of node.childNodes) children.push(child);
  }
  return children;
}

export function isElement(node: Node): node is Element {
  return "tagName" in node;
}

/** The node and its ancestors, innermost first. */
export function ancestorsOf(node: Node): Node[] {
  const chain: Node[] = [];
  let current: Node | null = node;
  while (current) {
    chain.push(current);
    current =
      (current as { parentNode?: ParentNode | null }).parentNode ?? null;
  }
  return chain;
}

/** True when `node` is an HTML `<a>` or sits inside one. */
export function isInsideLink(node: Node): boolean {
  for (const ancestor of ancestorsOf(node)) {
    if (
      isElement(ancestor) &&
      ancestor.namespaceURI === HTML_NS &&
      ancestor.tagName === "a"
    ) {
      return true;
    }
  }
  return false;
}

export function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

/** True when `value`, read as a URL, has the javascript: scheme. */
export function isJavascriptUrl(value: string): boolean {
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
