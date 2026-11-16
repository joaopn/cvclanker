// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_ELEMENTS, parsePage, serializePage } from "./html-tree";
import { visibleText } from "./page-text";
import { renderPage } from "./render-html";
import { type HtmlFieldSpan, spliceMarkers } from "./splice-markers";

const f = (id: string, value: string, segmentId = 0): HtmlFieldSpan => ({
  id,
  value,
  segmentId,
});

function template(page: string, fields: HtmlFieldSpan[]) {
  const spliced = spliceMarkers(parsePage(page), fields);
  return { templatedHtml: spliced.templatedHtml, defaults: spliced.defaults };
}

function render(
  templatedHtml: string,
  defaults: Record<string, string>,
  overrides: Record<string, string> = {},
) {
  return renderPage(
    templatedHtml,
    new Map(Object.entries(defaults)),
    new Map(Object.entries(overrides)),
  );
}

function bodyOf(html: string): string {
  return html.replace(/^.*<body>/s, "").replace(/<\/body>.*$/s, "");
}

function failure(result: ReturnType<typeof renderPage>) {
  if (result.ok) throw new Error("expected the render to fail");
  const { code, fieldId, reason } = result;
  return { code, fieldId, reason };
}

const page = (body: string) =>
  `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;

describe("renderPage", () => {
  it("renders the defaults back to the page byte for byte, and to the same text", () => {
    const original = serializePage(
      parsePage(
        `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head><title>CV</title><style>b{}</style></head><body>
<h1>Jane&nbsp;Doe</h1>
<!-- contact -->
<p>R&amp;D at <a href="https://x.test/?a=1&amp;b=2">Acme &lt;Labs&gt;</a>, 2020&ndash;2024</p>
<ul>
  <li>Built <b class="k">Kafka</b> pipelines</li>
  <li><span title="a &quot;b&quot;">Led</span> a team of 5</li>
</ul>
<pre>
  keep   this</pre>
<p>Skills: <code>TypeScript</code>, <svg><text>x</text></svg> SQL</p>
<table><tr><td>Lead &amp; mentor</td><td>2021&nbsp;&ndash; 2023</td></tr></table>
<p>See <a href="https://x.test/">my <i>own</i> site</a></p>
</body></html>`,
      ),
    );
    const { templatedHtml, defaults } = template(original, [
      f("name", "Jane Doe", 0),
      f("role", "R&D at Acme <Labs>, 2020–2024", 1),
      f("b1", "Built Kafka pipelines", 2),
      f("b2", "Led a team", 3),
      f("skill", "TypeScript", 4),
      f("cell", "Lead & mentor", 5),
      f("from", "2021", 6),
      f("to", "2023", 6),
      f("link", "own site", 7),
    ]);
    expect(templatedHtml).not.toBe(original);
    const result = renderPage(templatedHtml, defaults, new Map());
    if (!result.ok) throw new Error(result.message);
    expect(result.html).toBe(original);
    expect(visibleText(result.page.document)).toBe(
      visibleText(parsePage(original).document),
    );
  });

  it("substitutes a tailored value with markup the CV uses", () => {
    const { templatedHtml, defaults } = template(
      page("<p>Built <b>Kafka</b> pipelines</p><p>SQL</p>"),
      [f("b1", "Built Kafka pipelines", 0), f("s", "SQL", 1)],
    );
    const result = renderPage(
      templatedHtml,
      defaults,
      new Map([
        ["s", "<b>Postgres</b> &amp; SQL"],
        ["gone", "<i>ignored</i>"],
      ]),
    );
    if (!result.ok) throw new Error(result.message);
    expect(bodyOf(result.html)).toBe(
      "<p>Built <b>Kafka</b> pipelines</p><p><b>Postgres</b> &amp; SQL</p>",
    );
  });

  it("keeps the text around a marker, and several markers in one text node", () => {
    const result = render(page("<p>a ⟦x⟧ b ⟦y⟧c</p>"), { x: "X", y: "Y" });
    if (!result.ok) throw new Error(result.message);
    expect(bodyOf(result.html)).toBe("<p>a X b Yc</p>");
  });

  it("checks a default too, in its marker's link context", () => {
    expect(
      failure(render(page("<p>⟦x⟧</p>"), { x: '<img src="a.png">' })),
    ).toEqual({
      code: "VALUE_NOT_ALLOWED",
      fieldId: "x",
      reason: "TAG_NOT_ALLOWED",
    });
    expect(
      failure(
        render(page('<p><a href="#">a ⟦x⟧</a></p>'), {
          x: '<a href="#">b</a>',
        }),
      ),
    ).toEqual({
      code: "VALUE_NOT_ALLOWED",
      fieldId: "x",
      reason: "NESTED_LINK",
    });
  });

  it("refuses a marker with no value", () => {
    expect(failure(render(page("<p>⟦x⟧</p>"), {}))).toEqual({
      code: "MISSING_VALUE",
      fieldId: "x",
      reason: undefined,
    });
  });

  it("checks values against the defaults' markup, never the overrides'", () => {
    const templatedHtml = page("<p>⟦x⟧</p><p>⟦y⟧</p>");
    const defaults = { x: "<b>a</b>", y: "b" };
    expect(
      failure(
        render(templatedHtml, defaults, { x: "<i>a</i>", y: "<i>b</i>" }),
      ),
    ).toEqual({
      code: "VALUE_NOT_ALLOWED",
      fieldId: "x",
      reason: "TAG_NOT_USED",
    });
    expect(
      failure(
        render(templatedHtml, defaults, { y: '<b class="sr-only">b</b>' }),
      ),
    ).toEqual({
      code: "VALUE_NOT_ALLOWED",
      fieldId: "y",
      reason: "ATTRIBUTE_NOT_USED",
    });
  });

  it("refuses a link inside the link a marker sits in", () => {
    const templatedHtml = page(
      '<p><a href="https://x.test/">⟦x⟧</a></p><p>⟦y⟧</p>',
    );
    const defaults = { x: "site", y: '<a href="https://x.test/">me</a>' };
    expect(render(templatedHtml, defaults).ok).toBe(true);
    expect(
      failure(
        render(templatedHtml, defaults, {
          x: '<a href="https://x.test/">s</a>',
        }),
      ),
    ).toEqual({
      code: "VALUE_NOT_ALLOWED",
      fieldId: "x",
      reason: "NESTED_LINK",
    });
  });

  it("parses a value where its marker sits", () => {
    const result = render(page("<table><tr><td>⟦x⟧</td></tr></table>"), {
      x: "a <b>b</b> &lt;c&gt;",
    });
    if (!result.ok) throw new Error(result.message);
    expect(bodyOf(result.html)).toBe(
      "<table><tbody><tr><td>a <b>b</b> &lt;c&gt;</td></tr></tbody></table>",
    );
  });

  it("refuses a marker where text is never tailored", () => {
    for (const templatedHtml of [
      "<!DOCTYPE html><html><head><title>⟦x⟧</title></head><body></body></html>",
      page("<textarea>⟦x⟧</textarea>"),
      page("<pre>⟦x⟧</pre>"),
      page("<svg><text>⟦x⟧</text></svg>"),
      page("<math><mi>⟦x⟧</mi></math>"),
      page("<p hidden>⟦x⟧</p>"),
      page("<template><p>⟦x⟧</p></template>"),
    ]) {
      expect(failure(render(templatedHtml, { x: "v" })), templatedHtml).toEqual(
        { code: "MARKER_NOT_TAILORABLE", fieldId: "x", reason: undefined },
      );
    }
  });

  it("refuses a marker outside the page's text, or a malformed one", () => {
    for (const templatedHtml of [
      page('<p title="⟦x⟧">a</p>'),
      page("<!-- ⟦x⟧ --><p>a</p>"),
      page("<p>⟦x y⟧</p>"),
      page("<p>⟦⟦x⟧</p>"),
      page("<p>⟧</p>"),
    ]) {
      expect(failure(render(templatedHtml, { x: "v" })), templatedHtml).toEqual(
        { code: "TEMPLATE_INVALID", fieldId: undefined, reason: undefined },
      );
    }
  });

  it("refuses a template, a value or a result past the parser's caps", () => {
    // A template past the caps can only be a damaged one.
    expect(failure(render(page("<i></i>".repeat(MAX_ELEMENTS)), {})).code).toBe(
      "TEMPLATE_INVALID",
    );
    const nested = `${"<b>".repeat(600)}x${"</b>".repeat(600)}`;
    expect(
      failure(render(page("<p>⟦x⟧</p>"), { x: "<b>a</b>" }, { x: nested })),
    ).toEqual({ code: "PAGE_TOO_COMPLEX", fieldId: "x", reason: undefined });
    const crowded = page(`<p>⟦x⟧</p>${"<i></i>".repeat(MAX_ELEMENTS - 10)}`);
    expect(render(crowded, { x: "<b>a</b>" }).ok).toBe(true);
    expect(
      failure(render(crowded, { x: "<b>a</b>" }, { x: "<b>a</b>".repeat(20) })),
    ).toEqual({
      code: "PAGE_TOO_COMPLEX",
      fieldId: undefined,
      reason: undefined,
    });
  });

  it("refuses a result that does not read back to itself", () => {
    const smuggling =
      '<!doctype html><math><mtext><table><mglyph><style><!--</style><img title="--></mglyph><p>a</p><!--"><!-- -->';
    expect(failure(render(smuggling, {})).code).toBe("UNSTABLE_RENDER");
  });
});
