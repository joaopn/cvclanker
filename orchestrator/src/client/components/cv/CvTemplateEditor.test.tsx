import type { CvDocument } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "@/client/test/renderWithQueryClient";

const apiMocks = vi.hoisted(() => ({
  updateCvTemplate: vi.fn(),
}));

vi.mock("@client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@client/api")>()),
  updateCvTemplate: (...args: unknown[]) => apiMocks.updateCvTemplate(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { ApiClientError } from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { CvTemplateEditor } from "./CvTemplateEditor";

const TEMPLATE = "\\begin{document}\n«basics.name»\\\\\n\\end{document}\n";
const EDITED = "\\begin{document}\n«basics.name»\n\\end{document}\n";

const baseCv: CvDocument = {
  id: "cv-1",
  name: "ada.tex",
  flattenedTex: "...",
  fields: [{ id: "basics.name", role: "name", value: "Ada" }],
  personalBrief: "",
  templatedTex: TEMPLATE,
  defaultFieldValues: { "basics.name": "Ada" },
  lastCompileStderr: null,
  compileAttempts: 1,
  extractionPrompt: "",
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
};

function editor(): HTMLTextAreaElement {
  return screen.getByLabelText("Templated LaTeX") as HTMLTextAreaElement;
}

describe("CvTemplateEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the stored template and enables Save only once it is edited", () => {
    renderWithQueryClient(<CvTemplateEditor cv={baseCv} />);
    expect(editor().value).toBe(TEMPLATE);
    const save = screen.getByRole("button", { name: /save template/i });
    expect(save).toBeDisabled();
    fireEvent.change(editor(), { target: { value: EDITED } });
    expect(save).toBeEnabled();
  });

  it("sends the edited template for this CV", async () => {
    apiMocks.updateCvTemplate.mockResolvedValue({
      ...baseCv,
      templatedTex: EDITED,
    });
    renderWithQueryClient(<CvTemplateEditor cv={baseCv} />);
    fireEvent.change(editor(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    await waitFor(() =>
      expect(apiMocks.updateCvTemplate).toHaveBeenCalledWith("cv-1", EDITED),
    );
  });

  it("keeps the draft and shows the compile log when the save fails", async () => {
    apiMocks.updateCvTemplate.mockRejectedValue(
      new ApiClientError("LaTeX render failed: tectonic exited 1", {
        status: 422,
        details: { code: "COMPILE_FAILED", stderr: "! Undefined control." },
      }),
    );
    renderWithQueryClient(<CvTemplateEditor cv={baseCv} />);
    fireEvent.change(editor(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    expect(await screen.findByText("Template not saved")).toBeInTheDocument();
    expect(screen.getByText("! Undefined control.")).toBeInTheDocument();
    expect(editor().value).toBe(EDITED);
  });

  it("names the markers an edit dropped or invented", async () => {
    apiMocks.updateCvTemplate.mockRejectedValue(
      new ApiClientError("The template must keep every «field» marker.", {
        status: 422,
        details: { missing: ["basics.name"], unknown: ["basics.nom"] },
      }),
    );
    renderWithQueryClient(<CvTemplateEditor cv={baseCv} />);
    fireEvent.change(editor(), { target: { value: "«basics.nom»" } });
    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    expect(
      await screen.findByText("Missing markers: basics.name"),
    ).toBeInTheDocument();
    expect(screen.getByText("Unknown markers: basics.nom")).toBeInTheDocument();
  });

  it("names markers left only in a comment and new LaTeX errors", async () => {
    apiMocks.updateCvTemplate.mockRejectedValue(
      new ApiClientError("Rejected", {
        status: 422,
        details: {
          commented: ["basics.name"],
          texErrors: ["Undefined control sequence", "Missing $ inserted"],
        },
      }),
    );
    renderWithQueryClient(<CvTemplateEditor cv={baseCv} />);
    fireEvent.change(editor(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    expect(
      await screen.findByText("Markers only inside a comment: basics.name"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "New LaTeX errors: Undefined control sequence; Missing $ inserted",
      ),
    ).toBeInTheDocument();
  });

  it("refreshes from the stored template after a save and clears the failure", async () => {
    apiMocks.updateCvTemplate
      .mockRejectedValueOnce(new ApiClientError("Rejected", { status: 422 }))
      .mockResolvedValueOnce({ ...baseCv, templatedTex: EDITED });
    const { queryClient, rerender } = renderWithQueryClient(
      <CvTemplateEditor cv={baseCv} />,
    );
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.change(editor(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    expect(await screen.findByText("Template not saved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.cvDocuments.all,
      }),
    );
    expect(screen.queryByText("Template not saved")).not.toBeInTheDocument();

    const NEXT = "\\begin{document}\n«basics.name» \\\\\n\\end{document}\n";
    rerender(<CvTemplateEditor cv={{ ...baseCv, templatedTex: NEXT }} />);
    expect(editor().value).toBe(NEXT);
    expect(
      screen.getByRole("button", { name: /save template/i }),
    ).toBeDisabled();
  });

  it("Discard restores the stored template", () => {
    renderWithQueryClient(<CvTemplateEditor cv={baseCv} />);
    fireEvent.change(editor(), { target: { value: EDITED } });
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(editor().value).toBe(TEMPLATE);
  });
});
