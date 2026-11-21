import type { JobNote } from "@shared/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobNotesSection } from "./JobNotesSection";

const { notesState } = vi.hoisted(() => ({
  notesState: {
    notes: [] as JobNote[],
    isLoading: false,
    error: null as Error | null,
  },
}));
vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useJobNotesQuery: () => ({
    data: notesState.notes,
    isLoading: notesState.isLoading,
    error: notesState.error,
  }),
  useCreateJobNoteMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateJobNoteMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteJobNoteMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const note = (overrides: Partial<JobNote>): JobNote => ({
  id: "n1",
  jobId: "j1",
  title: "Recruiter call",
  content: "Asked about the on-call rota.",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  ...overrides,
});

const renderSection = () =>
  render(<JobNotesSection jobId="j1" readerSubtitle="Staff Engineer · Acme" />);

beforeEach(() => {
  notesState.notes = [];
  notesState.isLoading = false;
  notesState.error = null;
});

describe("the Notes reader", () => {
  it("opens every note in the reader box without edit controls", () => {
    notesState.notes = [
      note({}),
      note({ id: "n2", title: "Panel", content: "Four interviewers." }),
    ];
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Notes");
    expect(dialog).toHaveTextContent("Staff Engineer · Acme");
    expect(
      within(dialog).getByRole("heading", { name: "Recruiter call" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Asked about the on-call rota.");
    expect(
      within(dialog).getByRole("heading", { name: "Panel" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Four interviewers.");
    expect(
      within(dialog).queryByRole("button", { name: "Edit note" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Delete note" }),
    ).not.toBeInTheDocument();
  });

  it("shows the empty-state line when there are no notes", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("No notes yet.");
  });

  it("says the notes are loading", () => {
    notesState.isLoading = true;
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("Loading notes…");
  });

  it("says the notes failed to load", () => {
    notesState.error = new Error("boom");
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Failed to load notes.",
    );
  });
});
