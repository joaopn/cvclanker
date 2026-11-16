// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readStoredHtmlTemplate, StoredHtmlCvError } from "./stored-html-cv";

describe("readStoredHtmlTemplate", () => {
  it("reads the template and the fields inside links", () => {
    expect(
      readStoredHtmlTemplate(
        JSON.stringify({ html: "<p>⟦a⟧</p>", insideLinks: ["a"] }),
      ),
    ).toEqual({ templatedHtml: "<p>⟦a⟧</p>", insideLinks: ["a"] });
  });

  it.each([
    ["no template", null],
    ["an empty template", ""],
    ["text that is not JSON", "<p>x</p>"],
    ["JSON null", "null"],
    ["a Word envelope", JSON.stringify({ parts: {} })],
    ["no html", JSON.stringify({ insideLinks: [] })],
    ["no insideLinks", JSON.stringify({ html: "x" })],
    ["a non-string link id", JSON.stringify({ html: "x", insideLinks: [1] })],
  ])("refuses %s as damage on the server's side", (_label, templatedTex) => {
    expect(() => readStoredHtmlTemplate(templatedTex)).toThrow(
      new StoredHtmlCvError(
        "The stored CV template cannot be read; upload the CV again.",
      ),
    );
  });
});
