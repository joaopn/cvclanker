/**
 * Covers the two tailor entry points that live in this file and nothing else.
 * There was no test file here at all, so both gates the duplicate-application
 * guard added were wired-by-tsc but unverified — and one of them
 * (`handleProcess`'s non-`ready` arm, reachable from the All Jobs tab's
 * More-actions menu) was missed entirely by the first cut of that work.
 *
 * The heavy children are stubbed: this asserts handler behaviour, not layout.
 */

import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  processJob: vi.fn(),
  generateJobPdf: vi.fn(),
  updateJob: vi.fn(),
  updateJobOutcome: vi.fn(),
}));

// `vi.mock` factories are hoisted above the file body, so a shared `stub`
// helper declared here would hit its own TDZ. `vi.hoisted` is the escape.
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => <div data-testid={name} />,
}));
vi.mock("@client/components", () => ({
  DiscoveredPanel: stub("discovered-panel"),
  FitAssessment: stub("fit-assessment"),
  FitIndicator: stub("fit-indicator"),
}));
vi.mock("@client/components/ReadyPanel", () => ({
  ReadyPanel: stub("ready-panel"),
}));
vi.mock("@client/components/JobDetailsEditDrawer", () => ({
  JobDetailsEditDrawer: stub("edit-drawer"),
}));
vi.mock("./InterviewQaSection", () => ({
  InterviewQaSection: stub("interview-qa"),
}));
vi.mock("./JobDocumentsPanel", () => ({
  JobDocumentsPanel: stub("documents"),
}));
vi.mock("./JobNotesSection", () => ({ JobNotesSection: stub("notes") }));
vi.mock("./JobStageSwitcher", () => ({
  JobStageSwitcher: stub("stage-switcher"),
}));
vi.mock("./MarkClosedPopover", () => ({
  MarkClosedPopover: stub("mark-closed"),
}));
vi.mock("./CompanyNameButton", () => ({
  CompanyNameButton: ({ employer }: { employer: string }) => (
    <span>{employer}</span>
  ),
}));

vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useMarkAsAppliedMutation: () => ({ mutateAsync: vi.fn() }),
  useSkipJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@client/hooks/useActiveCv", () => ({
  useActiveCv: () => ({ personName: "Test Person" }),
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({
    cvSourceFormat: "latex",
    renderMarkdownInJobDescriptions: false,
  }),
}));
vi.mock("./useUndoController", () => ({
  useUndo: () => ({ pushUndo: vi.fn(), undo: vi.fn() }),
}));
vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

// The More-actions menu is a Radix dropdown, which cannot open in jsdom
// (no pointer-capture stubs). Render its content inline so the item is
// reachable — the item's onSelect is what this file is about.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const React = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children?: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
  };
});

import * as api from "@client/api";
import { JobDetailPanel } from "./JobDetailPanel";
import type { ConfirmTailor } from "./tailorCompanyConflicts";

const backlogJob = (): Job =>
  createJob({
    id: "j1",
    employer: "Acme",
    title: "Staff Engineer",
    status: "backlog",
  });

const allow = async (jobs: readonly { id: string }[]) => jobs.map((j) => j.id);
const refuse = async () => null;

const renderPanel = (job: Job, confirmTailor: ConfirmTailor = allow) =>
  render(
    <JobDetailPanel
      activeTab="all"
      activeJobs={[]}
      selectedJob={job}
      onSelectJobId={vi.fn()}
      onJobUpdated={vi.fn().mockResolvedValue(undefined)}
      confirmTailor={confirmTailor}
    />,
  );

beforeEach(() => {
  vi.mocked(api.processJob)
    .mockClear()
    .mockResolvedValue(createJob({ id: "resolved" }));
  vi.mocked(api.generateJobPdf)
    .mockClear()
    .mockResolvedValue(createJob({ id: "resolved" }));
});

describe("the backlog/stale row Tailor button", () => {
  it("asks the guard and tailors on approval", async () => {
    const confirmTailor = vi.fn().mockResolvedValue(["j1"]);
    renderPanel(backlogJob(), confirmTailor);

    fireEvent.click(screen.getByRole("button", { name: /^Tailor$/ }));

    await waitFor(() => expect(api.processJob).toHaveBeenCalledWith("j1"));
    expect(confirmTailor.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "j1", employer: "Acme" }),
    ]);
  });

  it("does not tailor when the guard cancels", async () => {
    const confirmTailor = vi.fn(refuse);
    renderPanel(backlogJob(), confirmTailor);

    fireEvent.click(screen.getByRole("button", { name: /^Tailor$/ }));

    await waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));
    expect(api.processJob).not.toHaveBeenCalled();
  });

  it("cannot start two tailors from a double click", async () => {
    // The button carries no disabled state, and the guard puts a fetch in
    // front of the dispatch.
    let release!: (ids: string[]) => void;
    const confirmTailor = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    renderPanel(backlogJob(), confirmTailor);

    const button = screen.getByRole("button", { name: /^Tailor$/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));

    release(["j1"]);
    await waitFor(() => expect(api.processJob).toHaveBeenCalledTimes(1));
  });
});

describe("the More-actions Generate PDF item", () => {
  it("guards the tailor arm for a discovered row on the All Jobs tab", async () => {
    const confirmTailor = vi.fn(refuse);
    const discovered = createJob({
      id: "j3",
      employer: "Acme",
      status: "discovered",
    });
    renderPanel(discovered, confirmTailor);

    fireEvent.click(screen.getByRole("button", { name: "Generate PDF" }));

    await waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));
    expect(api.processJob).not.toHaveBeenCalled();
  });

  it("tailors that row when the guard approves", async () => {
    const confirmTailor = vi.fn(allow);
    const discovered = createJob({
      id: "j3",
      employer: "Acme",
      status: "discovered",
    });
    renderPanel(discovered, confirmTailor);

    fireEvent.click(screen.getByRole("button", { name: "Generate PDF" }));

    await waitFor(() => expect(api.processJob).toHaveBeenCalledWith("j3"));
  });

  it("cannot start two tailors from a double select", async () => {
    // `setProcessingJobId` sits after an await and this handler never reads it
    // — only the rendered `disabled` does, from a promise continuation — so it
    // does not close this window on its own.
    let release!: (ids: string[]) => void;
    const confirmTailor = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const discovered = createJob({
      id: "j3",
      employer: "Acme",
      status: "discovered",
    });
    renderPanel(discovered, confirmTailor);

    const item = screen.getByRole("button", { name: "Generate PDF" });
    fireEvent.click(item);
    fireEvent.click(item);
    await waitFor(() => expect(confirmTailor).toHaveBeenCalledTimes(1));

    release(["j3"]);
    await waitFor(() => expect(api.processJob).toHaveBeenCalledTimes(1));
  });

  it("does NOT guard the ready arm, which re-renders an existing PDF", async () => {
    const confirmTailor = vi.fn(allow);
    const ready = createJob({
      id: "j2",
      employer: "Acme",
      status: "ready",
      pdfPath: "resume_j2.pdf",
    });
    renderPanel(ready, confirmTailor);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate PDF" }));

    await waitFor(() => expect(api.generateJobPdf).toHaveBeenCalledWith("j2"));
    expect(confirmTailor).not.toHaveBeenCalled();
    expect(api.processJob).not.toHaveBeenCalled();
  });
});
