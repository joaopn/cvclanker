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
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobCommandBar, type JobCommandBarResults } from "./JobCommandBar";
import { type CommandBarLock, jobMatchesLock } from "./JobCommandBar.utils";

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

type Search = { query: string; lock: CommandBarLock | null };

// What the page's search query would answer, computed from a fixture. The
// matcher is deliberately crude (a substring of title or employer): the real
// matching is the server's full-text index, tested in the repository.
const answer = (
  fixture: JobListItem[],
  search: Search,
): JobCommandBarResults => {
  const needle = search.query.toLowerCase();
  const matched = fixture
    .filter((job) => (search.lock ? jobMatchesLock(job, search.lock) : true))
    .filter(
      (job) =>
        !needle ||
        `${job.title} ${job.employer}`.toLowerCase().includes(needle),
    );
  return { ...search, jobs: matched, total: matched.length };
};

// Stands in for the page: records every search the bar submits (and the
// `null` it reports on close) and answers it from the fixture, either at once
// or only when the test calls `respond`; `fail`, `pend`, `close` and `reopen`
// drive the other things the page can do to it.
const renderBar = (
  options: {
    fixture?: JobListItem[];
    answers?: "at-once" | "on-demand";
    onMarkRejected?: (job: JobListItem) => void | Promise<void>;
  } = {},
) => {
  const fixture = options.fixture ?? jobs;
  const searches: (Search | null)[] = [];
  const onSelectJob = vi.fn();
  const onOpenChange = vi.fn();
  const control: {
    setResults?: (results: JobCommandBarResults) => void;
    setFailed?: (failed: boolean) => void;
    setPending?: (pending: boolean) => void;
    setOpen?: (open: boolean) => void;
  } = {};

  const Page = () => {
    const [results, setResults] = useState<JobCommandBarResults | null>(null);
    const [failed, setFailed] = useState(false);
    const [pending, setPending] = useState(false);
    const [open, setOpen] = useState(true);
    control.setResults = setResults;
    control.setFailed = setFailed;
    control.setPending = setPending;
    control.setOpen = setOpen;
    const onSearchChange = useCallback((search: Search | null) => {
      searches.push(search);
      if (search !== null && options.answers !== "on-demand") {
        setResults(answer(fixture, search));
      }
    }, []);
    return (
      <JobCommandBar
        results={results}
        searchFailed={failed}
        searchPending={pending}
        onSearchChange={onSearchChange}
        onSelectJob={onSelectJob}
        onMarkRejected={options.onMarkRejected}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  };

  render(<Page />);
  return {
    input: screen.getByRole("combobox"),
    results: () => screen.getByRole("listbox", { name: "Job search results" }),
    searchButton: () => screen.getByRole("button", { name: "Search" }),
    searches,
    onSelectJob,
    onOpenChange,
    /** Answer the newest search, or hand over a prepared answer. */
    respond: (prepared?: JobCommandBarResults) => {
      const latest = searches.at(-1);
      if (!latest && !prepared) throw new Error("nothing was searched");
      act(() => {
        control.setResults?.(prepared ?? answer(fixture, latest as Search));
      });
    },
    fail: () => act(() => control.setFailed?.(true)),
    pend: (pending: boolean) => act(() => control.setPending?.(pending)),
    close: () => act(() => control.setOpen?.(false)),
    reopen: () => act(() => control.setOpen?.(true)),
  };
};

const lockTo = (input: HTMLElement, token: string) => {
  fireEvent.change(input, { target: { value: token } });
  fireEvent.keyDown(input, { key: "Tab" });
};

const submit = (input: HTMLElement) => {
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("JobCommandBar", () => {
  it("lists every job when nothing is locked", () => {
    const { input, results } = renderBar();
    submit(input);
    for (const job of jobs) {
      expect(within(results()).getByText(job.title)).toBeInTheDocument();
    }
  });

  it("narrows to every job ever applied for, whatever its status now", () => {
    const { input, results } = renderBar();

    lockTo(input, "@ever");
    submit(input);

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
    const { input, results, searches } = renderBar();

    fireEvent.change(input, { target: { value: "@ever rejected" } });
    fireEvent.keyDown(input, { key: "Tab" });

    expect(input).toHaveValue("rejected");
    expect(searches).toEqual([]);

    submit(input);

    expect(searches.at(-1)).toEqual({
      query: "rejected",
      lock: "ever_applied",
    });
    const listed = within(results());
    expect(listed.getByText("Applied Rejected Role")).toBeInTheDocument();
    expect(listed.queryByText("Applied Live Role")).not.toBeInTheDocument();
  });

  it("keeps @applied meaning the status, so the two locks stay distinct", () => {
    const { input, results, searches } = renderBar();

    lockTo(input, "@applied");
    submit(input);
    expect(searches.at(-1)).toEqual({ query: "", lock: "applied" });

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
    submit(input);

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
    submit(input);

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
    const { input, results } = renderBar();

    const button = screen.getByRole("button", { name: "Ever applied" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    submit(input);

    expect(button).toHaveAttribute("aria-pressed", "true");
    const listed = within(results());
    expect(listed.getByText("Applied Live Role")).toBeInTheDocument();
    expect(listed.getByText("Applied Rejected Role")).toBeInTheDocument();
    expect(listed.getByText("Applied Then Skipped Role")).toBeInTheDocument();
    expect(listed.queryByText("Untouched Ready Role")).not.toBeInTheDocument();
    expect(listed.queryByText("Untouched Closed Role")).not.toBeInTheDocument();
  });

  it("releases the filter when the button is pressed again", () => {
    const { input, results } = renderBar();

    const button = screen.getByRole("button", { name: "Ever applied" });
    fireEvent.click(button);
    submit(input);
    fireEvent.click(button);
    submit(input);

    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(
      within(results()).getByText("Untouched Ready Role"),
    ).toBeInTheDocument();
  });

  it("takes over from another lock rather than sitting alongside it", () => {
    const { input, results } = renderBar();

    lockTo(input, "@applied");
    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));
    submit(input);

    expect(screen.getByText("@ever-applied")).toBeInTheDocument();
    // Structurally guaranteed rather than load-bearing (the input renders at
    // most one prefix badge), kept as documentation of the intent.
    expect(screen.queryByText("@applied")).not.toBeInTheDocument();
    expect(
      within(results()).getByText("Applied Rejected Role"),
    ).toBeInTheDocument();
  });

  it("consumes a half-typed token so the button's filter still searches", () => {
    // Without the strip the box keeps a leading "@ev", which offers locks
    // only — no search can go out and the button appears to do nothing.
    const { input, results, searches } = renderBar();

    fireEvent.change(input, { target: { value: "@ev" } });
    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));

    expect(input).toHaveValue("");
    submit(input);
    expect(searches.at(-1)).toEqual({ query: "", lock: "ever_applied" });
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
    const { input, results } = renderBar();

    const button = screen.getByRole("button", { name: "Ever applied" });
    fireEvent.keyDown(button, { key: "Enter" });

    expect(button).toHaveAttribute("aria-pressed", "true");
    submit(input);
    expect(
      within(results()).queryByText("Untouched Ready Role"),
    ).not.toBeInTheDocument();
  });

  it("stays on screen when its own filter empties the list", () => {
    // The button row renders ABOVE the empty-state branch on purpose: a filter
    // that matches nothing must still be releasable, or the dialog is a dead
    // end with no visible way back.
    const { input } = renderBar({ fixture: [jobs[3], jobs[4]] });

    const button = screen.getAllByRole("button", { name: "Ever applied" })[0];
    fireEvent.click(button);
    submit(input);

    expect(screen.getByText("No jobs found.")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("clears the lock on backspace at an empty query", () => {
    const { input, results } = renderBar();

    lockTo(input, "@ever");
    submit(input);
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(screen.queryByText("@ever-applied")).not.toBeInTheDocument();
    submit(input);
    expect(
      within(results()).getByText("Untouched Ready Role"),
    ).toBeInTheDocument();
  });
});

// Typing and picking a filter send nothing; Enter or the Search button does.
describe("JobCommandBar submitting a search", () => {
  it("asks for nothing on open or while typing, and searches every job on Enter", () => {
    const { input, results, searches } = renderBar();

    expect(
      screen.getByText("Type and press Enter to search all jobs."),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Live" } });
    expect(searches).toEqual([]);

    submit(input);

    // No `@` typed: no lock, i.e. every status.
    expect(searches).toEqual([{ query: "Live", lock: null }]);
    expect(
      within(results()).getByText("Applied Live Role"),
    ).toBeInTheDocument();
  });

  it("names the filter it will search before anything is submitted", () => {
    const { input, searches } = renderBar();

    lockTo(input, "@applied");

    expect(searches).toEqual([]);
    expect(
      screen.getByText("Press Enter to search @applied."),
    ).toBeInTheDocument();
  });

  it("names the text it will search before anything is submitted", () => {
    const { input } = renderBar();

    fireEvent.change(input, { target: { value: "Acme" } });

    expect(
      screen.getByText("Press Enter to search all jobs for “Acme”."),
    ).toBeInTheDocument();
  });

  it("searches on the Search button", () => {
    const { input, searchButton, searches } = renderBar();

    fireEvent.change(input, { target: { value: " Live " } });
    fireEvent.click(searchButton());

    expect(searches).toEqual([{ query: "Live", lock: null }]);
  });

  it("searches on Enter on the Search button, which cmdk's root would otherwise swallow", () => {
    const { input, searchButton, searches } = renderBar();

    fireEvent.change(input, { target: { value: "Live" } });
    fireEvent.keyDown(searchButton(), { key: "Enter" });

    expect(searches).toEqual([{ query: "Live", lock: null }]);
  });

  it("cancels the Search button's mousedown, keeping focus in the search box", () => {
    const { input, searchButton } = renderBar();

    input.focus();
    // Same reasoning as the Ever-applied chip's test: the cancellation is the
    // only thing jsdom can show.
    expect(fireEvent.mouseDown(searchButton())).toBe(false);
  });

  it("asks again when the Search button is pressed on an unchanged search", () => {
    const { input, searchButton, searches } = renderBar();

    fireEvent.change(input, { target: { value: "Live" } });
    submit(input);
    fireEvent.click(searchButton());

    expect(searches).toEqual([
      { query: "Live", lock: null },
      { query: "Live", lock: null },
    ]);
  });

  it("offers no Search press while a leading @token is being typed", () => {
    const { input, searchButton, searches } = renderBar();

    fireEvent.change(input, { target: { value: "@ev" } });

    expect(searchButton()).toBeDisabled();
    fireEvent.click(searchButton());
    expect(searches).toEqual([]);
  });

  it("opens the highlighted job on Enter once the rows answer the box", () => {
    const { input, onSelectJob, searches } = renderBar();

    fireEvent.change(input, { target: { value: "Live" } });
    submit(input);
    expect(onSelectJob).not.toHaveBeenCalled();

    submit(input);

    expect(searches).toHaveLength(1);
    expect(onSelectJob).toHaveBeenCalledWith("live", "live");
  });

  it("searches again on Enter after the text changes, rather than opening a row", () => {
    const { input, onSelectJob, searches } = renderBar();

    fireEvent.change(input, { target: { value: "Live" } });
    submit(input);
    fireEvent.change(input, { target: { value: "Rejected" } });
    submit(input);

    expect(onSelectJob).not.toHaveBeenCalled();
    expect(searches.at(-1)).toEqual({ query: "Rejected", lock: null });
  });

  // PI's choice: a filter change waits for Enter or Search like text does,
  // so the rows on screen can disagree with the badge for a while.
  it("dims the rows and says so when the filter changes, until Enter searches it", () => {
    const { input, results, searches, onSelectJob } = renderBar();
    submit(input);

    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));

    expect(searches).toHaveLength(1);
    expect(results()).toHaveClass("opacity-50");
    expect(
      screen.getByText("Filter changed — press Enter or Search to update."),
    ).toBeInTheDocument();
    expect(
      within(results()).getByText("Untouched Ready Role"),
    ).toBeInTheDocument();

    submit(input);

    expect(onSelectJob).not.toHaveBeenCalled();
    expect(searches.at(-1)).toEqual({ query: "", lock: "ever_applied" });
    expect(results()).not.toHaveClass("opacity-50");
    expect(screen.queryByText(/^Filter changed/)).not.toBeInTheDocument();
  });

  it("does not dim the rows while only the text differs", () => {
    const { input, results } = renderBar();
    submit(input);

    fireEvent.change(input, { target: { value: "Live" } });

    expect(results()).not.toHaveClass("opacity-50");
    expect(screen.queryByText(/^Filter changed/)).not.toBeInTheDocument();
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

  // Mounting WITHOUT the prop is a case of its own; this helper is the
  // mounted-with-a-handler shape, whose body a caller can swap (for one that
  // never settles, say).
  const renderWithReject = (
    implementation: (job: JobListItem) => void | Promise<void> = () =>
      Promise.resolve(),
  ) => {
    const onMarkRejected = vi.fn(implementation);
    const bar = renderBar({ fixture: openApplications, onMarkRejected });
    return {
      ...bar,
      onMarkRejected,
      rejectButtons: () =>
        screen.queryAllByRole("button", { name: /^Mark .* rejected$/ }),
    };
  };

  const turnOnEverApplied = () => {
    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));
    submit(screen.getByRole("combobox"));
  };

  it("offers the button only once the Ever-applied filter is on", () => {
    const { input, rejectButtons } = renderWithReject();
    submit(input);

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

  // The button follows the filter the rows were SEARCHED with, not the badge:
  // until Enter, the rows on screen are not the Ever-applied sweep.
  it("follows the filter the rows answer, not the badge", () => {
    const { input, rejectButtons } = renderWithReject();
    submit(input);

    fireEvent.click(screen.getByRole("button", { name: "Ever applied" }));
    expect(rejectButtons()).toHaveLength(0);

    submit(input);
    expect(rejectButtons()).toHaveLength(2);

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByText("@ever-applied")).not.toBeInTheDocument();
    expect(rejectButtons()).toHaveLength(2);
  });

  // The @applied lock lists the same live row. The button is deliberately not
  // offered there: this is a feature of the Ever-applied sweep, not of every
  // way a live row can be reached.
  it("does not ride along on the @applied lock", () => {
    const { input, results, rejectButtons } = renderWithReject();

    lockTo(input, "@applied");
    submit(input);

    expect(
      within(results()).getByText("Applied Live Role"),
    ).toBeInTheDocument();
    expect(rejectButtons()).toHaveLength(0);
  });

  it("does not render a button a mount cannot service", () => {
    const { input } = renderBar({ fixture: openApplications });

    fireEvent.click(screen.getAllByRole("button", { name: "Ever applied" })[0]);
    submit(input);

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

// The search runs on the server, so an answer can lag the search submitted.
describe("JobCommandBar and the server's answers", () => {
  it("asks for nothing while a leading @token is typed, and lists only locks", () => {
    const { input, results, searches } = renderBar();
    submit(input);
    const asked = searches.length;

    fireEvent.change(input, { target: { value: "@ev" } });

    expect(searches).toHaveLength(asked);
    const options = within(results()).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Lock to @ever-applied",
    ]);
  });

  it("says what it is searching, not that nothing matched, before the answer", () => {
    const { input, respond } = renderBar({ fixture: [], answers: "on-demand" });

    submit(input);

    expect(screen.getByText("Searching all jobs…")).toBeInTheDocument();
    expect(screen.queryByText("No jobs found.")).not.toBeInTheDocument();

    respond();

    expect(screen.getByText("No jobs found.")).toBeInTheDocument();
  });

  it("names the text and the filter it is searching", () => {
    const { input } = renderBar({ answers: "on-demand" });

    lockTo(input, "@ever");
    fireEvent.change(input, { target: { value: "Acme" } });
    submit(input);

    expect(
      screen.getByText("Searching @ever-applied for “Acme”…"),
    ).toBeInTheDocument();
  });

  // The reported defect: a slow search left the previous answer on screen,
  // with nothing saying a search was running.
  it("replaces the previous rows with a searching line until the new answer lands", () => {
    const { input, respond, onSelectJob, searchButton } = renderBar({
      answers: "on-demand",
    });
    submit(input);
    respond();

    fireEvent.change(input, { target: { value: "Live" } });
    // Typing alone keeps the answer on screen: nothing was asked yet.
    expect(screen.getByText("Untouched Ready Role")).toBeInTheDocument();

    submit(input);

    expect(screen.queryByText("Untouched Ready Role")).not.toBeInTheDocument();
    expect(
      screen.getByText("Searching all jobs for “Live”…"),
    ).toBeInTheDocument();
    expect(searchButton()).toHaveAttribute("aria-busy", "true");
    submit(input);
    expect(onSelectJob).not.toHaveBeenCalled();

    respond();
    expect(screen.getByText("Applied Live Role")).toBeInTheDocument();
    expect(searchButton()).toHaveAttribute("aria-busy", "false");
    submit(input);
    expect(onSelectJob).toHaveBeenCalledWith("live", "live");
  });

  // A mutation (or a repeat press) asks the submitted search again; the job in
  // the cached answer may have moved since, so Enter waits for the new one —
  // but the rows stay, or a rejection from the Ever-applied list would blank it.
  it("keeps the rows of a search being asked again, but selects nothing from them", () => {
    const { input, respond, pend, onSelectJob } = renderBar({
      answers: "on-demand",
    });
    fireEvent.change(input, { target: { value: "Live" } });
    submit(input);
    respond();

    pend(true);
    expect(screen.getByText("Applied Live Role")).toBeInTheDocument();
    submit(input);
    expect(onSelectJob).not.toHaveBeenCalled();

    pend(false);
    submit(input);
    expect(onSelectJob).toHaveBeenCalledWith("live", "live");
  });

  it("still applies a lock suggestion on Enter while a search is pending", () => {
    const { input, searches } = renderBar({ answers: "on-demand" });
    submit(input);

    fireEvent.change(input, { target: { value: "@" } });
    submit(input);

    expect(screen.getByText("@ready")).toBeInTheDocument();
    expect(searches).toHaveLength(1);
  });

  it("says how many matches the answer left out, for the submitted search only", () => {
    const { input, respond } = renderBar({ answers: "on-demand" });
    submit(input);
    respond({ query: "", lock: null, jobs: jobs.slice(0, 2), total: 1234 });

    expect(
      screen.getByText(
        "Showing 2 of 1,234 matches. Search with more words to narrow.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Live" } });
    submit(input);
    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
  });

  it("says a new search failed, without the rows of the one before it, and retries on Enter", () => {
    const { input, respond, fail, onSelectJob, searchButton, searches } =
      renderBar({ answers: "on-demand" });
    submit(input);
    respond();
    fireEvent.change(input, { target: { value: "Live" } });
    submit(input);

    fail();

    expect(screen.getByText("Search failed.")).toBeInTheDocument();
    expect(screen.queryByText("Untouched Ready Role")).not.toBeInTheDocument();
    expect(searchButton()).toHaveAttribute("aria-busy", "false");
    submit(input);
    expect(onSelectJob).not.toHaveBeenCalled();
    expect(searches.slice(-2)).toEqual([
      { query: "Live", lock: null },
      { query: "Live", lock: null },
    ]);
  });

  // The re-ask has ended (not pending) and failed: the hook's real state.
  it("keeps the rows when asking the same search again fails, says so, and retries on Enter", () => {
    const { input, respond, fail, onSelectJob, searches } = renderBar({
      answers: "on-demand",
    });
    submit(input);
    respond();

    fail();

    expect(
      screen.getByText("Search failed. These are the previous results."),
    ).toBeInTheDocument();
    expect(screen.getByText("Untouched Ready Role")).toBeInTheDocument();
    submit(input);
    expect(onSelectJob).not.toHaveBeenCalled();
    expect(searches).toHaveLength(2);
  });

  // react-query keeps the error status while a retry runs.
  it("stops saying a search failed while it is being retried", () => {
    const { input, respond, fail, pend } = renderBar({ answers: "on-demand" });
    submit(input);
    respond();
    fail();
    expect(screen.getByText(/^Search failed\./)).toBeInTheDocument();

    pend(true);

    expect(screen.queryByText(/^Search failed\./)).not.toBeInTheDocument();
    expect(screen.getByText("Untouched Ready Role")).toBeInTheDocument();
  });

  it("says a failed re-ask of an empty answer failed, not that nothing matched", () => {
    const { input, respond, fail } = renderBar({ answers: "on-demand" });
    fireEvent.change(input, { target: { value: "Zzz" } });
    submit(input);
    respond();
    expect(screen.getByText("No jobs found.")).toBeInTheDocument();

    fail();

    expect(screen.getByText("Search failed.")).toBeInTheDocument();
    expect(screen.queryByText("No jobs found.")).not.toBeInTheDocument();
  });

  // Nothing is submitted after a close: the page must hear that while the
  // dialog is closed, or a reopened dialog fetches the old search.
  it("reports nothing submitted when the dialog closes, and asks nothing on reopen", () => {
    const { input, searches, close, reopen } = renderBar();
    lockTo(input, "@applied");
    submit(input);
    expect(searches.at(-1)).toEqual({ query: "", lock: "applied" });

    close();
    expect(searches.at(-1)).toBeNull();

    reopen();
    expect(searches.at(-1)).toBeNull();
    expect(
      screen.getByText("Type and press Enter to search all jobs."),
    ).toBeInTheDocument();
  });

  it("says nothing about left-out matches when there are none", () => {
    const { input } = renderBar();
    submit(input);

    expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
  });
});
