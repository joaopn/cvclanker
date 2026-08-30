import { describe, expect, it } from "vitest";
import { isEmployerBlocked } from "./blocked-companies";

describe("isEmployerBlocked", () => {
  it("matches the same company name", () => {
    expect(isEmployerBlocked("Acme Corp", ["Acme Corp"])).toBe(true);
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    expect(isEmployerBlocked("ACME CORP", ["acme corp"])).toBe(true);
    expect(isEmployerBlocked("  Acme Corp  ", ["Acme Corp"])).toBe(true);
    expect(isEmployerBlocked("Acme Corp", ["  ACME corp  "])).toBe(true);
  });

  it("does NOT match a company that merely contains the entry", () => {
    // The rule this replaced blocked all three. Over-blocking is invisible to
    // the user, so it is the direction that must not be guessed at.
    expect(isEmployerBlocked("Novartis", ["Nova"])).toBe(false);
    expect(isEmployerBlocked("Global Recruitment Ltd", ["recruit"])).toBe(
      false,
    );
    expect(isEmployerBlocked("Michael Page", ["Page"])).toBe(false);
  });

  it("does NOT match a longer or shorter form of the same company", () => {
    // Precision over recall: the user blocks the name they actually saw, and
    // blocks another spelling by blacklisting it too.
    expect(isEmployerBlocked("Acme Corporation", ["Acme Corp"])).toBe(false);
    expect(isEmployerBlocked("Acme Corp (Remote)", ["Acme Corp"])).toBe(false);
  });

  it("normalizes nothing beyond case and OUTER whitespace", () => {
    // Each of these is a normalization someone could reasonably add, and each
    // would widen the rule back out by deciding two spellings are one company.
    expect(isEmployerBlocked("Nestle", ["Nestlé"])).toBe(false); // diacritics
    expect(isEmployerBlocked("Acme Corp", ["Acme Corp."])).toBe(false); // punctuation
    expect(isEmployerBlocked("Acme  Corp", ["Acme Corp"])).toBe(false); // inner spaces
    expect(isEmployerBlocked("Acme Ltd", ["Acme"])).toBe(false); // legal suffix
  });

  it("finds the match anywhere in the list", () => {
    expect(isEmployerBlocked("Acme Corp", ["globex", "acme corp"])).toBe(true);
  });

  it("is false for a missing employer or an empty list", () => {
    expect(isEmployerBlocked(null, ["acme"])).toBe(false);
    expect(isEmployerBlocked(undefined, ["acme"])).toBe(false);
    expect(isEmployerBlocked("", ["acme"])).toBe(false);
    expect(isEmployerBlocked("Acme Corp", [])).toBe(false);
    expect(isEmployerBlocked("Acme Corp", null)).toBe(false);
  });

  it("never lets a blank entry block a whole run", () => {
    expect(isEmployerBlocked("Acme Corp", ["", "   "])).toBe(false);
    // Nor an employer the scraper could not read match a blank entry.
    expect(isEmployerBlocked("   ", ["", "   "])).toBe(false);
  });
});
