import { createJob } from "@shared/testing/factories";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { settingsState } = vi.hoisted(() => ({
  settingsState: {
    cvSourceFormat: "latex" as "latex" | "docx" | "html",
    candidateName: null as string | null,
  },
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({
    cvSourceFormat: settingsState.cvSourceFormat,
    candidateName: settingsState.candidateName,
  }),
}));

import { JobDocumentsPanel } from "./JobDocumentsPanel";

const job = () =>
  createJob({
    id: "j1",
    employer: "Example Uni",
    status: "applied",
    pdfPath: "resume_j1.pdf",
    coverLetterPdfPath: "cover_letter_j1.pdf",
  });

const downloadName = () =>
  screen.getByRole("link", { name: /Download/ }).getAttribute("download");

beforeEach(() => {
  settingsState.cvSourceFormat = "latex";
  settingsState.candidateName = null;
});

afterEach(cleanup);

describe("JobDocumentsPanel download name", () => {
  it("names the CV and the cover letter after the candidate", () => {
    settingsState.candidateName = "Jane Q. Doe";
    render(<JobDocumentsPanel job={job()} />);

    expect(downloadName()).toBe("Doe_JQ_resume_Example_Uni.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Cover Letter" }));
    expect(downloadName()).toBe("Doe_JQ_cover_Example_Uni.pdf");
  });

  it("drops the name part when no name is set, keeping the Word extension", () => {
    settingsState.cvSourceFormat = "docx";
    render(<JobDocumentsPanel job={job()} />);

    expect(downloadName()).toBe("resume_Example_Uni.docx");

    fireEvent.click(screen.getByRole("button", { name: "Cover Letter" }));
    expect(downloadName()).toBe("cover_Example_Uni.pdf");
  });

  it("hands over an HTML CV's tailored zip, and the cover letter's PDF", () => {
    settingsState.cvSourceFormat = "html";
    render(
      <JobDocumentsPanel job={{ ...job(), tailoredSourceShape: "bundle" }} />,
    );

    expect(downloadName()).toBe("resume_Example_Uni.zip");

    fireEvent.click(screen.getByRole("button", { name: "Cover Letter" }));
    expect(downloadName()).toBe("cover_Example_Uni.pdf");
  });
});
