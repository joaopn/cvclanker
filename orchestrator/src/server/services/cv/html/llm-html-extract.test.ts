// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SegmentText } from "./html-worker-tasks";
import {
  buildHtmlPreviousAttemptBlock,
  getHtmlExtractionPromptDefault,
  llmHtmlExtract,
} from "./llm-html-extract";

const mocks = vi.hoisted(() => ({
  callJson: vi.fn(),
  loadPrompt: vi.fn(),
}));

vi.mock("@server/db/index", () => ({ db: {}, schema: {}, closeDb: vi.fn() }));

vi.mock("@server/services/llm/service", () => ({
  LlmService: class {
    callJson = mocks.callJson;
  },
}));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

vi.mock("@server/services/prompts", () => ({
  loadPrompt: mocks.loadPrompt,
}));

const SEGMENTS: SegmentText[] = [
  { segmentId: 0, text: "Jane Q. Applicant" },
  { segmentId: 1, text: "Led migration of the rendering fleet." },
];

function llmReturns(fields: unknown, personalBrief: unknown = "brief"): void {
  mocks.callJson.mockResolvedValue({
    success: true,
    data: {
      fieldsJson: typeof fields === "string" ? fields : JSON.stringify(fields),
      personalBrief,
    },
  });
}

const VALID_FIELD = {
  id: "experience.0.bullet.0",
  role: "bullet" as const,
  value: "Led migration of the rendering fleet.",
  segmentId: 1,
};

describe("llmHtmlExtract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPrompt.mockResolvedValue({
      name: "cv-html-extract",
      description: "",
      system: "stub-system",
      user: "stub-user",
      modelHints: {},
    });
  });

  it("returns fields and brief on a valid response", async () => {
    llmReturns([VALID_FIELD]);
    const result = await llmHtmlExtract({ segments: SEGMENTS });
    expect(result.fields).toEqual([VALID_FIELD]);
    expect(result.personalBrief).toBe("brief");
  });

  it("passes numbered segments to the prompt", async () => {
    llmReturns([VALID_FIELD]);
    await llmHtmlExtract({ segments: SEGMENTS });
    const vars = mocks.loadPrompt.mock.calls[0][1];
    expect(vars.segmentsList).toBe(
      "[0] Jane Q. Applicant\n[1] Led migration of the rendering fleet.",
    );
    expect(vars.previousAttemptBlock).toBe("");
  });

  it("uses the extractionPrompt override as the system message", async () => {
    llmReturns([VALID_FIELD]);
    await llmHtmlExtract({
      segments: SEGMENTS,
      extractionPrompt: "custom system",
    });
    const { messages } = mocks.callJson.mock.calls[0][0];
    expect(messages[0]).toEqual({ role: "system", content: "custom system" });
    expect(messages[1]).toEqual({ role: "user", content: "stub-user" });
  });

  it("renders the previous attempt into the prompt variables", async () => {
    llmReturns([VALID_FIELD]);
    await llmHtmlExtract({
      segments: SEGMENTS,
      previousAttempt: {
        fields: [VALID_FIELD],
        failureKind: "splice",
        detail: "span not found",
      },
    });
    const vars = mocks.loadPrompt.mock.calls[0][1];
    expect(vars.previousAttemptBlock).toContain("PREVIOUS ATTEMPT");
    expect(vars.previousAttemptBlock).toContain(
      "could not be marked in the page",
    );
    expect(vars.previousAttemptBlock).toContain("span not found");
  });

  it("throws LLM_FAILED when the call fails", async () => {
    mocks.callJson.mockResolvedValue({ success: false, error: "boom" });
    await expect(llmHtmlExtract({ segments: SEGMENTS })).rejects.toMatchObject({
      name: "HtmlExtractError",
      code: "LLM_FAILED",
    });
  });

  const rejectCases: Array<{
    label: string;
    fields: unknown;
    brief?: unknown;
    code: string;
  }> = [
    { label: "empty fieldsJson", fields: " ", code: "INVALID_FIELDS" },
    {
      label: "unparseable fieldsJson",
      fields: "not json",
      code: "INVALID_FIELDS_JSON",
    },
    { label: "empty fields array", fields: [], code: "EMPTY_FIELDS" },
    {
      label: "non-object field entry",
      fields: ["nope"],
      code: "INVALID_FIELD_SHAPE",
    },
    {
      label: "missing id",
      fields: [{ ...VALID_FIELD, id: "" }],
      code: "INVALID_FIELD_ID",
    },
    {
      label: "duplicate id",
      fields: [VALID_FIELD, { ...VALID_FIELD, value: "fleet" }],
      code: "DUPLICATE_FIELD_ID",
    },
    {
      label: "unknown role",
      fields: [{ ...VALID_FIELD, role: "wizard" }],
      code: "INVALID_FIELD_ROLE",
    },
    {
      label: "empty value",
      fields: [{ ...VALID_FIELD, value: "" }],
      code: "INVALID_FIELD_VALUE",
    },
    {
      label: "segmentId out of range",
      fields: [{ ...VALID_FIELD, segmentId: 2 }],
      code: "INVALID_SEGMENT_ID",
    },
    {
      label: "non-integer segmentId",
      fields: [{ ...VALID_FIELD, segmentId: 0.5 }],
      code: "INVALID_SEGMENT_ID",
    },
    {
      label: "non-string brief",
      fields: [VALID_FIELD],
      brief: 42,
      code: "INVALID_BRIEF",
    },
  ];

  for (const testCase of rejectCases) {
    it(`rejects ${testCase.label} with ${testCase.code}`, async () => {
      llmReturns(testCase.fields, testCase.brief ?? "brief");
      await expect(
        llmHtmlExtract({ segments: SEGMENTS }),
      ).rejects.toMatchObject({
        name: "HtmlExtractError",
        code: testCase.code,
      });
    });
  }
});

describe("getHtmlExtractionPromptDefault", () => {
  it("returns the cv-html-extract system prompt", async () => {
    mocks.loadPrompt.mockResolvedValue({
      name: "cv-html-extract",
      description: "",
      system: "the-system",
      user: "the-user",
      modelHints: {},
    });
    await expect(getHtmlExtractionPromptDefault()).resolves.toBe("the-system");
    expect(mocks.loadPrompt).toHaveBeenCalledWith("cv-html-extract", {
      segmentsList: "",
      previousAttemptBlock: "",
    });
  });
});

describe("buildHtmlPreviousAttemptBlock", () => {
  it("returns an empty string without a previous attempt", () => {
    expect(buildHtmlPreviousAttemptBlock(undefined)).toBe("");
  });

  it("truncates an oversized failure detail", () => {
    const block = buildHtmlPreviousAttemptBlock({
      fields: [VALID_FIELD],
      failureKind: "content-diff",
      detail: "x".repeat(5000),
    });
    expect(block).toContain("…(truncated)");
    expect(block).toContain("did not reproduce the original page exactly");
  });
});
