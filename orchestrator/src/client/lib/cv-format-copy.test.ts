import { describe, expect, it } from "vitest";
import { getCvFormatCopy } from "./cv-format-copy";

describe("getCvFormatCopy", () => {
  it("accepts .tex and .zip on a latex profile", () => {
    expect(getCvFormatCopy("latex").acceptedExtensions).toEqual([
      ".tex",
      ".zip",
    ]);
  });

  it("accepts only .docx on a word profile", () => {
    expect(getCvFormatCopy("docx").acceptedExtensions).toEqual([".docx"]);
  });

  it("never mentions LaTeX or tectonic in the word copy", () => {
    const copy = getCvFormatCopy("docx");
    const prose = [
      copy.dropHint,
      copy.uploadSubtitle,
      copy.uploadDescription,
      copy.uploadingLabel,
      copy.sourceStderrLabel,
      copy.fieldsDescription,
      copy.compileLogTitle,
      copy.compileLogDescription,
    ].join(" ");

    expect(prose).not.toMatch(/latex|tectonic|\.tex|\.zip/i);
  });

  it("keeps the latex copy on the latex substrate", () => {
    const copy = getCvFormatCopy("latex");
    expect(copy.dropHint).toContain(".tex");
    expect(copy.sourceStderrLabel).toContain("Tectonic");
    expect(copy.compileLogTitle).toBe("Compile log");
  });

  it("accepts .html, .htm and .zip on an html profile, saying the page must be self-contained", () => {
    const copy = getCvFormatCopy("html");
    expect(copy.acceptedExtensions).toEqual([".html", ".htm", ".zip"]);
    expect(copy.uploadDescription).toMatch(/self-contained/);
    expect(copy.uploadDescription).toMatch(/nothing loaded from the internet/);
  });

  it("never mentions LaTeX, tectonic or Word in the html copy", () => {
    const copy = getCvFormatCopy("html");
    const prose = [
      copy.dropHint,
      copy.uploadSubtitle,
      copy.uploadDescription,
      copy.uploadingLabel,
      copy.sourceStderrLabel,
      copy.fieldsDescription,
      copy.compileLogTitle,
      copy.compileLogDescription,
    ].join(" ");

    expect(prose).not.toMatch(/latex|tectonic|\.tex\b|\.docx|\bword\b/i);
  });

  it("returns a distinct copy table per format", () => {
    expect(getCvFormatCopy("docx")).not.toEqual(getCvFormatCopy("latex"));
    expect(getCvFormatCopy("html")).not.toEqual(getCvFormatCopy("latex"));
    expect(getCvFormatCopy("html")).not.toEqual(getCvFormatCopy("docx"));
  });

  it("falls back to the LaTeX copy for a format this build does not know", () => {
    expect(getCvFormatCopy("bogus" as never)).toBe(getCvFormatCopy("latex"));
  });
});
