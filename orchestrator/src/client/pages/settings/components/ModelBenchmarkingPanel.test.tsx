import * as api from "@client/api";
import { useScoringBench } from "@client/hooks/useScoringBench";
import type { BenchCell, BenchRun } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      { id: "cfg-a", label: "Reference", model: "big", effort: null },
      { id: "cfg-b", label: "Cheap", model: "small", effort: null },
    ],
    jobs: [
      {
        id: "j1",
        title: "Backend Engineer",
        employer: "Acme",
        jobUrl: null,
      },
      { id: "j2", title: "Data Engineer", employer: "Globex", jobUrl: null },
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
    startedAt: "2026-08-11T10:00:00Z",
    finishedAt: "2026-08-11T10:05:00Z",
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ModelBenchmarkingPanel layoutMode="panel" provider="openai" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useScoringBench).mockReturnValue({ run: null, connected: true });
});

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
      configs: [
        { label: "Reference", model: "big", effort: null },
        { label: "Candidate", model: "small", effort: null },
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

    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getAllByText("Good fit")).toHaveLength(2);
    expect(screen.getByText("Great fit")).toBeInTheDocument();
    expect(screen.getByText("Bad fit")).toBeInTheDocument();
  });

  it("shows the average token count per config, and a dash when unreported", () => {
    vi.mocked(useScoringBench).mockReturnValue({
      run: buildRun(),
      connected: true,
    });
    renderPanel();

    // cfg-a reported 1000 + 100 on its one usage-bearing cell.
    expect(screen.getByText(/1[\s,.]?100 avg tokens/)).toBeInTheDocument();
    expect(screen.getByText(/— avg tokens/)).toBeInTheDocument();
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
