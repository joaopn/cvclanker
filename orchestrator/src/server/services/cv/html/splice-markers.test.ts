// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parsePage, serializePage } from "./html-tree";
import { MAX_VALUE_CHARS } from "./inline-markup";
import {
  type HtmlFieldSpan,
  SpliceError,
  spliceMarkers,
} from "./splice-markers";

function html(body: string): string {
  return `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;
}

/** Splices, and checks that putting the defaults back gives the page again. */
function splice(body: string, fields: HtmlFieldSpan[]) {
  const page = parsePage(html(body));
  const original = serializePage(page);
  const result = spliceMarkers(page, fields);
  let restored = result.templatedHtml;
  for (const [id, markup] of result.defaults) {
    restored = restored.split(`⟦${id}⟧`).join(markup);
  }
  expect(restored).toBe(original);
  return {
    body: result.templatedHtml
      .replace(/^.*<body>/s, "")
      .replace(/<\/body>.*$/s, ""),
    defaults: Object.fromEntries(result.defaults),
    insideLinks: result.insideLinks,
  };
}

function spliceError(body: string, fields: HtmlFieldSpan[]) {
  const page = parsePage(html(body));
  const before = serializePage(page);
  try {
    spliceMarkers(page, fields);
  } catch (error) {
    expect(error).toBeInstanceOf(SpliceError);
    // Nothing is spliced when any field fails.
    expect(serializePage(page)).toBe(before);
    const { code, fieldId, reason } = error as SpliceError;
    return { code, fieldId, reason };
  }
  throw new Error("expected a SpliceError");
}

const f = (id: string, value: string, segmentId = 0): HtmlFieldSpan => ({
  id,
  value,
  segmentId,
});

describe("spliceMarkers", () => {
  it("replaces a span inside one text node", () => {
    expect(splice("<p>Built Kafka pipelines</p>", [f("f1", "Kafka")])).toEqual({
      body: "<p>Built ⟦f1⟧ pipelines</p>",
      defaults: { f1: "Kafka" },
      insideLinks: [],
    });
  });

  it("covers whole inline elements, keeping their markup as the default", () => {
    expect(
      splice("<p>Built <b>Kafka</b> pipelines</p>", [
        f("f1", "Built Kafka pipelines"),
      ]),
    ).toMatchObject({
      body: "<p>⟦f1⟧</p>",
      defaults: { f1: "Built <b>Kafka</b> pipelines" },
    });
    expect(
      splice("<p>Built <b>Kafka</b> pipelines</p>", [f("f1", "Built Kafka")]),
    ).toMatchObject({
      body: "<p>⟦f1⟧ pipelines</p>",
      defaults: { f1: "Built <b>Kafka</b>" },
    });
  });

  it("widens a span to an element's edge through nesting and whitespace", () => {
    expect(
      splice("<p><b><i>Kafka</i> x</b> y</p>", [f("f1", "Kafka x y")]),
    ).toMatchObject({
      body: "<p>⟦f1⟧</p>",
      defaults: { f1: "<b><i>Kafka</i> x</b> y" },
    });
    expect(
      splice('<p>See <a href="https://x.test/">\n  Project\n</a> now</p>', [
        f("f1", "See Project"),
      ]),
    ).toMatchObject({
      body: "<p>⟦f1⟧ now</p>",
      defaults: { f1: 'See <a href="https://x.test/">\n  Project\n</a>' },
      insideLinks: [],
    });
    expect(
      splice('<p><a href="#">\n  Project</a> page</p>', [
        f("f1", "Project page"),
      ]),
    ).toMatchObject({
      body: "<p>⟦f1⟧</p>",
      defaults: { f1: '<a href="#">\n  Project</a> page' },
    });
  });

  it("keeps a span inside a link inside it, and says so", () => {
    expect(
      splice('<li><a href="https://x.test/">\n  Project\n</a></li>', [
        f("f1", "Project"),
      ]),
    ).toEqual({
      body: '<li><a href="https://x.test/">\n  ⟦f1⟧\n</a></li>',
      defaults: { f1: "Project" },
      insideLinks: ["f1"],
    });
  });

  it("keeps the page's escaping in the default", () => {
    expect(
      splice("<p>R&amp;D &lt;x&gt; a&nbsp;b</p>", [f("f1", "R&D <x> a b")]),
    ).toMatchObject({ defaults: { f1: "R&amp;D &lt;x&gt; a&nbsp;b" } });
  });

  it("splices several fields in one text node and across elements", () => {
    const expected = {
      body: "<p>Built ⟦f1⟧ and ⟦f2⟧ pipelines</p>",
      defaults: { f1: "Kafka", f2: "Spark" },
    };
    const body = "<p>Built Kafka and Spark pipelines</p>";
    expect(splice(body, [f("f1", "Kafka"), f("f2", "Spark")])).toMatchObject(
      expected,
    );
    expect(splice(body, [f("f2", "Spark"), f("f1", "Kafka")])).toMatchObject(
      expected,
    );
    expect(
      splice("<p>KafkaSpark</p>", [f("f1", "Kafka"), f("f2", "Spark")]),
    ).toMatchObject({
      body: "<p>⟦f1⟧⟦f2⟧</p>",
      defaults: { f1: "Kafka", f2: "Spark" },
    });
    expect(
      splice("<p><b>Kafka</b> and <i>Spark</i></p><p>Later <b>x</b></p>", [
        f("f2", "and Spark"),
        f("f1", "Kafka"),
        f("f3", "Later x", 1),
      ]),
    ).toMatchObject({
      body: "<p><b>⟦f1⟧</b> ⟦f2⟧</p><p>⟦f3⟧</p>",
      defaults: { f1: "Kafka", f2: "and <i>Spark</i>", f3: "Later <b>x</b>" },
    });
  });

  it("refuses a span that splits an element", () => {
    expect(
      spliceError("<p>Built <b>Kafka</b> pipelines</p>", [
        f("f1", "Built Kaf"),
      ]),
    ).toMatchObject({ code: "SPAN_SPLITS_ELEMENT", fieldId: "f1" });
    expect(
      spliceError("<p>Built <b>Kafka</b> pipelines</p>", [
        f("f1", "fka pipelines"),
      ]),
    ).toMatchObject({ code: "SPAN_SPLITS_ELEMENT" });
    // Widening past an element's edge must not swallow its other text.
    expect(
      spliceError("<p>x <b>Foo<i>Kafka</i></b> y</p>", [f("f1", "Kafka y")]),
    ).toMatchObject({ code: "SPAN_SPLITS_ELEMENT" });
    expect(
      spliceError("<p>x <b><i>Kafka</i>Foo</b> y</p>", [f("f1", "x Kafka")]),
    ).toMatchObject({ code: "SPAN_SPLITS_ELEMENT" });
  });

  it("refuses a span whose markup a field cannot hold, with the reason", () => {
    expect(
      spliceError('<p>Call <svg><circle r="1"></circle></svg> me</p>', [
        f("f1", "Call me"),
      ]),
    ).toEqual({
      code: "SPAN_MARKUP_NOT_ALLOWED",
      fieldId: "f1",
      reason: "TAG_NOT_ALLOWED",
    });
    expect(
      spliceError('<p>x <span style="color:red">Kafka</span></p>', [
        f("f1", "x Kafka"),
      ]),
    ).toMatchObject({ reason: "ATTRIBUTE_NOT_ALLOWED" });
    expect(
      spliceError(`<p>${"a".repeat(MAX_VALUE_CHARS + 1)}</p>`, [
        f("f1", "a".repeat(MAX_VALUE_CHARS + 1)),
      ]),
    ).toMatchObject({
      code: "SPAN_MARKUP_NOT_ALLOWED",
      reason: "VALUE_TOO_LONG",
    });
  });

  it("refuses a link in a span whose marker would sit inside a link", () => {
    // A table cell keeps the parser from closing the outer link.
    expect(
      spliceError(
        '<a href="x"><table><tr><td><a href="y">Kafka</a> rocks</td></tr></table></a>',
        [f("f1", "Kafka rocks")],
      ),
    ).toEqual({
      code: "SPAN_MARKUP_NOT_ALLOWED",
      fieldId: "f1",
      reason: "NESTED_LINK",
    });
  });

  it("finds a link anywhere above the marker", () => {
    expect(
      splice('<p><a href="a"><span>x <b>y</b></span></a> z</p>', [
        f("f1", "x y"),
        f("f2", "z"),
      ]),
    ).toEqual({
      body: '<p><a href="a"><span>⟦f1⟧</span></a> ⟦f2⟧</p>',
      defaults: { f1: "x <b>y</b>", f2: "z" },
      insideLinks: ["f1"],
    });
  });

  it("refuses missing, ambiguous and empty spans and unknown segments", () => {
    const body = "<p>a b a</p>";
    expect(spliceError(body, [f("f1", "c")]).code).toBe("SPAN_NOT_FOUND");
    expect(spliceError(body, [f("f1", "a")]).code).toBe("SPAN_AMBIGUOUS");
    expect(spliceError(body, [f("f1", "")]).code).toBe("SPAN_NOT_FOUND");
    expect(spliceError(body, [f("f1", "b", 1)]).code).toBe("SPAN_NOT_FOUND");
    expect(spliceError(body, [f("f1", "b", 0.5)]).code).toBe("SPAN_NOT_FOUND");
  });

  it("refuses overlapping spans, including an overlap made by widening", () => {
    expect(
      spliceError("<p>Built Kafka pipelines</p>", [
        f("f1", "Built Kafka"),
        f("f2", "Kafka pipelines"),
      ]),
    ).toMatchObject({ code: "OVERLAPPING_SPANS" });
    // "aK" widens to the end of <b>, which holds the space " " covers.
    expect(
      spliceError("<p>a<b>K </b>z</p>", [f("f1", "aK"), f("f2", " ")]),
    ).toMatchObject({ code: "OVERLAPPING_SPANS", fieldId: "f2" });
    expect(
      splice("<p>a<b>K </b>z</p>", [f("f1", "aK"), f("f2", "z")]),
    ).toMatchObject({
      body: "<p>⟦f1⟧⟦f2⟧</p>",
    });
  });

  it("refuses invalid and repeated field ids", () => {
    const body = "<p>Kafka and Spark</p>";
    for (const id of ["", "a b", "a.b", "⟦x⟧"]) {
      expect(spliceError(body, [f(id, "Kafka")]).code, id).toBe(
        "FIELD_ID_INVALID",
      );
    }
    expect(
      spliceError(body, [f("f1", "Kafka"), f("f1", "Spark")]),
    ).toMatchObject({ code: "DUPLICATE_FIELD_ID", fieldId: "f1" });
  });
});
