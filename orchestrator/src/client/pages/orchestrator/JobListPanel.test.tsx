import { setupWindowVirtualizerTestEnvironment } from "@client/test/virtualization";
import { createJob } from "@shared/testing/factories.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusTokens } from "./constants";
import { JobListPanel } from "./JobListPanel";

const createJobs = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    createJob({
      id: `job-${index + 1}`,
      title: `Job ${index + 1}`,
      employer: `Employer ${index + 1}`,
    }),
  );

let virtualizationEnvironment: ReturnType<
  typeof setupWindowVirtualizerTestEnvironment
> | null = null;

beforeEach(() => {
  // Run this file under fake timers (auto-advanced so real-time-based
  // `waitFor`/async still progress normally). This makes @tanstack/virtual-core's
  // debounced `maybeNotify` setTimeout a FAKE timer we can cancel at teardown —
  // otherwise it occasionally fires after jsdom is torn down and crashes with
  // `ReferenceError: window is not defined` from React's `getCurrentEventPriority`.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Default environment: the element-mode virtualizer needs ResizeObserver
  // and a non-zero `getBoundingClientRect` on its scroll container, or it
  // sees an empty viewport in jsdom and renders zero rows. Individual
  // tests may override by reassigning `virtualizationEnvironment` with
  // their own settings before render.
  virtualizationEnvironment = setupWindowVirtualizerTestEnvironment();
});

afterEach(() => {
  virtualizationEnvironment?.cleanup();
  virtualizationEnvironment = null;
  // Unmount before clearing so react-virtual's listener is unsubscribed.
  cleanup();
  // Cancel virtual-core's pending debounced notify (and any other queued timer)
  // deterministically, while jsdom is still alive, so it can't dispatch into
  // React after teardown.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("JobListPanel", () => {
  it("shows a loading state when fetching jobs", () => {
    render(
      <JobListPanel
        isLoading
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />,
    );

    expect(screen.getByText("Loading jobs...")).toBeInTheDocument();
  });

  it("shows the tab empty state copy when no jobs exist", () => {
    render(
      <JobListPanel
        isLoading={false}
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        primaryEmptyStateAction={{
          label: "Tailor discovered jobs",
          onClick: vi.fn(),
        }}
        secondaryEmptyStateAction={{
          label: "Run pipeline",
          onClick: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText("No jobs found")).toBeInTheDocument();
    expect(screen.getByText(/Nothing in tailoring yet/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /tailor discovered jobs/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run pipeline/i }),
    ).toBeInTheDocument();
  });

  it("fires empty state actions when provided", () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();

    render(
      <JobListPanel
        isLoading={false}
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        primaryEmptyStateAction={{
          label: "Tailor discovered jobs",
          onClick: onPrimary,
        }}
        secondaryEmptyStateAction={{
          label: "Run pipeline",
          onClick: onSecondary,
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /tailor discovered jobs/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /run pipeline/i }));

    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it("prefers a custom empty state message when provided", () => {
    render(
      <JobListPanel
        isLoading={false}
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="all"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        emptyStateMessage="No applied jobs found for this date range."
      />,
    );

    expect(
      screen.getByText("No applied jobs found for this date range."),
    ).toBeInTheDocument();
  });

  it("renders the filter bar and a filters-active empty state", () => {
    render(
      <JobListPanel
        isLoading={false}
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="inbox"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        filterBar={<div>FILTER_BAR_SLOT</div>}
        filtersActive
      />,
    );

    expect(screen.getByText("FILTER_BAR_SLOT")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No jobs match your filters. Adjust or clear the filters above.",
      ),
    ).toBeInTheDocument();
  });

  it("stops blaming the fit filter when another family is also narrowing", () => {
    // Fit is ticked by default, so fit + a profile badge is the common case.
    // Offering "Clear fit filter" there sends the user to a button that leaves
    // the list just as empty.
    render(
      <JobListPanel
        isLoading={false}
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="inbox"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        fitFilter={["good_fit"]}
        onFitFilterChange={vi.fn()}
        filterBar={<div>FILTER_BAR_SLOT</div>}
        filtersActive
      />,
    );

    expect(
      screen.getByText(
        "No jobs match your filters. Adjust or clear the filters above.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear fit filter" }),
    ).not.toBeInTheDocument();
  });

  it("still offers the fit escape hatch when fit is the only filter", () => {
    const onFitFilterChange = vi.fn();
    render(
      <JobListPanel
        isLoading={false}
        jobs={[]}
        activeJobs={[]}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="inbox"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        fitFilter={["good_fit"]}
        onFitFilterChange={onFitFilterChange}
        filterBar={<div>FILTER_BAR_SLOT</div>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear fit filter" }));
    expect(onFitFilterChange).toHaveBeenCalledWith([]);
  });

  it("renders the filter bar alongside the stale controls with rows present", () => {
    const jobs = createJobs(2);

    render(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="stale"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
        // Stale always ships both bars in production, so render them together
        // rather than testing either in isolation.
        staleControlBar={<div>STALE_CONTROL_BAR_SLOT</div>}
        filterBar={<div>FILTER_BAR_SLOT</div>}
      />,
    );

    expect(screen.getByText("STALE_CONTROL_BAR_SLOT")).toBeInTheDocument();
    expect(screen.getByText("FILTER_BAR_SLOT")).toBeInTheDocument();
  });

  it("keeps the Untailored toggle in the header on the tailoring tab only", () => {
    const onUntailoredOnlyChange = vi.fn();
    const jobs = createJobs(2);
    const props = {
      isLoading: false,
      jobs,
      activeJobs: jobs,
      selectedJobId: null,
      selectedJobIds: new Set<string>(),
      onSelectJob: vi.fn(),
      onToggleSelectJob: vi.fn(),
      onToggleSelectAll: vi.fn(),
      untailoredOnly: false,
      onUntailoredOnlyChange,
    };

    const { unmount } = render(
      <JobListPanel {...props} activeTab="tailoring" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Untailored" }));
    expect(onUntailoredOnlyChange).toHaveBeenCalledWith(true);
    unmount();

    render(<JobListPanel {...props} activeTab="inbox" />);
    expect(
      screen.getByLabelText("Select all filtered jobs"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Untailored" }),
    ).not.toBeInTheDocument();
  });

  it("renders jobs and notifies when a job is selected", () => {
    const onSelectJob = vi.fn();
    const onToggleSelectJob = vi.fn();
    const onToggleSelectAll = vi.fn();
    const jobs = [
      createJob({ id: "job-1", title: "Backend Engineer" }),
      createJob({
        id: "job-2",
        title: "Frontend Engineer",
        employer: "Globex",
      }),
    ];

    render(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId="job-1"
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={onSelectJob}
        onToggleSelectJob={onToggleSelectJob}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Backend Engineer/i }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /Frontend Engineer/i }));
    expect(onSelectJob).toHaveBeenCalledWith("job-2");
  });

  const renderRows = (jobs: ReturnType<typeof createJob>[]) =>
    render(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />,
    );

  it("tints the status dot when the employer has other jobs in flight", () => {
    renderRows([
      createJob({
        id: "job-1",
        title: "Backend Engineer",
        employer: "Acme Labs",
        companyInFlightCount: 2,
      }),
    ]);

    // The warning is the dot alone — no inline badge competing with the row.
    expect(screen.queryByText(/in flight at/)).not.toBeInTheDocument();
    const dot = screen.getByTitle(
      "2 other jobs in flight at Acme Labs (tailoring, applied or interviewing)",
    );
    expect(dot).toHaveClass("bg-status-warn");
  });

  it("leaves the dot alone when nothing else at that employer is in flight", () => {
    renderRows([
      createJob({
        id: "job-1",
        title: "Backend Engineer",
        employer: "Acme Labs",
        status: "ready",
        companyInFlightCount: 0,
      }),
    ]);

    expect(screen.queryByText(/in flight at/)).not.toBeInTheDocument();
    expect(document.querySelector(".bg-status-warn")).toBeNull();
  });

  it("does not tint on a row the server did not annotate", () => {
    // The field is optional: a response that predates this hydration, or any
    // caller the route does not annotate, must render exactly as before. This
    // pins the `?? 0` specifically — the row must still carry a NORMAL status
    // dot, which an `undefined > 0` comparison alone would also produce, but a
    // thrown or blank render would not.
    const job = createJob({
      id: "job-1",
      employer: "Acme Labs",
      status: "discovered",
    });
    delete (job as { companyInFlightCount?: number }).companyInFlightCount;
    renderRows([job]);

    expect(document.querySelector(".bg-status-warn")).toBeNull();
    // The row still renders its NORMAL status dot rather than nothing.
    expect(
      document.querySelector(`.${statusTokens.discovered.dot}`),
    ).not.toBeNull();
  });

  it("toggles row selection and select-all", () => {
    const onToggleSelectJob = vi.fn();
    const onToggleSelectAll = vi.fn();
    const jobs = [
      createJob({ id: "job-1", title: "Backend Engineer" }),
      createJob({ id: "job-2", title: "Frontend Engineer" }),
    ];

    render(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId="job-1"
        selectedJobIds={new Set(["job-1"])}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={onToggleSelectJob}
        onToggleSelectAll={onToggleSelectAll}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select Backend Engineer"));
    expect(onToggleSelectJob).toHaveBeenCalledWith("job-1");

    fireEvent.click(screen.getByLabelText("Select all filtered jobs"));
    expect(onToggleSelectAll).toHaveBeenCalledWith(true);
  });

  it("shows checkbox only for selected or checked rows", () => {
    const jobs = [createJob({ id: "job-1", title: "Backend Engineer" })];
    const { rerender } = render(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId={null}
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Select Backend Engineer")).toHaveClass(
      "opacity-0",
    );

    rerender(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId="job-1"
        selectedJobIds={new Set()}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Select Backend Engineer")).toHaveClass(
      "opacity-100",
    );

    rerender(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId={null}
        selectedJobIds={new Set(["job-1"])}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Select Backend Engineer")).toHaveClass(
      "opacity-100",
    );
  });

  it("keeps large lists virtualized and scrolls offscreen rows into view", async () => {
    virtualizationEnvironment?.cleanup();
    virtualizationEnvironment = setupWindowVirtualizerTestEnvironment({
      viewportHeight: 240,
      rowHeight: 72,
    });
    const jobs = createJobs(40);

    render(
      <JobListPanel
        isLoading={false}
        jobs={jobs}
        activeJobs={jobs}
        selectedJobId="job-1"
        selectedJobIds={new Set(["job-1"])}
        activeTab="tailoring"
        onSelectJob={vi.fn()}
        onToggleSelectJob={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("select-job-35")).not.toBeInTheDocument();
    const renderedRows = screen.getAllByTestId(/select-job-/);
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(jobs.length);

    const scrollContainer = screen.getByTestId("job-list-scroll");
    act(() => {
      scrollContainer.scrollTop = 2800;
      scrollContainer.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("select-job-35")).toBeInTheDocument();
    });
  });
});
