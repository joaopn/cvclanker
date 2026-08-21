import { describe, expect, it } from "vitest";
import {
  isUniversalRemoteRegion,
  remoteRegionIncludesCountry,
} from "./remote-regions";

describe("remote-regions", () => {
  it("recognises the universal tokens whatever the casing or suffix", () => {
    expect(isUniversalRemoteRegion("Anywhere in the World")).toBe(true);
    expect(isUniversalRemoteRegion("anywhere")).toBe(true);
    expect(isUniversalRemoteRegion("Worldwide")).toBe(true);
    expect(isUniversalRemoteRegion("Remote")).toBe(true);
    expect(isUniversalRemoteRegion("Portugal")).toBe(false);
    expect(isUniversalRemoteRegion("EMEA")).toBe(false);
  });

  it("answers region membership for the boards' region grammar", () => {
    expect(remoteRegionIncludesCountry("EMEA", "portugal")).toBe(true);
    expect(remoteRegionIncludesCountry("Europe", "portugal")).toBe(true);
    expect(remoteRegionIncludesCountry("Europe", "united states")).toBe(false);
    expect(remoteRegionIncludesCountry("LATAM", "brazil")).toBe(true);
    expect(remoteRegionIncludesCountry("APAC", "japan")).toBe(true);
    expect(remoteRegionIncludesCountry("Americas", "canada")).toBe(true);
    expect(remoteRegionIncludesCountry("North America", "portugal")).toBe(
      false,
    );
  });

  it("drops a trailing 'Only' (We Work Remotely grammar)", () => {
    expect(remoteRegionIncludesCountry("Europe Only", "portugal")).toBe(true);
    expect(remoteRegionIncludesCountry("UK/EU Only", "united kingdom")).toBe(
      true,
    );
  });

  it("normalises aliases and diacritics through the shared tokenizer", () => {
    // "Türkiye" tokenizes with the diacritic stripped; the country key goes
    // through the alias map, so both sides meet at "turkey" ∈ EMEA.
    expect(remoteRegionIncludesCountry("EMEA", "türkiye")).toBe(true);
    expect(remoteRegionIncludesCountry("emea", "UK")).toBe(true);
  });

  it("answers false for unknown regions — the matcher treats that as a reject", () => {
    expect(remoteRegionIncludesCountry("Nordics", "sweden")).toBe(false);
    expect(remoteRegionIncludesCountry("", "portugal")).toBe(false);
  });
});
