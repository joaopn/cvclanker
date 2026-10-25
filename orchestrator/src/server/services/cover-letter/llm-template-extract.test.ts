// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { llmCoverLetterTemplateExtract } from "./llm-template-extract";

const callJsonMock = vi.fn();

vi.mock("@server/services/llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

vi.mock("@server/services/prompts", () => ({
  loadPrompt: vi.fn().mockResolvedValue({
    name: "coverletter-template-extract",
    description: "",
    system: "stub-system",
    user: "stub-user",
    modelHints: {},
  }),
}));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

const TEMPLATE = "\\begin{letter}{Acme}«body.text»\\end{letter}";
const VALID_FIELDS = [
  {
    id: "body.text",
    role: "body",
    value: "Dear Hiring Team, ...",
  },
];

beforeEach(() => {
  callJsonMock.mockReset();
});

describe("llmCoverLetterTemplateExtract", () => {
  it("parses a well-formed response and returns the bodyFieldId", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        templatedTex: TEMPLATE,
        fieldsJson: JSON.stringify(VALID_FIELDS),
      },
    });

    const result = await llmCoverLetterTemplateExtract({
      flattenedTex: "\\begin{letter}{Acme}Dear Hiring Team, ...\\end{letter}",
      assetReferences: [],
    });

    expect(result.templatedTex).toBe(TEMPLATE);
    expect(result.fields).toEqual(VALID_FIELDS);
    expect(result.bodyFieldId).toBe("body.text");
  });

  it("rejects when zero fields claim role=body", async () => {
    const fields = [{ id: "body.text", role: "summary", value: "..." }];
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        templatedTex: TEMPLATE,
        fieldsJson: JSON.stringify(fields),
      },
    });

    await expect(
      llmCoverLetterTemplateExtract({
        flattenedTex: "x",
        assetReferences: [],
      }),
    ).rejects.toMatchObject({
      name: "CoverLetterTemplateExtractError",
      code: "NO_BODY_FIELD",
    });
  });

  it("rejects when multiple fields claim role=body", async () => {
    const tex =
      "\\begin{letter}{Acme}«body.greeting»«body.text»\\end{letter}";
    const fields = [
      { id: "body.greeting", role: "body", value: "Dear Hiring Team," },
      { id: "body.text", role: "body", value: "Applying for ..." },
    ];
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        templatedTex: tex,
        fieldsJson: JSON.stringify(fields),
      },
    });

    await expect(
      llmCoverLetterTemplateExtract({
        flattenedTex: "x",
        assetReferences: [],
      }),
    ).rejects.toMatchObject({
      name: "CoverLetterTemplateExtractError",
      code: "MULTIPLE_BODY_FIELDS",
    });
  });

  it("rejects orphan markers", async () => {
    const tex = "«body.text»«recipient.name»";
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        templatedTex: tex,
        fieldsJson: JSON.stringify(VALID_FIELDS),
      },
    });

    await expect(
      llmCoverLetterTemplateExtract({
        flattenedTex: "x",
        assetReferences: [],
      }),
    ).rejects.toMatchObject({
      name: "CoverLetterTemplateExtractError",
      code: "ORPHAN_MARKER",
    });
  });

  it("propagates LLM service failures as LLM_FAILED", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "rate limited",
    });

    await expect(
      llmCoverLetterTemplateExtract({
        flattenedTex: "x",
        assetReferences: [],
      }),
    ).rejects.toMatchObject({
      name: "CoverLetterTemplateExtractError",
      code: "LLM_FAILED",
    });
  });
});
