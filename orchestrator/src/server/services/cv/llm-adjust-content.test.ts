// @vitest-environment node
import { loadPrompt } from "@server/services/prompts";
import {
  composeTailoringFailure,
  splitTailoringFailure,
} from "@shared/tailoring-failure";
import type { CvField } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCvFormatNote } from "./cv-format-note";
import { llmAdjustContent } from "./llm-adjust-content";

const callJsonMock = vi.fn();

vi.mock("@server/services/llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

vi.mock("@server/services/prompts", () => ({
  loadPrompt: vi.fn().mockResolvedValue({
    name: "cv-adjust",
    description: "",
    system: "stub-system",
    user: "stub-user",
    modelHints: {},
  }),
}));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

vi.mock("@server/services/writing-style", () => ({
  getWritingStyle: vi.fn().mockResolvedValue({
    tone: "professional",
    formality: "neutral",
    constraints: "",
    doNotUse: "",
    languageMode: "manual",
    manualLanguage: "english",
    summaryMaxWords: null,
    maxKeywordsPerSkill: null,
  }),
  stripLanguageDirectivesFromConstraints: (s: string) => s,
}));

const settingsMock = vi.fn().mockResolvedValue({
  maxTailoredContentChars: { value: 100_000, default: 100_000, override: null },
  cvSourceFormat: null,
});

vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: () => settingsMock(),
}));

vi.mock("./cv-format-note", () => ({
  getCvFormatNote: vi.fn(async (format: string) => `format-note:${format}`),
}));

const SAMPLE_FIELDS: CvField[] = [
  { id: "basics.name", role: "name", value: "Ada Lovelace" },
  { id: "experience.0.company", role: "company", value: "Analytical" },
  {
    id: "experience.0.bullet.0",
    role: "bullet",
    value: "Wrote algorithms.",
  },
];

beforeEach(() => {
  callJsonMock.mockReset();
});

describe("llmAdjustContent", () => {
  it("threads inputs into the prompt and returns parsed patches", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          {
            fieldId: "experience.0.bullet.0",
            newValue: "Wrote algorithms in Python.",
          },
        ]),
        matched: ["algorithms", "python"],
        skipped: ["kubernetes"],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "I'm Ada — I write algorithms in Python.",
      jobDescription: "Hiring a Python engineer who can write algorithms.",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result).toEqual({
      success: true,
      patches: [
        {
          fieldId: "experience.0.bullet.0",
          newValue: "Wrote algorithms in Python.",
        },
      ],
      matched: ["algorithms", "python"],
      skipped: ["kubernetes"],
    });

    expect(loadPrompt).toHaveBeenCalledWith(
      "cv-adjust",
      expect.objectContaining({
        personalBrief: "I'm Ada — I write algorithms in Python.",
        jobDescription: "Hiring a Python engineer who can write algorithms.",
        fieldsJson: expect.stringContaining("Analytical"),
        outputLanguage: "English",
        tone: "professional",
        formality: "neutral",
      }),
    );
  });

  it("hides unlocked overrides from the LLM (fresh tailor anchors on source defaults)", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "basics.name", newValue: "Updated" },
        ]),
        matched: [],
        skipped: [],
      },
    });

    await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: { "basics.name": "Ada L." },
    });

    const calls = (loadPrompt as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    const call = calls[calls.length - 1][1];
    expect(call.fieldsJson).toContain("Ada Lovelace");
    expect(call.fieldsJson).not.toContain("Ada L.");
  });

  it("substitutes placeholders for empty brief and JD", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([]),
        matched: [],
        skipped: [],
      },
    });

    await llmAdjustContent({
      personalBrief: "",
      jobDescription: "",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(loadPrompt).toHaveBeenCalledWith(
      "cv-adjust",
      expect.objectContaining({
        personalBrief: "(empty — no candidate brief on file)",
        jobDescription: "(empty)",
      }),
    );
  });

  it("passes the LaTeX format note when the profile's CV format is unset", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "basics.name", newValue: "Ada L." },
        ]),
        matched: [],
        skipped: [],
      },
    });

    await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(getCvFormatNote).toHaveBeenCalledWith("latex");
    expect(loadPrompt).toHaveBeenCalledWith(
      "cv-adjust",
      expect.objectContaining({ cvFormatNote: "format-note:latex" }),
    );
  });

  it("passes the Word format note on a docx profile", async () => {
    settingsMock.mockResolvedValueOnce({
      maxTailoredContentChars: {
        value: 100_000,
        default: 100_000,
        override: null,
      },
      cvSourceFormat: "docx",
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "basics.name", newValue: "Ada L." },
        ]),
        matched: [],
        skipped: [],
      },
    });

    await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(getCvFormatNote).toHaveBeenCalledWith("docx");
    expect(loadPrompt).toHaveBeenCalledWith(
      "cv-adjust",
      expect.objectContaining({ cvFormatNote: "format-note:docx" }),
    );
  });

  it("returns failure when the LLM call fails", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "rate limited",
      code: "rate_limited",
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    // Exact shape, so a stowaway key still fails the assertion.
    expect(result).toEqual({
      success: false,
      error: composeTailoringFailure(
        "LLM call failed: rate limited",
        // Which KIND of failure it was — what tells a user whether to wait or
        // to go and fix a credential.
        "Provider error code: rate_limited. Model: test-model.",
      ),
    });
  });

  it("returns failure when the parsed list of changes is not an array", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify({ fieldId: "x", newValue: "y" }),
        matched: [],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/unexpected shape/);
      // The whole point of the failure: say what the model actually sent, so
      // a job that fails this way on every retry can be diagnosed from the UI.
      const { summary, detail } = splitTailoringFailure(result.error);
      expect(summary).toBe(
        "The model returned the list of changes in an unexpected shape.",
      );
      expect(detail).toContain("Parsed value was an object.");
      expect(detail).toContain('Its keys were: "fieldId", "newValue"');
      expect(detail).toContain('{"fieldId":"x","newValue":"y"}');
    }
  });

  it("unwraps a DOUBLE-ENCODED patch list", async () => {
    // The measured shape behind the reported "fails on every retry": the model
    // JSON-encodes the array twice, so one parse yields a string.
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify(
          JSON.stringify([
            { fieldId: "basics.name", newValue: "Ada L." },
            { fieldId: "experience.0.bullet.0", newValue: "Shipped things." },
          ]),
        ),
        matched: ["algorithms"],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.patches).toEqual([
        { fieldId: "basics.name", newValue: "Ada L." },
        { fieldId: "experience.0.bullet.0", newValue: "Shipped things." },
      ]);
    }
  });

  it("still rejects a triple-encoded list rather than unwrapping for ever", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify(
          JSON.stringify(
            JSON.stringify([{ fieldId: "basics.name", newValue: "z" }]),
          ),
        ),
        matched: [],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/unexpected shape/);
    }
  });

  it("names the wrapper key when the model wraps the array in an object", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify({
          patches: [{ fieldId: "summary.text", newValue: "z" }],
        }),
        matched: [],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const { detail } = splitTailoringFailure(result.error);
      expect(detail).toContain('Its keys were: "patches"');
    }
  });

  it("reports the received type when patchesJson is not a string at all", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { patchesJson: [{ fieldId: "a" }], matched: [], skipped: [] },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const { summary, detail } = splitTailoringFailure(result.error);
      expect(summary).toBe(
        "The model returned the list of changes in an unexpected type.",
      );
      expect(detail).toBe("patchesJson was an array, not a string.");
    }
  });

  it("lists the unknown field ids and the CV's own ids when nothing matched", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "ghost.one", newValue: "a" },
          { fieldId: "ghost.two", newValue: "b" },
        ]),
        matched: [],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const { detail } = splitTailoringFailure(result.error);
      // The ids are what identify field-id drift between the CV document and
      // what the model was shown; the summary only carries counts.
      expect(detail).toContain("ghost.one");
      expect(detail).toContain("ghost.two");
      for (const field of SAMPLE_FIELDS) {
        expect(detail).toContain(field.id);
      }
    }
  });

  it("drops patches with unknown fieldIds, non-string newValue, or forbidden patterns", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "unknown.id", newValue: "ignored" },
          { fieldId: "basics.name", newValue: 42 },
          { fieldId: "basics.name", newValue: "evil \\write18 stuff" },
          { fieldId: "basics.name", newValue: "Ada (verified)" },
        ]),
        matched: ["python", 42, "rust"],
        skipped: null,
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result).toMatchObject({
      success: true,
      patches: [{ fieldId: "basics.name", newValue: "Ada (verified)" }],
      matched: ["python", "rust"],
      skipped: [],
    });
  });

  it("marks locked fields in the prompt and drops LLM patches targeting them", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "basics.name", newValue: "Locked override attempt" },
          {
            fieldId: "experience.0.bullet.0",
            newValue: "Built algorithms in Python.",
          },
        ]),
        matched: ["python"],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
      lockedFieldIds: ["basics.name"],
    });

    expect(result).toMatchObject({
      success: true,
      patches: [
        {
          fieldId: "experience.0.bullet.0",
          newValue: "Built algorithms in Python.",
        },
      ],
    });

    const lastCall = vi.mocked(loadPrompt).mock.calls.at(-1);
    const fieldsJson = (lastCall?.[1] as { fieldsJson?: string } | undefined)
      ?.fieldsJson;
    expect(fieldsJson).toBeDefined();
    const parsed = JSON.parse(fieldsJson ?? "[]") as Array<{
      id: string;
      locked: boolean;
    }>;
    const name = parsed.find((entry) => entry.id === "basics.name");
    const bullet = parsed.find((entry) => entry.id === "experience.0.bullet.0");
    expect(name?.locked).toBe(true);
    expect(bullet?.locked).toBe(false);
  });

  it("locked-field current value uses the override; unlocked field shows source default", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          {
            fieldId: "experience.0.bullet.0",
            newValue: "rewrite from defaults",
          },
        ]),
        matched: [],
        skipped: [],
      },
    });

    await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {
        "basics.name": "Ada L. Byron",
        "experience.0.bullet.0": "Stale prior tailoring",
      },
      lockedFieldIds: ["basics.name"],
    });

    const lastCall = vi.mocked(loadPrompt).mock.calls.at(-1);
    const fieldsJson = (lastCall?.[1] as { fieldsJson?: string } | undefined)
      ?.fieldsJson;
    const parsed = JSON.parse(fieldsJson ?? "[]") as Array<{
      id: string;
      value: string;
    }>;
    expect(parsed.find((e) => e.id === "basics.name")?.value).toBe(
      "Ada L. Byron",
    );
    expect(parsed.find((e) => e.id === "experience.0.bullet.0")?.value).toBe(
      "Wrote algorithms.",
    );
  });

  it("returns failure with cap details when serialized overrides exceed maxTailoredContentChars", async () => {
    settingsMock.mockResolvedValueOnce({
      maxTailoredContentChars: { value: 50, default: 50, override: null },
    });
    const longValue = "x".repeat(200);
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        patchesJson: JSON.stringify([
          { fieldId: "basics.name", newValue: longValue },
        ]),
        matched: [],
        skipped: [],
      },
    });

    const result = await llmAdjustContent({
      personalBrief: "x",
      jobDescription: "y",
      currentFields: SAMPLE_FIELDS,
      currentOverrides: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/configured limit/);
      expect(result.cap).toMatchObject({
        field: "tailoredFields",
        max: 50,
      });
      expect(result.cap?.observed).toBeGreaterThan(50);
    }
  });
});
