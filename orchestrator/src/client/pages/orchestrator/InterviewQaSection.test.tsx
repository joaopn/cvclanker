import { createJob } from "@shared/testing/factories";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterviewQaSection } from "./InterviewQaSection";

vi.mock("@client/api", () => ({
  generateInterviewPrep: vi.fn(),
  updateJob: vi.fn(),
}));
vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const renderSection = (interviewPrep: string) =>
  render(
    <InterviewQaSection
      job={createJob({
        id: "j1",
        title: "Staff Engineer",
        employer: "Acme",
        interviewPrep,
      })}
      onJobUpdated={vi.fn().mockResolvedValue(undefined)}
    />,
  );

describe("the Interview QA reader", () => {
  it("opens the saved strategy in the reader box", () => {
    renderSection("## Your narrative\n\nLead with the migration.");
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Interview QA");
    expect(dialog).toHaveTextContent("Staff Engineer · Acme");
    expect(
      within(dialog).getByRole("heading", { name: "Your narrative" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Lead with the migration.");
    expect(
      within(dialog).queryByRole("button", { name: /Edit/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the empty-state line when there is no strategy yet", () => {
    renderSection("");
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "No interview strategy yet.",
    );
  });
});
