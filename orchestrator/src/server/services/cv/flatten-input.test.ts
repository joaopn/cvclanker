// @vitest-environment node
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { FlattenInputError, flattenInput } from "./flatten-input";

function texZip(entries: Record<string, string>): Uint8Array {
  const zip = new AdmZip();
  for (const [name, source] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(source, "utf8"));
  }
  return new Uint8Array(zip.toBuffer());
}

describe("flattenInput", () => {
  it("passes a single .tex through unchanged", () => {
    const tex = "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n";
    const result = flattenInput({
      archive: new TextEncoder().encode(tex),
      filename: "cv.tex",
    });
    expect(result.flattenedTex).toBe(tex);
    expect(result.entrypoint).toBe("cv.tex");
    expect(result.assetReferences).toEqual([]);
  });

  it("rejects a single .tex containing \\input{}", () => {
    const tex = "\\input{header}\n\\documentclass{article}\n";
    expect(() =>
      flattenInput({
        archive: new TextEncoder().encode(tex),
        filename: "cv.tex",
      }),
    ).toThrow(FlattenInputError);
  });

  it("flattens nested \\input{} inside a zip", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n\\input{sections/intro}\n\\input{sections/exp.tex}\n",
      "sections/intro.tex": "Intro body.\n",
      "sections/exp.tex": "Exp body.\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.entrypoint).toBe("main.tex");
    expect(result.flattenedTex).toBe(
      "\\documentclass{article}\nIntro body.\n\nExp body.\n\n",
    );
  });

  it("collects \\includegraphics asset references", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n\\includegraphics[width=2cm]{photo.jpg}\nText\n\\setmainfont{Inter.ttf}\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.assetReferences).toEqual(
      expect.arrayContaining(["photo.jpg", "Inter.ttf"]),
    );
  });

  it("collects assets from included files", () => {
    const archive = texZip({
      "main.tex": "\\documentclass{article}\n\\input{sections/exp}\n",
      "sections/exp.tex": "\\includegraphics{logo.png}\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.assetReferences).toContain("logo.png");
  });

  it("rejects absolute \\input paths", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n\\input{/etc/passwd}\n",
    });
    expect(() => flattenInput({ archive, filename: "cv.zip" })).toThrow(
      /absolute/i,
    );
  });

  it("rejects \\input traversal", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n\\input{../../etc/secret}\n",
    });
    expect(() => flattenInput({ archive, filename: "cv.zip" })).toThrow(
      /traversal/i,
    );
  });

  it("throws on missing referenced file", () => {
    const archive = texZip({
      "main.tex": "\\documentclass{article}\n\\input{ghost}\n",
    });
    expect(() => flattenInput({ archive, filename: "cv.zip" })).toThrow(
      /not present/i,
    );
  });

  it("throws when the zip contains no .tex files", () => {
    const archive = texZip({ "readme.txt": "hello" });
    expect(() => flattenInput({ archive, filename: "cv.zip" })).toThrow(
      /no \.tex/i,
    );
  });

  it("prefers main.tex when multiple \\documentclass files exist", () => {
    const archive = texZip({
      "draft.tex": "\\documentclass{article}\nDraft\n",
      "main.tex": "\\documentclass{article}\nMain\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.entrypoint).toBe("main.tex");
  });

  it("detects cycles", () => {
    const archive = texZip({
      "main.tex": "\\documentclass{article}\n\\input{a}\n",
      "a.tex": "\\input{main}\n",
    });
    expect(() => flattenInput({ archive, filename: "cv.zip" })).toThrow(
      /cycle/i,
    );
  });

  it("ignores commented-out \\input{} in single-file uploads", () => {
    const tex =
      "\\documentclass{article}\n%\\input{leftover}\n\\begin{document}Hi\\end{document}\n";
    const result = flattenInput({
      archive: new TextEncoder().encode(tex),
      filename: "cv.tex",
    });
    expect(result.flattenedTex).toBe(tex);
  });

  it("does not inline commented-out \\input{} from a zip entrypoint", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n%\\input{leftover}\n\\input{intro}\nDone.\n",
      "intro.tex": "Intro body.\n",
      "leftover.tex": "Should not appear.\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.flattenedTex).toContain("Intro body.");
    expect(result.flattenedTex).toContain("%\\input{leftover}");
    expect(result.flattenedTex).not.toContain("Should not appear.");
  });

  it("treats \\%\\input{x} as an active directive (escaped percent)", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n\\%\\input{intro}\n",
      "intro.tex": "Intro body.\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.flattenedTex).toContain("Intro body.");
  });

  it("treats \\\\%\\input{x} as commented out (literal backslash then comment)", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n\\\\%\\input{intro}\nDone.\n",
      "intro.tex": "Should not appear.\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.flattenedTex).not.toContain("Should not appear.");
    expect(result.flattenedTex).toContain("%\\input{intro}");
  });

  it("picks cv.tex by default when both cv.tex and coverletter.tex exist", () => {
    const archive = texZip({
      "cv.tex": "\\documentclass{article}\nCV body\n",
      "coverletter.tex": "\\documentclass{article}\nLetter body\n",
      "shared.cls": "%% class file\n",
    });
    const result = flattenInput({ archive, filename: "bundle.zip" });
    expect(result.entrypoint).toBe("cv.tex");
    expect(result.flattenedTex).toContain("CV body");
  });

  it("picks coverletter.tex when given a cover-letter priority list", () => {
    const archive = texZip({
      "cv.tex": "\\documentclass{article}\nCV body\n",
      "coverletter.tex": "\\documentclass{article}\nLetter body\n",
      "shared.cls": "%% class file\n",
    });
    const result = flattenInput({
      archive,
      filename: "bundle.zip",
      entrypointPriority: [
        "coverletter.tex",
        "cover-letter.tex",
        "letter.tex",
        "cover.tex",
      ],
    });
    expect(result.entrypoint).toBe("coverletter.tex");
    expect(result.flattenedTex).toContain("Letter body");
  });

  it("matches priority entries case-insensitively", () => {
    // A competing root-level document that both sorts and is added first, so
    // whether the archive lists entries by name or by insertion it comes
    // first, ties on depth and the fallback would pick it: only the
    // case-insensitive priority match can land the letter.
    const archive = texZip({
      "Appendix.tex": "\\documentclass{article}\nAppendix\n",
      "CoverLetter.tex": "\\documentclass{article}\nLetter\n",
    });
    const result = flattenInput({
      archive,
      filename: "bundle.zip",
      entrypointPriority: ["coverletter.tex"],
    });
    expect(result.entrypoint).toBe("CoverLetter.tex");
  });

  it("skips commented-out \\includegraphics references", () => {
    const archive = texZip({
      "main.tex":
        "\\documentclass{article}\n%\\includegraphics{old.png}\n\\includegraphics{logo.png}\n",
    });
    const result = flattenInput({ archive, filename: "cv.zip" });
    expect(result.assetReferences).toContain("logo.png");
    expect(result.assetReferences).not.toContain("old.png");
  });
});
