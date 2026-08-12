import { describe, expect, it } from "vitest";
import {
  findDisagreements,
  formatPercent,
  summarizeConfig,
} from "./scoring-bench";
import type { BenchCell, BenchConfig, BenchJob } from "./types/scoring-bench";

const jobs: BenchJob[] = [
  { id: "j1", title: "One", employer: "A", jobUrl: null },
  { id: "j2", title: "Two", employer: "B", jobUrl: null },
  { id: "j3", title: "Three", employer: "C", jobUrl: null },
];

const configs: BenchConfig[] = [
  { id: "ref", label: "Reference", model: "big", effort: null },
  { id: "cheap", label: "Cheap", model: "small", effort: null },
];

function cell(
  overrides: Partial<BenchCell> & Pick<BenchCell, "jobId" | "configId">,
): BenchCell {
  return {
    status: "done",
    category: null,
    reason: null,
    error: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
    ...overrides,
  };
}

describe("summarizeConfig", () => {
  it("scores agreement only over jobs both configs classified", () => {
    const cells = [
      cell({ jobId: "j1", configId: "ref", category: "great_fit" }),
      cell({ jobId: "j2", configId: "ref", category: "good_fit" }),
      cell({ jobId: "j3", configId: "ref", category: "bad_fit" }),
      cell({ jobId: "j1", configId: "cheap", category: "great_fit" }),
      cell({ jobId: "j2", configId: "cheap", category: "bad_fit" }),
      // j3 failed for the cheap config: a gap, not a disagreement, so it must
      // not enter either the numerator or the denominator.
      cell({
        jobId: "j3",
        configId: "cheap",
        status: "error",
        error: "boom",
      }),
    ];

    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: "ref",
      cells,
    });

    expect(summary.comparable).toBe(2);
    expect(summary.agreement).toBe(0.5);
    expect(summary.classified).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("counts a one-tier gap as within-one but not as exact", () => {
    const cells = [
      cell({ jobId: "j1", configId: "ref", category: "great_fit" }),
      cell({ jobId: "j1", configId: "cheap", category: "very_good_fit" }),
      cell({ jobId: "j2", configId: "ref", category: "good_fit" }),
      cell({ jobId: "j2", configId: "cheap", category: "great_fit" }),
    ];

    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: "ref",
      cells,
    });

    expect(summary.agreement).toBe(0);
    expect(summary.withinOneTier).toBe(0.5);
  });

  it("reports no agreement rate for the reference itself", () => {
    const cells = [
      cell({ jobId: "j1", configId: "ref", category: "good_fit" }),
    ];

    const summary = summarizeConfig({
      configId: "ref",
      referenceConfigId: "ref",
      cells,
    });

    expect(summary.agreement).toBeNull();
    expect(summary.comparable).toBe(0);
  });

  it("averages total tokens per job and keeps 'unreported' distinct from zero", () => {
    const cells = [
      cell({
        jobId: "j1",
        configId: "cheap",
        category: "good_fit",
        promptTokens: 1000,
        completionTokens: 50,
      }),
      cell({
        jobId: "j2",
        configId: "cheap",
        category: "good_fit",
        promptTokens: 2000,
        completionTokens: 150,
      }),
      // Reports nothing (codex) — excluded from the mean rather than counted
      // as a free call.
      cell({ jobId: "j3", configId: "cheap", category: "bad_fit" }),
    ];

    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: null,
      cells,
    });

    expect(summary.avgTotalTokens).toBe(1600);
  });

  it("returns null average tokens when the provider reports none at all", () => {
    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: null,
      cells: [cell({ jobId: "j1", configId: "cheap", category: "good_fit" })],
    });

    expect(summary.avgTotalTokens).toBeNull();
  });
});

describe("findDisagreements", () => {
  it("lists only jobs where two or more configs produced different categories", () => {
    const cells = [
      cell({ jobId: "j1", configId: "ref", category: "great_fit" }),
      cell({ jobId: "j1", configId: "cheap", category: "great_fit" }),
      cell({ jobId: "j2", configId: "ref", category: "great_fit" }),
      cell({ jobId: "j2", configId: "cheap", category: "bad_fit" }),
      // Only one side classified — a gap, not a disagreement.
      cell({ jobId: "j3", configId: "ref", category: "good_fit" }),
      cell({ jobId: "j3", configId: "cheap", status: "error", error: "boom" }),
    ];

    const rows = findDisagreements({ jobs, configs, cells });

    expect(rows.map((row) => row.job.id)).toEqual(["j2"]);
    expect(rows[0].cells).toHaveLength(2);
  });

  it("is empty while nothing has been classified yet", () => {
    const cells = jobs.flatMap((job) =>
      configs.map((config) =>
        cell({ jobId: job.id, configId: config.id, status: "pending" }),
      ),
    );

    expect(findDisagreements({ jobs, configs, cells })).toEqual([]);
  });
});

describe("formatPercent", () => {
  it("renders an em dash for an absent rate rather than 0%", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.666)).toBe("67%");
  });
});
