import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  JOB_SORTER_LABELS,
  JOB_SORTERS,
  type JobSorter,
  UNATTRIBUTED_PROFILE_LABEL,
} from "../orchestrator/constants";
import { SwipeFilterSections } from "./SwipeFilterSheet";
import { EMPTY_SWIPE_FILTERS } from "./swipeFilters";

const profiles = [
  { id: "p1", name: "Berlin backend" },
  { id: "p2", name: "Remote EU" },
];
const titles = ["Python Developer", "Site Reliability Engineer"];

describe("SwipeFilterSections", () => {
  it("shows every badge of all three families", () => {
    render(
      <SwipeFilterSections
        filters={EMPTY_SWIPE_FILTERS}
        onFiltersChange={vi.fn()}
        sorter="none"
        onSorterChange={vi.fn()}
        profiles={profiles}
        titles={titles}
      />,
    );

    // Fit: the four tiers plus Unscored.
    for (const label of [
      "Great fit",
      "Very good fit",
      "Good fit",
      "Bad fit",
      "Unscored",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Profile: every profile plus the Unattributed sentinel.
    expect(
      screen.getByRole("button", { name: "Berlin backend" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remote EU" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: UNATTRIBUTED_PROFILE_LABEL }),
    ).toBeInTheDocument();
    // Job title: every search term.
    for (const title of titles) {
      expect(screen.getByRole("button", { name: title })).toBeInTheDocument();
    }
  });

  it("toggles a badge into and out of the selection", () => {
    const onFiltersChange = vi.fn();
    const { rerender } = render(
      <SwipeFilterSections
        filters={EMPTY_SWIPE_FILTERS}
        onFiltersChange={onFiltersChange}
        sorter="none"
        onSorterChange={vi.fn()}
        profiles={profiles}
        titles={titles}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Great fit" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      fit: ["great_fit"],
      profile: [],
      title: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "Berlin backend" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      fit: [],
      profile: ["p1"],
      title: [],
    });

    rerender(
      <SwipeFilterSections
        filters={{ fit: ["great_fit"], profile: ["p1"], title: [] }}
        onFiltersChange={onFiltersChange}
        sorter="none"
        onSorterChange={vi.fn()}
        profiles={profiles}
        titles={titles}
      />,
    );
    expect(screen.getByRole("button", { name: "Great fit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Great fit" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      fit: [],
      profile: ["p1"],
      title: [],
    });
  });

  it("keeps the fit selection in canonical order regardless of click order", () => {
    const onFiltersChange = vi.fn();
    render(
      <SwipeFilterSections
        filters={{ fit: ["unscored"], profile: [], title: [] }}
        onFiltersChange={onFiltersChange}
        sorter="none"
        onSorterChange={vi.fn()}
        profiles={profiles}
        titles={titles}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Great fit" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      fit: ["great_fit", "unscored"],
      profile: [],
      title: [],
    });
  });

  it("shows hints when no profiles or search terms exist", () => {
    render(
      <SwipeFilterSections
        filters={EMPTY_SWIPE_FILTERS}
        onFiltersChange={vi.fn()}
        sorter="none"
        onSorterChange={vi.fn()}
        profiles={[]}
        titles={[]}
      />,
    );
    expect(screen.getByText("No search profiles yet.")).toBeInTheDocument();
    expect(
      screen.getByText("No search terms in any Search Profile yet."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: UNATTRIBUTED_PROFILE_LABEL }),
    ).not.toBeInTheDocument();
  });
});

describe("SwipeFilterSections sorting", () => {
  const renderSort = (sorter: JobSorter, onSorterChange = vi.fn()) => {
    render(
      <SwipeFilterSections
        filters={EMPTY_SWIPE_FILTERS}
        onFiltersChange={vi.fn()}
        sorter={sorter}
        onSorterChange={onSorterChange}
        profiles={profiles}
        titles={titles}
      />,
    );
    return onSorterChange;
  };

  it("offers the Manage list sorter's options, under its labels", () => {
    renderSort("none");
    // Named on the element that carries the role, and named as a sort — the
    // section helper's default would call it "Sort filters".
    const row = screen.getByRole("radiogroup", { name: "Sort order" });
    expect(
      within(row)
        .getAllByRole("radio")
        .map((chip) => chip.textContent),
    ).toEqual(JOB_SORTERS.map((value) => JOB_SORTER_LABELS[value]));
  });

  it("checks exactly the active option — picking a sort unpicks the rest", () => {
    renderSort("applicants");
    const checked = screen
      .getAllByRole("radio")
      .filter((chip) => chip.getAttribute("aria-checked") === "true")
      .map((chip) => chip.textContent);
    expect(checked).toEqual([JOB_SORTER_LABELS.applicants]);
  });

  it("reports the option that was picked", () => {
    const onSorterChange = renderSort("applicants");
    fireEvent.click(
      screen.getByRole("radio", { name: JOB_SORTER_LABELS.none }),
    );
    expect(onSorterChange).toHaveBeenCalledWith("none");
  });
});
