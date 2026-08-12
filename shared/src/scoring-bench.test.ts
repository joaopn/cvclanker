import { describe, expect, it } from "vitest";
import {
  buildStoredCells,
  categoryCounts,
  configSubtitle,
  costMultiplier,
  findDisagreements,
  formatPercent,
  STORED_COLUMN,
  STORED_COLUMN_ID,
  summarizeConfig,
} from "./scoring-bench";
import type { BenchCell, BenchConfig, BenchJob } from "./types/scoring-bench";

function benchJob(id: string, overrides: Partial<BenchJob> = {}): BenchJob {
  return {
    id,
    title: id,
    employer: "A",
    jobUrl: null,
    storedCategory: null,
    storedReason: null,
    ...overrides,
  };
}

const jobs: BenchJob[] = [benchJob("j1"), benchJob("j2"), benchJob("j3")];

function benchConfig(
  id: string,
  overrides: Partial<BenchConfig> = {},
): BenchConfig {
  return {
    id,
    label: id,
    model: id,
    effort: null,
    inputCostPerMillion: null,
    outputCostPerMillion: null,
    ...overrides,
  };
}

const configs: BenchConfig[] = [
  benchConfig("ref", { label: "Reference", model: "big" }),
  benchConfig("cheap", { label: "Cheap", model: "small" }),
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

  it("averages input and output separately, and keeps 'unreported' distinct from zero", () => {
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

    expect(summary.avgPromptTokens).toBe(1500);
    expect(summary.avgCompletionTokens).toBe(100);
  });

  it("returns null average tokens when the provider reports none at all", () => {
    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: null,
      cells: [cell({ jobId: "j1", configId: "cheap", category: "good_fit" })],
    });

    expect(summary.avgPromptTokens).toBeNull();
    expect(summary.avgCompletionTokens).toBeNull();
    expect(summary.estimatedCost).toBeNull();
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

describe("buildStoredCells", () => {
  it("turns each job's saved value into a cell of the stored column", () => {
    const cells = buildStoredCells([
      benchJob("j1", {
        storedCategory: "good_fit",
        storedReason: "Scored last week.",
      }),
      benchJob("j2"),
    ]);

    expect(cells).toEqual([
      {
        jobId: "j1",
        configId: STORED_COLUMN_ID,
        status: "done",
        category: "good_fit",
        reason: "Scored last week.",
        error: null,
        promptTokens: null,
        completionTokens: null,
        durationMs: null,
      },
      expect.objectContaining({
        jobId: "j2",
        configId: STORED_COLUMN_ID,
        status: "pending",
        category: null,
      }),
    ]);
  });

  it("keeps an unscored job out of every rate, exactly like a failed cell", () => {
    // Half the sample has never been classified; the saved column must be
    // measured over the half that has, not scored 50% for the gap.
    const storedCells = buildStoredCells([
      benchJob("j1", { storedCategory: "good_fit" }),
      benchJob("j2"),
    ]);
    const modelCells = [
      cell({ jobId: "j1", configId: "cheap", category: "good_fit" }),
      cell({ jobId: "j2", configId: "cheap", category: "bad_fit" }),
    ];

    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: STORED_COLUMN_ID,
      cells: [...storedCells, ...modelCells],
    });

    expect(summary.comparable).toBe(1);
    expect(summary.agreement).toBe(1);
  });

  it("makes a job only the database classified a gap, not a disagreement", () => {
    const cells = [
      ...buildStoredCells([
        benchJob("j1", { storedCategory: "great_fit" }),
        benchJob("j2", { storedCategory: "bad_fit" }),
      ]),
      cell({ jobId: "j1", configId: "cheap", category: "great_fit" }),
      cell({ jobId: "j2", configId: "cheap", category: "great_fit" }),
    ];

    const rows = findDisagreements({
      jobs: [
        benchJob("j1", { storedCategory: "great_fit" }),
        benchJob("j2", { storedCategory: "bad_fit" }),
      ],
      configs: [benchConfig("cheap"), STORED_COLUMN],
      cells,
    });

    expect(rows.map((row) => row.job.id)).toEqual(["j2"]);
  });
});

describe("categoryCounts", () => {
  it("counts only the named column's classified cells", () => {
    const cells = [
      cell({ jobId: "j1", configId: "cheap", category: "good_fit" }),
      cell({ jobId: "j2", configId: "cheap", category: "good_fit" }),
      cell({ jobId: "j3", configId: "cheap", status: "error", error: "boom" }),
      cell({ jobId: "j1", configId: "ref", category: "great_fit" }),
    ];

    expect(categoryCounts(cells, "cheap")).toEqual({
      great_fit: 0,
      very_good_fit: 0,
      good_fit: 2,
      bad_fit: 0,
    });
  });
});

describe("cost estimates", () => {
  const priced = (rates: { input: number | null; output: number | null }) =>
    summarizeConfig({
      configId: "cheap",
      referenceConfigId: null,
      rates,
      cells: [
        cell({
          jobId: "j1",
          configId: "cheap",
          category: "good_fit",
          promptTokens: 1_000_000,
          completionTokens: 500_000,
        }),
        cell({
          jobId: "j2",
          configId: "cheap",
          category: "good_fit",
          promptTokens: 1_000_000,
          completionTokens: 500_000,
        }),
      ],
    });

  it("prices the run from the tokens actually reported", () => {
    const summary = priced({ input: 3, output: 15 });

    // 2M input at 3/M + 1M output at 15/M.
    expect(summary.estimatedCost).toBe(21);
    expect(summary.estimatedCostPerJob).toBe(10.5);
    expect(summary.pricedJobs).toBe(2);
  });

  it("divides by the jobs it could price, not by every classified job", () => {
    // One job reported usage, one did not. Dividing 6 by 2 would halve the
    // per-job figure and double every multiplier built on it.
    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: null,
      rates: { input: 3, output: null },
      cells: [
        cell({
          jobId: "j1",
          configId: "cheap",
          category: "good_fit",
          promptTokens: 2_000_000,
        }),
        cell({ jobId: "j2", configId: "cheap", category: "good_fit" }),
      ],
    });

    expect(summary.classified).toBe(2);
    expect(summary.pricedJobs).toBe(1);
    expect(summary.estimatedCost).toBe(6);
    expect(summary.estimatedCostPerJob).toBe(6);
  });

  it("flags an estimate that could only price one half", () => {
    const summary = summarizeConfig({
      configId: "cheap",
      referenceConfigId: null,
      rates: { input: 3, output: 15 },
      cells: [
        cell({
          jobId: "j1",
          configId: "cheap",
          category: "good_fit",
          promptTokens: 1_000_000,
        }),
      ],
    });

    // Output was priced but never reported, so the number is a floor.
    expect(summary.estimatedCost).toBe(3);
    expect(summary.partialEstimate).toBe(true);
    expect(priced({ input: 3, output: 15 }).partialEstimate).toBe(false);
  });

  it("prices a half-specified rate rather than refusing", () => {
    expect(priced({ input: 3, output: null }).estimatedCost).toBe(6);
  });

  it("has no estimate at all when no rate was given", () => {
    expect(priced({ input: null, output: null }).estimatedCost).toBeNull();
    expect(
      summarizeConfig({
        configId: "cheap",
        referenceConfigId: null,
        cells: [cell({ jobId: "j1", configId: "cheap", category: "good_fit" })],
      }).estimatedCost,
    ).toBeNull();
  });

  it("compares cost per job against the reference", () => {
    const expensive = priced({ input: 3, output: 15 });
    const cheap = priced({ input: 0.3, output: 1.5 });

    expect(costMultiplier(cheap, expensive)).toBeCloseTo(0.1);
    expect(costMultiplier(expensive, expensive)).toBe(1);
  });

  it("refuses a multiplier when either side carries no estimate", () => {
    const unpriced = priced({ input: null, output: null });
    const expensive = priced({ input: 3, output: 15 });

    // A ratio against an unpriced column would be a number the user could act
    // on, built from nothing.
    expect(costMultiplier(expensive, unpriced)).toBeNull();
    expect(costMultiplier(unpriced, expensive)).toBeNull();
    expect(costMultiplier(expensive, undefined)).toBeNull();
  });
});

describe("configSubtitle", () => {
  it("never claims the saved column came from the provider's default model", () => {
    expect(configSubtitle(STORED_COLUMN)).toBe("saved on the job");
  });

  it("names the model, with the effort when there is one", () => {
    expect(configSubtitle(benchConfig("c", { model: "m" }))).toBe("m");
    expect(
      configSubtitle(benchConfig("c", { model: "m", effort: "low" })),
    ).toBe("m · low");
    expect(configSubtitle(benchConfig("c", { model: "" }))).toBe(
      "provider default",
    );
  });
});
