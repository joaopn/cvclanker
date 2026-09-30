import { defaultProfileConfig } from "@shared/types";
import { describe, expect, it } from "vitest";
import { buildConfig, formFromConfig } from "./ProfileConfigFields";

describe("ProfileConfigFields term job budgets", () => {
  const config = {
    ...defaultProfileConfig(),
    searchTerms: ["AI Engineer", "NLP"],
    termJobBudget: 80,
    termJobBudgets: { "ai engineer": 300 },
  };

  it("round-trips the default and the overrides", () => {
    const form = formFromConfig("P", config);
    expect(form.termJobBudget).toBe("80");
    expect(form.termJobBudgets).toEqual({ "ai engineer": "300" });
    const built = buildConfig(form, config);
    expect(built.termJobBudget).toBe(80);
    expect(built.termJobBudgets).toEqual({ "ai engineer": 300 });
  });

  it("drops blank overrides and ones for terms no longer searched", () => {
    const form = {
      ...formFromConfig("P", config),
      searchTerms: ["NLP", "Data Scientist"],
      termJobBudgets: {
        "ai engineer": "300",
        nlp: " ",
        "data scientist": "45",
      },
    };
    expect(buildConfig(form, config).termJobBudgets).toEqual({
      "data scientist": 45,
    });
  });

  it("clamps out-of-range numbers instead of failing the save", () => {
    const form = {
      ...formFromConfig("P", config),
      termJobBudget: "3",
      termJobBudgets: { "ai engineer": "999999", nlp: "abc" },
    };
    const built = buildConfig(form, config);
    expect(built.termJobBudget).toBe(10);
    expect(built.termJobBudgets).toEqual({ "ai engineer": 5000 });
  });
});
