// @vitest-environment node
import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import type { HtmlBundle } from "./bundle";
import {
  checkHtmlBundleUnbounded,
  type HtmlRejectCode,
  HtmlRejectError,
} from "./parse-html";

function bundleOf(
  files: Record<string, string | Uint8Array>,
  entry = "index.html",
): HtmlBundle {
  return {
    shape: "bundle",
    files: new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      ]),
    ),
    entry,
  };
}

function page(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

function rejectOf(files: Record<string, string | Uint8Array>): HtmlRejectError {
  try {
    checkHtmlBundleUnbounded(bundleOf(files));
  } catch (error) {
    if (error instanceof HtmlRejectError) return error;
    throw error;
  }
  throw new Error("expected the page to be rejected");
}

function codeOf(files: Record<string, string | Uint8Array>): HtmlRejectCode {
  return rejectOf(files).code;
}

function cleaned(files: Record<string, string | Uint8Array>): string {
  return checkHtmlBundleUnbounded(bundleOf(files)).entryHtml;
}

describe("checkHtmlBundleUnbounded — accepted pages", () => {
  it("accepts a simple page with local CSS, fonts and images", () => {
    const result = checkHtmlBundleUnbounded(
      bundleOf({
        "index.html": page(
          '<img src="img/me.png" srcset="img/me.png 1x, img/me@2x.png 2x"><p>Jane</p>',
          '<link rel="stylesheet" href="css/main.css">',
        ),
        "css/main.css":
          '@import "lib/type.css"; body { background: url(../img/bg.png); }',
        // Resolved against css/lib/, the imported file's own folder.
        "css/lib/type.css":
          '@font-face { font-family: X; src: url("fonts/x.woff2") format("woff2"), local("X"); }',
        "img/me.png": "png",
        "img/me@2x.png": "png",
        "img/bg.png": "png",
        "css/lib/fonts/x.woff2": "font",
      }),
    );
    expect(result.entryHtml).toContain("<p>Jane</p>");
    expect(result.bundle.files.size).toBe(7);
  });

  it("accepts data: URLs, fragments and links to other sites", () => {
    expect(() =>
      cleaned({
        "index.html": page(
          '<img src="data:image/png;base64,AAAA"><a href="https://example.com/me">site</a><svg><a href="https://example.com"><rect fill="url(#g)"/></a></svg>',
        ),
      }),
    ).not.toThrow();
  });

  it("accepts every WHATWG label for UTF-8", () => {
    for (const label of ["utf8", "UTF-8", " unicode-1-1-utf-8 "]) {
      expect(() =>
        cleaned({
          "index.html": `<!doctype html><meta charset="${label}"><p>x</p>`,
        }),
      ).not.toThrow();
    }
    expect(() =>
      cleaned({
        "index.html":
          '<!doctype html><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><p>x</p>',
      }),
    ).not.toThrow();
  });

  it("accepts prose mentioning JavaScript in non-URL attributes", () => {
    expect(() =>
      cleaned({
        "index.html": page(
          '<span title="JavaScript: 5 years" aria-label="javascript: expert">JS</span>',
        ),
      }),
    ).not.toThrow();
  });

  it("does not treat @namespace or format() strings as files", () => {
    expect(() =>
      cleaned({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css":
          '@namespace svg url(http://www.w3.org/2000/svg); @font-face { src: url(f.woff2) format("woff2"); } p::before { content: "x.png"; }',
        "f.woff2": "font",
      }),
    ).not.toThrow();
  });

  it("follows a stylesheet import cycle without looping", () => {
    expect(() =>
      cleaned({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css": '@import "b.css";',
        "b.css": '@import url("a.css"); p { color: red; }',
      }),
    ).not.toThrow();
  });
});

describe("checkHtmlBundleUnbounded — bounds", () => {
  // A known mutation-XSS shape: on a second read, the parser turns the
  // title attribute's text into real elements.
  const smuggling = (inner: string) =>
    `<!doctype html><math><mtext><table><mglyph><style><!--</style><img title="--></mglyph>${inner}<!--"><!-- -->`;

  it("checks what the page parses to on a second read", () => {
    expect(
      codeOf({
        "index.html": smuggling(
          "<div><template shadowrootmode=open><p>x</p></template></div>",
        ),
      }),
    ).toBe("SHADOW_ROOT");
  });

  it("cleans up what the page parses to on a second read", () => {
    // On the second read the <link> inside the <style> becomes a real
    // element, with an integrity attribute the first clean-up never saw.
    expect(
      codeOf({
        "index.html":
          '<!doctype html><math><mtext><table><mglyph><style><mtext><link rel="stylesheet" href="a.css" integrity="sha384-x"></mtext></style></mglyph></table></mtext></math>',
        "a.css": "p{}",
      }),
    ).toBe("UNSTABLE_MARKUP");
  });

  it("finds a marker character the page only shows on a second read", () => {
    expect(
      codeOf({
        "index.html":
          "<!doctype html><math><mtext><table><mglyph><style><!--</style><p>&#x27E6;</p><style><!--x--></style></mglyph></table></mtext></math>",
      }),
    ).toBe("MARKER_COLLISION");
  });

  it("refuses markup that reads back differently after cleaning", () => {
    expect(codeOf({ "index.html": smuggling("<p>x</p>") })).toBe(
      "UNSTABLE_MARKUP",
    );
  });

  it("refuses nesting deeper than Chromium's parser goes", () => {
    expect(
      codeOf({ "index.html": `<!doctype html>${"<div>".repeat(600)}x` }),
    ).toBe("NESTING_TOO_DEEP");
    expect(() =>
      cleaned({ "index.html": `<!doctype html>${"<div>".repeat(400)}x` }),
    ).not.toThrow();
  });

  it("counts elements the parser creates, not tags written", () => {
    // "</br>" creates a <br>, and formatting elements are rebuilt for every
    // paragraph they span: both build far more elements than tags written.
    expect(
      codeOf({ "index.html": `<!doctype html>${"</br>".repeat(10_001)}` }),
    ).toBe("TOO_MANY_ELEMENTS");
    const bolds = Array.from({ length: 500 }, (_, i) => `<b id=${i}>`).join("");
    expect(
      codeOf({
        "index.html": `<!doctype html><p>${bolds}</p>${"<p>x</p>".repeat(30)}`,
      }),
    ).toBe("TOO_MANY_ELEMENTS");
  });

  it("handles hundreds of thousands of comments", () => {
    expect(() =>
      cleaned({ "index.html": `<!doctype html>${"<!---->".repeat(300_000)}` }),
    ).not.toThrow();
  });

  it("refuses more elements than a CV page needs", () => {
    expect(
      codeOf({ "index.html": `<!doctype html>${"<b>x</b>".repeat(10_001)}` }),
    ).toBe("TOO_MANY_ELEMENTS");
  });

  it("sniffs SVG content in linear time", () => {
    const started = Date.now();
    expect(() =>
      cleaned({
        "index.html": page('<img src="a.png">'),
        // Enough to take the old pattern ~16 s, few enough that a
        // regression fails here instead of hanging the run.
        "a.png": `${"<!---->".repeat(28)}x`,
      }),
    ).not.toThrow();
    // A backtracking pattern took exponential time here (243 ms at 22
    // comments, doubling with each one).
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("checkHtmlBundleUnbounded — clean-up", () => {
  it("keeps stylesheets and removes every other link", () => {
    const html = cleaned({
      "index.html": page(
        "<p>x</p>",
        '<link rel="preconnect" href="https://fonts.example"><link rel="dns-prefetch" href="//x.example"><link rel="icon" href="https://x.example/f.ico"><link rel="preload" href="a.css" as="style"><link rel="canonical" href="https://me.example"><link rel="stylesheet" href="a.css" integrity="sha384-abc">',
      ),
      "a.css": "p{}",
    });
    expect(html).toContain('<link rel="stylesheet" href="a.css">');
    for (const gone of [
      "preconnect",
      "dns-prefetch",
      "icon",
      "preload",
      "canonical",
      "integrity",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("keeps only the stylesheet part of a stylesheet link", () => {
    const html = cleaned({
      "index.html": page(
        "<p>x</p>",
        '<link rel="stylesheet preload" as="image" imagesrcset="https://x.example/a.png 1x" href="a.css">',
      ),
      "a.css": "p{}",
    });
    expect(html).toContain('<link rel="stylesheet" href="a.css">');
    expect(html).not.toContain("imagesrcset");
    expect(html).not.toContain("preload");
  });

  it("keeps an alternate stylesheet's rel and drops imagesizes", () => {
    const html = cleaned({
      "index.html": page(
        "<p>x</p>",
        '<link rel="alternate stylesheet" title="print" imagesizes="10px" href="a.css">',
      ),
      "a.css": "p{}",
    });
    expect(html).toContain('rel="alternate stylesheet"');
    expect(html).not.toContain("imagesizes");
  });

  it("keeps a blank first line in <pre> and <textarea>", () => {
    const html = cleaned({
      "index.html":
        "<!doctype html><pre>\n\ncode</pre><textarea>\n\nx</textarea>",
    });
    expect(html).toContain("<pre>\n\ncode</pre>");
    expect(html).toContain("<textarea>\n\nx</textarea>");
  });

  it("removes a content-security-policy meta and lazy loading", () => {
    const html = cleaned({
      "index.html": page(
        '<img src="a.png" loading="lazy">',
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`,
      ),
      "a.png": "png",
    });
    expect(html).not.toContain("Content-Security-Policy");
    expect(html).not.toContain("loading");
    expect(html).toContain('<img src="a.png">');
  });

  it("keeps the original doctype, so a legacy page keeps its layout mode", () => {
    const legacy =
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">';
    expect(
      cleaned({ "index.html": `<!-- <!DOCTYPE html> -->${legacy}<p>x</p>` }),
    ).toMatch(
      /^<!-- <!DOCTYPE html> --><!DOCTYPE HTML PUBLIC "-\/\/W3C\/\/DTD HTML 4.01 Transitional\/\/EN">/,
    );
    expect(parse(cleaned({ "index.html": `${legacy}<p>x</p>` })).mode).toBe(
      "quirks",
    );
    expect(cleaned({ "index.html": "<!doctype html><p>x</p>" })).toMatch(
      /^<!DOCTYPE html>/,
    );
  });

  it("writes the cleaned page back into the bundle", () => {
    const result = checkHtmlBundleUnbounded(
      bundleOf({
        "index.html": page("<p>x</p>", '<link rel="icon" href="f.ico">'),
      }),
    );
    expect(
      new TextDecoder().decode(result.bundle.files.get("index.html")),
    ).toBe(result.entryHtml);
  });
});

describe("checkHtmlBundleUnbounded — rejects", () => {
  it.each<[string, string, HtmlRejectCode]>([
    ["a script", "<script>1</script>", "SCRIPT"],
    ["an SVG script", "<svg><script>1</script></svg>", "SCRIPT"],
    ["noscript", "<noscript><p>x</p></noscript>", "NOSCRIPT"],
    ["an event handler", '<p onclick="x()">x</p>', "EVENT_HANDLER"],
    [
      "a javascript: link",
      '<a href=" JaVa\tScript:alert(1)">x</a>',
      "JAVASCRIPT_URL",
    ],
    [
      "a javascript: srcset",
      '<img srcset="javascript:x 1x">',
      "JAVASCRIPT_URL",
    ],
    [
      "a javascript: link split by a newline",
      '<a href="java\nscr\ript:x">x</a>',
      "JAVASCRIPT_URL",
    ],
    [
      "a javascript: link after a control character",
      '<a href="\u0001javascript:x">x</a>',
      "JAVASCRIPT_URL",
    ],
    ["an iframe", '<iframe src="a.html"></iframe>', "EMBEDDED_CONTENT"],
    ["a form", "<form></form>", "EMBEDDED_CONTENT"],
    [
      "an SVG animation",
      '<svg><a><set attributeName="href" to="x"/></a></svg>',
      "SVG_ANIMATION",
    ],
    [
      "a declarative shadow root",
      '<div><template shadowrootmode="open"><p>x</p></template></div>',
      "SHADOW_ROOT",
    ],
    ["a select", "<select><option>x</option></select>", "SELECT"],
    ["a base element", '<base href="https://x.example/">', "BASE_ELEMENT"],
    [
      "a meta refresh",
      '<meta http-equiv="refresh" content="0;url=x">',
      "META_REFRESH",
    ],
    ["a marker character", "<p>⟦x⟧</p>", "MARKER_COLLISION"],
    ["an encoded marker character", "<p>&#x27E6;x</p>", "MARKER_COLLISION"],
    [
      "a marker in an attribute",
      '<p title="&LeftDoubleBracket;">x</p>',
      "MARKER_COLLISION",
    ],
    ["a marker in a comment", "<!-- ⟦ --><p>x</p>", "MARKER_COLLISION"],
    [
      "a script inside a template",
      "<template><script>1</script></template>",
      "SCRIPT",
    ],
  ])("refuses %s", (_label, body, code) => {
    expect(codeOf({ "index.html": page(body) })).toBe(code);
  });

  it("ignores an empty charset declaration", () => {
    expect(() =>
      cleaned({ "index.html": '<!doctype html><meta charset=""><p>x</p>' }),
    ).not.toThrow();
  });

  it("refuses a page that is not UTF-8, or declares another charset", () => {
    expect(
      codeOf({
        "index.html":
          '<!doctype html><meta http-equiv="content-type" content="text/html; charset=ISO-8859-1"><p>x</p>',
      }),
    ).toBe("NON_UTF8_CHARSET");
    expect(
      codeOf({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css": Uint8Array.from([0x70, 0x7b, 0xe9, 0x7d]),
      }),
    ).toBe("NOT_UTF8");
    expect(
      codeOf({ "index.html": Uint8Array.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c]) }),
    ).toBe("NOT_UTF8");
    expect(
      codeOf({
        "index.html": '<!doctype html><meta charset="windows-1252"><p>x</p>',
      }),
    ).toBe("NON_UTF8_CHARSET");
  });

  it("lists remote files in a message that can be pasted back", () => {
    const error = rejectOf({
      "index.html": page(
        '<img src="//cdn.example/a.png">',
        '<link rel="stylesheet" href="https://fonts.example/css2?family=X&amp;display=swap"><link rel="stylesheet" href="a.css">',
      ),
      "a.css":
        "@import url(https://cdn.example/b.css); p { background: url(http://img.example/c.png); }",
    });
    expect(error.code).toBe("REMOTE_REFERENCES");
    expect(error.message).toMatch(/^This CV loads files from the internet/);
    for (const url of [
      "https://fonts.example/css2?family=X&display=swap",
      "//cdn.example/a.png",
      "https://cdn.example/b.css",
      "http://img.example/c.png",
    ]) {
      expect(error.message).toContain(url);
    }
  });

  it("caps the listed files", () => {
    const images = Array.from(
      { length: 30 },
      (_, i) => `<img src="https://x.example/${i}.png">`,
    ).join("");
    const error = rejectOf({ "index.html": page(images) });
    expect(error.message).toContain("https://x.example/19.png");
    expect(error.message).not.toContain("https://x.example/20.png");
    expect(error.message).toMatch(/and 10 more\.$/);
  });

  it("names each missing file with the file that uses it", () => {
    const error = rejectOf({
      "index.html": page(
        '<img src="me.png"><table background="bg.png"><tr><td background="cell.png">x</td></tr></table><video poster="p.png"></video><input type="image" src="btn.png"><svg><image href="i.png"/><use href="sprite.svg#x"/></svg>',
        '<link rel="stylesheet" href="css/a.css">',
      ),
      "css/a.css":
        'p { background-image: image-set("x.avif" type("image/avif"), "x.png"); }',
    });
    expect(error.code).toBe("MISSING_FILES");
    for (const missing of [
      "me.png (used by index.html)",
      "bg.png (used by index.html)",
      "cell.png (used by index.html)",
      "p.png (used by index.html)",
      "btn.png (used by index.html)",
      "i.png (used by index.html)",
      "sprite.svg (used by index.html)",
      "css/x.avif (used by css/a.css)",
      "css/x.png (used by css/a.css)",
    ]) {
      expect(error.message).toContain(missing);
    }
    expect(error.message).not.toContain("image/avif");
  });

  it("checks every srcset candidate, data: candidates included", () => {
    const error = rejectOf({
      "index.html": page(
        '<picture><source srcset="data:image/png;base64,AA,AA 1x, wide.png 2x"><img src="a.png" srcset="a.png 1x,b.png 2x"></picture>',
      ),
      "a.png": "png",
    });
    expect(error.message).toBe(
      "The page uses files the upload does not contain: wide.png (used by index.html), b.png (used by index.html).",
    );
  });

  it("checks inline styles, <style> and SVG presentation attributes", () => {
    for (const body of [
      '<svg><rect cursor="url(gone.cur), auto"/></svg>',
      '<p style="background: url(gone.png)">x</p>',
      "<style>p { background: u\\72l(gone.png); }</style><p>x</p>",
      '<svg><rect fill="url(gone.svg#g)"/></svg>',
    ]) {
      expect(codeOf({ "index.html": page(body) })).toBe("MISSING_FILES");
    }
  });

  it("ends a skipped @namespace rule at its block, and an @import too", () => {
    expect(
      rejectOf({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css":
          "@namespace url(http://www.w3.org/1999/xhtml)\nbody { color: red }\np { background: url(gone.png); }",
      }).message,
    ).toContain("gone.png (used by a.css)");
    expect(() =>
      cleaned({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css": "@import {} p { background: url(bg.png); }",
        "bg.png": "png",
      }),
    ).not.toThrow();
  });

  it("refuses data: stylesheets and stylesheets not named .css", () => {
    expect(
      codeOf({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css": '@import "data:text/css,p{}";',
      }),
    ).toBe("DATA_STYLESHEET");
    expect(
      codeOf({
        "index.html": page(
          "<p>x</p>",
          '<link rel="stylesheet" href="data:text/css,p{}">',
        ),
      }),
    ).toBe("DATA_STYLESHEET");
    expect(
      codeOf({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="style">'),
        style: "p{}",
      }),
    ).toBe("STYLESHEET_EXTENSION");
  });

  it("refuses SVG content not named .svg", () => {
    for (const svg of [
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<!DOCTYPE svg [<!ENTITY a "<x>">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>',
      "<svg/>",
    ]) {
      expect(
        codeOf({
          "index.html": page('<img src="logo.png">'),
          "logo.png": svg,
        }),
      ).toBe("SVG_EXTENSION");
    }
  });

  describe("SVG files", () => {
    const withSvg = (svg: string) => ({
      "index.html": page('<img src="logo.svg">'),
      "logo.svg": svg,
    });

    it("accepts a plain SVG, with or without a doctype", () => {
      expect(() =>
        cleaned(
          withSvg(
            '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://example.com"><rect fill="url(#g)"/></a></svg>',
          ),
        ),
      ).not.toThrow();
    });

    it.each([
      [
        "entities",
        '<!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      ],
      [
        "a script",
        '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      ],
      [
        "foreignObject",
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
      ],
      [
        "an event handler",
        '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>',
      ],
      [
        "xml:base",
        '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://x.example/"/>',
      ],
      [
        "an animation",
        '<svg xmlns="http://www.w3.org/2000/svg"><animate/></svg>',
      ],
      [
        "a javascript: link",
        '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x"/></svg>',
      ],
      ["malformed XML", "<svg><g></svg>"],
    ])("refuses %s", (_label, svg) => {
      expect(codeOf(withSvg(svg))).toBe("UNSAFE_SVG");
    });

    it("checks an SVG nobody references, too", () => {
      expect(
        codeOf({
          "index.html": page("<p>x</p>"),
          "unused.svg":
            '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
        }),
      ).toBe("UNSAFE_SVG");
    });

    it("resolves an SVG's own references against its folder", () => {
      const error = rejectOf({
        "index.html": page('<img src="img/logo.svg">'),
        "img/logo.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="photo.png"/><image href="https://x.example/r.png"/></svg>',
      });
      expect(error.code).toBe("REMOTE_REFERENCES");
      expect(error.message).toContain("https://x.example/r.png");
      expect(
        rejectOf({
          "index.html": page('<img src="img/logo.svg">'),
          "img/logo.svg":
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="photo.png"/></svg>',
        }).message,
      ).toContain("img/photo.png (used by img/logo.svg)");
    });
  });

  it("refuses a marker character in a CSS file", () => {
    expect(
      codeOf({
        "index.html": page("<p>x</p>", '<link rel="stylesheet" href="a.css">'),
        "a.css": 'p::after { content: "⟦"; }',
      }),
    ).toBe("MARKER_COLLISION");
  });
});
