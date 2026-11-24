/**
 * Covers the two Download buttons' file names and when the Add real URL button
 * shows; every child with its own data or layout concerns is stubbed.
 */

import { createJob } from "@shared/testing/factories";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { stub, settingsState } = vi.hoisted(() => ({
  stub: (name: string) => () => <div data-testid={name} />,
  settingsState: {
    cvSourceFormat: "latex" as "latex" | "docx" | "html",
    candidateName: null as string | null,
  },
}));

vi.mock("@client/api", () => ({}));
vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useMarkAsAppliedMutation: () => ({ mutateAsync: vi.fn() }),
  useSkipJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@client/hooks/useActiveCv", () => ({
  useActiveCv: () => ({ cv: null }),
}));
vi.mock("@client/hooks/useRescoreJob", () => ({
  useRescoreJob: () => ({ isRescoring: false, rescoreJob: vi.fn() }),
}));
vi.mock("@client/hooks/useResizableListPanel", () => ({
  useResizablePanel: () => ({
    width: 380,
    isDragging: false,
    startDrag: vi.fn(),
  }),
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({
    cvSourceFormat: settingsState.cvSourceFormat,
    candidateName: settingsState.candidateName,
    renderMarkdownInJobDescriptions: false,
    hasScorerPrefilter: false,
  }),
}));
vi.mock("@client/pages/orchestrator/useUndoController", () => ({
  useUndo: () => ({ pushUndo: vi.fn(), undo: vi.fn() }),
}));
vi.mock("@client/pages/orchestrator/CompanyNameButton", () => ({
  CompanyNameButton: ({ employer }: { employer: string }) => (
    <span>{employer}</span>
  ),
}));
vi.mock("@client/pages/orchestrator/JobStageSwitcher", () => ({
  JobStageSwitcher: stub("stage-switcher"),
}));
vi.mock("@client/components", () => ({
  FitAssessment: stub("fit-assessment"),
}));
vi.mock("./ghostwriter/AtsCoverageBadge", () => ({
  AtsCoverageBadge: stub("ats-badge"),
}));
vi.mock("./ghostwriter/BriefPane", () => ({ BriefPane: stub("brief") }));
vi.mock("./ghostwriter/CoverLetterPane", () => ({
  CoverLetterPane: stub("cover-pane"),
}));
vi.mock("./ghostwriter/CvPane", () => ({ CvPane: stub("cv-pane") }));
vi.mock("./ghostwriter/GhostwriterPanel", () => ({
  GhostwriterPanel: stub("ghostwriter"),
}));
vi.mock("./ghostwriter/TailorColumnSplitter", () => ({
  TailorColumnSplitter: stub("splitter"),
}));
vi.mock("./JobDescriptionMarkdown", () => ({
  JobDescriptionMarkdown: stub("description"),
}));
vi.mock("./JobDetailsEditDrawer", () => ({
  JobDetailsEditDrawer: stub("edit-drawer"),
}));
vi.mock("./OpenJobListingButton", () => ({
  OpenJobListingButton: stub("open-listing"),
}));
vi.mock("./ReadySummaryAccordion", () => ({
  ReadySummaryAccordion: stub("summary"),
}));

import { ReadyPanel } from "./ReadyPanel";

const readyJob = () =>
  createJob({
    id: "j1",
    employer: "Acme Corp Ltd",
    status: "ready",
    pdfPath: "resume_j1.pdf",
    coverLetterPdfPath: "cover_letter_j1.pdf",
  });

const renderPanel = (job = readyJob()) =>
  render(<ReadyPanel job={job} onJobUpdated={vi.fn()} onJobMoved={vi.fn()} />);

const downloadName = (label: string) =>
  screen.getByText(label).closest("a")?.getAttribute("download");

beforeEach(() => {
  settingsState.cvSourceFormat = "latex";
  settingsState.candidateName = null;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ReadyPanel download names", () => {
  it("names the CV and the cover letter after the candidate", () => {
    settingsState.candidateName = "Jane Q. Doe";
    renderPanel();

    expect(downloadName("Download CV")).toBe("Doe_JQ_resume_Acme_Corp_Ltd.pdf");
    expect(downloadName("Download Cover")).toBe(
      "Doe_JQ_cover_Acme_Corp_Ltd.pdf",
    );
  });

  it("drops the name part when no name is set, keeping the Word extension", () => {
    settingsState.cvSourceFormat = "docx";
    renderPanel();

    expect(downloadName("Download .docx")).toBe("resume_Acme_Corp_Ltd.docx");
    expect(downloadName("Download Cover")).toBe("cover_Acme_Corp_Ltd.pdf");
  });

  it("hands over an HTML CV's tailored zip under Download CV", () => {
    settingsState.cvSourceFormat = "html";
    renderPanel({ ...readyJob(), tailoredSourceShape: "bundle" });

    const link = screen.getByText("Download CV").closest("a");
    expect(link?.getAttribute("download")).toBe("resume_Acme_Corp_Ltd.zip");
    expect(link?.getAttribute("href")).toMatch(/^\/pdfs\/resume_j1\.zip\?v=/);
  });
});

describe("ReadyPanel Add real URL button", () => {
  const linkedInJob = (overrides: Parameters<typeof createJob>[0] = {}) =>
    createJob({
      ...readyJob(),
      jobUrl: "https://www.linkedin.com/jobs/view/2000012345",
      applicationLink: null,
      ...overrides,
    });
  const checkedAt = "2026-11-20T10:00:00.000Z";
  const addButton = () =>
    screen.queryByRole("button", { name: "Add real URL" });

  it("shows on a LinkedIn job that was never live-checked", () => {
    renderPanel(linkedInJob());
    expect(addButton()).toBeInTheDocument();
  });

  it("shows on a LinkedIn job checked as not Easy Apply", () => {
    renderPanel(
      linkedInJob({
        liveStatusCheckedAt: checkedAt,
        liveEasyApply: false,
        liveClosed: false,
      }),
    );
    expect(addButton()).toBeInTheDocument();
  });

  it("is absent on an Easy Apply job", () => {
    renderPanel(
      linkedInJob({
        liveStatusCheckedAt: checkedAt,
        liveEasyApply: true,
        liveClosed: false,
      }),
    );
    expect(addButton()).not.toBeInTheDocument();
  });

  it("is absent once the job has an application address off LinkedIn", () => {
    renderPanel(
      linkedInJob({ applicationLink: "https://careers.example.com/apply/42" }),
    );
    expect(addButton()).not.toBeInTheDocument();
  });
});
