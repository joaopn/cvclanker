import type { SourceConfigRunGlobals } from "@shared/types";
import { describe, expect, it } from "vitest";
import { resolveSearchLocations } from "./mapper-helpers";

const globals = (
  overrides: Partial<SourceConfigRunGlobals> = {},
): SourceConfigRunGlobals => ({
  city: "",
  country: "",
  ...overrides,
});

describe("resolveSearchLocations", () => {
  it("qualifies every city with the run's country", () => {
    expect(
      resolveSearchLocations(
        globals({ city: "London|Cambridge|Exeter", country: "united kingdom" }),
      ),
    ).toEqual([
      "London, United Kingdom",
      "Cambridge, United Kingdom",
      "Exeter, United Kingdom",
    ]);
  });

  it("leaves a city that already names the country alone", () => {
    expect(
      resolveSearchLocations(
        globals({ city: "Toronto, Canada|Ottawa", country: "canada" }),
      ),
    ).toEqual(["Toronto, Canada", "Ottawa, Canada"]);
  });

  it("recognises a country alias in the city's own tail", () => {
    expect(
      resolveSearchLocations(
        globals({ city: "Cambridge, UK", country: "united kingdom" }),
      ),
    ).toEqual(["Cambridge, UK"]);
  });

  it("falls back to the country when no cities are configured", () => {
    expect(resolveSearchLocations(globals({ country: "netherlands" }))).toEqual(
      ["Netherlands"],
    );
  });

  it("returns the cities bare when no country is selected", () => {
    expect(resolveSearchLocations(globals({ city: "Berlin|Munich" }))).toEqual([
      "Berlin",
      "Munich",
    ]);
  });

  it("does not qualify with a non-geographic country", () => {
    // "London, Worldwide" resolves to nothing useful — the city goes out bare.
    expect(
      resolveSearchLocations(globals({ city: "London", country: "worldwide" })),
    ).toEqual(["London"]);
    expect(
      resolveSearchLocations(globals({ city: "Toronto", country: "usa/ca" })),
    ).toEqual(["Toronto"]);
  });

  it("is empty when neither a city nor a country is configured", () => {
    expect(resolveSearchLocations(globals())).toEqual([]);
  });
});
