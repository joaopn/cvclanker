import * as api from "@client/api";
import type { PromptDescriptor, PromptDetail } from "@client/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Accordion } from "@/components/ui/accordion";
import { PromptsPanel } from "./PromptsPanel";

vi.mock("@client/api", () => ({
  listPrompts: vi.fn(),
  getPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  resetPrompt: vi.fn(),
  reloadPrompt: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const DESCRIPTOR_DEFAULTS: PromptDescriptor = {
  name: "job-score",
  path: "job-score",
  description: "scoring prompt",
  modifiedAt: "2026-07-08T00:00:00Z",
  edited: false,
};

const DETAIL_DEFAULTS: PromptDetail = {
  name: "job-score",
  content: "name: job-score\nsystem: ''\nuser: score it\n",
  defaultContent: "name: job-score\nsystem: ''\nuser: score it\n",
  edited: false,
  updatedAt: "2026-07-08T00:00:00Z",
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Accordion type="multiple" defaultValue={["prompts"]}>
        <PromptsPanel />
      </Accordion>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listPrompts).mockResolvedValue([{ ...DESCRIPTOR_DEFAULTS }]);
  vi.mocked(api.getPrompt).mockResolvedValue({ ...DETAIL_DEFAULTS });
});

async function expandEditor() {
  fireEvent.click(await screen.findByRole("button", { name: /edit/i }));
  return (await screen.findByRole("textbox", {
    name: /prompt content for job-score/i,
  })) as HTMLTextAreaElement;
}

describe("PromptsPanel", () => {
  it("lists prompts and shows the modified badge only for edited rows", async () => {
    vi.mocked(api.listPrompts).mockResolvedValue([
      { ...DESCRIPTOR_DEFAULTS },
      {
        ...DESCRIPTOR_DEFAULTS,
        name: "cv-adjust",
        path: "cv-adjust",
        edited: true,
      },
    ]);

    renderPanel();

    expect(await screen.findByText("job-score")).toBeInTheDocument();
    expect(screen.getByText("cv-adjust")).toBeInTheDocument();
    expect(screen.getAllByText("modified")).toHaveLength(1);
  });

  it("expands a row and shows the prompt content", async () => {
    renderPanel();

    const textarea = await expandEditor();
    expect(textarea.value).toBe(DETAIL_DEFAULTS.content);
    expect(api.getPrompt).toHaveBeenCalledWith("job-score");
  });

  it("saves an edited draft and reports success", async () => {
    const editedContent = "name: job-score\nsystem: ''\nuser: better\n";
    vi.mocked(api.updatePrompt).mockResolvedValue({
      ...DETAIL_DEFAULTS,
      content: editedContent,
      edited: true,
    });

    renderPanel();
    const textarea = await expandEditor();

    fireEvent.change(textarea, { target: { value: editedContent } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updatePrompt).toHaveBeenCalledWith("job-score", editedContent),
    );
    const { toast } = await import("@client/lib/toast");
    expect(toast.success).toHaveBeenCalledWith("Saved job-score");
  });

  it("renders a rejected save inline without a success toast", async () => {
    vi.mocked(api.updatePrompt).mockRejectedValue(
      new Error('Invalid prompt schema for "job-score": boom'),
    );

    renderPanel();
    const textarea = await expandEditor();

    fireEvent.change(textarea, { target: { value: "broken: [yaml" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/save rejected/i)).toBeInTheDocument();
    expect(
      screen.getByText(/invalid prompt schema for "job-score": boom/i),
    ).toBeInTheDocument();
    const { toast } = await import("@client/lib/toast");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not call the API when saving a pristine draft", async () => {
    renderPanel();
    await expandEditor();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    // react-query runs a mutation's mutationFn after a tick, not inside
    // mutate(), so the assertion must wait past it to see a call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.updatePrompt).not.toHaveBeenCalled();
  });

  it("preserves keystrokes typed while a save is in flight", async () => {
    const sent = "name: job-score\nsystem: ''\nuser: v2\n";
    const typedDuringFlight = `${sent}# more\n`;
    let resolveSave: (value: PromptDetail) => void = () => {};
    vi.mocked(api.updatePrompt).mockImplementation(
      () =>
        new Promise<PromptDetail>((resolve) => {
          resolveSave = resolve;
        }),
    );

    renderPanel();
    const textarea = await expandEditor();

    fireEvent.change(textarea, { target: { value: sent } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.updatePrompt).toHaveBeenCalled());

    // Keep typing while the PUT is in flight…
    fireEvent.change(textarea, { target: { value: typedDuringFlight } });

    // …then the save resolves: the draft must keep the newer keystrokes
    // (only an unchanged draft syncs to the server response).
    resolveSave({ ...DETAIL_DEFAULTS, content: sent, edited: true });
    await waitFor(() => expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument());
    expect((textarea as HTMLTextAreaElement).value).toBe(typedDuringFlight);
  });

  it("resets to default through the confirm dialog", async () => {
    vi.mocked(api.getPrompt).mockResolvedValue({
      ...DETAIL_DEFAULTS,
      content: "name: job-score\nsystem: ''\nuser: custom\n",
      edited: true,
    });
    vi.mocked(api.resetPrompt).mockResolvedValue({ ...DETAIL_DEFAULTS });

    renderPanel();
    const textarea = await expandEditor();
    expect(textarea.value).toContain("custom");

    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^reset$/i }),
    );

    await waitFor(() =>
      expect(api.resetPrompt).toHaveBeenCalledWith("job-score"),
    );
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe(
        DETAIL_DEFAULTS.content,
      ),
    );
  });

  it("uses revalidation wording for reload toasts", async () => {
    vi.mocked(api.reloadPrompt).mockResolvedValue({ reloaded: "job-score" });

    renderPanel();
    await screen.findByText("job-score");

    fireEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    const { toast } = await import("@client/lib/toast");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Revalidated job-score"),
    );
  });
});
