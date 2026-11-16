// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkMarkup,
  FULL_ALLOWLIST,
  MAX_VALUE_CHARS,
  markupUsage,
  stripToText,
} from "./inline-markup";

const any = { usage: FULL_ALLOWLIST, insideLink: false } as const;

function reason(markup: string, opts: Parameters<typeof checkMarkup>[1] = any) {
  const check = checkMarkup(markup, opts);
  return check.ok ? "ok" : check.reason;
}

describe("checkMarkup", () => {
  it("accepts text, entities, and a bare & or stray < as HTML reads them", () => {
    expect(reason("Built Kafka pipelines")).toBe("ok");
    expect(reason("R&amp;D, R&D, a < b, 5 > 3")).toBe("ok");
  });

  it("accepts balanced allowlisted tags with allowlisted attributes", () => {
    expect(
      reason(
        'Built <b>Apache <i>Kafka</i></b> <a href="https://x.test/" target="_blank" rel="noopener" title="t">site</a> <span class="k" id="a" lang="en" dir="ltr" role="note" itemprop="skill" itemscope itemtype="https://schema.org/Thing" aria-label="l" data-x="1">s</span>',
      ),
    ).toBe("ok");
    expect(reason('<a href="#">x</a> <a href="cv/other.html">y</a>')).toBe(
      "ok",
    );
  });

  it("accepts every allowlisted tag", () => {
    for (const tag of [
      "a",
      "abbr",
      "b",
      "code",
      "em",
      "i",
      "mark",
      "s",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "u",
    ]) {
      expect(reason(`x <${tag}>y</${tag}>`), tag).toBe("ok");
    }
  });

  it("caps the value's length", () => {
    expect(reason("a".repeat(MAX_VALUE_CHARS))).toBe("ok");
    expect(reason("a".repeat(MAX_VALUE_CHARS + 1))).toBe("VALUE_TOO_LONG");
  });

  it("refuses a NULL character", () => {
    expect(reason("a\u0000b")).toBe("NULL_CHARACTER");
    for (const markup of [
      '<span title="a\u0000b">x</span>',
      "<span title='\u0000'>x</span>",
      "<span title=\u0000>x</span>",
      "a<\u0000b",
      "a&\u0000b",
      "<b\u0000>x</b>",
    ]) {
      expect(reason(markup), JSON.stringify(markup)).toBe("NULL_CHARACTER");
    }
  });

  it("refuses ⟦ and ⟧ however they are written", () => {
    expect(reason("a ⟦x⟧")).toBe("MARKER");
    expect(reason("a &#x27E6;x")).toBe("MARKER");
    expect(reason("a &LeftDoubleBracket;x")).toBe("MARKER");
    expect(reason('<span title="&#10215;">x</span>')).toBe("MARKER");
  });

  it("refuses comments, doctypes, CDATA and processing instructions", () => {
    expect(reason("a <!-- c --> b")).toBe("NOT_TEXT");
    expect(reason("<!doctype html>a")).toBe("NOT_TEXT");
    expect(reason("a <![CDATA[x]]>")).toBe("NOT_TEXT");
    expect(reason("a <?x y?>")).toBe("NOT_TEXT");
  });

  it("refuses tags outside the allowlist, <br> included", () => {
    for (const markup of [
      "a<br>b",
      '<img src="x.png">',
      "<div>x</div>",
      "<script>x</script>",
      "<svg></svg>",
      "<style>x{}</style>",
    ]) {
      expect(reason(markup), markup).toBe("TAG_NOT_ALLOWED");
    }
  });

  it("refuses self-closing, unmatched, misnested and unclosed tags", () => {
    expect(reason("<b/>x")).toBe("SELF_CLOSING_TAG");
    expect(reason("x</b>")).toBe("UNMATCHED_END_TAG");
    expect(reason("<b><i>x</b></i>")).toBe("UNMATCHED_END_TAG");
    expect(reason("<b><i>x</b></b>")).toBe("UNMATCHED_END_TAG");
    expect(reason("</br>")).toBe("UNMATCHED_END_TAG");
    expect(reason("<b>x")).toBe("UNCLOSED_TAG");
  });

  it("refuses a value that ends inside a tag", () => {
    expect(reason('x <b class="a')).toBe("TRUNCATED_TAG");
    expect(reason("x <b")).toBe("TRUNCATED_TAG");
  });

  it("refuses end tags with attributes or a slash, and repeated attributes", () => {
    expect(reason("<b>x</b class=y>")).toBe("MALFORMED_ATTRIBUTE");
    expect(reason("<b>x</b/>")).toBe("MALFORMED_ATTRIBUTE");
    expect(reason('<span class="a" class="b">x</span>')).toBe(
      "DUPLICATE_ATTRIBUTE",
    );
  });

  it("refuses attributes outside the allowlist, and href off <a>", () => {
    for (const markup of [
      '<span style="color:red">x</span>',
      '<b onclick="x()">x</b>',
      '<span href="https://x.test/">x</span>',
      "<span data->x</span>",
      '<span data-a"b="1">x</span>',
      '<a ping="https://x.test/">x</a>',
      // Text the segments skip stays out of values (page-text.ts).
      "<span hidden>x</span>",
    ]) {
      expect(reason(markup), markup).toBe("ATTRIBUTE_NOT_ALLOWED");
    }
  });

  it("refuses javascript: links however they are written", () => {
    expect(reason('<a href="javascript:alert(1)">x</a>')).toBe(
      "JAVASCRIPT_URL",
    );
    expect(reason('<a href=" JAVA&#x09;script:x">x</a>')).toBe(
      "JAVASCRIPT_URL",
    );
  });

  it("refuses a link inside a link, in the value or around it", () => {
    expect(reason('<a href="a"><b><a href="b">x</a></b></a>')).toBe(
      "NESTED_LINK",
    );
    expect(
      reason('<a href="a">x</a>', { usage: FULL_ALLOWLIST, insideLink: true }),
    ).toBe("NESTED_LINK");
    expect(reason('<a href="a">x</a> <a href="b">y</a>')).toBe("ok");
  });

  describe("with the CV's usage", () => {
    const usage = markupUsage([
      'Built <b class="k\n\thl">Kafka</b>',
      '<a href="https://x.test/" title="Site" data-kind="web">site</a> <span class="">x</span> <span itemscope>y</span>',
    ]);
    const used = { usage, insideLink: false };

    it("accepts tags, class names, attribute values and links the defaults use", () => {
      expect(reason("<b>Spark</b>", used)).toBe("ok");
      expect(
        reason('<b class="hl k">Spark</b> <span class="k">x</span>', used),
      ).toBe("ok");
      expect(
        reason(
          '<a href="https://x.test/" title="Site" data-kind="web">x</a>',
          used,
        ),
      ).toBe("ok");
      expect(
        reason('<span class="">z</span> <span itemscope>w</span>', used),
      ).toBe("ok");
    });

    it("refuses an empty class unless the defaults use one", () => {
      const classed = markupUsage(['<b class="k">x</b>']);
      expect(
        reason('<b class="">x</b>', { usage: classed, insideLink: false }),
      ).toBe("ATTRIBUTE_NOT_USED");
      expect(reason('<span class="">x</span>', used)).toBe("ok");
    });

    it("refuses tags the defaults do not use", () => {
      expect(reason("<i>x</i>", used)).toBe("TAG_NOT_USED");
    });

    it("refuses class names, attribute values and links the defaults do not use", () => {
      expect(reason('<b class="sr-only">x</b>', used)).toBe(
        "ATTRIBUTE_NOT_USED",
      );
      expect(reason('<b class="k sr-only">x</b>', used)).toBe(
        "ATTRIBUTE_NOT_USED",
      );
      expect(reason('<span class=" ">x</span>', used)).toBe("ok");
      expect(reason('<a href="https://evil.test/">x</a>', used)).toBe(
        "ATTRIBUTE_NOT_USED",
      );
      expect(
        reason('<a href="https://x.test/" title="Other">x</a>', used),
      ).toBe("ATTRIBUTE_NOT_USED");
      expect(reason('<span data-kind="mail">x</span>', used)).toBe(
        "ATTRIBUTE_NOT_USED",
      );
      expect(reason('<span aria-hidden="true">x</span>', used)).toBe(
        "ATTRIBUTE_NOT_USED",
      );
      expect(reason('<span itemscope="x">y</span>', used)).toBe(
        "ATTRIBUTE_NOT_USED",
      );
    });

    it("still refuses what the allowlist refuses", () => {
      const withScript = markupUsage([
        '<img src="x"> <span style="a">x</span>',
      ]);
      expect(
        reason('<img src="x">', { usage: withScript, insideLink: false }),
      ).toBe("TAG_NOT_ALLOWED");
      expect(
        reason('<span style="a">x</span>', {
          usage: withScript,
          insideLink: false,
        }),
      ).toBe("ATTRIBUTE_NOT_ALLOWED");
    });
  });

  it("reports the first problem with a message", () => {
    expect(checkMarkup("<i>x</b> <br>", any)).toEqual({
      ok: false,
      reason: "UNMATCHED_END_TAG",
      message: "has </b> where it does not close the last open tag",
    });
  });
});

describe("markupUsage", () => {
  it("collects tags, class names, attribute pairs and links, with entities decoded", () => {
    const usage = markupUsage([
      '<b class=" a b ">x</b><a href="https://x.test/?a=1&amp;b=2" lang="en">y</a>',
      '<span class="">z</span>',
    ]);
    expect([...usage.tags].sort()).toEqual(["a", "b", "span"]);
    expect([...usage.classes].sort()).toEqual(["a", "b"]);
    expect([...usage.attributes].sort()).toEqual(["class=", "lang=en"]);
    expect([...usage.hrefs]).toEqual(["https://x.test/?a=1&b=2"]);
  });
});

describe("stripToText", () => {
  it("drops tags and decodes entities", () => {
    expect(stripToText("<b>Apache</b> <b>Kafka</b>, R&amp;D&nbsp;x")).toBe(
      "Apache Kafka, R&D\u00a0x",
    );
  });

  it("reads at most MAX_VALUE_CHARS", () => {
    expect(stripToText("a".repeat(MAX_VALUE_CHARS + 50))).toHaveLength(
      MAX_VALUE_CHARS,
    );
  });
});
