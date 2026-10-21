import type { CvDocument } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "@/client/test/renderWithQueryClient";

const apiMocks = vi.hoisted(() => ({
  listCvDocuments: vi.fn(),
  getCvDocument: vi.fn(),
  fetchExtractionPromptDefault: vi.fn(),
  updateCvDocument: vi.fn(),
}));

vi.mock("@client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@client/api")>()),
  listCvDocuments: () => apiMocks.listCvDocuments(),
  getCvDocument: (id: string) => apiMocks.getCvDocument(id),
  fetchExtractionPromptDefault: () => apiMocks.fetchExtractionPromptDefault(),
  updateCvDocument: (...args: unknown[]) => apiMocks.updateCvDocument(...args),
}));

const settingsMock = vi.hoisted(() => ({
  current: { cvSourceFormat: "latex", isLoading: false },
}));

vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => settingsMock.current,
}));

vi.mock("@client/components/ActivityLogButton", () => ({
  ActivityLogButton: () => null,
}));

vi.mock("@client/components/LlmStatusButton", () => ({
  LlmStatusButton: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { CvPage } from "./CvPage";

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter>
      <CvPage />
    </MemoryRouter>,
  );
}

const cv: CvDocument = {
  id: "cv-1",
  name: "Ada CV",
  flattenedTex: "...",
  fields: [{ id: "basics.name", role: "name", value: "Ada" }],
  personalBrief: "I'm Ada.",
  templatedTex: "\\begin{document}\n«basics.name»\n\\end{document}\n",
  defaultFieldValues: { "basics.name": "Ada" },
  lastCompileStderr: null,
  compileAttempts: 1,
  extractionPrompt: "",
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
};

describe("CvPage editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.current = { cvSourceFormat: "latex", isLoading: false };
    apiMocks.listCvDocuments.mockResolvedValue([
      {
        id: cv.id,
        name: cv.name,
        createdAt: cv.createdAt,
        updatedAt: cv.updatedAt,
      },
    ]);
    apiMocks.getCvDocument.mockResolvedValue(cv);
    apiMocks.fetchExtractionPromptDefault.mockResolvedValue("prompt");
  });

  it("shows the stored name again after saving a cleared name", async () => {
    apiMocks.updateCvDocument.mockResolvedValue({
      ...cv,
      updatedAt: "2026-10-21T00:00:00Z",
    });
    renderPage();
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(apiMocks.updateCvDocument).toHaveBeenCalledWith("cv-1", {
        name: "Ada CV",
        personalBrief: "I'm Ada.",
      }),
    );
    await waitFor(() => expect(name.value).toBe("Ada CV"));
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
  });

  it("mounts the template editor for a templated LaTeX CV", async () => {
    renderPage();
    expect(await screen.findByLabelText("Templated LaTeX")).toHaveValue(
      cv.templatedTex,
    );
  });

  it.each([
    [
      "settings are still loading",
      { cvSourceFormat: "latex", isLoading: true },
      cv,
    ],
    [
      "the profile uses Word CVs",
      { cvSourceFormat: "docx", isLoading: false },
      cv,
    ],
    [
      "the CV has no template",
      { cvSourceFormat: "latex", isLoading: false },
      { ...cv, templatedTex: "" },
    ],
  ])("leaves the template editor out when %s", async (_label, settings, doc) => {
    settingsMock.current = settings;
    apiMocks.getCvDocument.mockResolvedValue(doc);
    renderPage();
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Templated LaTeX")).not.toBeInTheDocument();
  });
});
