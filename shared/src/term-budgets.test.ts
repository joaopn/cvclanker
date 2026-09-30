import { describe, expect, it } from "vitest";
import {
  normalizeTermJobBudgets,
  resolveTermJobBudgets,
  termKey,
} from "./term-budgets";
import { parseProfileConfig } from "./types/profile";

describe("normalizeTermJobBudgets", () => {
  it("keys overrides by trimmed lowercase term and keeps only current terms", () => {
    expect(
      normalizeTermJobBudgets(
        { " AI Engineer ": 50, "data scientist": 70, removed: 30 },
        ["ai engineer", "Data Scientist"],
      ),
    ).toEqual({ "ai engineer": 50, "data scientist": 70 });
  });

  it("drops an invalid entry without losing the others", () => {
    expect(
      normalizeTermJobBudgets({ a: 9, b: 10.5, c: "40", d: 5001, e: 40 }, [
        "a",
        "b",
        "c",
        "d",
        "e",
      ]),
    ).toEqual({ e: 40 });
  });

  it("keeps the first of two keys naming the same term", () => {
    expect(
      normalizeTermJobBudgets({ "ML Engineer": 20, "ml engineer": 90 }, [
        "ml engineer",
      ]),
    ).toEqual({ "ml engineer": 20 });
  });

  it("treats a term named __proto__ as an ordinary key", () => {
    const out = normalizeTermJobBudgets(JSON.parse('{"__proto__": 25}'), [
      "__proto__",
    ]);
    expect(Object.keys(out)).toEqual(["__proto__"]);
    expect(out.__proto__).toBe(25);
  });

  it("returns an empty map for anything that is not an object", () => {
    expect(normalizeTermJobBudgets(null, ["a"])).toEqual({});
    expect(normalizeTermJobBudgets([10], ["a"])).toEqual({});
  });
});

describe("resolveTermJobBudgets", () => {
  it("gives each term its override, else the default, once per key", () => {
    expect(
      resolveTermJobBudgets(["AI Engineer", "ai engineer", "NLP"], 100, {
        "ai engineer": 300,
      }),
    ).toEqual({ "ai engineer": 300, nlp: 100 });
  });

  it("covers the run's terms, not the overrides' keys", () => {
    expect(resolveTermJobBudgets(["x"], 40, { y: 300 })).toEqual({ x: 40 });
  });
});

describe("parseProfileConfig term budgets", () => {
  it("keeps valid overrides when one stored entry is out of range", () => {
    const config = parseProfileConfig({
      searchTerms: ["a", "b"],
      termJobBudget: 60,
      termJobBudgets: { a: 1, b: 250 },
    });
    expect(config.termJobBudget).toBe(60);
    expect(config.termJobBudgets).toEqual({ b: 250 });
  });

  it("defaults a blob that predates the fields", () => {
    const config = parseProfileConfig({ searchTerms: ["a"] });
    expect(config.termJobBudget).toBe(100);
    expect(config.termJobBudgets).toEqual({});
  });

  it("keys a term by its trimmed, lowercased text", () => {
    expect(termKey("  ML Engineer ")).toBe("ml engineer");
  });
});
