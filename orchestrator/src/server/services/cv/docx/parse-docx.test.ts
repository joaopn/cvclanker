// @vitest-environment node
import { describe, expect, it } from "vitest";
import { looksLikeDocx, ParseDocxError, parseDocx } from "./parse-docx";
import {
  buildDocx,
  cfbBytes,
  contentTypes,
  doctypeDoc,
  documentXml,
  externalFieldDoc,
  externalInstrTextDoc,
  headerFooterDoc,
  macroDoc,
  malformedXmlDoc,
  markerCollisionDoc,
  notAZip,
  para,
  pathTraversalDoc,
  simpleDoc,
  trackedChangesDoc,
} from "./test/fixture-builder";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParseDocxError) return error.code;
    throw error;
  }
  throw new Error("expected ParseDocxError, got success");
}

describe("parseDocx", () => {
  it("parses a well-formed docx and exposes the story parts", () => {
    const pkg = parseDocx(simpleDoc());
    expect(pkg.storyPartOrder).toEqual(["word/document.xml"]);
    expect(
      pkg.storyParts.get("word/document.xml")?.documentElement,
    ).toBeTruthy();
  });

  it("orders story parts: document first, then headers/footers in content-types order", () => {
    const pkg = parseDocx(headerFooterDoc());
    expect(pkg.storyPartOrder).toEqual([
      "word/document.xml",
      "word/header1.xml",
      "word/footer1.xml",
    ]);
  });

  it("rejects non-zip input as NOT_DOCX", () => {
    expect(codeOf(() => parseDocx(notAZip()))).toBe("NOT_DOCX");
  });

  it("identifies OLE compound files (password-protected / legacy .doc)", () => {
    expect(() => parseDocx(cfbBytes())).toThrow(/password-protected|legacy/);
    expect(codeOf(() => parseDocx(cfbBytes()))).toBe("NOT_DOCX");
  });

  it("rejects a zip that is not a docx package", () => {
    const zip = buildDocx({ "readme.txt": "not a docx" });
    expect(codeOf(() => parseDocx(zip))).toBe("NOT_DOCX");
  });

  it("rejects macro packages via vbaProject.bin", () => {
    expect(codeOf(() => parseDocx(macroDoc()))).toBe("MACRO_PACKAGE");
  });

  it("rejects macro packages via macroEnabled content type", () => {
    const doc = buildDocx({
      "[Content_Types].xml": contentTypes().replace(
        "wordprocessingml.document.main+xml",
        "wordprocessingml.document.macroEnabled.main+xml",
      ),
      "_rels/.rels": "<Relationships/>",
      "word/document.xml": documentXml(para("hi")),
    });
    expect(codeOf(() => parseDocx(doc))).toBe("MACRO_PACKAGE");
  });

  it("rejects unresolved tracked changes with actionable copy", () => {
    expect(() => parseDocx(trackedChangesDoc())).toThrow(/tracked changes/i);
    expect(codeOf(() => parseDocx(trackedChangesDoc()))).toBe(
      "TRACKED_CHANGES",
    );
  });

  it("rejects external-reference fields (fldSimple and instrText forms)", () => {
    expect(codeOf(() => parseDocx(externalFieldDoc()))).toBe(
      "EXTERNAL_REF_FIELD",
    );
    expect(codeOf(() => parseDocx(externalInstrTextDoc()))).toBe(
      "EXTERNAL_REF_FIELD",
    );
  });

  it("rejects archives above the part-count cap", () => {
    expect(codeOf(() => parseDocx(simpleDoc(), { maxPartCount: 2 }))).toBe(
      "ZIP_BOMB",
    );
  });

  it("rejects archives above the byte cap", () => {
    expect(codeOf(() => parseDocx(simpleDoc(), { maxExpandedBytes: 64 }))).toBe(
      "ZIP_BOMB",
    );
  });

  it("rejects path-traversal entry names", () => {
    expect(codeOf(() => parseDocx(pathTraversalDoc()))).toBe("PATH_TRAVERSAL");
  });

  it("rejects text containing the reserved marker glyphs", () => {
    expect(codeOf(() => parseDocx(markerCollisionDoc()))).toBe(
      "MARKER_COLLISION",
    );
  });

  it("rejects DOCTYPE declarations outright", () => {
    expect(codeOf(() => parseDocx(doctypeDoc()))).toBe("DOCTYPE_FORBIDDEN");
  });

  it("rejects malformed XML as PART_UNPARSEABLE", () => {
    expect(codeOf(() => parseDocx(malformedXmlDoc()))).toBe("PART_UNPARSEABLE");
  });
});

describe("looksLikeDocx", () => {
  it("accepts a well-formed docx", () => {
    expect(looksLikeDocx(simpleDoc())).toBe(true);
  });

  it("rejects a zip without the docx entries", () => {
    const texZip = buildDocx({
      "main.tex": "\\documentclass{article}",
      "style.cls": "% class",
    });
    expect(looksLikeDocx(texZip)).toBe(false);
  });

  it("rejects a zip with content types but no main document part", () => {
    const partial = buildDocx({ "[Content_Types].xml": contentTypes() });
    expect(looksLikeDocx(partial)).toBe(false);
  });

  it("rejects plain text bytes", () => {
    expect(looksLikeDocx(notAZip())).toBe(false);
  });

  it("rejects OLE compound files", () => {
    expect(looksLikeDocx(cfbBytes())).toBe(false);
  });

  it("rejects a truncated zip without throwing", () => {
    expect(looksLikeDocx(simpleDoc().slice(0, 40))).toBe(false);
  });
});
