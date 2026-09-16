import { createJob } from "@shared/testing/factories.js";
import type { JobStatus } from "@shared/types.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real Radix DropdownMenu can't open in jsdom (no pointer-capture /
// ResizeObserver) — the same shell mock JobSorterMenu.test.tsx uses, rendering
// every item eagerly so the menu's CONTENTS are assertable. `onSelect` is
// Radix's own item callback, so wiring it to `onClick` here keeps the
// component's real handler on the path under test.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  // `disabled` is reported via aria only, NOT via the DOM `disabled`
  // attribute: jsdom refuses to dispatch click on a disabled button, which
  // would make "selecting the current stage does nothing" pass even with the
  // component's own guard deleted. Radix likewise keeps its items focusable
  // and marks them `data-disabled`/`aria-disabled` rather than disabling a
  // native control, so this is the closer model as well.
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled ? "true" : "false"}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
}));

vi.mock("@client/api", () => ({
  updateJob: vi.fn().mockResolvedValue(undefined),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@client/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const pushUndo = vi.fn();
vi.mock("./useUndoController", () => ({
  useUndo: () => ({
    pushUndo: (entry: unknown) => pushUndo(entry),
    undo: vi.fn(),
    canUndo: false,
    pendingLabel: null,
  }),
}));

import * as api from "@client/api";
import { JobStageSwitcher } from "./JobStageSwitcher";

// Keyed off the TYPE, not a hand-kept array: a status added to `JobStatus`
// later must make this fail to compile rather than silently go untested. Same
// idiom as `constants.test.ts`.
const ALL_STATUSES = Object.keys({
  discovered: true,
  selected: true,
  processing: true,
  ready: true,
  applied: true,
  in_progress: true,
  backlog: true,
  stale: true,
  skipped: true,
  closed: true,
} satisfies Record<JobStatus, true>) as JobStatus[];

/** Every destination the menu offers, in the order it offers them. */
const STAGE_LABELS = [
  "Inbox",
  "Tailoring",
  "Live",
  "Interviewing",
  "Backlog",
  "Stale",
  "Skipped",
];

const REASON_LABELS = ["Rejected", "Withdrew", "Ghosted", "Other"];

/**
 * Every status's menu label. Exhaustive over `JobStatus` by construction, so a
 * new status forces a decision here rather than defaulting to invisible.
 */
const STATUS_LABEL = {
  discovered: "Inbox",
  ready: "Tailoring",
  applied: "Live",
  in_progress: "Interviewing",
  backlog: "Backlog",
  stale: "Stale",
  skipped: "Skipped",
  processing: "Processing",
  selected: "Selected",
  closed: "Closed",
} satisfies Record<JobStatus, string>;

/** The permanent applied mark — what gates the close-with-reason group. */
const APPLIED_AT = "2026-01-02T03:04:05.000Z";

const noop = () => {};

const renderSwitcher = (job: Parameters<typeof createJob>[0]) =>
  render(
    <JobStageSwitcher
      job={createJob(job)}
      onJobUpdated={noop}
      onJobMoved={noop}
    />,
  );

const menuLabels = () =>
  screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());

beforeEach(() => {
  vi.mocked(api.updateJob)
    .mockClear()
    // The component ignores the resolved job; the cast keeps the mock typed.
    .mockResolvedValue(
      createJob({ id: "patched" }) as Awaited<ReturnType<typeof api.updateJob>>,
    );
  pushUndo.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("JobStageSwitcher visibility", () => {
  // The slice's whole point: seven of these ten statuses rendered NOTHING
  // before, so a row sitting at one of them could not be moved from its detail
  // panel at all.
  it.each(ALL_STATUSES)("renders for a %s row", (status) => {
    renderSwitcher({ id: `j-${status}`, status });

    expect(screen.getByRole("button", { name: /^Stage:/ })).toBeInTheDocument();
  });

  it.each([
    ["discovered" as JobStatus, "Stage: Inbox"],
    ["ready" as JobStatus, "Stage: Tailoring"],
    ["applied" as JobStatus, "Stage: Live"],
    ["in_progress" as JobStatus, "Stage: Interviewing"],
    ["backlog" as JobStatus, "Stage: Backlog"],
    ["stale" as JobStatus, "Stage: Stale"],
    ["skipped" as JobStatus, "Stage: Skipped"],
    ["closed" as JobStatus, "Stage: Closed"],
    // The two statuses no destination claims still have to name themselves.
    ["processing" as JobStatus, "Stage: Processing"],
    ["selected" as JobStatus, "Stage: Selected"],
  ])("labels a %s row %s", (status, label) => {
    renderSwitcher({ id: `l-${status}`, status });

    expect(screen.getByRole("button", { name: /^Stage:/ })).toHaveTextContent(
      label,
    );
  });
});

describe("JobStageSwitcher status coverage", () => {
  /**
   * The `satisfies` list above is exhaustive at COMPILE time, but every other
   * table in this file is a hand-kept literal — so without this a status added
   * to `JobStatus` would silently become a non-destination with nothing red.
   * `STAGES` is a plain array in the component and has no exhaustiveness of
   * its own; this is what supplies it.
   */
  it("accounts for every JobStatus as a destination or a named exception", () => {
    // The three `STAGES` deliberately omits, each for a documented reason:
    // `processing`/`selected` are destinations nobody should pick, and `closed`
    // is reached through the reason group instead.
    const EXCEPTIONS: JobStatus[] = ["processing", "selected", "closed"];
    const offered = new Set<string>(STAGE_LABELS);

    const unaccounted = ALL_STATUSES.filter(
      (status) =>
        !EXCEPTIONS.includes(status) && !offered.has(STATUS_LABEL[status]),
    );

    expect(unaccounted).toEqual([]);
    // And the exceptions are exactly the statuses NOT offered, so removing a
    // destination without removing it here fails too.
    expect(
      ALL_STATUSES.filter(
        (status) => !offered.has(STATUS_LABEL[status]),
      ).sort(),
    ).toEqual([...EXCEPTIONS].sort());
  });
});

describe("JobStageSwitcher menu", () => {
  it("offers every pipeline destination plus the four close reasons", () => {
    // Carries a PDF so no item wears the "no PDF" annotation — this test is
    // about the menu's SHAPE; the annotation has its own two below.
    renderSwitcher({
      id: "m1",
      status: "discovered",
      appliedAt: APPLIED_AT,
      pdfPath: "/data/pdfs/resume_m1.pdf",
    });

    expect(menuLabels()).toEqual([...STAGE_LABELS, ...REASON_LABELS]);
  });

  /**
   * An outcome describes how an APPLICATION ended. Offering these from a row
   * nobody applied to writes `closed` + rejected/withdrawn/ghosted over a null
   * `applied_at` — the exact shape `db/migrate.ts`'s boot backfill treats as a
   * legacy application and stamps, so every such close would come back next
   * boot counted as an application AND a rejection.
   */
  it("hides the close reasons on a row that was never applied to", () => {
    renderSwitcher({
      id: "m0",
      status: "discovered",
      appliedAt: null,
      pdfPath: "/data/pdfs/resume_m0.pdf",
    });

    expect(menuLabels()).toEqual(STAGE_LABELS);
    expect(screen.queryByText("Close with reason")).not.toBeInTheDocument();
  });

  it("keeps the close reasons on a reopened row that carries the mark", () => {
    // The mark is permanent, so a row moved back to a shelf is still an
    // application and can still be closed out.
    renderSwitcher({
      id: "m0b",
      status: "backlog",
      appliedAt: APPLIED_AT,
      pdfPath: "/data/pdfs/resume_m0b.pdf",
    });

    expect(menuLabels()).toEqual([...STAGE_LABELS, ...REASON_LABELS]);
  });

  it("never offers processing or selected as destinations", () => {
    renderSwitcher({ id: "m0c", status: "processing", appliedAt: APPLIED_AT });

    const labels = menuLabels();
    expect(labels).not.toContain("Processing");
    expect(labels).not.toContain("Selected");
  });

  it("disables the stage the job is already in", () => {
    renderSwitcher({ id: "m2", status: "backlog" });

    expect(screen.getByRole("menuitem", { name: "Backlog" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Stale" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  it("disables only the close reason a closed job already carries", () => {
    renderSwitcher({
      id: "m3",
      status: "closed",
      outcome: "ghosted",
      appliedAt: APPLIED_AT,
    });

    expect(screen.getByRole("menuitem", { name: "Ghosted" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Rejected" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  // `handleClose` deliberately has no same-status early return, so a closed
  // row can correct its outcome in place. Red if one is ever added.
  it("re-closes a closed row under a different reason", async () => {
    renderSwitcher({
      id: "m3b",
      status: "closed",
      outcome: "ghosted",
      appliedAt: APPLIED_AT,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Rejected" }));

    await waitFor(() => expect(api.updateJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateJob).mock.calls[0][1]).toMatchObject({
      status: "closed",
      outcome: "rejected",
    });
  });

  it("flags Tailoring as PDF-less without blocking it", () => {
    renderSwitcher({ id: "m4", status: "discovered", pdfPath: null });

    const item = screen.getByRole("menuitem", { name: /Tailoring/ });
    expect(item).toHaveTextContent("no PDF");
    expect(item).toHaveAttribute("aria-disabled", "false");
  });

  // The fork this slice took: the guard that used to DISABLE this item is now
  // an annotation. Red if it is ever restored.
  it("moves a PDF-less row to Tailoring anyway", async () => {
    renderSwitcher({ id: "m4b", status: "backlog", pdfPath: null });

    fireEvent.click(screen.getByRole("menuitem", { name: /Tailoring/ }));

    await waitFor(() =>
      expect(api.updateJob).toHaveBeenCalledWith("m4b", {
        status: "ready",
        outcome: null,
        closedAt: null,
      }),
    );
  });

  it("drops the PDF-less flag once the row has one", () => {
    renderSwitcher({
      id: "m5",
      status: "applied",
      pdfPath: "/data/pdfs/resume_m5.pdf",
    });

    expect(
      screen.getByRole("menuitem", { name: /Tailoring/ }),
    ).not.toHaveTextContent("no PDF");
  });
});

describe("JobStageSwitcher moves", () => {
  it.each([
    ["Inbox", "discovered"],
    ["Tailoring", "ready"],
    ["Live", "applied"],
    ["Interviewing", "in_progress"],
    ["Backlog", "backlog"],
    ["Stale", "stale"],
    ["Skipped", "skipped"],
  ])("moves to %s as status %s", async (label, status) => {
    renderSwitcher({
      id: "mv",
      status: "closed",
      outcome: "rejected",
      pdfPath: "/data/pdfs/resume_mv.pdf",
    });

    fireEvent.click(screen.getByRole("menuitem", { name: label }));

    await waitFor(() =>
      expect(api.updateJob).toHaveBeenCalledWith("mv", {
        status,
        outcome: null,
        closedAt: null,
      }),
    );
  });

  // The regression this pins: a bare `{status}` PATCH leaves the close-out on
  // the row, so a job moved Closed -> Live wears a "Rejected" chip on a live
  // application and still counts as rejected in the application stats.
  it("clears the close-out when a closed job leaves Closed", async () => {
    renderSwitcher({
      id: "reopen",
      status: "closed",
      outcome: "rejected",
      closedAt: 1_700_000_000,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Live" }));

    await waitFor(() => expect(api.updateJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateJob).mock.calls[0][1]).toEqual({
      status: "applied",
      outcome: null,
      closedAt: null,
    });
  });

  it.each([
    ["Rejected", "rejected"],
    ["Withdrew", "withdrawn"],
    ["Ghosted", "ghosted"],
    ["Other", "other"],
  ])("closes with reason %s", async (label, outcome) => {
    renderSwitcher({ id: "cl", status: "applied", appliedAt: APPLIED_AT });

    fireEvent.click(screen.getByRole("menuitem", { name: label }));

    await waitFor(() => expect(api.updateJob).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(api.updateJob).mock.calls[0][1];
    expect(patch).toMatchObject({ status: "closed", outcome });
    expect(typeof patch.closedAt).toBe("number");
  });

  it("writes closedAt in SECONDS, not milliseconds", async () => {
    renderSwitcher({ id: "cs", status: "applied", appliedAt: APPLIED_AT });

    fireEvent.click(screen.getByRole("menuitem", { name: "Rejected" }));

    await waitFor(() => expect(api.updateJob).toHaveBeenCalledTimes(1));
    const { closedAt } = vi.mocked(api.updateJob).mock.calls[0][1];
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(closedAt).toBeGreaterThan(nowSeconds - 60);
    expect(closedAt).toBeLessThanOrEqual(nowSeconds);
  });

  // The mock leaves disabled items clickable on purpose, so this exercises
  // `handleMove`'s own `status === job.status` early return. Red if it goes.
  it("does nothing when the current stage is selected anyway", async () => {
    renderSwitcher({ id: "same", status: "stale" });

    fireEvent.click(screen.getByRole("menuitem", { name: "Stale" }));

    await waitFor(() => expect(toastSuccess).not.toHaveBeenCalled());
    expect(api.updateJob).not.toHaveBeenCalled();
  });

  /**
   * Correcting the reason on an already-closed row must NOT re-date the
   * closure: `closed_at` drives the Closed date filter and the time-to-close
   * the application stats derive from `closed_at - applied_at`.
   */
  it("keeps the original close date when only the reason changes", async () => {
    renderSwitcher({
      id: "redate",
      status: "closed",
      outcome: "ghosted",
      closedAt: 1_700_000_000,
      appliedAt: APPLIED_AT,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Rejected" }));

    await waitFor(() => expect(api.updateJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateJob).mock.calls[0][1]).toEqual({
      status: "closed",
      outcome: "rejected",
      closedAt: 1_700_000_000,
    });
  });

  /**
   * Undo restores the captured status verbatim, so an undo here would put the
   * row back at `processing` with no tailor behind it — the stuck state this
   * control exists to escape, one click from the toast.
   */
  it("offers no undo for a move OFF processing", async () => {
    renderSwitcher({ id: "stuck", status: "processing" });

    fireEvent.click(screen.getByRole("menuitem", { name: "Inbox" }));

    await waitFor(() => expect(api.updateJob).toHaveBeenCalledTimes(1));
    expect(pushUndo).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Moved to Inbox", {});
  });

  it("pushes an undo entry carrying the pre-move state", async () => {
    renderSwitcher({
      id: "undo",
      status: "closed",
      outcome: "withdrawn",
      closedAt: 1_700_000_000,
      appliedAt: APPLIED_AT,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Interviewing" }));

    await waitFor(() => expect(pushUndo).toHaveBeenCalledTimes(1));
    expect(pushUndo.mock.calls[0][0]).toMatchObject({
      label: "Moved to Interviewing",
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Moved to Interviewing",
      expect.objectContaining({ action: expect.anything() }),
    );
  });

  it("reports a failed move and pushes no undo", async () => {
    vi.mocked(api.updateJob).mockRejectedValueOnce(new Error("nope"));
    renderSwitcher({ id: "fail", status: "backlog" });

    fireEvent.click(screen.getByRole("menuitem", { name: "Live" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("nope"));
    expect(pushUndo).not.toHaveBeenCalled();
  });
});
