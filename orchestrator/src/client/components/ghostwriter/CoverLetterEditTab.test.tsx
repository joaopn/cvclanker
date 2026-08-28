import type { CoverLetterDocument, Job } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "@/client/test/renderWithQueryClient";

const apiMocks = vi.hoisted(() => ({
  updateJob: vi.fn(),
  generateCoverLetter: vi.fn(),
  renderCoverLetterPdf: vi.fn(),
}));

const activeCoverLetterMock = vi.hoisted(() => ({
  current: null as CoverLetterDocument | null,
}));

vi.mock("@client/api", () => ({
  updateJob: (...args: unknown[]) => apiMocks.updateJob(...args),
  generateCoverLetter: (...args: unknown[]) =>
    apiMocks.generateCoverLetter(...args),
  renderCoverLetterPdf: (...args: unknown[]) =>
    apiMocks.renderCoverLetterPdf(...args),
}));

vi.mock("@client/hooks/useActiveCoverLetter", () => ({
  useActiveCoverLetter: () => ({
    coverLetter: activeCoverLetterMock.current,
    bodyFieldId:
      activeCoverLetterMock.current?.fields.find((f) => f.role === "body")
        ?.id ?? null,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { CoverLetterPane } from "./CoverLetterPane";

const TEMPLATE_BODY = "Dear Other Company, I have long admired your work.";

const baseCoverLetter: CoverLetterDocument = {
  id: "cl-1",
  name: "letter.tex",
  flattenedTex: "...",
  fields: [
    { id: "recipient", role: "name", value: "Hiring Team" },
    { id: "letter.body", role: "body", value: TEMPLATE_BODY },
  ],
  templatedTex: "...",
  defaultFieldValues: {
    recipient: "Hiring Team",
    "letter.body": TEMPLATE_BODY,
  },
  lastCompileStderr: null,
  compileAttempts: 0,
  extractionPrompt: "",
  createdAt: "2026-04-26T00:00:00Z",
  updatedAt: "2026-04-26T00:00:00Z",
};

const baseJob: Job = {
  id: "job-1",
  coverLetterDocumentId: "cl-1",
  coverLetterFieldOverrides: {},
  coverLetterDraft: "",
  coverLetterPdfPath: null,
  updatedAt: "2026-04-26T00:00:00Z",
} as unknown as Job;

const bodyTextarea = (): HTMLTextAreaElement => {
  const rows = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
  const found = rows.find(
    (el) => el.getAttribute("data-field-id") === "letter.body",
  );
  // The Fields editor does not tag rows, so fall back to position: the body
  // is the second field on this fixture.
  return (found ?? rows[1]) as HTMLTextAreaElement;
};

beforeEach(() => {
  apiMocks.updateJob.mockReset();
  apiMocks.generateCoverLetter.mockReset();
  apiMocks.renderCoverLetterPdf.mockReset();
  activeCoverLetterMock.current = baseCoverLetter;
});

describe("CoverLetterEditTab", () => {
  it("opens with an EMPTY body — never the uploaded letter's prose", () => {
    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    expect(screen.queryByDisplayValue(TEMPLATE_BODY)).toBeNull();
    expect(bodyTextarea().value).toBe("");
  });

  it("keeps every non-body field on its document default", () => {
    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    expect(screen.getByDisplayValue("Hiring Team")).toBeInTheDocument();
  });

  it("opens undirty, so nothing offers to persist the blank body", () => {
    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("still surfaces a legacy free-text draft as the body", () => {
    renderWithQueryClient(
      <CoverLetterPane
        job={{ ...baseJob, coverLetterDraft: "An older draft." } as Job}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    expect(screen.getByDisplayValue("An older draft.")).toBeInTheDocument();
  });

  it("does NOT re-seed a legacy draft that is just the template body", () => {
    renderWithQueryClient(
      <CoverLetterPane
        job={{ ...baseJob, coverLetterDraft: TEMPLATE_BODY } as Job}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    expect(screen.queryByDisplayValue(TEMPLATE_BODY)).toBeNull();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("shows a per-job override when one exists", () => {
    renderWithQueryClient(
      <CoverLetterPane
        job={
          {
            ...baseJob,
            coverLetterFieldOverrides: { "letter.body": "Written for Acme." },
          } as Job
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));

    expect(screen.getByDisplayValue("Written for Acme.")).toBeInTheDocument();
  });

  it("Generate drafts, then renders, then switches to the PDF tab", async () => {
    apiMocks.generateCoverLetter.mockResolvedValue({ ...baseJob });
    apiMocks.renderCoverLetterPdf.mockResolvedValue({ ...baseJob });

    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(apiMocks.renderCoverLetterPdf).toHaveBeenCalledWith("job-1");
    });
    expect(apiMocks.generateCoverLetter).toHaveBeenCalledWith("job-1");
    // The PDF pane is the only surface that renders this copy, so seeing it
    // proves Generate landed the user on the PDF tab. (The job prop is not
    // refetched in this harness, so the pane shows its not-yet-rendered
    // state rather than an iframe.)
    await waitFor(() => {
      expect(
        screen.getByText(/no cover-letter pdf rendered yet/i),
      ).toBeInTheDocument();
    });
  });

  it("saves pending field edits before generating, so the PDF includes them", async () => {
    apiMocks.updateJob.mockResolvedValue({ ...baseJob });
    apiMocks.generateCoverLetter.mockResolvedValue({ ...baseJob });
    apiMocks.renderCoverLetterPdf.mockResolvedValue({ ...baseJob });

    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^fields$/i }));
    fireEvent.change(screen.getByDisplayValue("Hiring Team"), {
      target: { value: "Acme People Team" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(apiMocks.updateJob).toHaveBeenCalledWith("job-1", {
        coverLetterFieldOverrides: { recipient: "Acme People Team" },
      });
    });
    // Generate reads the PERSISTED overrides, so the save has to land first.
    expect(apiMocks.updateJob.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.generateCoverLetter.mock.invocationCallOrder[0],
    );
  });

  it("commits a pending Raw-tab edit before generating", async () => {
    apiMocks.updateJob.mockResolvedValue({ ...baseJob });
    apiMocks.generateCoverLetter.mockResolvedValue({ ...baseJob });
    apiMocks.renderCoverLetterPdf.mockResolvedValue({ ...baseJob });

    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^raw$/i }));
    const raw = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(raw, {
      target: {
        value: raw.value.replace("Hiring Team", "Acme People Team"),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(apiMocks.updateJob).toHaveBeenCalledWith("job-1", {
        coverLetterFieldOverrides: { recipient: "Acme People Team" },
      });
    });
  });

  it("stays on the Edit tab when the post-generate render fails", async () => {
    apiMocks.generateCoverLetter.mockResolvedValue({ ...baseJob });
    apiMocks.renderCoverLetterPdf.mockRejectedValue(new Error("tectonic died"));

    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(apiMocks.renderCoverLetterPdf).toHaveBeenCalled();
    });
    // Switching to a PDF that was never produced is the UI lying about what
    // happened; the toolbar must still be the Edit one.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^generate$/i })).toBeEnabled();
    });
    expect(screen.queryByText(/no cover-letter pdf rendered yet/i)).toBeNull();
  });

  it("keeps the draft when the post-generate render fails", async () => {
    apiMocks.generateCoverLetter.mockResolvedValue({ ...baseJob });
    apiMocks.renderCoverLetterPdf.mockRejectedValue(new Error("tectonic died"));
    const { toast } = await import("sonner");

    renderWithQueryClient(<CoverLetterPane job={baseJob} />);
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/drafted, but the PDF failed to render/i),
      );
    });
  });
});
