// @vitest-environment node
import { renderFragment } from "@server/services/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCvFormatNote } from "./cv-format-note";

vi.mock("@server/services/prompts", () => ({
  renderFragment: vi.fn(async (name: string) => `rendered:${name}`),
}));

beforeEach(() => {
  vi.mocked(renderFragment).mockClear();
});

describe("getCvFormatNote", () => {
  it("renders the LaTeX fragment for a latex profile", async () => {
    await expect(getCvFormatNote("latex")).resolves.toBe(
      "rendered:cv-format-latex",
    );
    expect(renderFragment).toHaveBeenCalledWith("cv-format-latex");
  });

  it("renders the Word fragment for a docx profile", async () => {
    await expect(getCvFormatNote("docx")).resolves.toBe(
      "rendered:cv-format-docx",
    );
    expect(renderFragment).toHaveBeenCalledWith("cv-format-docx");
  });

  it("renders the HTML fragment for an html profile", async () => {
    await expect(getCvFormatNote("html")).resolves.toBe(
      "rendered:cv-format-html",
    );
    expect(renderFragment).toHaveBeenCalledWith("cv-format-html");
  });
});
