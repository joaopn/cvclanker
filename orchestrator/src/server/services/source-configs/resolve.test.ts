import type { SourceConfigSchema } from "@shared/types";
import { describe, expect, it } from "vitest";
import { resolveSourceContextSettings } from "./resolve";

const schema: SourceConfigSchema = {
  fields: [
    { key: "max_jobs_per_term", label: "Max", type: "number", default: "20" },
    { key: "country_indeed", label: "Country", type: "text", default: "" },
  ],
  globalMappings: [
    {
      globalField: "city",
      sourceField: "searchCities",
      enabledByDefault: true,
    },
    {
      globalField: "country",
      sourceField: "country_indeed",
      enabledByDefault: true,
    },
    {
      globalField: "workplaceTypes",
      sourceField: "workplaceTypes",
      enabledByDefault: true,
    },
  ],
};

describe("resolveSourceContextSettings", () => {
  it("seeds schema defaults when row + globals empty", () => {
    const result = resolveSourceContextSettings({
      schema,
      row: { config: {}, mappings: {} },
      runGlobals: {},
    });
    expect(result).toEqual({ max_jobs_per_term: "20", country_indeed: "" });
  });

  it("row config overrides schema defaults", () => {
    const result = resolveSourceContextSettings({
      schema,
      row: { config: { max_jobs_per_term: "100" }, mappings: {} },
      runGlobals: {},
    });
    expect(result.max_jobs_per_term).toBe("100");
  });

  it("enabled mappings write run-global value into sourceField", () => {
    const result = resolveSourceContextSettings({
      schema,
      row: { config: {}, mappings: {} },
      runGlobals: {
        city: "Vienna",
        country: "Austria",
        workplaceTypes: '["remote"]',
      },
    });
    expect(result.searchCities).toBe("Vienna");
    expect(result.country_indeed).toBe("Austria");
    expect(result.workplaceTypes).toBe('["remote"]');
  });

  it("user-disabled mapping preserves row config value", () => {
    const result = resolveSourceContextSettings({
      schema,
      row: {
        config: { country_indeed: "Germany" },
        mappings: { country: false },
      },
      runGlobals: { country: "Austria" },
    });
    expect(result.country_indeed).toBe("Germany");
  });

  it("missing run-global value falls through to row config / schema default", () => {
    const result = resolveSourceContextSettings({
      schema,
      row: { config: { country_indeed: "Spain" }, mappings: {} },
      runGlobals: { city: "Madrid" },
    });
    expect(result.searchCities).toBe("Madrid");
    expect(result.country_indeed).toBe("Spain");
  });

  it("no schema returns row config verbatim", () => {
    const result = resolveSourceContextSettings({
      schema: undefined,
      row: { config: { foo: "bar" }, mappings: {} },
      runGlobals: { city: "Vienna" },
    });
    expect(result).toEqual({ foo: "bar" });
  });
});
