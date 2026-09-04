import { describe, expect, it } from "vitest";
import {
  composeTailoringFailure,
  splitTailoringFailure,
  TAILORING_FAILURE_DETAIL_MAX_CHARS,
  tailoringFailureSummary,
} from "./tailoring-failure";

describe("composeTailoringFailure", () => {
  it("returns the summary alone when there is no detail", () => {
    expect(composeTailoringFailure("Tailoring failed.")).toBe(
      "Tailoring failed.",
    );
    expect(composeTailoringFailure("Tailoring failed.", "")).toBe(
      "Tailoring failed.",
    );
    expect(composeTailoringFailure("Tailoring failed.", "   ")).toBe(
      "Tailoring failed.",
    );
    expect(composeTailoringFailure("Tailoring failed.", null)).toBe(
      "Tailoring failed.",
    );
  });

  it("separates the detail with a blank line", () => {
    expect(composeTailoringFailure("Summary.", "the detail")).toBe(
      "Summary.\n\nthe detail",
    );
  });

  it("caps the detail and marks the truncation", () => {
    const detail = "x".repeat(TAILORING_FAILURE_DETAIL_MAX_CHARS + 500);
    const composed = composeTailoringFailure("Summary.", detail);
    const parts = splitTailoringFailure(composed);

    expect(parts.detail).not.toBeNull();
    expect(parts.detail?.startsWith("x".repeat(100))).toBe(true);
    expect(parts.detail).toContain("(truncated)");
    // Bounded by the cap plus the truncation note, never by the input length.
    expect(parts.detail?.length).toBeLessThan(
      TAILORING_FAILURE_DETAIL_MAX_CHARS + 40,
    );
  });

  it("does not truncate a detail that exactly fits the cap", () => {
    const detail = "y".repeat(TAILORING_FAILURE_DETAIL_MAX_CHARS);
    const parts = splitTailoringFailure(
      composeTailoringFailure("Summary.", detail),
    );
    expect(parts.detail).toBe(detail);
  });

  it("collapses a blank line inside the summary so the split stays unambiguous", () => {
    const composed = composeTailoringFailure("First.\n\nStill summary.", "d");
    expect(splitTailoringFailure(composed)).toEqual({
      summary: "First.\nStill summary.",
      detail: "d",
    });
  });

  it.each([
    ["A\n \n \nB", "consecutive whitespace-only lines"],
    ["A\n\n \nB", "an empty line then a whitespace-only one"],
    ["A\n\t\n \nB", "a tab line then a space line"],
    ["A\n \n\t\n \nB", "three blank lines of mixed whitespace"],
  ])("collapses a RUN of blank lines in the summary (%s: %s)", (summary) => {
    // A single-pass regex that collapsed one blank line per position left the
    // summary still splittable, so its tail silently became part of the
    // detail on the next read.
    const parts = splitTailoringFailure(
      composeTailoringFailure(summary, "DETAIL"),
    );
    expect(parts.summary).toBe("A\nB");
    expect(parts.detail).toBe("DETAIL");
  });

  it("round-trips through split", () => {
    const parts = splitTailoringFailure(
      composeTailoringFailure("A summary.", "line one\nline two"),
    );
    expect(parts).toEqual({
      summary: "A summary.",
      detail: "line one\nline two",
    });
  });
});

describe("splitTailoringFailure", () => {
  it("reports no detail for a reason written before this existed", () => {
    expect(
      splitTailoringFailure("Tailoring interrupted (server restart)"),
    ).toEqual({
      summary: "Tailoring interrupted (server restart)",
      detail: null,
    });
  });

  it("is total for empty and nullish input", () => {
    for (const value of [null, undefined, ""]) {
      expect(splitTailoringFailure(value)).toEqual({
        summary: "",
        detail: null,
      });
    }
  });

  it("treats a whitespace-only separator line as the separator", () => {
    expect(splitTailoringFailure("Summary.\n \ndetail")).toEqual({
      summary: "Summary.",
      detail: "detail",
    });
  });

  it("splits on the FIRST blank line, keeping later ones inside the detail", () => {
    expect(splitTailoringFailure("Summary.\n\npara one\n\npara two")).toEqual({
      summary: "Summary.",
      detail: "para one\n\npara two",
    });
  });

  it("reports no detail when the block after the separator is empty", () => {
    expect(splitTailoringFailure("Summary.\n\n   ")).toEqual({
      summary: "Summary.",
      detail: null,
    });
  });

  it("keeps a single newline inside the summary", () => {
    expect(splitTailoringFailure("line one\nline two")).toEqual({
      summary: "line one\nline two",
      detail: null,
    });
  });
});

describe("tailoringFailureSummary", () => {
  it("drops the detail so a tooltip cannot become a blob", () => {
    expect(
      tailoringFailureSummary("Summary.\n\na very long diagnostic block"),
    ).toBe("Summary.");
  });

  it("is total for nullish input", () => {
    expect(tailoringFailureSummary(null)).toBe("");
  });
});
