import { describe, expect, it } from "vitest";
import {
  parseNewlineSeparatedInput,
  parseSearchTermsInput,
} from "./automatic-run";

describe("automatic-run utilities", () => {
  it("parses comma and newline separated search terms", () => {
    expect(parseSearchTermsInput("backend, platform\napi\n\n")).toEqual([
      "backend",
      "platform",
      "api",
    ]);
  });

  it("keeps a comma inside a newline-separated entry", () => {
    // Company names carry commas ("Kforce, Inc."); splitting on them yields
    // fragments that match no employer under the exact blocked-company rule.
    expect(parseNewlineSeparatedInput("Kforce, Inc.\nAcme Corp\n\n")).toEqual([
      "Kforce, Inc.",
      "Acme Corp",
    ]);
  });
});
