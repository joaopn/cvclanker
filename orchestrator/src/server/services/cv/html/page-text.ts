import {
  attribute,
  childrenOf,
  type Element,
  HTML_NS,
  isElement,
  type Node,
  type ParentNode,
  type TextNode,
} from "./html-tree";

// The text of an HTML-CV page: exactly (visibleText, which tests compare),
// and as segments — one per run of inline content between block boundaries,
// whitespace collapsed — the text the LLM picks field spans from.

// Text never offered for tailoring, all of it kept in the page byte for byte:
// text no marker can sit in (raw-text and RCDATA elements, and inline SVG and
// MathML — any element outside the HTML namespace, skipped in traverse); the
// head and template contents; <noscript>, which the upload refuses; and text
// Chromium does not print by default (measured with scripting off): audio
// and video fallback, datalist options, progress and meter content, ruby
// parentheses, and — skipped in traverse — a dialog that is not open and any
// element with the hidden attribute. Where page CSS (or an inline element's
// hidden="until-found") gets such text printed after all, it is still not
// offered, and a span over its element is refused. A canvas's fallback
// content is printed, so it is not skipped.

const SKIPPED = new Set([
  "audio",
  "datalist",
  "head",
  "iframe",
  "meter",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "progress",
  "rp",
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "video",
  "xmp",
]);

// Whitespace-significant: a segment shows collapsed text, so a value tailored
// from it could not keep the layout. Kept byte for byte, never tailored.
const NOT_TAILORABLE = new Set(["listing", "pre"]);

// HTML's block-level elements, plus the elements that end a line: a segment
// never spans one of these boundaries, except where traverse treats the
// element as having no box (a closed dialog, or hidden other than
// until-found).
// (A table's row and column groups hold no text of their own outside a row,
// so the rows and cells suffice.)
const SEGMENT_BREAKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "legend",
  "li",
  "listing",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
  "xmp",
]);

/** HTML whitespace and U+00A0: what a segment collapses to one space. */
export function isCollapsibleSpace(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0xa0
  );
}

/** Every text node's value in document order, minus the skipped elements. */
export function visibleText(root: ParentNode): string {
  const parts: string[] = [];
  traverse(root, false, {
    text: (node) => parts.push(node.value),
    boundary: () => {},
  });
  return parts.join("");
}

/** Where a segment character comes from. */
export interface TextPosition {
  node: TextNode;
  offset: number;
}

export interface PageSegment {
  segmentId: number;
  /** Whitespace runs collapsed to one space, trimmed. */
  text: string;
  /** For each character of `text`: its text node and offset (a collapsed space: its run's first character). */
  positions: TextPosition[];
}

/** The page's segments, in document order, empty ones dropped. */
export function segmentsOf(root: ParentNode): PageSegment[] {
  const segments: PageSegment[] = [];
  let text = "";
  let positions: TextPosition[] = [];
  let pendingSpace: TextPosition | null = null;
  const flush = () => {
    if (text.length > 0) {
      segments.push({ segmentId: segments.length, text, positions });
    }
    text = "";
    positions = [];
    pendingSpace = null;
  };
  traverse(root, true, {
    text: (node) => {
      const value = node.value;
      for (let offset = 0; offset < value.length; offset++) {
        if (isCollapsibleSpace(value.charCodeAt(offset))) {
          pendingSpace ??= { node, offset };
          continue;
        }
        if (pendingSpace) {
          if (text.length > 0) {
            text += " ";
            positions.push(pendingSpace);
          }
          pendingSpace = null;
        }
        text += value[offset];
        positions.push({ node, offset });
      }
    },
    boundary: flush,
  });
  flush();
  return segments;
}

/** The text nodes segmentsOf reads: the only places a field's marker may sit. */
export function tailorableTextNodes(root: ParentNode): Set<TextNode> {
  const nodes = new Set<TextNode>();
  traverse(root, true, {
    text: (node) => nodes.add(node),
    boundary: () => {},
  });
  return nodes;
}

interface TextVisitor {
  text(node: TextNode): void;
  /** A segment boundary: entering or leaving a block, or a line break. */
  boundary(): void;
}

const EXIT = Symbol("exit");

function traverse(
  root: ParentNode,
  segments: boolean,
  visitor: TextVisitor,
): void {
  const stack: (Node | typeof EXIT)[] = [root];
  while (stack.length > 0) {
    const item = stack.pop() as Node | typeof EXIT;
    if (item === EXIT) {
      visitor.boundary();
      continue;
    }
    if (item.nodeName === "#text") {
      visitor.text(item as TextNode);
      continue;
    }
    let breaks = false;
    if (isElement(item)) {
      const element = item as Element;
      const html = element.namespaceURI === HTML_NS;
      const hidden = attribute(element, "hidden");
      // hidden="until-found" keeps the element's box, and so a block's line
      // break; any other hidden value, and a closed dialog, leave no box and
      // no line break — as Chromium's default styles render them. The content
      // is skipped either way, even an inline element's until-found content,
      // which Chromium prints.
      const untilFound = hidden?.toLowerCase() === "until-found";
      const notDisplayed =
        (hidden !== undefined && !untilFound) ||
        (element.tagName === "dialog" &&
          attribute(element, "open") === undefined);
      breaks = html && !notDisplayed && SEGMENT_BREAKS.has(element.tagName);
      if (breaks) visitor.boundary();
      if (
        !html ||
        notDisplayed ||
        untilFound ||
        SKIPPED.has(element.tagName) ||
        (segments && NOT_TAILORABLE.has(element.tagName))
      ) {
        continue;
      }
    }
    if (breaks) stack.push(EXIT);
    const children = childrenOf(item);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}
