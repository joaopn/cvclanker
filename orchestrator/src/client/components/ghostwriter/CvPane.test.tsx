import type { CvDocument, Job } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "@/client/test/renderWithQueryClient";

const apiMocks = vi.hoisted(() => ({
  updateJob: vi.fn(),
  renderCvPdf: vi.fn(),
}));

const activeCvMock = vi.hoisted(() => ({ current: null as CvDocument | null }));

vi.mock("@client/api", () => ({
  updateJob: (...args: unknown[]) => apiMocks.updateJob(...args),
  renderCvPdf: (...args: unknown[]) => apiMocks.renderCvPdf(...args),
}));

vi.mock("@client/hooks/useActiveCv", () => ({
  useActiveCv: () => ({
    cv: activeCvMock.current,
    personName: "",
    isLoading: false,
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { CvPane } from "./CvPane";

const baseCv: CvDocument = {
  id: "cv-1",
  name: "cv.tex",
  flattenedTex: "...",
  fields: [
    { id: "basics.name", role: "name", value: "Ada Lovelace" },
    { id: "experience.0.title", role: "title", value: "Lead Engineer" },
    { id: "experience.0.bullet.0", role: "bullet", value: "Built things." },
    { id: "experience.0.bullet.1", role: "bullet", value: "Shipped things." },
  ],
  personalBrief: "",
  templatedTex: "...",
  defaultFieldValues: {
    "basics.name": "Ada Lovelace",
    "experience.0.title": "Lead Engineer",
    "experience.0.bullet.0": "Built things.",
    "experience.0.bullet.1": "Shipped things.",
  },
  lastCompileStderr: null,
  compileAttempts: 0,
  extractionPrompt: "",
  createdAt: "2026-04-26T00:00:00Z",
  updatedAt: "2026-04-26T00:00:00Z",
};

const baseJob: Job = {
  id: "job-1",
  cvDocumentId: "cv-1",
  tailoredFields: {},
  cvFieldLocks: [],
  pdfPath: null,
  updatedAt: "2026-04-26T00:00:00Z",
} as unknown as Job;

beforeEach(() => {
  apiMocks.updateJob.mockReset();
  apiMocks.renderCvPdf.mockReset();
  activeCvMock.current = baseCv;
});

describe("CvPane", () => {
  it("renders the Fields editor with one row per CvField", () => {
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));
    expect(screen.getByText("basics.name")).toBeInTheDocument();
    expect(screen.getByText("experience.0.bullet.0")).toBeInTheDocument();
    expect(screen.getByText("experience.0.bullet.1")).toBeInTheDocument();
  });

  it("shows the empty state when no CV is uploaded yet", () => {
    activeCvMock.current = null;
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);
    expect(screen.getByText(/no cv uploaded yet/i)).toBeInTheDocument();
  });

  it("disables the PDF tab until a PDF has been rendered", () => {
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);
    const pdfTab = screen.getByRole("button", { name: /^pdf$/i });
    expect(pdfTab).toBeDisabled();
  });

  it("Save persists only fields that diverge from defaults", async () => {
    apiMocks.updateJob.mockResolvedValue({ ...baseJob });
    const onJobUpdated = vi.fn();
    renderWithQueryClient(
      <CvPane job={baseJob} onJobUpdated={onJobUpdated} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    const textareas = screen.getAllByRole("textbox");
    const bulletZero = textareas.find(
      (el) => (el as HTMLTextAreaElement).value === "Built things.",
    );
    expect(bulletZero).toBeDefined();
    fireEvent.change(bulletZero as HTMLTextAreaElement, {
      target: { value: "Built things end-to-end." },
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiMocks.updateJob).toHaveBeenCalled();
    });
    expect(apiMocks.updateJob).toHaveBeenCalledWith("job-1", {
      tailoredFields: {
        "experience.0.bullet.0": "Built things end-to-end.",
      },
    });
  });

  it("toggling lock writes cvFieldLocks on save without touching overrides", async () => {
    apiMocks.updateJob.mockResolvedValue({ ...baseJob });
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    // Find the lock button next to basics.name. The lock title text varies
    // by state — the unlocked state's title starts with "Lock —".
    const lockButtons = screen
      .getAllByRole("button")
      .filter((el) => el.getAttribute("title")?.startsWith("Lock —"));
    expect(lockButtons.length).toBeGreaterThan(0);
    fireEvent.click(lockButtons[0]);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiMocks.updateJob).toHaveBeenCalled();
    });
    const call = apiMocks.updateJob.mock.calls[0][1];
    expect(call.cvFieldLocks?.length).toBe(1);
    expect(call.tailoredFields).toBeUndefined();
  });

  it("Render PDF autosaves dirty state then calls renderCvPdf and switches to PDF tab", async () => {
    apiMocks.updateJob.mockResolvedValue({
      ...baseJob,
      pdfPath: "/data/pdfs/resume_job-1.pdf",
    });
    apiMocks.renderCvPdf.mockResolvedValue({
      ...baseJob,
      pdfPath: "/data/pdfs/resume_job-1.pdf",
    });
    renderWithQueryClient(
      <CvPane
        job={{ ...baseJob, pdfPath: "/data/pdfs/resume_job-1.pdf" } as Job}
        onJobUpdated={vi.fn()}
      />,
    );

    const textareas = screen.getAllByRole("textbox");
    const target = textareas[0] as HTMLTextAreaElement;
    fireEvent.change(target, { target: { value: `${target.value} edited` } });

    fireEvent.click(screen.getByRole("button", { name: /render pdf/i }));

    await waitFor(() => {
      expect(apiMocks.renderCvPdf).toHaveBeenCalledWith("job-1");
    });
    expect(apiMocks.updateJob).toHaveBeenCalled();
    expect(await screen.findByTitle("Compiled CV preview")).toBeInTheDocument();
  });

  it("Raw sub-tab hydrates fence text from the current state", async () => {
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^raw$/i }));

    const textareas = screen.getAllByRole(
      "textbox",
    ) as HTMLTextAreaElement[];
    const raw = textareas[textareas.length - 1];
    expect(raw.value).toContain("--- basics.name ---");
    expect(raw.value).toContain("Ada Lovelace");
    expect(raw.value).toContain("--- experience.0.bullet.0 ---");
  });

  it("Raw sub-tab Save persists the edited override after parsing", async () => {
    apiMocks.updateJob.mockResolvedValue({ ...baseJob });
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^raw$/i }));

    const textareas = screen.getAllByRole(
      "textbox",
    ) as HTMLTextAreaElement[];
    const raw = textareas[textareas.length - 1];
    fireEvent.change(raw, {
      target: {
        value: raw.value.replace("Built things.", "Built fancy things."),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiMocks.updateJob).toHaveBeenCalled();
    });
    expect(apiMocks.updateJob).toHaveBeenCalledWith("job-1", {
      tailoredFields: {
        "experience.0.bullet.0": "Built fancy things.",
      },
    });
  });

  it("Raw sub-tab Save surfaces parse errors and does NOT call updateJob", async () => {
    apiMocks.updateJob.mockResolvedValue({ ...baseJob });
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^raw$/i }));

    const textareas = screen.getAllByRole(
      "textbox",
    ) as HTMLTextAreaElement[];
    const raw = textareas[textareas.length - 1];
    fireEvent.change(raw, {
      target: { value: raw.value.replace("--- basics.name ---", "stray text") },
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(
      await screen.findByText(/parse error/i),
    ).toBeInTheDocument();
    expect(apiMocks.updateJob).not.toHaveBeenCalled();
  });

  it("switching from a malformed Raw tab back to Fields is blocked", async () => {
    renderWithQueryClient(<CvPane job={baseJob} onJobUpdated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^raw$/i }));

    const textareas = screen.getAllByRole(
      "textbox",
    ) as HTMLTextAreaElement[];
    const raw = textareas[textareas.length - 1];
    fireEvent.change(raw, {
      target: { value: raw.value.replace("--- basics.name ---", "garbage") },
    });

    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    // Errors should now be displayed under the Raw textarea, and the Raw
    // textarea is still present (sub-tab did not switch).
    expect(
      await screen.findByText(/parse error/i),
    ).toBeInTheDocument();
    expect(raw).toBeInTheDocument();
  });
});
