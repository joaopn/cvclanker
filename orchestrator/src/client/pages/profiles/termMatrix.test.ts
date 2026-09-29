import { defaultProfileConfig, type Profile } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  collectTermRows,
  nextSearchTerms,
  sameKeys,
  termKeysOf,
} from "./termMatrix";

function profile(id: string, searchTerms: string[]): Profile {
  return {
    id,
    name: id,
    config: { ...defaultProfileConfig(), searchTerms },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("collectTermRows", () => {
  it("unions every profile's terms case-insensitively, keeps the first spelling and sorts", () => {
    const rows = collectTermRows([
      profile("a", ["ML Engineer", "backend"]),
      profile("b", ["ml engineer ", "Data scientist"]),
    ]);
    expect(rows).toEqual([
      { key: "backend", label: "backend" },
      { key: "data scientist", label: "Data scientist" },
      { key: "ml engineer", label: "ML Engineer" },
    ]);
  });

  it("includes extra rows no profile has yet, without duplicating existing ones", () => {
    const rows = collectTermRows(
      [profile("a", ["backend"])],
      [
        { key: "backend", label: "Backend" },
        { key: "rust", label: "Rust" },
      ],
    );
    expect(rows).toEqual([
      { key: "backend", label: "backend" },
      { key: "rust", label: "Rust" },
    ]);
  });
});

describe("nextSearchTerms", () => {
  const rows = collectTermRows(
    [profile("x", ["zeta", "alpha"])],
    [{ key: "new term", label: "New Term" }],
  );

  it("keeps surviving terms in their order and spelling, then appends new ones", () => {
    const p = profile("a", ["Zeta", "Alpha", "zeta"]);
    expect(
      nextSearchTerms(p, new Set(["alpha", "zeta", "new term"]), rows),
    ).toEqual(["Zeta", "Alpha", "New Term"]);
  });

  it("drops deselected terms", () => {
    const p = profile("a", ["zeta", "alpha"]);
    expect(nextSearchTerms(p, new Set(["alpha"]), rows)).toEqual(["alpha"]);
  });
});

describe("sameKeys / termKeysOf", () => {
  it("compares term sets ignoring case and order", () => {
    expect(
      sameKeys(termKeysOf(profile("a", ["A", "b"])), new Set(["b", "a"])),
    ).toBe(true);
    expect(sameKeys(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(sameKeys(new Set(["a", "c"]), new Set(["a", "b"]))).toBe(false);
  });
});
