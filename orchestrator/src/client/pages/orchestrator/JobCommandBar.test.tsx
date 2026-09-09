import { setupWindowVirtualizerTestEnvironment } from "@client/test/virtualization";
import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobCommandBar } from "./JobCommandBar";

const APPLIED_AT = "2025-03-01T00:00:00Z";

// Small on purpose: the dialog's fallback layout renders roughly the first ten
// rows at jsdom's viewport, so a long fixture would make an absence assertion
// pass because the row was scrolled out rather than filtered out.
const jobs: JobListItem[] = [
  createJob({
    id: "live",
    title: "Applied Live Role",
    employer: "Acme",
    status: "applied",
    appliedAt: APPLIED_AT,
  }),
  createJob({
    id: "rejected",
    title: "Applied Rejected Role",
    employer: "Acme",
    status: "closed",
    outcome: "rejected",
    appliedAt: APPLIED_AT,
  }),
  createJob({
    id: "skipped-after-applying",
    title: "Applied Then Skipped Role",
    employer: "Acme",
    status: "skipped",
    appliedAt: APPLIED_AT,
  }),
  createJob({
    id: "never-ready",
    title: "Untouched Ready Role",
    employer: "Acme",
    status: "ready",
    appliedAt: null,
  }),
  createJob({
    id: "never-closed",
    title: "Untouched Closed Role",
    employer: "Acme",
    status: "closed",
    appliedAt: null,
  }),
];

let virtualizationEnvironment: ReturnType<
  typeof setupWindowVirtualizerTestEnvironment
> | null = null;

beforeEach(() => {
  // Same shape as JobListPanel.test: virtual-core's debounced notify is a real
  // setTimeout that can fire after jsdom is torn down.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  virtualizationEnvironment = setupWindowVirtualizerTestEnvironment({
    viewportHeight: 768,
  });
});

afterEach(() => {
  virtualizationEnvironment?.cleanup();
  virtualizationEnvironment = null;
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const renderBar = (onSelectJob = vi.fn()) => {
  render(
    <JobCommandBar
      jobs={jobs}
      onSelectJob={onSelectJob}
      open
      onOpenChange={vi.fn()}
    />,
  );
  return {
    onSelectJob,
    input: screen.getByRole("combobox"),
    results: () => screen.getByRole("listbox", { name: "Job search results" }),
  };
};

const lockTo = (input: HTMLElement, token: string) => {
  fireEvent.change(input, { target: { value: token } });
  fireEvent.keyDown(input, { key: "Tab" });
};

describe("JobCommandBar", () => {
  it("lists every job when nothing is locked", () => {
    const { results } = renderBar();
    for (const job of jobs) {
      expect(within(results()).getByText(job.title)).toBeInTheDocument();
    }
  });

  it("narrows to every job ever applied for, whatever its status now", () => {
    const { input, results } = renderBar();

    lockTo(input, "@ever");

    const listed = within(results());
    // The point of the lock: a closed and a skipped application are still
    // applications, and neither is reachable through @applied.
    expect(listed.getByText("Applied Live Role")).toBeInTheDocument();
    expect(listed.getByText("Applied Rejected Role")).toBeInTheDocument();
    expect(listed.getByText("Applied Then Skipped Role")).toBeInTheDocument();
    expect(listed.queryByText("Untouched Ready Role")).not.toBeInTheDocument();
    expect(listed.queryByText("Untouched Closed Role")).not.toBeInTheDocument();
    expect(screen.getByText("@ever-applied")).toBeInTheDocument();
  });

  it("consumes the token so the rest of the query still searches", () => {
    const { input, results } = renderBar();

    fireEvent.change(input, { target: { value: "@ever rejected" } });
    fireEvent.keyDown(input, { key: "Tab" });

    expect(input).toHaveValue("rejected");
    const listed = within(results());
    expect(listed.getByText("Applied Rejected Role")).toBeInTheDocument();
    expect(listed.queryByText("Applied Live Role")).not.toBeInTheDocument();
  });

  it("keeps @applied meaning the status, so the two locks stay distinct", () => {
    const { input, results } = renderBar();

    lockTo(input, "@applied");

    const listed = within(results());
    expect(listed.getByText("Applied Live Role")).toBeInTheDocument();
    expect(listed.queryByText("Applied Rejected Role")).not.toBeInTheDocument();
    expect(screen.getByText("@applied")).toBeInTheDocument();
  });

  it("offers the lock as a suggestion row and applies it on click", () => {
    const { input, results } = renderBar();

    fireEvent.change(input, { target: { value: "@ever" } });
    fireEvent.click(
      within(results()).getByText("Lock to @ever-applied").closest("div")
        ?.parentElement as HTMLElement,
    );

    expect(screen.getByText("@ever-applied")).toBeInTheDocument();
    expect(
      within(results()).queryByText("Untouched Ready Role"),
    ).not.toBeInTheDocument();
  });

  it("clears the lock on backspace at an empty query", () => {
    const { input, results } = renderBar();

    lockTo(input, "@ever");
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(screen.queryByText("@ever-applied")).not.toBeInTheDocument();
    expect(
      within(results()).getByText("Untouched Ready Role"),
    ).toBeInTheDocument();
  });
});
