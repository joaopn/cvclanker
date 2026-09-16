import { composeTailoringFailure } from "@shared/tailoring-failure";
import { createJob } from "@shared/testing/factories.js";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type React from "react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel starts a tailor through the API client; the guard tests assert
// exactly whether that call happens, so it must not reach the network.
// A factory mock replaces the WHOLE module, and a missing export throws on
// first access rather than at mock time — so every `@client/api` function this
// component tree can reach has to be listed, not just the one under test.
vi.mock("@client/api", () => ({
  processJob: vi.fn().mockResolvedValue(undefined),
  updateJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useSkipJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@client/hooks/useRescoreJob", () => ({
  useRescoreJob: () => ({ isRescoring: false, rescoreJob: vi.fn() }),
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({ renderMarkdownInJobDescriptions: false }),
}));

import * as api from "@client/api";
import {
  type UndoController,
  UndoProvider,
} from "@client/pages/orchestrator/useUndoController";
import { DiscoveredPanel } from "./DiscoveredPanel";

/**
 * The panel mounts `JobStageSwitcher`, which reads the Manage screen's undo
 * controller — `OrchestratorPage` provides it around this whole tree. Wrapping
 * here keeps the real switcher on the path rather than mocking it away, and
 * `rerender` re-wraps because RTL re-renders at the ROOT.
 */
const undoStub: UndoController = {
  pushUndo: () => {},
  undo: async () => {},
  canUndo: false,
  pendingLabel: null,
};

const render = (ui: React.ReactElement) => {
  const result = rtlRender(<UndoProvider value={undoStub}>{ui}</UndoProvider>);
  return {
    ...result,
    rerender: (next: React.ReactElement) =>
      result.rerender(<UndoProvider value={undoStub}>{next}</UndoProvider>),
  };
};

beforeEach(() => {
  vi.mocked(api.processJob).mockClear();
});

const noop = () => {};

/** Default guard for the existing fixtures: approve everything, ask nothing. */
const allowTailor = async (jobs: readonly { id: string }[]) =>
  jobs.map((job) => job.id);

describe("DiscoveredPanel failed-tailor state", () => {
  it("shows the retry state (reason + Retry) for a failed processing row, not the spinner", () => {
    render(
      <DiscoveredPanel
        job={createJob({
          id: "f",
          status: "processing",
          tailoringFailureReason: "LLM provider error",
        })}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={allowTailor}
      />,
    );
    expect(
      screen.getByText("Last tailoring attempt failed"),
    ).toBeInTheDocument();
    expect(screen.getByText("LLM provider error")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /retry tailoring/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Processing job/i)).not.toBeInTheDocument();
  });

  it("shows the spinner for a clean (running) processing row", () => {
    render(
      <DiscoveredPanel
        job={createJob({ id: "r", status: "processing" })}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={allowTailor}
      />,
    );
    expect(screen.getByText(/Processing job/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Last tailoring attempt failed"),
    ).not.toBeInTheDocument();
  });

  /**
   * The escape hatch. A clean `processing` row is refused by the bulk skip
   * guard (`SKIPPABLE_STATUSES` has no `processing`) and by delete (which keys
   * on a null failure reason), and this spinner is its only detail view — so
   * a tailor that never finishes used to leave the row stuck with nothing in
   * the app able to move it.
   */
  it("offers the stage switcher on the spinner so a stuck row can be moved", () => {
    render(
      <DiscoveredPanel
        job={createJob({ id: "stuck", status: "processing" })}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={allowTailor}
      />,
    );

    expect(
      screen.getByRole("button", { name: /^Stage: Processing/ }),
    ).toBeInTheDocument();
  });

  it("offers the stage switcher beside the triage buttons", () => {
    render(
      <DiscoveredPanel
        job={createJob({ id: "triage", status: "discovered" })}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={allowTailor}
      />,
    );

    expect(
      screen.getByRole("button", { name: /^Stage: Inbox/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start tailoring/i }),
    ).toBeInTheDocument();
  });
});

describe("failed-tailor detail disclosure", () => {
  const REASON = composeTailoringFailure(
    "Tailoring failed: The model returned the list of changes in an unexpected shape.",
    'Parsed value was a string.\npatchesJson (2554 chars) was:\n"[{...}]"',
  );

  const panel = (id: string, tailoringFailureReason: string) => (
    // StrictMode double-invokes render, which is where this component adjusts
    // its disclosure state — the reset must be idempotent under it.
    <StrictMode>
      <DiscoveredPanel
        job={createJob({ id, status: "processing", tailoringFailureReason })}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={allowTailor}
      />
    </StrictMode>
  );

  it("shows the summary and hides the detail behind a disclosure", () => {
    render(panel("a", REASON));

    expect(
      screen.getByText(
        "Tailoring failed: The model returned the list of changes in an unexpected shape.",
      ),
    ).toBeInTheDocument();
    // The detail is what the user could not see before; it must not be
    // rendered until asked for.
    expect(screen.queryByText(/patchesJson/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText(/patchesJson \(2554 chars\)/)).toBeInTheDocument();
  });

  it("offers no disclosure for a reason that carries no detail", () => {
    render(panel("b", "Tailoring interrupted (server restart)"));

    expect(
      screen.getByText("Tailoring interrupted (server restart)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show details/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses an expanded detail when a different job is shown", () => {
    const { rerender } = render(panel("a", REASON));
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText(/patchesJson/)).toBeInTheDocument();

    // A fresh element: re-rendering an identical one makes React bail out and
    // the assertion would hold for the wrong reason.
    rerender(panel("second-job", REASON));

    expect(screen.queryByText(/patchesJson/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show details/i }),
    ).toBeInTheDocument();
  });
});

describe("DiscoveredPanel duplicate-application guard", () => {
  const failedRow = () =>
    createJob({
      id: "j1",
      employer: "Acme",
      status: "processing",
      tailoringFailureReason: "LLM provider error",
    });

  const retry = () =>
    fireEvent.click(screen.getByRole("button", { name: /retry tailoring/i }));

  it("asks the guard before starting a tailor, with the job it would tailor", async () => {
    const confirmTailor = vi.fn().mockResolvedValue(["j1"]);
    render(
      <DiscoveredPanel
        job={failedRow()}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={confirmTailor}
      />,
    );

    retry();

    await vi.waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));
    expect(confirmTailor.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "j1", employer: "Acme" }),
    ]);
    await vi.waitFor(() => expect(api.processJob).toHaveBeenCalledWith("j1"));
  });

  it("cannot start two tailors from a double click", async () => {
    // `isFinalizing` is state, so two clicks in one tick both read it as false;
    // the guard's fetch makes that window a whole round trip wide.
    let release!: (ids: string[]) => void;
    const confirmTailor = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <DiscoveredPanel
        job={failedRow()}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={confirmTailor}
      />,
    );

    const button = screen.getByRole("button", { name: /retry tailoring/i });
    fireEvent.click(button);
    fireEvent.click(button);
    await vi.waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));

    release(["j1"]);
    await vi.waitFor(() => expect(api.processJob).toHaveBeenCalledTimes(1));
  });

  it("does not tailor when the guard cancels", async () => {
    const confirmTailor = vi.fn().mockResolvedValue(null);
    render(
      <DiscoveredPanel
        job={failedRow()}
        onJobUpdated={noop}
        onJobMoved={noop}
        confirmTailor={confirmTailor}
      />,
    );

    retry();

    await vi.waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));
    expect(api.processJob).not.toHaveBeenCalled();
  });
});
