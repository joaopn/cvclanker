/**
 * Covers the `s` and `d` shortcuts, and the `r` (Tailor) shortcut's two arms
 * and their interaction with the duplicate-application guard. Both arms were
 * rewritten when the guard landed: the selection arm now goes through
 * `runTailorAction`, and the single-job arm became an async body precisely so a
 * cancelled guard skips the success toast and the row advance — a `.then` chain
 * would have run both on the undefined it passes along, and nothing else in the
 * repo pins that.
 */

import * as api from "@client/api";
import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types.js";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  processJob: vi.fn(),
}));
const skipMutateAsync = vi.fn();
const closeStaleMutateAsync = vi.fn();
vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useMarkAsAppliedMutation: () => ({ mutateAsync: vi.fn() }),
  useSkipJobMutation: () => ({ mutateAsync: skipMutateAsync }),
  useCloseStaleJobMutation: () => ({ mutateAsync: closeStaleMutateAsync }),
}));
const { settingsState } = vi.hoisted(() => ({
  settingsState: {
    cvSourceFormat: "latex" as "latex" | "docx",
    candidateName: null as string | null,
  },
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({
    cvSourceFormat: settingsState.cvSourceFormat,
    candidateName: settingsState.candidateName,
  }),
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

import type { FilterTab } from "./constants";
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
  activeTab?: FilterTab;
}

const setup = (overrides: Overrides = {}) => {
  const runTailorAction =
    overrides.runTailorAction ?? vi.fn().mockResolvedValue(undefined);
  const confirmTailor: ConfirmTailor =
    overrides.confirmTailor ?? (async (jobs) => jobs.map((j) => j.id));
  const handleSelectJobId = vi.fn();
  const loadJobs = vi.fn().mockResolvedValue(undefined);
  const selectedJob = overrides.selectedJob ?? job("j1");
  const runJobAction = vi.fn().mockResolvedValue(undefined);

  renderHook(() =>
    useKeyboardShortcuts({
      isAnyModalOpen: false,
      isAnyModalOpenExcludingCommandBar: false,
      isAnyModalOpenExcludingHelp: false,
      activeTab: overrides.activeTab ?? "inbox",
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
      runJobAction,
      runTailorAction,
      confirmTailor,
      loadJobs,
      onUndo: vi.fn(),
    }),
  );

  return {
    runTailorAction,
    runJobAction,
    confirmTailor,
    handleSelectJobId,
    loadJobs,
  };
};

beforeEach(() => {
  settingsState.cvSourceFormat = "latex";
  settingsState.candidateName = null;
  vi.mocked(api.processJob).mockClear();
  vi.mocked(api.processJob).mockResolvedValue(createJob({ id: "resolved" }));
  toastSuccess.mockClear();
  toastError.mockClear();
  skipMutateAsync.mockReset();
  skipMutateAsync.mockResolvedValue(undefined);
  closeStaleMutateAsync.mockReset();
  closeStaleMutateAsync.mockResolvedValue(undefined);
});

describe("the s shortcut", () => {
  it("closes rather than skips the focused job on the Stale tab", async () => {
    const { loadJobs } = setup({ activeTab: "stale" });

    press("s");

    await waitFor(() => expect(loadJobs).toHaveBeenCalled());
    expect(closeStaleMutateAsync).toHaveBeenCalledWith("j1");
    expect(skipMutateAsync).not.toHaveBeenCalled();
  });

  it("closes the selection on the Stale tab", () => {
    const { runJobAction } = setup({
      activeTab: "stale",
      selectedJobIds: new Set(["j1"]),
    });

    press("s");

    expect(runJobAction).toHaveBeenCalledWith("close_stale");
  });

  it("still skips on the other tabs", async () => {
    const { loadJobs, runJobAction } = setup({
      activeTab: "backlog",
    });

    press("s");

    await waitFor(() => expect(loadJobs).toHaveBeenCalled());
    expect(skipMutateAsync).toHaveBeenCalledWith("j1");
    expect(closeStaleMutateAsync).not.toHaveBeenCalled();
    expect(runJobAction).not.toHaveBeenCalled();
  });
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

describe("the d shortcut", () => {
  const readyJob = () =>
    createJob({ id: "j9", employer: "WU Wien", status: "ready" });
  const pressAndCapture = () => {
    const downloads: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    try {
      press("d");
    } finally {
      click.mockRestore();
    }
    return downloads;
  };

  it("names the CV after the candidate when a name is set", () => {
    settingsState.candidateName = "Jane Q. Doe";
    setup({ activeTab: "tailoring", selectedJob: readyJob() });

    expect(pressAndCapture()).toEqual(["Doe_JQ_resume_WU_Wien.pdf"]);
  });

  it("drops the name part when no name is set, keeping the Word extension", () => {
    settingsState.cvSourceFormat = "docx";
    setup({ activeTab: "tailoring", selectedJob: readyJob() });

    expect(pressAndCapture()).toEqual(["resume_WU_Wien.docx"]);
  });
});
