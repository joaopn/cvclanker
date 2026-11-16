// @vitest-environment node
import type { CvField } from "@shared/types";
import { describe, expect, it } from "vitest";
import { buildCvText, recomputeAtsCoverage } from "./ats-coverage";

describe("recomputeAtsCoverage", () => {
  it("partitions keywords by literal presence in the CV text", () => {
    const text = "Built Kubernetes pipelines with Terraform and Go.";
    const result = recomputeAtsCoverage(text, [
      "Kubernetes",
      "Terraform",
      "Rust",
    ]);
    expect(result.matched).toEqual(["Kubernetes", "Terraform"]);
    expect(result.skipped).toEqual(["Rust"]);
  });

  it("matches case-insensitively but preserves the original casing", () => {
    const result = recomputeAtsCoverage("expert in GRAPHQL apis", [
      "GraphQL",
    ]);
    expect(result.matched).toEqual(["GraphQL"]);
    expect(result.skipped).toEqual([]);
  });

  it("trims keywords and drops empties", () => {
    const result = recomputeAtsCoverage("python and sql", [
      "  python  ",
      "   ",
      "",
    ]);
    expect(result.matched).toEqual(["python"]);
    expect(result.skipped).toEqual([]);
  });

  it("collapses duplicate keywords (case-insensitive)", () => {
    const result = recomputeAtsCoverage("docker everywhere", [
      "Docker",
      "docker",
      "DOCKER",
    ]);
    expect(result.matched).toEqual(["Docker"]);
    expect(result.skipped).toEqual([]);
  });

  it("returns empty partitions for an empty keyword set", () => {
    const result = recomputeAtsCoverage("anything", []);
    expect(result).toEqual({ matched: [], skipped: [] });
  });
});

describe("buildCvText", () => {
  const fields: CvField[] = [
    { id: "basics.name", role: "name", value: "Ada Lovelace" },
    { id: "experience.0.bullet", role: "bullet", value: "Wrote algorithms" },
  ];

  it("uses the source default when no override exists", () => {
    expect(buildCvText(fields, {}, "latex")).toBe(
      "Ada Lovelace\nWrote algorithms",
    );
  });

  it("prefers the per-job override over the source default", () => {
    const text = buildCvText(
      fields,
      { "experience.0.bullet": "Shipped Kubernetes operators" },
      "latex",
    );
    expect(text).toBe("Ada Lovelace\nShipped Kubernetes operators");
  });

  it("reads an HTML value as text, and leaves other formats' values alone", () => {
    const overrides = {
      "experience.0.bullet": "<b>Apache</b> <b>Kafka</b> R&amp;D",
    };
    expect(buildCvText(fields, overrides, "html")).toBe(
      "Ada Lovelace\nApache Kafka R&D",
    );
    expect(buildCvText(fields, overrides, "docx")).toBe(
      "Ada Lovelace\n<b>Apache</b> <b>Kafka</b> R&amp;D",
    );
  });
});
