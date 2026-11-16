import {
  type Element,
  isInsideLink,
  type Node,
  PageTooComplexError,
  type ParentNode,
  type ParsedPage,
  parseFragmentBounded,
  parsePage,
  serializePage,
  type TextNode,
  walk,
} from "./html-tree";
import { checkMarkup, type MarkupRefusal, markupUsage } from "./inline-markup";
import { tailorableTextNodes } from "./page-text";

// One render of an HTML-CV template: each ⟦id⟧ marker replaced by its value,
// parsed as markup where the marker sits, and the page serialised once. Every
// value must pass the value check against what the CV's own defaults use, in
// its marker's link context. The result must read back to itself.
//
// Failures of the template or the values come back as values: a per-job
// render must report { success: false } rather than throw. Anything else
// thrown is a bug, or a RangeError from a stack or allocation limit;
// renderHtmlPage (html-worker.ts) reports either as a value.

export type RenderPageErrorCode =
  | "MISSING_VALUE"
  | "VALUE_NOT_ALLOWED"
  | "MARKER_NOT_TAILORABLE"
  | "TEMPLATE_INVALID"
  | "PAGE_TOO_COMPLEX"
  | "UNSTABLE_RENDER";

export interface RenderPageFailure {
  ok: false;
  code: RenderPageErrorCode;
  fieldId?: string;
  /** Why the value was refused (VALUE_NOT_ALLOWED). */
  reason?: MarkupRefusal;
  message: string;
}

export type RenderPageResult =
  | {
      ok: true;
      html: string;
      /** `html` as parsed again by the round trip. */
      page: ParsedPage;
    }
  | RenderPageFailure;

const MARKER = /⟦([A-Za-z0-9_.-]+)⟧/g;
const MARKER_CHARS = /[⟦⟧]/;

const REUPLOAD =
  "the stored CV template is damaged; upload the CV again to rebuild it.";

/**
 * Renders `templatedHtml` with each field's value: its override when there is
 * one, else its default. Values are checked against the markup the defaults
 * use (never the overrides, which would vouch for themselves). Overrides for
 * fields the template has no marker for are ignored.
 */
export function renderPage(
  templatedHtml: string,
  defaults: ReadonlyMap<string, string>,
  overrides: ReadonlyMap<string, string>,
): RenderPageResult {
  // A template is the checked page with spans replaced by markers, so it is
  // within the caps unless storage is damaged.
  const parsed = parseBounded(
    templatedHtml,
    "TEMPLATE_INVALID",
    (problem) => `The CV template has ${problem}: ${REUPLOAD}`,
  );
  if (!parsed.ok) return parsed;
  const page = parsed.page;
  const usage = markupUsage(defaults.values());
  const tailorable = tailorableTextNodes(page.document);

  const substitutions: { node: TextNode; replacement: Node[] }[] = [];
  let failure: RenderPageFailure | undefined;
  walk(page.document, (node) => {
    if (failure || node.nodeName !== "#text") return;
    const text = node as TextNode;
    const parent = text.parentNode as ParentNode;
    const replacement: Node[] = [];
    let last = 0;
    for (const match of text.value.matchAll(MARKER)) {
      const fieldId = match[1];
      if (!tailorable.has(text)) {
        failure = fail(
          "MARKER_NOT_TAILORABLE",
          `Field "${fieldId}" sits where text cannot be replaced; ${REUPLOAD}`,
          fieldId,
        );
        return;
      }
      const value = overrides.get(fieldId) ?? defaults.get(fieldId);
      if (value === undefined) {
        failure = fail(
          "MISSING_VALUE",
          `Field "${fieldId}" has no value.`,
          fieldId,
        );
        return;
      }
      const check = checkMarkup(value, {
        usage,
        insideLink: isInsideLink(parent),
      });
      if (!check.ok) {
        failure = {
          ...fail(
            "VALUE_NOT_ALLOWED",
            `Field "${fieldId}": the value ${check.message}.`,
            fieldId,
          ),
          reason: check.reason,
        };
        return;
      }
      const nodes = parseValue(parent, value);
      if (!nodes.ok) {
        failure = { ...nodes, fieldId };
        return;
      }
      pushText(replacement, text.value.slice(last, match.index), parent);
      for (const valueNode of nodes.nodes) {
        (valueNode as { parentNode: ParentNode | null }).parentNode = parent;
        replacement.push(valueNode);
      }
      last = match.index + match[0].length;
    }
    if (last === 0) return;
    pushText(replacement, text.value.slice(last), parent);
    substitutions.push({ node: text, replacement });
  });
  if (failure) return failure;

  for (const { node, replacement } of substitutions) {
    const parent = node.parentNode as ParentNode;
    const at = parent.childNodes.indexOf(node);
    parent.childNodes.splice(
      at,
      1,
      ...(replacement as typeof parent.childNodes),
    );
  }

  const html = serializePage(page);
  // Every well-formed marker in tailorable text is gone and no value can
  // hold ⟦ or ⟧, and the page the template came from held neither — so any
  // left is a marker outside tailorable text (an attribute, a comment) or a
  // malformed one.
  if (MARKER_CHARS.test(html)) {
    return fail(
      "TEMPLATE_INVALID",
      `The CV could not be rendered: ${REUPLOAD}`,
    );
  }

  const reparsed = parseBounded(
    html,
    "PAGE_TOO_COMPLEX",
    (problem) => `The rendered CV has ${problem}; shorten the tailored values.`,
  );
  if (!reparsed.ok) return reparsed;
  if (serializePage(reparsed.page) !== html) {
    return fail(
      "UNSTABLE_RENDER",
      "The rendered CV does not read back the same way; simplify the formatting in the tailored values.",
    );
  }
  return { ok: true, html, page: reparsed.page };
}

function parseBounded(
  html: string,
  code: RenderPageErrorCode,
  message: (problem: string) => string,
): { ok: true; page: ParsedPage } | RenderPageFailure {
  try {
    return { ok: true, page: parsePage(html) };
  } catch (error) {
    if (!(error instanceof PageTooComplexError)) throw error;
    return fail(code, message(error.message));
  }
}

function parseValue(
  parent: ParentNode,
  value: string,
): { ok: true; nodes: Node[] } | RenderPageFailure {
  try {
    return { ok: true, nodes: parseFragmentBounded(parent as Element, value) };
  } catch (error) {
    if (!(error instanceof PageTooComplexError)) throw error;
    return fail(
      "PAGE_TOO_COMPLEX",
      `A tailored value has ${error.message}; shorten it.`,
    );
  }
}

function pushText(nodes: Node[], value: string, parent: ParentNode): void {
  const text: TextNode = { nodeName: "#text", value, parentNode: parent };
  nodes.push(text);
}

function fail(
  code: RenderPageErrorCode,
  message: string,
  fieldId?: string,
): RenderPageFailure {
  return fieldId === undefined
    ? { ok: false, code, message }
    : { ok: false, code, fieldId, message };
}
