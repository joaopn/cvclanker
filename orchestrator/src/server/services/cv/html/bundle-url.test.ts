// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  bundlePathForUrl,
  resolveReference,
  urlForBundlePath,
} from "./bundle-url";

describe("resolveReference", () => {
  const cases: [string, string, ReturnType<typeof resolveReference>][] = [
    ["style.css", "index.html", { kind: "local", path: "style.css" }],
    [
      "fonts/a.woff2",
      "css/main.css",
      { kind: "local", path: "css/fonts/a.woff2" },
    ],
    ["../img/a.png", "css/main.css", { kind: "local", path: "img/a.png" }],
    // Root-relative and climbing above the root clamp at the bundle root,
    // as Chromium's URL parser does.
    ["/assets/a.css", "cv/index.html", { kind: "local", path: "assets/a.css" }],
    ["../../../a.png", "index.html", { kind: "local", path: "a.png" }],
    ["img\\a.png", "index.html", { kind: "local", path: "img/a.png" }],
    ["  a.png\n", "index.html", { kind: "local", path: "a.png" }],
    ["\u0001a.png\u0000", "index.html", { kind: "local", path: "a.png" }],
    ["a\t.p\nng", "index.html", { kind: "local", path: "a.png" }],
    [
      " //cdn.example/a.css",
      "index.html",
      { kind: "remote", url: "//cdn.example/a.css" },
    ],
    ["\u0001#top", "index.html", { kind: "fragment" }],
    ["a.css?v=2#top", "index.html", { kind: "local", path: "a.css" }],
    ["my%20cv.css", "index.html", { kind: "local", path: "my cv.css" }],
    [
      "a%2Fb.css",
      "index.html",
      { kind: "unresolvable", reference: "a%2Fb.css" },
    ],
    [
      "bad%zz.css",
      "index.html",
      { kind: "unresolvable", reference: "bad%zz.css" },
    ],
    [
      "css//main.css",
      "index.html",
      { kind: "unresolvable", reference: "css//main.css" },
    ],
    ["css/", "index.html", { kind: "unresolvable", reference: "css/" }],
    ["https://", "index.html", { kind: "unresolvable", reference: "https://" }],
    ["http://", "index.html", { kind: "unresolvable", reference: "http://" }],
    ["http://[", "index.html", { kind: "unresolvable", reference: "http://[" }],
    [
      "https://a b/x.png",
      "index.html",
      { kind: "unresolvable", reference: "https://a b/x.png" },
    ],
    ["data:image/png;base64,AAAA", "index.html", { kind: "data" }],
    ["#gradient", "a.svg", { kind: "fragment" }],
    ["", "index.html", { kind: "fragment" }],
    [
      "https://fonts.example/a.css",
      "index.html",
      { kind: "remote", url: "https://fonts.example/a.css" },
    ],
    [
      "//cdn.example/a.css",
      "index.html",
      { kind: "remote", url: "//cdn.example/a.css" },
    ],
    [
      "https://cv.invalid/a.css",
      "index.html",
      { kind: "remote", url: "https://cv.invalid/a.css" },
    ],
    [
      "http://cv.invalid/a.css",
      "index.html",
      { kind: "remote", url: "http://cv.invalid/a.css" },
    ],
    [
      "//cv.invalid/a.css",
      "index.html",
      { kind: "remote", url: "//cv.invalid/a.css" },
    ],
    [
      "\\\\host\\a.css",
      "index.html",
      { kind: "remote", url: "\\\\host\\a.css" },
    ],
    ["/\\host/a.css", "index.html", { kind: "remote", url: "/\\host/a.css" }],
    [
      "file:///etc/hostname",
      "index.html",
      { kind: "remote", url: "file:///etc/hostname" },
    ],
    [
      "JavaScript:alert(1)",
      "index.html",
      { kind: "remote", url: "JavaScript:alert(1)" },
    ],
  ];
  for (const [reference, containing, expected] of cases) {
    it(`${JSON.stringify(reference)} in ${containing}`, () => {
      expect(resolveReference(reference, containing)).toEqual(expected);
    });
  }
});

describe("bundle URLs", () => {
  it("round-trips paths that need encoding", () => {
    for (const path of ["index.html", "C# cv/index.html", "a/ü b%/c?.css"]) {
      expect(bundlePathForUrl(urlForBundlePath(path))).toBe(path);
    }
  });

  it("serves only the placeholder origin over http", () => {
    expect(bundlePathForUrl("https://cv.invalid/a.css")).toBeNull();
    expect(bundlePathForUrl("http://cv.invalid:81/a.css")).toBeNull();
    expect(bundlePathForUrl("http://example.com/a.css")).toBeNull();
    expect(bundlePathForUrl("http://cv.invalid/")).toBeNull();
  });
});
