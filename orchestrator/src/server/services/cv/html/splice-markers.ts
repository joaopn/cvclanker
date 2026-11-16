import {
  ancestorsOf,
  childrenOf,
  isInsideLink,
  type Node,
  type ParentNode,
  type ParsedPage,
  serializeNodes,
  serializePage,
  type TextNode,
  walk,
} from "./html-tree";
import {
  checkMarkup,
  FULL_ALLOWLIST,
  type MarkupRefusal,
} from "./inline-markup";
import { isCollapsibleSpace, type PageSegment, segmentsOf } from "./page-text";

// Turns the LLM's field spans into ⟦id⟧ markers in the page. The LLM names
// each span by its text within a segment; the server finds it in the tree,
// widens it to whole elements where it starts or ends at an element's edge,
// and checks the markup it covers. That markup, byte for byte, is the field's
// default, so substituting the defaults reproduces the page exactly.
//
// Each failure is a typed SpliceError the upload's retry loop feeds back to
// the LLM.

export interface HtmlFieldSpan {
  id: string;
  value: string;
  segmentId: number;
}

export type SpliceErrorCode =
  | "FIELD_ID_INVALID"
  | "DUPLICATE_FIELD_ID"
  | "SPAN_NOT_FOUND"
  | "SPAN_AMBIGUOUS"
  | "OVERLAPPING_SPANS"
  | "SPAN_SPLITS_ELEMENT"
  | "SPAN_MARKUP_NOT_ALLOWED";

export class SpliceError extends Error {
  readonly code: SpliceErrorCode;
  readonly fieldId: string;
  /** Why the covered markup was refused (SPAN_MARKUP_NOT_ALLOWED). */
  readonly reason: MarkupRefusal | undefined;
  constructor(
    message: string,
    code: SpliceErrorCode,
    fieldId: string,
    reason?: MarkupRefusal,
  ) {
    super(message);
    this.name = "SpliceError";
    this.code = code;
    this.fieldId = fieldId;
    this.reason = reason;
  }
}

export interface SplicedPage {
  templatedHtml: string;
  /** Each field's default: the markup its span covered, byte for byte. */
  defaults: Map<string, string>;
  /** The fields whose marker sits inside an `<a>` (their values cannot hold one). */
  insideLinks: string[];
}

// Dotted, like the LaTeX and Word extractors' ids (`experience.0.bullet.2`).
const FIELD_ID = /^[A-Za-z0-9_.-]+$/;

/**
 * One end of a field's range, as a child of the range's parent: inside a
 * text node at `offset`, or (offset null) at the node's edge — before it for
 * a start, after it for an end.
 */
interface Boundary {
  node: Node;
  offset: number | null;
}

interface FieldRange {
  field: HtmlFieldSpan;
  parent: ParentNode;
  start: Boundary;
  end: Boundary;
  /** Document-order keys of the two ends, for the overlap check and ordering. */
  startKey: [number, number];
  endKey: [number, number];
}

/**
 * Splices a marker for every field into `page` (which it modifies) and
 * returns the templated page. All fields are checked before any is spliced.
 */
export function spliceMarkers(
  page: ParsedPage,
  fields: readonly HtmlFieldSpan[],
): SplicedPage {
  const segments = segmentsOf(page.document);
  const order = documentOrder(page.document);
  const ids = new Set<string>();
  const ranges: FieldRange[] = [];
  for (const field of fields) {
    if (!FIELD_ID.test(field.id)) {
      throw new SpliceError(
        `Field id ${JSON.stringify(field.id)} is invalid: use only ASCII letters and digits, ".", "_" and "-".`,
        "FIELD_ID_INVALID",
        field.id,
      );
    }
    if (ids.has(field.id)) {
      throw new SpliceError(
        `Field id "${field.id}" is used more than once; give each field its own id.`,
        "DUPLICATE_FIELD_ID",
        field.id,
      );
    }
    ids.add(field.id);
    ranges.push(locate(field, segments, order));
  }

  const sorted = [...ranges].sort((a, b) =>
    compareKeys(a.startKey, b.startKey),
  );
  for (let i = 1; i < sorted.length; i++) {
    if (compareKeys(sorted[i].startKey, sorted[i - 1].endKey) < 0) {
      throw new SpliceError(
        `Fields "${sorted[i - 1].field.id}" and "${sorted[i].field.id}" overlap; choose spans that do not share text or elements.`,
        "OVERLAPPING_SPANS",
        sorted[i].field.id,
      );
    }
  }

  const defaults = new Map<string, string>();
  const insideLinks: string[] = [];
  for (const range of ranges) {
    const insideLink = isInsideLink(range.parent);
    const markup = coveredMarkup(range);
    const check = checkMarkup(markup, { usage: FULL_ALLOWLIST, insideLink });
    if (!check.ok) {
      throw new SpliceError(
        `Field "${range.field.id}": the span's markup ${check.message}; choose a narrower span that covers only text and simple inline formatting.`,
        "SPAN_MARKUP_NOT_ALLOWED",
        range.field.id,
        check.reason,
      );
    }
    defaults.set(range.field.id, markup);
    if (insideLink) insideLinks.push(range.field.id);
  }

  // Last first, so every earlier range's nodes and offsets stay valid.
  for (let i = sorted.length - 1; i >= 0; i--) spliceOne(sorted[i]);
  return { templatedHtml: serializePage(page), defaults, insideLinks };
}

function locate(
  field: HtmlFieldSpan,
  segments: PageSegment[],
  order: Map<Node, [number, number]>,
): FieldRange {
  const segment = segments[field.segmentId];
  if (!segment) {
    throw new SpliceError(
      `Field "${field.id}" references unknown segment ${field.segmentId}.`,
      "SPAN_NOT_FOUND",
      field.id,
    );
  }
  if (field.value.length === 0) {
    throw new SpliceError(
      `Field "${field.id}" has an empty value.`,
      "SPAN_NOT_FOUND",
      field.id,
    );
  }
  const first = segment.text.indexOf(field.value);
  if (first === -1) {
    throw new SpliceError(
      `Field "${field.id}": value not found in segment ${field.segmentId}. The value must be a verbatim substring of the segment text.`,
      "SPAN_NOT_FOUND",
      field.id,
    );
  }
  if (segment.text.indexOf(field.value, first + 1) !== -1) {
    throw new SpliceError(
      `Field "${field.id}": value occurs more than once in segment ${field.segmentId}. Choose a longer, unambiguous span.`,
      "SPAN_AMBIGUOUS",
      field.id,
    );
  }
  const from = segment.positions[first];
  const to = segment.positions[first + field.value.length - 1];
  const fromAncestors = ancestorsOf(from.node);
  const toAncestors = new Set(ancestorsOf(to.node));
  const common = fromAncestors.findIndex((node) => toAncestors.has(node));
  const splits = () =>
    new SpliceError(
      `Field "${field.id}": the span starts or ends inside a formatted element (bold, a link, …) without covering all of its text; choose a span that covers the element's whole text or stays inside it.`,
      "SPAN_SPLITS_ELEMENT",
      field.id,
    );

  let parent: ParentNode;
  let start: Boundary;
  let end: Boundary;
  if (common === 0) {
    // Both ends in one text node.
    parent = from.node.parentNode as ParentNode;
    start = { node: from.node, offset: from.offset };
    end = { node: to.node, offset: to.offset + 1 };
  } else {
    parent = fromAncestors[common] as ParentNode;
    const startChild = fromAncestors[common - 1];
    const toChain = ancestorsOf(to.node);
    const endChild = toChain[toChain.indexOf(parent) - 1];
    if (startChild === from.node) {
      start = { node: from.node, offset: from.offset };
    } else if (onlySpaceBefore(startChild, from.node, from.offset)) {
      start = { node: startChild, offset: null };
    } else {
      throw splits();
    }
    if (endChild === to.node) {
      end = { node: to.node, offset: to.offset + 1 };
    } else if (onlySpaceAfter(endChild, to.node, to.offset + 1)) {
      end = { node: endChild, offset: null };
    } else {
      throw splits();
    }
  }
  return {
    field,
    parent,
    start,
    end,
    startKey: boundaryKey(start, "start", order),
    endKey: boundaryKey(end, "end", order),
  };
}

/** True when every character of `element`'s text before (node, offset) is whitespace. */
function onlySpaceBefore(
  element: Node,
  node: TextNode,
  offset: number,
): boolean {
  for (const text of textNodesOf(element)) {
    if (text === node) return isSpace(node.value, 0, offset);
    if (!isSpace(text.value, 0, text.value.length)) return false;
  }
  return false;
}

/** True when every character of `element`'s text from (node, offset) on is whitespace. */
function onlySpaceAfter(
  element: Node,
  node: TextNode,
  offset: number,
): boolean {
  const texts = textNodesOf(element);
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i];
    if (text === node) return isSpace(node.value, offset, node.value.length);
    if (!isSpace(text.value, 0, text.value.length)) return false;
  }
  return false;
}

function textNodesOf(element: Node): TextNode[] {
  const texts: TextNode[] = [];
  walk(element as ParentNode, (node) => {
    if (node.nodeName === "#text") texts.push(node as TextNode);
  });
  return texts;
}

function isSpace(value: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (!isCollapsibleSpace(value.charCodeAt(i))) return false;
  }
  return true;
}

/** Each node's position on entering and leaving it, in document order. */
function documentOrder(root: ParentNode): Map<Node, [number, number]> {
  const order = new Map<Node, [number, number]>();
  let counter = 0;
  const stack: { node: Node; leaving: boolean }[] = [
    { node: root, leaving: false },
  ];
  while (stack.length > 0) {
    const { node, leaving } = stack.pop() as { node: Node; leaving: boolean };
    if (leaving) {
      (order.get(node) as [number, number])[1] = counter++;
      continue;
    }
    order.set(node, [counter++, 0]);
    stack.push({ node, leaving: true });
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], leaving: false });
    }
  }
  return order;
}

function boundaryKey(
  boundary: Boundary,
  side: "start" | "end",
  order: Map<Node, [number, number]>,
): [number, number] {
  const [entered, left] = order.get(boundary.node) as [number, number];
  if (boundary.offset !== null) return [entered, boundary.offset];
  return side === "start" ? [entered, 0] : [left, 0];
}

function compareKeys(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** The markup a range covers, serialised in place (its parent decides the escaping). */
function coveredMarkup(range: FieldRange): string {
  const { parent, start, end } = range;
  const children = parent.childNodes;
  const first = children.indexOf(start.node as never);
  const last = children.indexOf(end.node as never);
  const nodes: Node[] = [];
  for (let i = first; i <= last; i++) {
    const node = children[i];
    const from = i === first ? start.offset : null;
    const to = i === last ? end.offset : null;
    if (from === null && to === null) {
      nodes.push(node);
    } else {
      const value = (node as TextNode).value;
      nodes.push(textNode(value.slice(from ?? 0, to ?? value.length), parent));
    }
  }
  return serializeNodes(nodes);
}

function spliceOne(range: FieldRange): void {
  const { parent, start, end } = range;
  const children = parent.childNodes;
  const first = children.indexOf(start.node as never);
  const last = children.indexOf(end.node as never);
  const replacement: Node[] = [];
  let suffix: TextNode | undefined;
  if (end.offset !== null) {
    const node = end.node as TextNode;
    if (node === start.node) {
      suffix = textNode(node.value.slice(end.offset), parent);
    } else {
      node.value = node.value.slice(end.offset);
      suffix = node;
    }
  }
  if (start.offset !== null) {
    const node = start.node as TextNode;
    node.value = node.value.slice(0, start.offset);
    replacement.push(node);
  }
  replacement.push(textNode(`⟦${range.field.id}⟧`, parent));
  if (suffix) replacement.push(suffix);
  parent.childNodes = [
    ...children.slice(0, first),
    ...replacement,
    ...children.slice(last + 1),
  ] as typeof children;
}

function textNode(value: string, parent: ParentNode): TextNode {
  return { nodeName: "#text", value, parentNode: parent };
}
