import * as api from "@client/api";
import { useScoringBench } from "@client/hooks/useScoringBench";
import type { BenchCell, BenchRun } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelBenchmarkingPanel } from "./ModelBenchmarkingPanel";

vi.mock("@client/api", () => ({
  startScoringBenchRun: vi.fn(),
  cancelScoringBenchRun: vi.fn(),
}));
vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@client/hooks/useScoringBench", () => ({
  useScoringBench: vi.fn(),
}));

function cell(
  jobId: string,
  configId: string,
  overrides: Partial<BenchCell> = {},
): BenchCell {
  return {
    jobId,
    configId,
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

function buildRun(overrides: Partial<BenchRun> = {}): BenchRun {
  return {
    id: "run-1",
    status: "done",
    stoppedReason: null,
    configs: [
      {
        id: "cfg-a",
        label: "Reference",
        model: "big",
        effort: null,
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
      },
      {
        id: "cfg-b",
        label: "Cheap",
        model: "small",
        effort: null,
        inputCostPerMillion: 0.3,
        outputCostPerMillion: 1.5,
      },
    ],
    jobs: [
      {
        id: "j1",
        title: "Backend Engineer",
        employer: "Acme",
        jobUrl: null,
        storedCategory: "very_good_fit",
        storedReason: "Saved earlier.",
      },
      {
        id: "j2",
        title: "Data Engineer",
        employer: "Globex",
        jobUrl: null,
        storedCategory: null,
        storedReason: null,
      },
    ],
    cells: [
      cell("j1", "cfg-a", {
        category: "great_fit",
        reason: "Strong overlap.",
        promptTokens: 1000,
        completionTokens: 100,
      }),
      cell("j1", "cfg-b", { category: "bad_fit", reason: "Missing Rust." }),
      cell("j2", "cfg-a", { category: "good_fit", reason: "Partial." }),
      cell("j2", "cfg-b", { category: "good_fit", reason: "Partial." }),
    ],
    sampleCategories: [
      "great_fit",
      "very_good_fit",
      "good_fit",
      "bad_fit",
      "unscored",
    ],
    startedAt: "2026-08-11T10:00:00Z",
    finishedAt: "2026-08-11T10:05:00Z",
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A FRESH element each time: re-rendering a referentially identical element
  // makes React bail out of the update entirely, so the component would never
  // see the new run.
  const tree = () => (
    <QueryClientProvider client={client}>
      <ModelBenchmarkingPanel layoutMode="panel" provider="openai" />
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, rerenderPanel: () => result.rerender(tree()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useScoringBench).mockReturnValue({ run: null, connected: true });
});

// Category labels now appear in three places — the sampling chips, the summary
// table's column headers, and the grid's cells — so every assertion about a
// category has to say which table it means.
function summaryTable(): HTMLElement {
  const table = Array.from(document.querySelectorAll("table")).find((entry) =>
    entry.querySelector("caption"),
  );
  if (!table) throw new Error("summary table not rendered");
  return table as HTMLElement;
}

/** Reads one cell of a summary row by its column heading. */
function summaryCell(row: HTMLElement, columnLabel: string): string {
  const headers = Array.from(summaryTable().querySelectorAll("thead th")).map(
    (header) => header.textContent?.trim(),
  );
  const index = headers.indexOf(columnLabel);
  if (index === -1) throw new Error(`no summary column "${columnLabel}"`);
  const cells = Array.from(row.querySelectorAll("th, td"));
  return cells[index]?.textContent?.trim() ?? "";
}

function resultsGrid(): HTMLElement {
  const table = Array.from(document.querySelectorAll("table")).find(
    (entry) => !entry.querySelector("caption"),
  );
  if (!table) throw new Error("results grid not rendered");
  return table as HTMLElement;
}

describe("ModelBenchmarkingPanel", () => {
  it("starts a run with the configured sample size and models", async () => {
    vi.mocked(api.startScoringBenchRun).mockResolvedValue(buildRun());
    renderPanel();

    fireEvent.change(screen.getByLabelText("Jobs to sample"), {
      target: { value: "5" },
    });
    // Queried by placeholder, not by id: draft ids come from a module-level
    // counter that keeps climbing across tests in this file.
    const modelInputs = screen.getAllByPlaceholderText("model id");
    fireEvent.change(modelInputs[0], { target: { value: "big" } });
    fireEvent.change(modelInputs[1], { target: { value: "small" } });
    fireEvent.click(screen.getByRole("button", { name: /run benchmark/i }));

    await waitFor(() => {
      expect(api.startScoringBenchRun).toHaveBeenCalledTimes(1);
    });
    // react-query passes a context object as the second argument, so only the
    // payload is asserted here.
    expect(vi.mocked(api.startScoringBenchRun).mock.calls[0][0]).toEqual({
      sampleSize: 5,
      // Every chip starts selected, so the default draw is unrestricted.
      categories: [
        "great_fit",
        "very_good_fit",
        "good_fit",
        "bad_fit",
        "unscored",
      ],
      configs: [
        {
          label: "Reference",
          model: "big",
          effort: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
        {
          label: "Candidate",
          model: "small",
          effort: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
      ],
    });
  });

  it("sends a blank model through — the server resolves it to the configured one", async () => {
    // The claude_code case: its configured model is legitimately empty, so
    // requiring one here would make comparing efforts alone impossible.
    vi.mocked(api.startScoringBenchRun).mockResolvedValue(buildRun());
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /run benchmark/i }));

    await waitFor(() => {
      expect(api.startScoringBenchRun).toHaveBeenCalledTimes(1);
    });
    expect(
      vi.mocked(api.startScoringBenchRun).mock.calls[0][0].configs[0].model,
    ).toBe("");
  });

  it("rejects a sample size below one without calling the API", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Jobs to sample"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run benchmark/i }));

    await waitFor(() => {
      expect(api.startScoringBenchRun).not.toHaveBeenCalled();
    });
  });

  it("renders one column per config and a category per cell", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    const grid = within(resultsGrid());
    expect(grid.getByText("Backend Engineer")).toBeInTheDocument();
    expect(grid.getAllByText("Good fit")).toHaveLength(2);
    expect(grid.getByText("Great fit")).toBeInTheDocument();
    expect(grid.getByText("Bad fit")).toBeInTheDocument();
  });

  it("splits input and output tokens, and shows a dash when unreported", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    const rows = within(summaryTable()).getAllByRole("row");
    // cfg-a reported 1000 in / 100 out on its one usage-bearing cell.
    expect(summaryCell(rows[1], "Avg in")).toMatch(/1[\s,.]?000/);
    expect(summaryCell(rows[1], "Avg out")).toBe("100");
    // cfg-b reported nothing: unavailable, never zero.
    expect(summaryCell(rows[2], "Avg in")).toBe("—");
    expect(summaryCell(rows[2], "Avg out")).toBe("—");
  });

  it("estimates cost from the configured rates and compares it to the reference", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    const rows = within(summaryTable()).getAllByRole("row");
    // 1000 input at 3/M + 100 output at 15/M = 0.0045.
    expect(summaryCell(rows[1], "Est. cost")).toBe("0.0045");
    expect(summaryCell(rows[1], "× ref")).toBe("1×");
    // cfg-b priced at a tenth, but it reported no usage, so there is nothing
    // to price and the multiplier has no basis.
    expect(summaryCell(rows[2], "Est. cost")).toBe("—");
    expect(summaryCell(rows[2], "× ref")).toBe("—");
  });

  it("prices a cheaper column as a fraction of the reference", () => {
    const run = buildRun();
    const priced = {
      ...run,
      cells: run.cells.map((cell) =>
        cell.configId === "cfg-b"
          ? { ...cell, promptTokens: 1000, completionTokens: 100 }
          : cell,
      ),
    };
    vi.mocked(useScoringBench).mockReturnValue({
      run: priced,
      connected: true,
    });
    renderPanel();

    const rows = within(summaryTable()).getAllByRole("row");
    // cfg-b is priced at a tenth of cfg-a on identical token counts, and both
    // classified the same jobs.
    expect(summaryCell(rows[2], "× ref")).toBe("0.10×");
  });

  it("shows the agreement percentages and the denominator behind them", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    const rows = within(summaryTable()).getAllByRole("row");
    // cfg-b matches cfg-a on j2 and is three tiers away on j1 (great vs bad),
    // so the ±1 rate must NOT rescue it.
    expect(summaryCell(rows[2], "Same")).toBe("50%");
    expect(summaryCell(rows[2], "±1 tier")).toBe("50%");
    expect(summaryCell(rows[2], "Compared")).toBe("2");
    // The saved column classified only j1 (very_good_fit vs cfg-a's great_fit).
    expect(summaryCell(rows[3], "Same")).toBe("0%");
    expect(summaryCell(rows[3], "Compared")).toBe("1");
  });

  it("opens the disagreement dialog with each config's reasoning", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: /review 1 disagreement/i }),
    );

    expect(screen.getByText("Missing Rust.")).toBeInTheDocument();
    expect(screen.getByText("Strong overlap.")).toBeInTheDocument();
    // The agreeing job is not offered as a disagreement.
    expect(screen.queryByText("Partial.")).not.toBeInTheDocument();
  });

  it("offers Stop instead of Run while a run is in flight", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun({ status: "running", finishedAt: null }),
      connected: true,
    });
    renderPanel();

    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run benchmark/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the reason a run was stopped by the provider", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun({
        status: "stopped",
        stoppedReason: "Scoring stopped — the LLM provider is rate limiting",
      }),
      connected: true,
    });
    renderPanel();

    expect(screen.getByText(/rate limiting/i)).toBeInTheDocument();
  });
});

describe("ModelBenchmarkingPanel sampling filter", () => {
  it("starts with every fit chip selected", () => {
    renderPanel();

    for (const label of [
      "Great fit",
      "Very good fit",
      "Good fit",
      "Bad fit",
      "Unscored",
    ]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
  });

  it("sends only the chips left selected", async () => {
    vi.mocked(api.startScoringBenchRun).mockResolvedValue(buildRun());
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Great fit" }));
    fireEvent.click(screen.getByRole("button", { name: "Unscored" }));
    fireEvent.click(screen.getByRole("button", { name: /run benchmark/i }));

    await waitFor(() => {
      expect(api.startScoringBenchRun).toHaveBeenCalledTimes(1);
    });
    expect(
      vi.mocked(api.startScoringBenchRun).mock.calls[0][0].categories,
    ).toEqual(["very_good_fit", "good_fit", "bad_fit"]);
  });

  it("refuses to run with no category selected", async () => {
    renderPanel();

    for (const label of [
      "Great fit",
      "Very good fit",
      "Good fit",
      "Bad fit",
      "Unscored",
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    fireEvent.click(screen.getByRole("button", { name: /run benchmark/i }));

    await waitFor(() => {
      expect(api.startScoringBenchRun).not.toHaveBeenCalled();
    });
  });
});

describe("ModelBenchmarkingPanel results", () => {
  it("shows the value saved on each job as its own column", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    const grid = within(resultsGrid());
    expect(grid.getByText("Saved in database")).toBeInTheDocument();
    // j1 carries a saved category, j2 has never been scored.
    expect(grid.getByText("Very good fit")).toBeInTheDocument();
  });

  it("summarises every column above the grid, database included", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    const summary = screen.getByText(/Summary — 2 jobs sampled/);
    const table = summary.closest("table");
    expect(table).not.toBeNull();
    const rowHeaders = Array.from(
      table?.querySelectorAll("tbody tr th[scope='row']") ?? [],
    ).map((cell) => cell.textContent);
    expect(rowHeaders[0]).toContain("Reference");
    expect(rowHeaders[1]).toContain("Cheap");
    expect(rowHeaders[2]).toContain("Saved in database");
  });

  it("pages the grid at 20 jobs and does not page a short sample", () => {
    const run = buildRun();
    const many = {
      ...run,
      jobs: Array.from({ length: 25 }, (_, index) => ({
        id: `job-${index}`,
        title: `Job ${index}`,
        employer: "Acme",
        jobUrl: null,
        storedCategory: null,
        storedReason: null,
      })),
      cells: [],
    };
    vi.mocked(useScoringBench).mockReturnValue({ run: many, connected: true });
    const { rerenderPanel } = renderPanel();

    expect(screen.getByText("Showing 1–20 of 25")).toBeInTheDocument();
    expect(screen.getByText("Job 0")).toBeInTheDocument();
    expect(screen.queryByText("Job 20")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("Showing 21–25 of 25")).toBeInTheDocument();
    expect(screen.getByText("Job 20")).toBeInTheDocument();
    expect(screen.queryByText("Job 0")).not.toBeInTheDocument();

    // A DIFFERENT run arriving (started elsewhere) must reset the page rather
    // than dropping the reader in the middle of a sample they've never seen.
    vi.mocked(useScoringBench).mockReturnValue({
      run: { ...many, id: "run-2" },
      connected: true,
    });
    rerenderPanel();
    expect(screen.getByText("Showing 1–20 of 25")).toBeInTheDocument();

    // The same panel, now looking at a 2-job run: the pager must disappear and
    // the retained page index must not strand it past the end.
    vi.mocked(useScoringBench).mockReturnValue({ run, connected: true });
    rerenderPanel();
    expect(screen.queryByText(/Showing /)).not.toBeInTheDocument();
    expect(
      within(resultsGrid()).getByText("Backend Engineer"),
    ).toBeInTheDocument();
  });
});
