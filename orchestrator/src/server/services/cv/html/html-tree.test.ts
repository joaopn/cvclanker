// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type Element,
  MAX_DEPTH,
  MAX_ELEMENTS,
  PageTooComplexError,
  parsePage,
  serializeNodes,
  serializePage,
  type TextNode,
} from "./html-tree";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PageTooComplexError);
    return (error as PageTooComplexError).code;
  }
  return "ok";
}

describe("serializePage", () => {
  it("writes back the newline the parser drops after <pre>, <textarea> and <listing>, without changing the tree", () => {
    const text =
      "<!DOCTYPE html><html><head></head><body><pre>\n\ncode</pre><textarea>\n\nx</textarea><listing>\n\nl</listing><pre>\nkept</pre></body></html>";
    const page = parsePage(text);
    const first = serializePage(page);
    expect(first).toBe(text.replace("<pre>\nkept", "<pre>kept"));
    expect(serializePage(page)).toBe(first);
    expect(serializePage(parsePage(first))).toBe(first);
    const pre = (page.document.childNodes[1] as Element)
      .childNodes[1] as Element;
    expect(
      ((pre.childNodes[0] as Element).childNodes[0] as TextNode).value,
    ).toBe("\ncode");
  });

  it("parses and serialises with scripting off, so <noscript> holds markup", () => {
    const text =
      "<!DOCTYPE html><html><head></head><body><noscript>&lt;i&gt;<i>c</i></noscript></body></html>";
    const page = parsePage(text);
    const body = (page.document.childNodes[1] as Element)
      .childNodes[1] as Element;
    const noscript = body.childNodes[0] as Element;
    expect(noscript.childNodes.map((node) => node.nodeName)).toEqual([
      "#text",
      "i",
    ]);
    expect(serializePage(page)).toBe(text);
  });

  it("writes no newline back where the parser dropped none", () => {
    // A later text node in <pre>, and an SVG element named textarea (not
    // HTML's, so the parser keeps its newline).
    const text =
      "<!DOCTYPE html><html><head></head><body><pre><b>x</b>\ny</pre><svg><textarea>\nz</textarea></svg></body></html>";
    expect(serializePage(parsePage(text))).toBe(text);
  });

  it("keeps the original doctype", () => {
    const legacy =
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">';
    expect(serializePage(parsePage(`${legacy}<p>x</p>`))).toBe(
      `${legacy}<html><head></head><body><p>x</p></body></html>`,
    );
  });
});

describe("serializeNodes", () => {
  it("escapes text by its parent, as the page does", () => {
    const page = parsePage("<style>a&b</style><p>a &amp; b</p>");
    const html = page.document.childNodes[0] as Element;
    const [head, body] = html.childNodes as Element[];
    const p = body.childNodes[0] as Element;
    const style = head.childNodes[0] as Element;
    expect(serializeNodes([p])).toBe("<p>a &amp; b</p>");
    expect(serializeNodes(p.childNodes)).toBe("a &amp; b");
    expect(serializeNodes(style.childNodes)).toBe("a&b");
    // Scripting off, as parsed: <noscript> content is markup, escaped.
    const html2 = parsePage("<p><noscript>&lt;i&gt;<i>c</i></noscript></p>")
      .document.childNodes[0] as Element;
    const noscript = ((html2.childNodes[1] as Element).childNodes[0] as Element)
      .childNodes[0] as Element;
    expect(serializeNodes([noscript])).toBe(
      "<noscript>&lt;i&gt;<i>c</i></noscript>",
    );
  });
});

describe("the parse caps", () => {
  it("refuses pages past the element and depth caps", () => {
    expect(codeOf(() => parsePage("<b>x</b>".repeat(MAX_ELEMENTS)))).toBe(
      "TOO_MANY_ELEMENTS",
    );
    expect(codeOf(() => parsePage("<b>x</b>".repeat(MAX_ELEMENTS - 10)))).toBe(
      "ok",
    );
    expect(codeOf(() => parsePage("<span>".repeat(MAX_DEPTH)))).toBe(
      "NESTING_TOO_DEEP",
    );
    expect(codeOf(() => parsePage("<span>".repeat(MAX_DEPTH - 10)))).toBe("ok");
  });
});
