// @vitest-environment node
import {
  createCoverLetterDocument,
  createJob,
} from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobById: vi.fn(),
  getActiveCvDocument: vi.fn(),
  getActiveCoverLetterDocument: vi.fn(),
  loadPrompt: vi.fn(),
  getWritingStyle: vi.fn(),
  getEffectiveSettings: vi.fn(),
  getCvFormatNote: vi.fn(async (format: string) => `format-note:${format}`),
}));

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../repositories/jobs", () => ({
  getJobById: mocks.getJobById,
}));

vi.mock("./cv-active", () => ({
  getActiveCvDocument: mocks.getActiveCvDocument,
}));

vi.mock("./cover-letter/active", () => ({
  getActiveCoverLetterDocument: mocks.getActiveCoverLetterDocument,
}));

vi.mock("./prompts", () => ({
  loadPrompt: mocks.loadPrompt,
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: mocks.getEffectiveSettings,
}));

vi.mock("./cv/cv-format-note", () => ({
  getCvFormatNote: mocks.getCvFormatNote,
}));

vi.mock("./writing-style", () => ({
  getWritingStyle: mocks.getWritingStyle,
  stripLanguageDirectivesFromConstraints: (value: string) => value,
}));

import { buildJobChatPromptContext } from "./ghostwriter-context";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getJobById.mockResolvedValue(
    createJob({ id: "job-1", title: "Engineer", employer: "Acme" }),
  );
  mocks.getActiveCvDocument.mockResolvedValue(null);
  mocks.getActiveCoverLetterDocument.mockResolvedValue(null);
  mocks.getWritingStyle.mockResolvedValue({
    tone: "professional",
    formality: "neutral",
    constraints: "",
    doNotUse: "",
    languageMode: "manual",
    manualLanguage: "english",
    summaryMaxWords: null,
    maxKeywordsPerSkill: null,
  });
  mocks.getEffectiveSettings.mockResolvedValue({ cvSourceFormat: null });
  mocks.getCvFormatNote.mockImplementation(
    async (format: string) => `format-note:${format}`,
  );
  mocks.loadPrompt.mockResolvedValue({
    name: "ghostwriter-system",
    description: "",
    system: "stub-system",
    user: "",
    modelHints: {},
  });
});

describe("buildJobChatPromptContext", () => {
  it("passes the LaTeX format note when the profile's CV format is unset", async () => {
    await buildJobChatPromptContext("job-1");

    expect(mocks.getCvFormatNote).toHaveBeenCalledWith("latex");
    expect(mocks.loadPrompt).toHaveBeenCalledWith(
      "ghostwriter-system",
      expect.objectContaining({ cvFormatNote: "format-note:latex" }),
    );
  });

  it("passes the Word format note on a docx profile", async () => {
    mocks.getEffectiveSettings.mockResolvedValue({ cvSourceFormat: "docx" });

    await buildJobChatPromptContext("job-1");

    expect(mocks.getCvFormatNote).toHaveBeenCalledWith("docx");
    expect(mocks.loadPrompt).toHaveBeenCalledWith(
      "ghostwriter-system",
      expect.objectContaining({ cvFormatNote: "format-note:docx" }),
    );
  });

  describe("cover-letter snapshot", () => {
    const doc = createCoverLetterDocument({
      fields: [
        {
          id: "letter.body",
          role: "body",
          value: "Dear Other Company, I have long admired…",
        },
      ],
      defaultFieldValues: {
        "letter.body": "Dear Other Company, I have long admired…",
      },
    });

    it("is EMPTY for a job that was never generated, never the template's own letter", async () => {
      mocks.getActiveCoverLetterDocument.mockResolvedValue(doc);
      mocks.getJobById.mockResolvedValue(
        createJob({ id: "job-1", coverLetterFieldOverrides: {} }),
      );

      const context = await buildJobChatPromptContext("job-1");

      // The pane shows the per-job baseline; a model told otherwise would
      // tailor against text the user is not looking at.
      expect(context.coverLetterSnapshot).toBe("");
    });

    it("uses the per-job override once one exists", async () => {
      mocks.getActiveCoverLetterDocument.mockResolvedValue(doc);
      mocks.getJobById.mockResolvedValue(
        createJob({
          id: "job-1",
          coverLetterFieldOverrides: { "letter.body": "Written for Acme." },
        }),
      );

      const context = await buildJobChatPromptContext("job-1");

      expect(context.coverLetterSnapshot).toBe("Written for Acme.");
    });

    it("drops a legacy draft that is just the template body, as the pane does", async () => {
      mocks.getActiveCoverLetterDocument.mockResolvedValue(doc);
      mocks.getJobById.mockResolvedValue(
        createJob({
          id: "job-1",
          coverLetterFieldOverrides: {},
          coverLetterDraft: "Dear Other Company, I have long admired…",
        }),
      );

      const context = await buildJobChatPromptContext("job-1");

      expect(context.coverLetterSnapshot).toBe("");
    });

    it("still falls back to a legacy free-text draft", async () => {
      mocks.getActiveCoverLetterDocument.mockResolvedValue(doc);
      mocks.getJobById.mockResolvedValue(
        createJob({
          id: "job-1",
          coverLetterFieldOverrides: {},
          coverLetterDraft: "An older draft for this job.",
        }),
      );

      const context = await buildJobChatPromptContext("job-1");

      expect(context.coverLetterSnapshot).toBe("An older draft for this job.");
    });
  });

  it("throws when the job does not exist", async () => {
    mocks.getJobById.mockResolvedValue(null);

    await expect(buildJobChatPromptContext("missing")).rejects.toThrow(
      /Job not found/,
    );
  });
});
