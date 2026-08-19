import { describe, expect, it } from "vitest";
import { mapHiringCafeRows } from "../src/run";

describe("mapHiringCafeRows drop accounting", () => {
  it("counts unreadable dataset rows", () => {
    const result = mapHiringCafeRows([
      { jobUrl: "https://example.com/1", title: "Kept", employer: "Acme" },
      // Not an object.
      "garbage",
      // An object with no url to identify the posting by.
      { title: "No URL" },
    ]);

    expect(result.jobs).toHaveLength(1);
    expect(result.dropped).toBe(2);
  });

  it("does NOT count an in-run duplicate as unreadable", () => {
    // The row mapped fine; it is the same posting seen twice in one run, which
    // is dedupe, not a mapping failure. Conflating them would make the funnel
    // report data loss where there is none.
    const row = {
      jobUrl: "https://example.com/1",
      sourceJobId: "abc",
      title: "Kept",
    };
    const result = mapHiringCafeRows([row, { ...row }]);

    expect(result.jobs).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });

  it("treats a non-array dataset as empty rather than throwing", () => {
    expect(mapHiringCafeRows(null)).toEqual({ jobs: [], dropped: 0 });
  });
});
