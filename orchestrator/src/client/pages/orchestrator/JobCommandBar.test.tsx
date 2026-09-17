import { setupWindowVirtualizerTestEnvironment } from "@client/test/virtualization";
import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobCommandBar } from "./JobCommandBar";

const APPLIED_AT = "2025-03-01T00:00:00Z";

// Small on purpose. The results list is virtualized, and several tests below
// assert that a row is ABSENT — which only means "filtered out" while every row
// would have been rendered had it survived the filter. Two things keep that
// true here and both are fragile: the whole fixture is 446px against a window
// hundreds of pixels taller, and no test moves the selection off the first
// selectable row, so the window stays pinned at the top of the list (it slides
// with `scrollTop`, and its leading edge cuts rows off the top, not just the
// bottom). Grow the fixture or add an ArrowDown and re-check every absence
// assertion.
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

const renderBar = () => {
  render(
    <JobCommandBar
      jobs={jobs}
      onSelectJob={vi.fn()}
      open
      onOpenChange={vi.fn()}
    />,
  );
  return {
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

  // Both click tests drive a bare `@`, which offers all six locks, and click one
  // that is NOT first. A narrower query offers a single suggestion, and then
  // `applyLock(row.lock)`, `applyLock(lockSuggestions[0])` and a hardcoded
  // literal are indistinguishable — the click proves nothing about which lock
  // was picked.
  it("applies the clicked lock, not the first one offered", () => {
    const { input, results } = renderBar();

    fireEvent.change(input, { target: { value: "@" } });
    const options = within(results()).getAllByRole("option");
    expect(options).toHaveLength(6);
    expect(options[0]).toHaveTextContent("Lock to @ready");

    fireEvent.click(
      within(results()).getByRole("option", { name: /Lock to @ever-applied/ }),
    );

    expect(screen.getByText("@ever-applied")).toBeInTheDocument();
    expect(
      within(results()).getByText("Applied Rejected Role"),
    ).toBeInTheDocument();
    expect(
      within(results()).queryByText("Untouched Ready Role"),
    ).not.toBeInTheDocument();
  });

  it("applies a different clicked lock the same way", () => {
    const { input, results } = renderBar();

    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.click(
      within(results()).getByRole("option", { name: /Lock to @applied$/ }),
    );

    expect(screen.getByText("@applied")).toBeInTheDocument();
    expect(
      within(results()).getByText("Applied Live Role"),
    ).toBeInTheDocument();
    expect(
      within(results()).queryByText("Applied Rejected Role"),
    ).not.toBeInTheDocument();
  });

  // The button exists because the typed `@ever-applied` token was not
  // discoverable: the maintainer could not find the feature on a running
  // build that demonstrably contained it.
  it("filters to every job ever applied for when the button is pressed", () => {
    const { results } = renderBar();

    const button = screen.getByRole("button", { name: "Ever applied" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-pressed", "true");
    const listed = within(results());
    expect(listed.getByText("Applied Live Role")).toBeInTheDocument();
    expect(listed.getByText("Applied Rejected Role")).toBeInTheDocument();
    expect(listed.getByText("Applied Then Skipped Role")).toBeInTheDocument();
    expect(listed.queryByText("Untouched Ready Role")).not.toBeInTheDocument();
    expect(listed.queryByText("Untouched Closed Role")).not.toBeInTheDocument();
  });

  it("releases the filter when the button is pressed again", () => {
    const { results } = renderBar();

    const button = screen.getByRole("button", { name: "Ever applied" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(
      within(results()).getByText("Untouched Ready Role"),
    ).toBeInTheDocument();
  });

  it("takes over from another lock rather than sitting alongside it", () => {
    const { input, results } = renderBar();

    lockTo(input, "@applied");
    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));

    expect(screen.getByText("@ever-applied")).toBeInTheDocument();
    // Structurally guaranteed rather than load-bearing (the input renders at
    // most one prefix badge), kept as documentation of the intent.
    expect(screen.queryByText("@applied")).not.toBeInTheDocument();
    expect(
      within(results()).getByText("Applied Rejected Role"),
    ).toBeInTheDocument();
  });

  it("consumes a half-typed token so the button's filter is not scored away", () => {
    // Without the strip the query keeps "@ev", which scores every row below
    // the relevance floor — the button would appear to filter to nothing.
    const { input, results } = renderBar();

    fireEvent.change(input, { target: { value: "@ev" } });
    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));

    expect(input).toHaveValue("");
    expect(
      within(results()).getByText("Applied Rejected Role"),
    ).toBeInTheDocument();
  });

  it("cancels the press's mousedown, which is what keeps focus in the search box", () => {
    const { input } = renderBar();

    input.focus();
    // The cancellation IS the assertion. jsdom implements no focus default
    // action for mousedown, so `document.activeElement` would still be the
    // input whether or not the handler existed — asserting it would prove
    // nothing. `fireEvent` returns false exactly when the event was cancelled,
    // and a cancelled mousedown is what stops a browser moving focus.
    expect(
      fireEvent.mouseDown(screen.getByRole("button", { name: "Ever applied" })),
    ).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("toggles on Enter, which cmdk's root would otherwise swallow", () => {
    const { results } = renderBar();

    const button = screen.getByRole("button", { name: "Ever applied" });
    fireEvent.keyDown(button, { key: "Enter" });

    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(
      within(results()).queryByText("Untouched Ready Role"),
    ).not.toBeInTheDocument();
  });

  it("stays on screen when its own filter empties the list", () => {
    // The button row renders ABOVE the empty-state branch on purpose: a filter
    // that matches nothing must still be releasable, or the dialog is a dead
    // end with no visible way back.
    render(
      <JobCommandBar
        jobs={[jobs[3], jobs[4]]}
        onSelectJob={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const button = screen.getAllByRole("button", { name: "Ever applied" })[0];
    fireEvent.click(button);

    expect(screen.getByText("No jobs found.")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
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

// The rejection button, offered on the Ever-applied filter's still-open rows.
// Its own fixture rather than the shared one: it needs an Interviewing row,
// and the list above is sized so that every row renders inside the virtual
// window, which is what several of its absence assertions rest on.
describe("JobCommandBar rejection button", () => {
  const openApplications: JobListItem[] = [
    createJob({
      id: "live",
      title: "Applied Live Role",
      employer: "Acme",
      status: "applied",
      appliedAt: APPLIED_AT,
    }),
    createJob({
      id: "interviewing",
      title: "Interviewing Role",
      employer: "Acme",
      status: "in_progress",
      appliedAt: APPLIED_AT,
    }),
    createJob({
      id: "already-closed",
      title: "Applied Rejected Role",
      employer: "Acme",
      status: "closed",
      outcome: "rejected",
      appliedAt: APPLIED_AT,
    }),
  ];

  // Mounting WITHOUT the prop is a case of its own and renders directly; this
  // helper is the mounted-with-a-handler shape, whose body a caller can swap
  // (for one that never settles, say).
  const renderWithReject = (
    implementation: (job: JobListItem) => void | Promise<void> = () =>
      Promise.resolve(),
  ) => {
    const onMarkRejected = vi.fn(implementation);
    const onSelectJob = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <JobCommandBar
        jobs={openApplications}
        onSelectJob={onSelectJob}
        onMarkRejected={onMarkRejected}
        open
        onOpenChange={onOpenChange}
      />,
    );
    return {
      onMarkRejected,
      onSelectJob,
      onOpenChange,
      input: screen.getByRole("combobox"),
      results: () =>
        screen.getByRole("listbox", { name: "Job search results" }),
      rejectButtons: () =>
        screen.queryAllByRole("button", { name: /^Mark .* rejected$/ }),
    };
  };

  const turnOnEverApplied = () => {
    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));
  };

  it("offers the button only once the Ever-applied filter is on", () => {
    const { rejectButtons } = renderWithReject();

    expect(rejectButtons()).toHaveLength(0);

    turnOnEverApplied();

    // Both still-open applications, and only those: a row that is already
    // closed has nothing left to reject.
    expect(
      rejectButtons()
        .map((button) => button.getAttribute("aria-label"))
        .sort(),
    ).toEqual([
      "Mark Applied Live Role at Acme rejected",
      "Mark Interviewing Role at Acme rejected",
    ]);
  });

  // The @applied lock lists the same live row. The button is deliberately not
  // offered there: this is a feature of the Ever-applied sweep, not of every
  // way a live row can be reached.
  it("does not ride along on the @applied lock", () => {
    const { input, results, rejectButtons } = renderWithReject();

    lockTo(input, "@applied");

    expect(
      within(results()).getByText("Applied Live Role"),
    ).toBeInTheDocument();
    expect(rejectButtons()).toHaveLength(0);
  });

  it("does not render a button a mount cannot service", () => {
    const onSelectJob = vi.fn();
    render(
      <JobCommandBar jobs={openApplications} onSelectJob={onSelectJob} open />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Ever applied" })[0]);

    expect(
      screen.queryAllByRole("button", { name: /^Mark .* rejected$/ }),
    ).toHaveLength(0);
  });

  // Awaited, here and below, because the press settles its in-flight bookkeeping
  // when the handler's promise resolves — a state update React would otherwise
  // report as happening outside `act`.
  it("closes the application without closing the dialog, and clears the query", async () => {
    const { input, onMarkRejected, onSelectJob, onOpenChange } =
      renderWithReject();

    turnOnEverApplied();
    fireEvent.change(input, { target: { value: "Live" } });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Mark Applied Live Role at Acme rejected",
        }),
      );
    });

    expect(onMarkRejected).toHaveBeenCalledTimes(1);
    expect(onMarkRejected.mock.calls[0][0]).toMatchObject({ id: "live" });
    // The three halves of "streamline the sweep": the dialog stays open, the
    // lock survives, and the typed company name is gone so the next one can be
    // typed straight away.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSelectJob).not.toHaveBeenCalled();
    expect(screen.getByText("@ever-applied")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  // Without `stopPropagation` the press lands on the row underneath too, which
  // navigates to the job and closes the dialog — the one thing the feature is
  // for is not doing that.
  it("does not select the row it sits on", async () => {
    const { onSelectJob, onOpenChange } = renderWithReject();

    turnOnEverApplied();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Mark Interviewing Role at Acme rejected",
        }),
      );
    });

    expect(onSelectJob).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("cancels the press's mousedown, which is what keeps focus in the search box", () => {
    const { input } = renderWithReject();

    turnOnEverApplied();
    input.focus();
    expect(
      fireEvent.mouseDown(
        screen.getByRole("button", {
          name: "Mark Applied Live Role at Acme rejected",
        }),
      ),
    ).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("acts on Enter, which cmdk's root would otherwise swallow", async () => {
    const { onMarkRejected } = renderWithReject();

    turnOnEverApplied();
    await act(async () => {
      fireEvent.keyDown(
        screen.getByRole("button", {
          name: "Mark Applied Live Role at Acme rejected",
        }),
        { key: "Enter" },
      );
    });

    expect(onMarkRejected).toHaveBeenCalledTimes(1);
  });

  // The row survives on screen until the parent's refetch lands, so a second
  // press is reachable — and would send a `mark_closed` the server refuses.
  it("ignores a second press while the first is still in flight", () => {
    // A rejection that never settles — the row stays pressable throughout.
    const { onMarkRejected } = renderWithReject(
      () => new Promise<void>(() => {}),
    );

    turnOnEverApplied();
    const button = screen.getByRole("button", {
      name: "Mark Applied Live Role at Acme rejected",
    });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(onMarkRejected).toHaveBeenCalledTimes(1);
  });
});
