import type { JobSource } from "@shared/types.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AppliedFilter,
  FilterTab,
  JobSort,
  SponsorFilter,
} from "./constants";
import { OrchestratorFilters } from "./OrchestratorFilters";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: originalScrollIntoView,
  });
});

const renderFilters = (
  overrides?: Partial<ComponentProps<typeof OrchestratorFilters>>,
) => {
  const props = {
    activeTab: "tailoring" as FilterTab,
    onTabChange: vi.fn(),
    counts: {
      inbox: 1,
      tailoring: 2,
      live: 3,
      interviewing: 0,
      backlog: 0,
      stale: 0,
      closed: 0,
      all: 6,
    },
    onOpenCommandBar: vi.fn(),
    sourceFilter: "all" as const,
    onSourceFilterChange: vi.fn(),
    sponsorFilter: "all" as SponsorFilter,
    onSponsorFilterChange: vi.fn(),
    salaryFilter: {
      mode: "at_least" as const,
      min: null,
      max: null,
    },
    onSalaryFilterChange: vi.fn(),
    dateFilter: {
      dimensions: [],
      startDate: null,
      endDate: null,
      preset: null,
    },
    onDateFilterChange: vi.fn(),
    appliedFilter: "all" as AppliedFilter,
    onAppliedFilterChange: vi.fn(),
    maxAgeDays: null,
    onMaxAgeDaysChange: vi.fn(),
    sourcesWithJobs: ["hiringcafe", "linkedin", "manual"] as JobSource[],
    sort: { key: "score", direction: "desc" } as JobSort,
    onSortChange: vi.fn(),
    onResetFilters: vi.fn(),
    filteredCount: 5,
    ...overrides,
  };

  return {
    props,
    ...render(<OrchestratorFilters {...props} />),
  };
};

describe("OrchestratorFilters", () => {
  it("notifies when tabs and command search shortcut are used", () => {
    const { props } = renderFilters();

    fireEvent.mouseDown(screen.getByRole("tab", { name: /live/i }));
    expect(props.onTabChange).toHaveBeenCalledWith("live");

    fireEvent.click(screen.getByRole("button", { name: /search jobs/i }));
    expect(props.onOpenCommandBar).toHaveBeenCalled();
  });

  it("updates source, sponsor, salary range, and sort from the drawer", async () => {
    const { props } = renderFilters();

    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));

    fireEvent.click(await screen.findByRole("button", { name: /linkedin/i }));
    expect(props.onSourceFilterChange).toHaveBeenCalledWith("linkedin");

    fireEvent.click(screen.getByRole("button", { name: "Potential sponsor" }));
    expect(props.onSponsorFilterChange).toHaveBeenCalledWith("potential");

    fireEvent.change(screen.getByLabelText("Minimum"), {
      target: { value: "65000" },
    });
    expect(props.onSalaryFilterChange).toHaveBeenCalledWith({
      mode: "at_least",
      min: 65000,
      max: null,
    });

    fireEvent.click(
      screen.getByRole("combobox", { name: "Salary range specifier" }),
    );
    fireEvent.click(await screen.findByText("between"));
    expect(props.onSalaryFilterChange).toHaveBeenCalledWith({
      mode: "between",
      min: null,
      max: null,
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Sort field" }));
    fireEvent.click(await screen.findByText("Date"));
    expect(props.onSortChange).toHaveBeenCalledWith({
      key: "date",
      direction: "desc",
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Sort order" }));
    fireEvent.click(await screen.findByText("Smallest first"));
    expect(props.onSortChange).toHaveBeenCalledWith({
      key: "score",
      direction: "asc",
    });
  });

  it("updates date presets and custom dates from the drawer", async () => {
    const { props } = renderFilters({
      dateFilter: {
        dimensions: ["applied"],
        startDate: "2026-04-01",
        endDate: "2026-04-08",
        preset: "custom",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));

    fireEvent.click(screen.getByRole("button", { name: "Ready" }));
    expect(props.onDateFilterChange).toHaveBeenCalledWith({
      dimensions: ["ready", "applied"],
      startDate: "2026-04-01",
      endDate: "2026-04-08",
      preset: "custom",
    });

    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(props.onDateFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: ["applied"],
        preset: "7",
      }),
    );

    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-04-02" },
    });
    expect(props.onDateFilterChange).toHaveBeenCalledWith({
      dimensions: ["applied"],
      startDate: "2026-04-02",
      endDate: "2026-04-08",
      preset: "custom",
    });

    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-04-09" },
    });
    expect(props.onDateFilterChange).toHaveBeenCalledWith({
      dimensions: ["applied"],
      startDate: "2026-04-01",
      endDate: "2026-04-09",
      preset: "custom",
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear date filters" }));
    expect(props.onDateFilterChange).toHaveBeenCalledWith({
      dimensions: [],
      startDate: null,
      endDate: null,
      preset: null,
    });
  });

  it("resets filters and only shows sources present in jobs", async () => {
    const { props } = renderFilters({
      sourcesWithJobs: ["hiringcafe", "manual"],
    });

    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));

    expect(
      screen.queryByRole("button", { name: "LinkedIn" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Hiring Cafe" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manual" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onResetFilters).toHaveBeenCalled();
  });
});

/**
 * The permanent applied mark's filter. Both of these went untested in the first
 * cut, and both mutations survived the whole suite: deleting the card left the
 * filter URL-only and unreachable from the UI, and dropping its term from
 * `activeFilterCount` left it narrowing the list while the Filters badge said
 * nothing.
 */
describe("OrchestratorFilters ever-applied filter", () => {
  const openPanel = () =>
    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));

  it("offers the three states and reports a pick", () => {
    const { props } = renderFilters();
    openPanel();

    // Scoped to the fieldset: the Dates card below renders its own button
    // labelled "Applied" (the applied DATE dimension), so an unscoped query by
    // that name is exactly the collision these labels avoid.
    const group = screen.getByRole("group", { name: "Ever applied" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Any", "Yes", "No"]);

    fireEvent.click(within(group).getByRole("button", { name: "No" }));
    expect(props.onAppliedFilterChange).toHaveBeenCalledWith("not_applied");

    fireEvent.click(within(group).getByRole("button", { name: "Yes" }));
    expect(props.onAppliedFilterChange).toHaveBeenCalledWith("applied");
  });

  it("counts toward the Filters badge, and Any does not", () => {
    renderFilters({ appliedFilter: "applied" });
    expect(
      screen.getByRole("button", { name: /^filters/i }).textContent,
    ).toContain("1");

    cleanup();

    renderFilters({ appliedFilter: "all" });
    expect(
      screen.getByRole("button", { name: /^filters/i }).textContent,
    ).not.toContain("1");
  });
});
