import { describe, expect, it } from "vitest";
import { findBlockingCompanyKeyword } from "./blocked-companies";

describe("findBlockingCompanyKeyword", () => {
  it("matches case-insensitively", () => {
    expect(findBlockingCompanyKeyword("Acme Corp", ["acme corp"])).toBe(
      "acme corp",
    );
    expect(findBlockingCompanyKeyword("acme corp", ["Acme Corp"])).toBe(
      "Acme Corp",
    );
  });

  it("matches a keyword anywhere inside the employer name", () => {
    expect(
      findBlockingCompanyKeyword("Global Recruitment Ltd", ["recruit"]),
    ).toBe("recruit");
  });

  it("returns the keyword as stored, not its normalized form", () => {
    expect(findBlockingCompanyKeyword("Acme Corp", ["  ACME  "])).toBe(
      "  ACME  ",
    );
  });

  it("reports the first matching keyword", () => {
    expect(
      findBlockingCompanyKeyword("Acme Recruitment", ["recruit", "acme"]),
    ).toBe("recruit");
  });

  it("returns null when nothing matches", () => {
    expect(findBlockingCompanyKeyword("Acme Corp", ["globex"])).toBeNull();
  });

  it("returns null for a missing employer or an empty keyword list", () => {
    expect(findBlockingCompanyKeyword(null, ["acme"])).toBeNull();
    expect(findBlockingCompanyKeyword(undefined, ["acme"])).toBeNull();
    expect(findBlockingCompanyKeyword("", ["acme"])).toBeNull();
    expect(findBlockingCompanyKeyword("Acme Corp", [])).toBeNull();
    expect(findBlockingCompanyKeyword("Acme Corp", null)).toBeNull();
  });

  it("never lets a blank keyword block everything", () => {
    expect(findBlockingCompanyKeyword("Acme Corp", ["", "   "])).toBeNull();
  });
});
