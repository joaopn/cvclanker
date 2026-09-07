import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_SOURCE_IDS,
  EXTRACTOR_SOURCE_METADATA,
  extractorSourceEnum,
  isExtractorSourceId,
  PIPELINE_EXTRACTOR_SOURCE_IDS,
  sourceLabel,
} from "./index";

describe("extractor source catalog", () => {
  it("validates known source ids", () => {
    for (const source of EXTRACTOR_SOURCE_IDS) {
      expect(extractorSourceEnum.parse(source)).toBe(source);
      expect(isExtractorSourceId(source)).toBe(true);
    }
  });

  it("rejects unknown source ids", () => {
    expect(isExtractorSourceId("unknown-source")).toBe(false);
    expect(() => extractorSourceEnum.parse("unknown-source")).toThrow();
  });

  it("provides metadata for every known source", () => {
    for (const source of EXTRACTOR_SOURCE_IDS) {
      expect(EXTRACTOR_SOURCE_METADATA[source]).toBeDefined();
      expect(EXTRACTOR_SOURCE_METADATA[source].label.length).toBeGreaterThan(0);
    }
  });

  it("keeps a retired source known but never offers it to the pipeline", () => {
    // This triple IS the retirement contract (B70). Dropping `glassdoor` from
    // EXTRACTOR_SOURCE_IDS would break every historical row that carries it;
    // leaving it in PIPELINE_EXTRACTOR_SOURCE_IDS would keep offering a source
    // that cannot work. Nothing else in the suite pins either half.
    expect(EXTRACTOR_SOURCE_IDS).toContain("glassdoor");
    expect(EXTRACTOR_SOURCE_METADATA.glassdoor.retired).toBe(true);
    expect(PIPELINE_EXTRACTOR_SOURCE_IDS).not.toContain("glassdoor");
    // Historical rows must still render a real label.
    expect(sourceLabel("glassdoor")).toBe("Glassdoor");
    expect(isExtractorSourceId("glassdoor")).toBe(true);
  });

  it("offers every non-retired pipeline source", () => {
    // Guards the filter from over-reaching: only retired sources drop out.
    for (const source of EXTRACTOR_SOURCE_IDS) {
      const meta = EXTRACTOR_SOURCE_METADATA[source];
      const offered = PIPELINE_EXTRACTOR_SOURCE_IDS.includes(source);
      expect(offered).toBe(meta.category === "pipeline" && !meta.retired);
    }
  });
});
