// @vitest-environment node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  RenderHtmlPdfError,
  renderHtmlToPdf,
  stopHtmlRenderer,
} from "./render-html-pdf";

const execFileAsync = promisify(execFile);

const RENDER_TEST_TIMEOUT_MS = 60_000;

function bundle(
  files: Record<string, string | Uint8Array>,
): Map<string, Uint8Array> {
  return new Map(
    Object.entries(files).map(([name, content]) => [
      name,
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    ]),
  );
}

// A 1x1 pure-red PNG.
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

async function withPdfFile<T>(
  pdf: Uint8Array,
  use: (pdfPath: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "render-html-pdf-test-"));
  try {
    const pdfPath = path.join(dir, "out.pdf");
    await fs.writeFile(pdfPath, pdf);
    return await use(pdfPath, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function pdfToText(pdf: Uint8Array): Promise<string> {
  return withPdfFile(pdf, async (pdfPath) => {
    const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"]);
    return stdout;
  });
}

async function pageSizePoints(pdf: Uint8Array): Promise<[number, number]> {
  return withPdfFile(pdf, async (pdfPath) => {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);
    const match = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(stdout);
    if (!match) throw new Error(`no page size in pdfinfo output: ${stdout}`);
    return [Number(match[1]), Number(match[2])];
  });
}

/** RGB of the page's top-left pixel, rasterised at a low resolution. */
function topLeftPixel(pdf: Uint8Array): Promise<[number, number, number]> {
  return pixelAt(pdf, 0, 0);
}

/** RGB of the pixel at a fraction of the first page's width and height. */
async function pixelAt(
  pdf: Uint8Array,
  xFraction: number,
  yFraction: number,
): Promise<[number, number, number]> {
  return withPdfFile(pdf, async (pdfPath, dir) => {
    const prefix = path.join(dir, "page");
    await execFileAsync("pdftoppm", [
      "-r",
      "10",
      "-f",
      "1",
      "-l",
      "1",
      "-singlefile",
      pdfPath,
      prefix,
    ]);
    const ppm = await fs.readFile(`${prefix}.ppm`);
    // Binary PPM: "P6\n<w> <h>\n<max>\n" then RGB triples.
    const header = /^P6\s+(\d+)\s+(\d+)\s+\d+\s/.exec(
      ppm.subarray(0, 64).toString("latin1"),
    );
    if (!header) throw new Error("unexpected pdftoppm output");
    const width = Number(header[1]);
    const height = Number(header[2]);
    const x = Math.floor((width - 1) * xFraction);
    const y = Math.floor((height - 1) * yFraction);
    const offset = header[0].length + (y * width + x) * 3;
    return [ppm[offset], ppm[offset + 1], ppm[offset + 2]];
  });
}

async function renderError(
  promise: Promise<unknown>,
): Promise<RenderHtmlPdfError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RenderHtmlPdfError) return error;
    throw error;
  }
  throw new Error("expected the render to fail");
}

describe("renderHtmlToPdf", () => {
  afterAll(async () => {
    await stopHtmlRenderer();
  });

  it(
    "renders the entry page with its bundled stylesheet",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Jane Q. Applicant</h1></body></html>',
          "style.css": 'h1::after { content: " styled-by-css"; }',
        }),
        entry: "index.html",
      });
      expect(Buffer.from(pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
      const text = await pdfToText(pdf);
      expect(text).toContain("Jane Q. Applicant");
      // Generated content only appears if the stylesheet was served with a
      // type Chromium accepts.
      expect(text).toContain("styled-by-css");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "reads stylesheets as UTF-8 whatever their @charset says",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="a.css"><p>Body</p>',
          "a.css":
            '@charset "iso-8859-1"; p::after { content: " caf\u00e9-css"; }',
        }),
        entry: "index.html",
      });
      expect(await pdfToText(pdf)).toContain("caf\u00e9-css");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "resolves relative references against an entry in a subfolder",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "cv/index.html":
            '<!doctype html><html><head><link rel="stylesheet" href="css/main.css"></head><body><p>Body</p></body></html>',
          "cv/css/main.css": 'p::after { content: " from-subfolder-css"; }',
        }),
        entry: "cv/index.html",
      });
      expect(await pdfToText(pdf)).toContain("from-subfolder-css");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "prints on A4 when the page sets no size, and honours @page size",
    async () => {
      const a4 = await renderHtmlToPdf({
        files: bundle({ "index.html": "<!doctype html><p>A4</p>" }),
        entry: "index.html",
      });
      const [a4Width, a4Height] = await pageSizePoints(a4);
      expect(a4Width).toBeCloseTo(595.9, 0);
      expect(a4Height).toBeCloseTo(842.9, 0);

      const letter = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            "<!doctype html><style>@page { size: letter; }</style><p>Letter</p>",
        }),
        entry: "index.html",
      });
      const [letterWidth, letterHeight] = await pageSizePoints(letter);
      expect(letterWidth).toBeCloseTo(612, 0);
      expect(letterHeight).toBeCloseTo(792, 0);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "prints background colours",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            "<!doctype html><style>@page { margin: 0; } html, body { margin: 0; background: rgb(255, 0, 0); }</style><p>Red</p>",
        }),
        entry: "index.html",
      });
      expect(await topLeftPixel(pdf)).toEqual([255, 0, 0]);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "runs no JavaScript",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            '<!doctype html><p>Static text</p><script>document.write("written-by-script")</script>',
        }),
        entry: "index.html",
      });
      const text = await pdfToText(pdf);
      expect(text).toContain("Static text");
      expect(text).not.toContain("written-by-script");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "fails naming a relative file the bundle does not contain",
    async () => {
      const error = await renderError(
        renderHtmlToPdf({
          files: bundle({
            "index.html":
              '<!doctype html><link rel="stylesheet" href="missing.css"><p>Body</p>',
          }),
          entry: "index.html",
        }),
      );
      expect(error.code).toBe("UNANSWERED_REQUESTS");
      expect(error.unansweredRequests).toEqual([
        "http://cv.invalid/missing.css",
      ]);
      expect(error.message).toContain("http://cv.invalid/missing.css");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "fails naming a remote reference",
    async () => {
      const error = await renderError(
        renderHtmlToPdf({
          files: bundle({
            "index.html":
              '<!doctype html><p>Body</p><img src="https://example.com/photo.png">',
          }),
          entry: "index.html",
        }),
      );
      expect(error.code).toBe("UNANSWERED_REQUESTS");
      expect(error.unansweredRequests).toEqual([
        "https://example.com/photo.png",
      ]);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "serves bundle files whose names need percent-encoding",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "C# cv/index.html":
            '<!doctype html><link rel="stylesheet" href="styles%20%C3%BC%23v2.css"><p>Body</p>',
          "C# cv/styles ü#v2.css": 'p::after { content: " encoded-name-css"; }',
        }),
        entry: "C# cv/index.html",
      });
      expect(await pdfToText(pdf)).toContain("encoded-name-css");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "accepts data: URLs without treating them as requests",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            '<!doctype html><p>Inline image</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">',
        }),
        entry: "index.html",
      });
      expect(await pdfToText(pdf)).toContain("Inline image");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "prints an image only print styles use",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            "<!doctype html><style>@page { margin: 0; } html, body { margin: 0; height: 100%; } @media print { body { background: url(red.png) repeat; } }</style><p>Body</p>",
          "red.png": RED_PNG,
        }),
        entry: "index.html",
      });
      expect(await topLeftPixel(pdf)).toEqual([255, 0, 0]);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  // While printing, Chromium evaluates width media queries at 720 CSS px and
  // height ones at no less than 1049 (and under 1050). A rule at exactly that
  // edge applies while printing; an image it uses is printed only if the rule
  // also applies when the page is laid out before printing, since an image
  // first needed while printing arrives too late; laying out at that size
  // makes every such rule apply. The last case checks that the page's own
  // @page size and margin do not widen the print width.
  // (max-height is not pinned: the print height may lie above 1049.)
  for (const [label, query, pageRule] of [
    ["min-width: 720px", "(min-width: 720px)", ""],
    ["max-width: 720px", "(max-width: 720px)", ""],
    ["min-height: 1049px", "(min-height: 1049px)", ""],
    [
      "max-width: 720px on a letter page without margins",
      "(max-width: 720px)",
      "@page { size: letter; margin: 0; }",
    ],
  ] as const) {
    it(
      `prints an image behind a ${label} rule`,
      async () => {
        const pdf = await renderHtmlToPdf({
          files: bundle({
            "index.html": `<!doctype html><style>${pageRule} html, body { margin: 0; height: 100%; } @media ${query} { body { background: rgb(0, 255, 0) url(red.png) repeat; } }</style><p>Body</p>`,
            "red.png": RED_PNG,
          }),
          entry: "index.html",
        });
        expect(await pixelAt(pdf, 0.5, 0.5)).toEqual([255, 0, 0]);
      },
      RENDER_TEST_TIMEOUT_MS,
    );
  }

  it(
    "fails naming a file only print styles use",
    async () => {
      const error = await renderError(
        renderHtmlToPdf({
          files: bundle({
            "index.html":
              "<!doctype html><style>@media print { body { background: url(print-only.png); } }</style><p>Body</p>",
          }),
          entry: "index.html",
        }),
      );
      expect(error.code).toBe("UNANSWERED_REQUESTS");
      expect(error.unansweredRequests).toEqual([
        "http://cv.invalid/print-only.png",
      ]);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it("fails when the entry is not in the bundle", async () => {
    const error = await renderError(
      renderHtmlToPdf({
        files: bundle({ "index.html": "<!doctype html><p>Body</p>" }),
        entry: "other.html",
      }),
    );
    expect(error.code).toBe("RENDER_FAILED");
    expect(error.message).toBe(
      'The bundle has no file "other.html" to render.',
    );
  });

  it("refuses an entry path with a leading slash", async () => {
    // Even when the bundle has that key: request paths lose their leading
    // slash, so such an entry could never be served to the page.
    const error = await renderError(
      renderHtmlToPdf({
        files: bundle({ "/index.html": "<!doctype html><p>Body</p>" }),
        entry: "/index.html",
      }),
    );
    expect(error.code).toBe("RENDER_FAILED");
    expect(error.message).toBe(
      'The bundle has no file "/index.html" to render.',
    );
  });

  it(
    "leaves a 1cm margin when the page sets none",
    async () => {
      const pdf = await renderHtmlToPdf({
        files: bundle({
          "index.html":
            "<!doctype html><style>html, body { margin: 0; background: rgb(255, 0, 0); }</style><p>Red</p>",
        }),
        entry: "index.html",
      });
      expect(await topLeftPixel(pdf)).toEqual([255, 255, 255]);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "reports a render whose browser another render's timeout retired as UNAVAILABLE",
    async () => {
      const page = bundle({ "index.html": "<!doctype html><p>Body</p>" });
      const victim = renderError(
        renderHtmlToPdf({ files: page, entry: "index.html" }),
      );
      const timedOut = await renderError(
        renderHtmlToPdf({ files: page, entry: "index.html", timeoutMs: 1 }),
      );
      expect(timedOut.code).toBe("TIMEOUT");
      expect((await victim).code).toBe("UNAVAILABLE");
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  it(
    "times out, and the next render still works",
    async () => {
      const page = bundle({ "index.html": "<!doctype html><p>Again</p>" });
      const error = await renderError(
        renderHtmlToPdf({ files: page, entry: "index.html", timeoutMs: 1 }),
      );
      expect(error.code).toBe("TIMEOUT");

      const pdf = await renderHtmlToPdf({ files: page, entry: "index.html" });
      expect(await pdfToText(pdf)).toContain("Again");
    },
    RENDER_TEST_TIMEOUT_MS,
  );
});
