// @vitest-environment node
import { createAppSettings, createJob } from "@shared/testing/factories";
import type { CvDocument } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildCv = (overrides: Partial<CvDocument> = {}): CvDocument => ({
  id: "cv-1",
  name: "CV",
  flattenedTex: "",
  fields: [],
  personalBrief: "",
  templatedTex: "",
  defaultFieldValues: {},
  lastCompileStderr: null,
  compileAttempts: 0,
  extractionPrompt: "",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

const callJsonMock = vi.fn();

vi.mock("@server/services/llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

const loadPromptMock = vi.fn().mockResolvedValue({
  name: "interview-qa-generate",
  description: "",
  system: "stub-system",
  user: "stub-user",
  modelHints: {},
});
vi.mock("@server/services/prompts", () => ({
  loadPrompt: (...args: unknown[]) => loadPromptMock(...args),
}));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

const getJobByIdMock = vi.fn();
const updateJobMock = vi.fn();
vi.mock("@server/repositories/jobs", () => ({
  getJobById: (...args: unknown[]) => getJobByIdMock(...args),
  updateJob: (...args: unknown[]) => updateJobMock(...args),
}));

const getActiveCvDocumentMock = vi.fn();
vi.mock("@server/services/cv-active", () => ({
  getActiveCvDocument: (...args: unknown[]) => getActiveCvDocumentMock(...args),
}));

const getEffectiveSettingsMock = vi.fn();
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: (...args: unknown[]) =>
    getEffectiveSettingsMock(...args),
}));

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { generateInterviewPrep } from "./generate";

beforeEach(() => {
  callJsonMock.mockReset();
  getJobByIdMock.mockReset();
  updateJobMock.mockReset();
  getActiveCvDocumentMock.mockReset();
  loadPromptMock.mockClear();
  getEffectiveSettingsMock.mockReset();
  getEffectiveSettingsMock.mockResolvedValue(createAppSettings());
});

describe("generateInterviewPrep", () => {
  it("persists the generated strategy and returns the updated job", async () => {
    const job = createJob({
      id: "job-1",
      status: "in_progress",
      title: "Lead Engineer",
      employer: "Acme",
      jobDescription: "JD text",
    });
    getJobByIdMock
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, interviewPrep: "## Strategy" });
    getActiveCvDocumentMock.mockResolvedValue(
      buildCv({ personalBrief: "I'm Ada." }),
    );
    callJsonMock.mockResolvedValue({
      success: true,
      data: { strategyMarkdown: "## Strategy\n\n- lead with X" },
    });

    const result = await generateInterviewPrep({
      jobId: "job-1",
      steer: "system-design panel",
    });

    expect(result.success).toBe(true);
    expect(updateJobMock).toHaveBeenCalledWith("job-1", {
      interviewPrep: "## Strategy\n\n- lead with X",
    });
  });

  it("shows an HTML CV's values as text, and other formats' as they are", async () => {
    const fields = [
      {
        id: "summary.0",
        role: "summary" as const,
        value: "<b>Kafka</b> R&amp;D",
      },
    ];
    for (const [format, expected] of [
      ["html", "Kafka R&D"],
      ["latex", "<b>Kafka</b> R&amp;D"],
    ] as const) {
      getEffectiveSettingsMock.mockResolvedValue(
        createAppSettings({ cvSourceFormat: format }),
      );
      const job = createJob({ id: "job-1", status: "applied" });
      getJobByIdMock
        .mockResolvedValueOnce(job)
        .mockResolvedValueOnce({ ...job, interviewPrep: "x" });
      getActiveCvDocumentMock.mockResolvedValue(buildCv({ fields }));
      callJsonMock.mockResolvedValue({
        success: true,
        data: { strategyMarkdown: "x" },
      });
      loadPromptMock.mockClear();

      await generateInterviewPrep({ jobId: "job-1" });

      const vars = loadPromptMock.mock.calls[0][1] as Record<string, string>;
      expect(JSON.parse(vars.tailoredCvFieldsJson)[0].value, format).toBe(
        expected,
      );
    }
  });

  it("forwards the steering text into the prompt vars", async () => {
    const job = createJob({ id: "job-1", status: "applied" });
    getJobByIdMock
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, interviewPrep: "x" });
    getActiveCvDocumentMock.mockResolvedValue(buildCv());
    callJsonMock.mockResolvedValue({
      success: true,
      data: { strategyMarkdown: "x" },
    });

    await generateInterviewPrep({ jobId: "job-1", steer: "  focus here  " });

    expect(loadPromptMock).toHaveBeenCalledWith(
      "interview-qa-generate",
      expect.objectContaining({ userSteer: "focus here" }),
    );
  });

  it("rejects jobs that are not applied or interviewing", async () => {
    getJobByIdMock.mockResolvedValueOnce(
      createJob({ id: "job-1", status: "discovered" }),
    );

    const result = await generateInterviewPrep({ jobId: "job-1" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/applied to or are interviewing/i);
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("rejects an empty strategy", async () => {
    const job = createJob({ id: "job-1", status: "applied" });
    getJobByIdMock.mockResolvedValueOnce(job);
    getActiveCvDocumentMock.mockResolvedValue(buildCv());
    callJsonMock.mockResolvedValue({
      success: true,
      data: { strategyMarkdown: "   " },
    });

    const result = await generateInterviewPrep({ jobId: "job-1" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/empty interview strategy/i);
    expect(updateJobMock).not.toHaveBeenCalled();
  });

  it("propagates LLM service failures", async () => {
    const job = createJob({ id: "job-1", status: "in_progress" });
    getJobByIdMock.mockResolvedValueOnce(job);
    getActiveCvDocumentMock.mockResolvedValue(buildCv());
    callJsonMock.mockResolvedValue({ success: false, error: "rate limited" });

    const result = await generateInterviewPrep({ jobId: "job-1" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/LLM call failed.*rate limited/);
  });

  it("rejects when the job is not found", async () => {
    getJobByIdMock.mockResolvedValueOnce(undefined);
    const result = await generateInterviewPrep({ jobId: "missing" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/job not found/i);
  });
});
