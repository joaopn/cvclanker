// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parsePage } from "./html-tree";
import { segmentsOf, visibleText } from "./page-text";

function page(body: string, head = "") {
  return parsePage(
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  ).document;
}

function texts(body: string, head = ""): string[] {
  return segmentsOf(page(body, head)).map((segment) => segment.text);
}

describe("visibleText", () => {
  it("keeps every text node's value exactly, whitespace included", () => {
    expect(
      visibleText(page("<p>  Built <b>Kafka</b>\n pipelines&nbsp;</p>")),
    ).toBe("  Built Kafka\n pipelines\u00a0");
  });

  it("skips the head, raw-text and RCDATA elements, templates, SVG, MathML and what Chromium does not print", () => {
    const text = visibleText(
      page(
        [
          "<p>a</p>",
          "<style>s{}</style>",
          "<textarea>t</textarea>",
          "<template><p>tp</p></template>",
          "<svg><text>sv</text><foreignObject><p>fo</p></foreignObject></svg>",
          "<math><mi>m</mi></math>",
          "<noscript>n</noscript>",
          "<xmp>x</xmp>",
          "<title>bt</title>",
          "<script>sc</script>",
          "<iframe>if</iframe>",
          "<noembed>ne</noembed>",
          "<noframes>nf</noframes>",
          "<video>vi</video>",
          "<audio>au</audio>",
          "<datalist><option>dl</option></datalist>",
          '<progress value="0.5">pr</progress>',
          '<meter value="0.8">me</meter>',
          "<ruby>r<rp>(</rp><rt>rt</rt><rp>)</rp></ruby>",
          "<dialog>dc</dialog>",
          "<dialog open>do</dialog>",
          "<p>b</p>",
          "<plaintext>pt",
        ].join(""),
        "<title>T</title>\n  <style>h{}</style>\n",
      ),
    );
    expect(text).toBe("arrtdob");
  });

  it("keeps <pre> and <listing> text, which segments skip", () => {
    expect(visibleText(page("<pre>p</pre><listing>l</listing>"))).toBe("pl");
  });
});

describe("segmentsOf", () => {
  it("joins inline content into one segment and splits at blocks", () => {
    expect(
      texts(
        "<h1>Ada <i>Lovelace</i></h1><div>Built <b>Kafka</b> pipelines<p>Next</p>after</div>",
      ),
    ).toEqual(["Ada Lovelace", "Built Kafka pipelines", "Next", "after"]);
  });

  it("splits at <br>, <hr>, list items and table cells", () => {
    expect(
      texts(
        "a<br>b<hr>c<ul><li>d</li><li>e</li></ul><table><tr><td>f</td><td>g</td></tr></table>",
      ),
    ).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("splits at every common block element", () => {
    const blocks = [
      "address",
      "article",
      "aside",
      "blockquote",
      "center",
      "details",
      "dir",
      "div",
      "dl",
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
      "legend",
      "main",
      "menu",
      "nav",
      "ol",
      "p",
      "search",
      "section",
      "summary",
      "ul",
    ];
    for (const tag of blocks) {
      expect(texts(`a<${tag}>b</${tag}>c`), tag).toEqual(["a", "b", "c"]);
    }
    expect(texts("a<dialog open>b</dialog>c")).toEqual(["a", "b", "c"]);
    // A closed dialog is not printed, so it breaks no line either.
    expect(texts("<div>a <dialog>x</dialog>b</div>")).toEqual(["a b"]);
    expect(texts("<dl><dt>a</dt><dt>b</dt><dd>c</dd><dd>d</dd></dl>")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(
      texts(
        "<table><caption>a</caption><colgroup></colgroup><thead><tr><th>b</th><th>b2</th></tr></thead><tbody><tr><td>c</td></tr></tbody><tfoot><tr><td>d</td></tr></tfoot></table>e",
      ),
    ).toEqual(["a", "b", "b2", "c", "d", "e"]);
  });

  it("skips hidden elements; hidden=until-found keeps its line break", () => {
    expect(
      texts(
        '<div>a<span hidden>h</span>b<div hidden="until-found">u</div>c<p hidden="false">p</p>d<div hidden="Until-Found">U</div>e</div>',
      ),
    ).toEqual(["ab", "cd", "e"]);
    expect(
      visibleText(
        page('<p>a<span hidden="">h</span><b hidden="until-found">u</b>b</p>'),
      ),
    ).toBe("ab");
  });

  it("splits at tables, captions and skipped blocks with nothing else between", () => {
    expect(texts("x<table><caption>y</caption></table>z")).toEqual([
      "x",
      "y",
      "z",
    ]);
    expect(
      texts("<table><caption>a</caption><caption>b</caption></table>"),
    ).toEqual(["a", "b"]);
    expect(texts("a<table></table>b")).toEqual(["a", "b"]);
    expect(texts("a<pre>p</pre>b")).toEqual(["a", "b"]);
    expect(texts("a<listing>l</listing>b")).toEqual(["a", "b"]);
    expect(texts("<div>a<xmp>x</xmp>b</div>")).toEqual(["a", "b"]);
  });

  it("keeps a canvas's fallback text, which Chromium prints with scripting off", () => {
    expect(texts("<p>a <canvas>c</canvas> b</p>")).toEqual(["a c b"]);
  });

  it("collapses runs of whitespace and U+00A0 to one space, and trims", () => {
    expect(
      texts("<p>\n  Built&nbsp;\t<b> Kafka </b>\r\n pipelines \u00a0</p>"),
    ).toEqual(["Built Kafka pipelines"]);
    expect(texts("<p>a&#13;&#12;b</p>")).toEqual(["a b"]);
  });

  it("skips <pre>, <listing>, <textarea>, SVG and MathML text, without splitting at inline ones", () => {
    expect(
      texts(
        "<p>a <svg><text>icon</text></svg> b <math><mi>x</mi></math> c<textarea>t</textarea>d</p><pre>pre</pre><listing>l</listing><p>e</p>",
      ),
    ).toEqual(["a b cd", "e"]);
  });

  it("drops empty segments and numbers the rest in document order", () => {
    const segments = segmentsOf(page("<p> </p><p>a</p><div>\n</div><p>b</p>"));
    expect(segments.map((s) => [s.segmentId, s.text])).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
  });

  it("maps each character to its text node and offset, a collapsed space to its run's first character", () => {
    const [segment] = segmentsOf(page("<p>  Built \n <b>Kafka</b></p>"));
    expect(segment.text).toBe("Built Kafka");
    const at = (i: number) => [
      segment.positions[i].node.value,
      segment.positions[i].offset,
    ];
    expect(at(0)).toEqual(["  Built \n ", 2]);
    expect(at(4)).toEqual(["  Built \n ", 6]);
    expect(at(5)).toEqual(["  Built \n ", 7]);
    expect(at(6)).toEqual(["Kafka", 0]);
    expect(at(10)).toEqual(["Kafka", 4]);
    expect(segment.positions).toHaveLength(segment.text.length);
  });

  it("maps a space collapsed across text nodes to the first one", () => {
    const [segment] = segmentsOf(page("<p>Built <b> Kafka</b></p>"));
    expect(segment.text).toBe("Built Kafka");
    expect(segment.positions[5].node.value).toBe("Built ");
    expect(segment.positions[5].offset).toBe(5);
  });
});
