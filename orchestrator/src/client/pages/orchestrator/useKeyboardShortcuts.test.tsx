/**
 * Covers the `r` (Tailor) shortcut's two arms and their interaction with the
 * duplicate-application guard. Both arms were rewritten when the guard landed:
 * the selection arm now goes through `runTailorAction`, and the single-job arm
 * became an async body precisely so a cancelled guard skips the success toast
 * and the row advance — a `.then` chain would have run both on the undefined it
 * passes along, and nothing else in the repo pins that.
 */

import * as api from "@client/api";
import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types.js";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  processJob: vi.fn(),
}));
vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useMarkAsAppliedMutation: () => ({ mutateAsync: vi.fn() }),
  useSkipJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@client/hooks/useActiveCv", () => ({
  useActiveCv: () => ({ personName: "Test Person" }),
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({ cvSourceFormat: "latex" }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@client/lib/toast", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    message: vi.fn(),
  },
}));

import type { ConfirmTailor } from "./tailorCompanyConflicts";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

const job = (id: string, employer = "Acme"): Job =>
  createJob({ id, employer, status: "discovered" });

const press = (key: string) => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
};

interface Overrides {
  selectedJobIds?: Set<string>;
  selectedJob?: Job | null;
  confirmTailor?: ConfirmTailor;
  runTailorAction?: () => Promise<void>;
}

const setup = (overrides: Overrides = {}) => {
  const runTailorAction =
    overrides.runTailorAction ?? vi.fn().mockResolvedValue(undefined);
  const confirmTailor: ConfirmTailor =
    overrides.confirmTailor ?? (async (jobs) => jobs.map((j) => j.id));
  const handleSelectJobId = vi.fn();
  const loadJobs = vi.fn().mockResolvedValue(undefined);
  const selectedJob = overrides.selectedJob ?? job("j1");

  renderHook(() =>
    useKeyboardShortcuts({
      isAnyModalOpen: false,
      isAnyModalOpenExcludingCommandBar: false,
      isAnyModalOpenExcludingHelp: false,
      activeTab: "inbox",
      activeJobs: selectedJob ? [selectedJob] : [],
      selectedJobId: selectedJob?.id ?? null,
      selectedJob,
      selectedJobIds: overrides.selectedJobIds ?? new Set<string>(),
      isDesktop: true,
      handleSelectJobId,
      requestScrollToJob: vi.fn(),
      setActiveTab: vi.fn(),
      setIsCommandBarOpen: vi.fn(),
      setIsHelpDialogOpen: vi.fn(),
      clearSelection: vi.fn(),
      toggleSelectJob: vi.fn(),
      runJobAction: vi.fn().mockResolvedValue(undefined),
      runTailorAction,
      confirmTailor,
      loadJobs,
      onUndo: vi.fn(),
    }),
  );

  return { runTailorAction, confirmTailor, handleSelectJobId, loadJobs };
};

beforeEach(() => {
  vi.mocked(api.processJob).mockClear();
  vi.mocked(api.processJob).mockResolvedValue(createJob({ id: "resolved" }));
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("the Tailor shortcut with a selection", () => {
  it("goes through runTailorAction, which owns the guard", () => {
    const { runTailorAction } = setup({ selectedJobIds: new Set(["j1"]) });

    press("r");

    expect(runTailorAction).toHaveBeenCalledTimes(1);
    // It must NOT reach the single-job path as well.
    expect(api.processJob).not.toHaveBeenCalled();
  });
});

describe("the Tailor shortcut with no selection", () => {
  it("asks the guard, then tailors the selected job", async () => {
    const confirmTailor = vi.fn().mockResolvedValue(["j1"]);
    const { loadJobs } = setup({ confirmTailor });

    press("r");

    await waitFor(() => expect(api.processJob).toHaveBeenCalledWith("j1"));
    expect(confirmTailor.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "j1", employer: "Acme" }),
    ]);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    await waitFor(() => expect(loadJobs).toHaveBeenCalled());
  });

  it("does not tailor when the guard cancels", async () => {
    const confirmTailor = vi.fn().mockResolvedValue(null);
    setup({ confirmTailor });

    press("r");

    await waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));
    expect(api.processJob).not.toHaveBeenCalled();
  });

  it("skips the success toast and the row advance on a cancel", async () => {
    // The reason this arm is an async body rather than a .then chain: a chained
    // .then would run both of these on the undefined it passes along.
    const confirmTailor = vi.fn().mockResolvedValue(null);
    const { handleSelectJobId, loadJobs } = setup({ confirmTailor });

    press("r");

    await waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(handleSelectJobId).not.toHaveBeenCalled();
    expect(loadJobs).not.toHaveBeenCalled();
  });

  it("reports a failed tailor without claiming it started", async () => {
    vi.mocked(api.processJob).mockRejectedValue(new Error("boom"));
    setup();

    press("r");

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
