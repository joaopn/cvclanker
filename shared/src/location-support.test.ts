import { describe, expect, it } from "vitest";
import {
  foldDiacritics,
  formatCountryLabel,
  getCompatibleSourcesForCountry,
  isGlassdoorCountry,
  isSourceAllowedForCountry,
  isUkCountry,
  normalizeCountryKey,
  SUPPORTED_COUNTRY_KEYS,
} from "./location-support";

describe("location-support", () => {
  it("normalizes country aliases", () => {
    expect(normalizeCountryKey("UK")).toBe("united kingdom");
    expect(normalizeCountryKey("us")).toBe("united states");
    expect(normalizeCountryKey("usa")).toBe("united states");
    expect(normalizeCountryKey("czech republic")).toBe("czechia");
  });

  it("folds diacritics to their ASCII base letter", () => {
    expect(foldDiacritics("Málaga")).toBe("Malaga");
    expect(foldDiacritics("Zürich")).toBe("Zurich");
    expect(foldDiacritics("Kraków")).toBe("Krakow");
    expect(foldDiacritics("Malmö")).toBe("Malmo");
    expect(foldDiacritics("Sankt Pölten")).toBe("Sankt Polten");
    expect(foldDiacritics("Genève")).toBe("Geneve");
    expect(foldDiacritics("São Paulo")).toBe("Sao Paulo");
    expect(foldDiacritics("Ålesund")).toBe("Alesund");
  });

  it("folds the letters NFD cannot decompose", () => {
    // These carry no combining mark, so the decomposition pass never sees them.
    expect(foldDiacritics("Wrocław")).toBe("Wroclaw");
    expect(foldDiacritics("Straße")).toBe("Strasse");
    expect(foldDiacritics("Tromsø")).toBe("Tromso");
    expect(foldDiacritics("Æbeltoft")).toBe("AEbeltoft");
    // Malta is selectable, and Ħamrun is a real locality there.
    expect(foldDiacritics("Ħamrun")).toBe("Hamrun");
    // The commute sweep below only detects ASYMMETRY, so it is blind to a
    // symmetric pair being deleted or given a wrong value. These pin the
    // multi-character expansions and the Turkish dotless i by hand.
    expect(foldDiacritics("Þórshöfn")).toBe("THorshofn");
    expect(foldDiacritics("Þingvellir")).toBe("THingvellir");
    expect(foldDiacritics("Norðurland")).toBe("Nordurland");
    expect(foldDiacritics("Œuvre")).toBe("OEuvre");
    expect(foldDiacritics("Diyarbakır")).toBe("Diyarbakir");
  });

  it("preserves case and leaves ASCII untouched", () => {
    // pronounUsIndices distinguishes "US" from "us" on the folded string.
    expect(foldDiacritics("US Only")).toBe("US Only");
    expect(foldDiacritics("help us scale")).toBe("help us scale");
    expect(foldDiacritics("")).toBe("");
    expect(foldDiacritics("London, England, United Kingdom")).toBe(
      "London, England, United Kingdom",
    );
  });

  it("folding commutes with lowercasing across Latin", () => {
    // The invariant pronounUsIndices depends on: it folds the MIXED-CASE
    // string while tokenizeLocation folds the lowercased one, so a
    // STANDALONE_LETTER_FOLDS entry present in only one case would make the
    // two disagree on token count and silently disable the pronoun guard.
    // U+1E9E (capital sharp s) was exactly that gap.
    const asymmetric: string[] = [];
    // Through Latin Extended Additional (0x1e00-0x1eff) on purpose: that block
    // holds U+1E9E and all of Vietnamese, i.e. exactly where the next
    // asymmetric entry would come from. A sweep stopping at 0x2ff would not
    // reach the character this comment names.
    for (let codePoint = 0x20; codePoint <= 0x24ff; codePoint += 1) {
      const char = String.fromCodePoint(codePoint);
      if (
        foldDiacritics(char).toLowerCase() !==
        foldDiacritics(char.toLowerCase())
      ) {
        asymmetric.push(char);
      }
    }
    expect(asymmetric).toEqual([]);
    expect(foldDiacritics("STRAẞE")).toBe("STRASSE");
    expect(foldDiacritics("Straße")).toBe("Strasse");
  });

  it("leaves non-Latin scripts alone", () => {
    // The combining-marks block only, never \p{M}: dakuten and Indic vowel
    // signs are not accent variants, and collapsing them would merge
    // characters that are genuinely different letters.
    expect(foldDiacritics("ガード")).toBe("ガード");
    expect(foldDiacritics("हिन्दी")).toBe("हिन्दी");
  });

  it("folds a country typed without its diacritics", () => {
    // The alias table's key is spelled "türkiye"; the lookup is folded on both
    // sides, so both spellings still reach the same country key.
    expect(normalizeCountryKey("Türkiye")).toBe("turkey");
    expect(normalizeCountryKey("Turkiye")).toBe("turkey");
    expect(normalizeCountryKey("turkey")).toBe("turkey");
  });

  it("formats country labels", () => {
    expect(formatCountryLabel("united kingdom")).toBe("United Kingdom");
    expect(formatCountryLabel("usa/ca")).toBe("USA/CA");
    expect(formatCountryLabel("south korea")).toBe("South Korea");
  });

  it("keeps supported country keys unique and canonical", () => {
    expect(SUPPORTED_COUNTRY_KEYS).toContain("united kingdom");
    expect(SUPPORTED_COUNTRY_KEYS).toContain("united states");
    expect(SUPPORTED_COUNTRY_KEYS).toContain("worldwide");
    expect(SUPPORTED_COUNTRY_KEYS).not.toContain("uk");
    expect(SUPPORTED_COUNTRY_KEYS).not.toContain("us");
  });

  it("treats only united kingdom as UK country", () => {
    expect(isUkCountry("united kingdom")).toBe(true);
    expect(isUkCountry("UK")).toBe(true);
    expect(isUkCountry("worldwide")).toBe(false);
    expect(isUkCountry("usa/ca")).toBe(false);
    expect(isUkCountry("united states")).toBe(false);
  });

  it("applies source compatibility rules by country", () => {
    expect(isSourceAllowedForCountry("indeed", "united states")).toBe(true);
    expect(isSourceAllowedForCountry("linkedin", "worldwide")).toBe(true);
    expect(isSourceAllowedForCountry("glassdoor", "united states")).toBe(true);
    expect(isSourceAllowedForCountry("glassdoor", "japan")).toBe(false);
    expect(isSourceAllowedForCountry("startupjobs", "united states")).toBe(
      true,
    );
    expect(isSourceAllowedForCountry("startupjobs", "worldwide")).toBe(true);
  });

  it("filters incompatible sources while preserving compatible order", () => {
    expect(
      getCompatibleSourcesForCountry(
        ["indeed", "glassdoor", "startupjobs", "linkedin"],
        "united states",
      ),
    ).toEqual(["indeed", "glassdoor", "startupjobs", "linkedin"]);
  });

  it("supports glassdoor only in explicitly supported countries", () => {
    expect(isGlassdoorCountry("united kingdom")).toBe(true);
    expect(isGlassdoorCountry("uk")).toBe(true);
    expect(isGlassdoorCountry("usa")).toBe(true);
    expect(isGlassdoorCountry("japan")).toBe(false);
    expect(isGlassdoorCountry("worldwide")).toBe(false);
  });
});
