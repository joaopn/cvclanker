import { defaultProfileConfig, type Profile } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  collectTermRows,
  nextSearchTerms,
  nextTermJobBudgets,
  rowBudgetState,
  sameBudgets,
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

describe("term job budgets", () => {
  const withBudgets = (
    id: string,
    searchTerms: string[],
    termJobBudgets: Record<string, number>,
  ): Profile => {
    const base = profile(id, searchTerms);
    return { ...base, config: { ...base.config, termJobBudgets } };
  };

  it("reports a row's common override, none, or mixed", () => {
    const a = withBudgets("a", ["x"], { x: 40 });
    const b = withBudgets("b", ["x"], { x: 40 });
    const c = profile("c", ["x"]);
    expect(rowBudgetState([a, b], "x")).toEqual({ kind: "same", value: 40 });
    expect(rowBudgetState([c], "x")).toEqual({ kind: "none" });
    expect(rowBudgetState([a, c], "x")).toEqual({ kind: "mixed" });
    expect(rowBudgetState([], "x")).toEqual({ kind: "none" });
  });

  it("applies edits to ticked terms only and drops unticked ones", () => {
    const a = withBudgets("a", ["x", "y"], { x: 40, y: 50 });
    const next = nextTermJobBudgets(
      a,
      new Set(["x", "z"]),
      new Map([
        ["z", 70],
        ["w", 90],
      ]),
    );
    expect(next).toEqual({ x: 40, z: 70 });
  });

  it("clears an override with a null edit", () => {
    const a = withBudgets("a", ["x"], { x: 40 });
    expect(
      nextTermJobBudgets(a, new Set(["x"]), new Map([["x", null]])),
    ).toEqual({});
  });

  it("compares override maps by entries", () => {
    expect(sameBudgets({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameBudgets({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameBudgets({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
