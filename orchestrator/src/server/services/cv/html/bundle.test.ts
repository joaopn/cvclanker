// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type HtmlBundle,
  HtmlBundleError,
  hasHtmlSignature,
  type OpenHtmlBundleOptions,
  openHtmlBundle,
  openStoredHtmlBundle,
  packHtmlBundle,
} from "./bundle";
import { buildZip, type ZipBuilderEntry } from "./test/zip-builder";

const OPTS = { maxExpandedBytes: 50 * 1024 * 1024 };
const PAGE = "<!doctype html><p>CV</p>";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function open(
  entries: ZipBuilderEntry[],
  opts: OpenHtmlBundleOptions = OPTS,
): HtmlBundle {
  return openHtmlBundle(buildZip(entries), opts);
}

function bundleError(run: () => unknown): HtmlBundleError {
  try {
    run();
  } catch (error) {
    if (error instanceof HtmlBundleError) return error;
    throw error;
  }
  throw new Error("expected an HtmlBundleError");
}

describe("hasHtmlSignature", () => {
  it.each([
    ["<!doctype html><p>x</p>", true],
    ['<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">', true],
    ["<html lang=en>", true],
    ["<html>", true],
    ["\ufeff  \n<!-- made by an agent -->\n<!doctype html>", true],
    ['<?xml version="1.0"?>\n<!DOCTYPE html>', true],
    ["<!-- unterminated <!doctype html>", false],
    ["\\documentclass{article}", false],
    ["% comment\n\\begin{document}", false],
    ["<!DOCTYPE\n    html>", true],
    ["<!--><!doctype html>", true],
    ["<!---><html>", true],
    ["<HTML LANG=en>", true],
    ["<html", true],
    ["<html/>", true],
    [' <?xml version="1.0"', false],
    [" <!-- unterminated", false],
    ["<!doctypehtml>", false],
    ["<!doctype\u000bhtml>", false],
    ["<htmlx>", false],
    ["<p>no doctype</p>", false],
    ["", false],
  ])("%j → %s", (text, expected) => {
    expect(hasHtmlSignature(utf8(text))).toBe(expected);
  });
});

describe("openHtmlBundle — single file", () => {
  it("opens a single HTML file as the entry", () => {
    const bundle = openHtmlBundle(utf8(PAGE), OPTS);
    expect(bundle.shape).toBe("file");
    expect([...bundle.files.keys()]).toEqual(["index.html"]);
    expect(bundle.entry).toBe("index.html");
  });

  it("refuses a file that is not HTML", () => {
    expect(
      bundleError(() => openHtmlBundle(utf8("\\documentclass{x}"), OPTS)).code,
    ).toBe("NOT_HTML");
  });
});

describe("openHtmlBundle — zip", () => {
  it("normalises names, skips directories and OS junk, keeps other files", () => {
    const bundle = open([
      { name: "css/", data: "" },
      { name: "index.html", data: PAGE },
      { name: "css\\main.css", data: "p{}" },
      { name: "./img/./a.png", data: "png" },
      { name: "__MACOSX/._index.html", data: "junk" },
      { name: "__MACOSX/css/main.css", data: "junk" },
      { name: ".DS_Store", data: "junk" },
      { name: "img/._a.png", data: "junk" },
      { name: "Thumbs.db", data: "junk" },
      { name: ".hidden/notes.txt", data: "kept" },
    ]);
    expect(bundle.shape).toBe("bundle");
    expect([...bundle.files.keys()].sort()).toEqual([
      ".hidden/notes.txt",
      "css/main.css",
      "img/a.png",
      "index.html",
    ]);
    expect(bundle.entry).toBe("index.html");
  });

  it("strips a single top folder, so root-relative references resolve", () => {
    const bundle = open([
      { name: "site/", data: "" },
      { name: "site/index.html", data: PAGE },
      { name: "site/assets/a.css", data: "p{}" },
    ]);
    expect([...bundle.files.keys()].sort()).toEqual([
      "assets/a.css",
      "index.html",
    ]);
  });

  it.each([
    ["../evil.html"],
    ["a/../../evil.html"],
    ["/etc/passwd"],
    ["C:/x.html"],
    ["..\\evil.html"],
  ])("refuses the unsafe name %j", (name) => {
    expect(
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name, data: "x" },
        ]),
      ).code,
    ).toBe("UNSAFE_PATH");
  });

  it("refuses two entries that name the same file", () => {
    const error = bundleError(() =>
      open([
        { name: "index.html", data: PAGE },
        { name: "css/a.css", data: "1" },
        { name: "css\\a.css", data: "2" },
      ]),
    );
    expect(error.code).toBe("DUPLICATE_ENTRY");
    expect(error.message).toContain('"css/a.css"');
    expect(error.message).toContain("css\\a.css");
  });

  it("refuses two names that differ only by case", () => {
    expect(
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name: "Img/a.png", data: "1" },
          { name: "img/a.png", data: "2" },
        ]),
      ).code,
    ).toBe("DUPLICATE_ENTRY");
  });

  it("refuses names that are the same in another Unicode form", () => {
    expect(
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name: "caf\u00e9.png", data: "1" },
          { name: "cafe\u0301.png", data: "2" },
        ]),
      ).code,
    ).toBe("DUPLICATE_ENTRY");
  });

  it("refuses a file and a folder of the same name", () => {
    expect(
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name: "img", data: "1" },
          { name: "IMG/a.png", data: "2" },
        ]),
      ).code,
    ).toBe("DUPLICATE_ENTRY");
  });

  it("accepts a file whose name only starts like a folder's", () => {
    expect(
      [
        ...open([
          { name: "index.html", data: PAGE },
          { name: "a", data: "1" },
          { name: "ab/x.css", data: "2" },
        ]).files.keys(),
      ].sort(),
    ).toEqual(["a", "ab/x.css", "index.html"]);
  });

  it("refuses names too long to extract, at the exact limits", () => {
    const accepts = (name: string) =>
      open([
        { name: "index.html", data: PAGE },
        { name, data: "1" },
      ]).files.has(name);
    const refuses = (name: string) =>
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name, data: "1" },
        ]),
      ).code;
    // A part: 255 bytes is fine, 256 is not.
    expect(accepts(`${"b".repeat(251)}.css`)).toBe(true);
    expect(refuses(`${"b".repeat(252)}.css`)).toBe("UNSAFE_PATH");
    // A path: 4095 bytes is fine, 4096 is not.
    expect(accepts(`${"a/".repeat(2045)}xxxxx`)).toBe(true);
    expect(refuses(`${"a/".repeat(2045)}xxxxxx`)).toBe("UNSAFE_PATH");
  });

  it("drops a macOS twin longer than the limit instead of refusing", () => {
    const name = `${"b".repeat(251)}.css`;
    const deep = `${"a/".repeat(2045)}xxxxx`;
    const bundle = open([
      { name: "index.html", data: PAGE },
      { name, data: "1" },
      { name: `__MACOSX/._${name}`, data: "junk" },
      { name: deep, data: "2" },
      { name: `__MACOSX/${"a/".repeat(2045)}._xxxxx`, data: "junk" },
    ]);
    expect([...bundle.files.keys()].sort()).toEqual(
      ["index.html", name, deep].sort(),
    );
  });

  it("does not count ./ padding towards the length limit", () => {
    expect(
      open([
        { name: "index.html", data: PAGE },
        { name: `${"./".repeat(2048)}a.css`, data: "1" },
      ]).files.has("a.css"),
    ).toBe(true);
  });

  it("shortens long names in messages", () => {
    const error = bundleError(() =>
      open([
        { name: "index.html", data: PAGE },
        { name: `${"./".repeat(30_000)}a.css`, data: "1" },
        { name: "a.css", data: "2" },
      ]),
    );
    expect(error.code).toBe("DUPLICATE_ENTRY");
    expect(error.message.length).toBeLessThan(300);
  });

  it("checks deep names at the length limit in linear time", () => {
    // A thousand names of 2,047 segments each (4,095 bytes): building every
    // ancestor of each name is quadratic in its depth; the sorted-key check
    // is not.
    const deep = "a/".repeat(2046);
    const started = Date.now();
    const bundle = open([
      { name: "index.html", data: PAGE },
      ...Array.from({ length: 999 }, (_, i) => ({
        name: `${deep}${String(i).padStart(3, "0")}`,
        data: "",
        method: 0,
      })),
    ]);
    expect(bundle.files.size).toBe(1000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a file named like a folder even with names sorting between", () => {
    expect(
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name: "img", data: "1" },
          { name: "img.png", data: "2" },
          { name: "img-2.png", data: "3" },
          { name: "img/a.png", data: "4" },
        ]),
      ).code,
    ).toBe("DUPLICATE_ENTRY");
  });

  it("refuses a __proto__ path segment", () => {
    expect(
      bundleError(() =>
        open([
          { name: "index.html", data: PAGE },
          { name: "__proto__/a.css", data: "1" },
        ]),
      ).code,
    ).toBe("UNSAFE_PATH");
  });

  it("refuses a zip whose files add up to more than the cap", () => {
    expect(
      bundleError(() =>
        open(
          [
            { name: "index.html", data: PAGE },
            { name: "big.bin", data: "x".repeat(2000) },
          ],
          { maxExpandedBytes: 1000 },
        ),
      ).code,
    ).toBe("ZIP_BOMB");
  });

  it("refuses more entries than the cap", () => {
    expect(
      bundleError(() =>
        open(
          [
            { name: "index.html", data: PAGE },
            { name: "a.css", data: "a" },
          ],
          { ...OPTS, maxEntries: 1 },
        ),
      ).code,
    ).toBe("ZIP_BOMB");
  });

  it("refuses a corrupt zip with a typed error", () => {
    const zip = buildZip([{ name: "index.html", data: PAGE }]);
    expect(
      bundleError(() => openHtmlBundle(zip.subarray(0, zip.length - 3), OPTS))
        .code,
    ).toBe("BAD_ZIP");
    expect(
      bundleError(() =>
        open([{ name: "index.html", data: PAGE, declaredSize: 3 }]),
      ).code,
    ).toBe("BAD_ZIP");
  });

  describe("entry page", () => {
    it("prefers the shallowest page over a deeper index.html", () => {
      expect(
        open([
          { name: "cv.html", data: PAGE },
          { name: "fonts/specimen/index.html", data: PAGE },
          { name: "fonts/a.woff2", data: "f" },
        ]).entry,
      ).toBe("cv.html");
    });

    it("prefers index.html, then index.htm, at the shallowest level", () => {
      expect(
        open([
          { name: "about.html", data: PAGE },
          { name: "index.htm", data: PAGE },
          { name: "INDEX.HTML", data: PAGE },
        ]).entry,
      ).toBe("INDEX.HTML");
      expect(
        open([
          { name: "about.html", data: PAGE },
          { name: "index.htm", data: PAGE },
        ]).entry,
      ).toBe("index.htm");
    });

    it("ignores .html files that do not start like HTML", () => {
      expect(
        open([
          { name: "notes.html", data: "just text" },
          { name: "cv.html", data: PAGE },
        ]).entry,
      ).toBe("cv.html");
    });

    it("refuses several candidates at the same level", () => {
      expect(
        bundleError(() =>
          open([
            { name: "a.html", data: PAGE },
            { name: "b.html", data: PAGE },
          ]),
        ).code,
      ).toBe("AMBIGUOUS_ENTRY");
      expect(
        bundleError(() =>
          open([
            { name: "a/index.html", data: PAGE },
            { name: "b/Index.html", data: PAGE },
          ]),
        ).message,
      ).toBe(
        'The zip has 2 HTML pages at the same level ("a/index.html" and "b/Index.html"); keep one, named index.html.',
      );
    });

    it("names two of the competing pages, shortened", () => {
      const long = `${"p".repeat(200)}.html`;
      const error = bundleError(() =>
        open([
          ...Array.from({ length: 50 }, (_, i) => ({
            name: `${i}${long}`,
            data: PAGE,
          })),
        ]),
      );
      expect(error.code).toBe("AMBIGUOUS_ENTRY");
      expect(error.message).toMatch(/^The zip has 50 HTML pages/);
      expect(error.message).toContain(
        `(such as "0${"p".repeat(79)}…" and "1${"p".repeat(79)}…")`,
      );
      expect(error.message.length).toBeLessThan(400);
    });

    it("refuses a zip without an HTML page", () => {
      expect(
        bundleError(() => open([{ name: "a.css", data: "p{}" }])).code,
      ).toBe("NO_ENTRY");
    });
  });
});

describe("packHtmlBundle", () => {
  it("gives a single file back as the page itself", () => {
    const bundle = openHtmlBundle(utf8(PAGE), OPTS);
    expect(Buffer.from(packHtmlBundle(bundle)).toString()).toBe(PAGE);
  });

  it("packs a zip that opens to the same files", () => {
    const original = open([
      { name: "index.html", data: PAGE },
      { name: "css/a.css", data: "p{}" },
    ]);
    const reopened = openHtmlBundle(packHtmlBundle(original), OPTS);
    expect(reopened.entry).toBe("index.html");
    expect(
      Object.fromEntries(
        [...reopened.files].map(([path, data]) => [
          path,
          Buffer.from(data).toString(),
        ]),
      ),
    ).toEqual({ "index.html": PAGE, "css/a.css": "p{}" });
  });

  it("packs a zip that opens as stored to the same entry and files, however deep", () => {
    // The upload strips the single top folder `outer/`; opening the packed
    // zip as an upload again would strip `inner/` too.
    const original = open([
      { name: "outer/inner/index.html", data: PAGE },
      { name: "outer/inner/css/a.css", data: "p{}" },
    ]);
    expect(original.entry).toBe("inner/index.html");
    const stored = openStoredHtmlBundle(packHtmlBundle(original));
    expect(stored.shape).toBe("bundle");
    expect(stored.entry).toBe("inner/index.html");
    expect([...stored.files.keys()].sort()).toEqual([
      "inner/css/a.css",
      "inner/index.html",
    ]);
    expect(openHtmlBundle(packHtmlBundle(original), OPTS).entry).toBe(
      "index.html",
    );
  });

  it("opens a stored zip past the upload's size cap, and a stored page", () => {
    const original = open([
      { name: "index.html", data: PAGE },
      { name: "a.css", data: "p{}".repeat(100) },
    ]);
    const packed = packHtmlBundle(original);
    expect(
      bundleError(() => openHtmlBundle(packed, { maxExpandedBytes: 10 })).code,
    ).toBe("ZIP_BOMB");
    expect(openStoredHtmlBundle(packed).files.size).toBe(2);
    expect(openStoredHtmlBundle(utf8(PAGE))).toEqual(
      openHtmlBundle(utf8(PAGE), OPTS),
    );
  });

  it("packs to the same bytes in every time zone", () => {
    const bundle = open([
      { name: "index.html", data: PAGE },
      { name: "a.css", data: "p{}" },
    ]);
    const original = process.env.TZ;
    const packIn = (tz: string) => {
      process.env.TZ = tz;
      return Buffer.from(packHtmlBundle(bundle)).toString("hex");
    };
    try {
      const utc = packIn("UTC");
      const newYork = packIn("America/New_York");
      const tokyo = packIn("Asia/Tokyo");
      expect(newYork).toBe(utc);
      expect(tokyo).toBe(utc);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
