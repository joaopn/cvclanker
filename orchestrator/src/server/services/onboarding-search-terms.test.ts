import type { CvDocument, CvField } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.fn();

vi.mock("./llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

vi.mock("./cv-active", () => ({
  getActiveCvDocument: vi.fn(),
}));

const settingsMock = vi.hoisted(() => ({ cvSourceFormat: null as string | null }));
vi.mock("./settings", () => ({
  getEffectiveSettings: async () => ({ cvSourceFormat: settingsMock.cvSourceFormat }),
}));

vi.mock("./prompts", () => ({
  loadPrompt: vi.fn().mockResolvedValue({
    name: "onboarding-search-terms",
    description: "",
    system: "stub-system",
    user: "stub-user",
    modelHints: {},
  }),
}));

import { buildFallbackSearchTerms, suggestOnboardingSearchTerms } from "./onboarding-search-terms";
import { getActiveCvDocument } from "./cv-active";

function makeCv(overrides: {
  personalBrief?: string;
  fields?: CvField[];
}): CvDocument {
  return {
    id: "cv-1",
    name: "cv.tex",
    flattenedTex: "",
    fields: overrides.fields ?? [],
    personalBrief: overrides.personalBrief ?? "",
    templatedTex: "",
    defaultFieldValues: {},
    lastCompileStderr: null,
    compileAttempts: 0,
    extractionPrompt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("suggestOnboardingSearchTerms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.cvSourceFormat = null;
  });

  it("reads an HTML CV's hints as text, so markup is never searched for", async () => {
    settingsMock.cvSourceFormat = "html";
    vi.mocked(getActiveCvDocument).mockResolvedValue(
      makeCv({
        fields: [
          { id: "summary.0", role: "summary", value: "<b>Data</b> Engineer" },
          { id: "skills.0", role: "skill", value: "Kafka &amp; Spark" },
        ],
      }),
    );
    callJsonMock.mockResolvedValue({ success: false, error: "down" });

    expect(await suggestOnboardingSearchTerms()).toEqual({
      terms: ["Data Engineer", "Kafka & Spark"],
      source: "fallback",
    });

    // Another format's values are taken as they are.
    settingsMock.cvSourceFormat = "latex";
    expect((await suggestOnboardingSearchTerms()).terms).toEqual([
      "<b>Data</b> Engineer",
      "Kafka &amp; Spark",
    ]);
  });

  it("returns sanitized AI terms when generation succeeds", async () => {
    vi.mocked(getActiveCvDocument).mockResolvedValue(
      makeCv({
        personalBrief: "Backend platform engineer with API and infra experience.",
        fields: [
          { id: "summary.0", role: "summary", value: "Senior Backend Engineer" },
          { id: "experience.0.title", role: "title", value: "Platform Engineer" },
        ],
      }),
    );
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        terms: [
          " Senior Backend Engineer ",
          "Platform Engineer",
          "platform engineer",
          "",
        ],
      },
    });

    const result = await suggestOnboardingSearchTerms();

    expect(result).toEqual({
      terms: ["Senior Backend Engineer", "Platform Engineer"],
      source: "ai",
    });
  });

  it("falls back to headline and title hints when AI generation fails", async () => {
    vi.mocked(getActiveCvDocument).mockResolvedValue(
      makeCv({
        personalBrief: "Staff engineer focused on platform tooling.",
        fields: [
          { id: "summary.0", role: "summary", value: "Staff Software Engineer" },
          { id: "experience.0.title", role: "title", value: "Platform Engineer" },
        ],
      }),
    );
    callJsonMock.mockResolvedValue({
      success: false,
      error: "LLM provider unavailable",
    });

    const result = await suggestOnboardingSearchTerms();

    expect(result).toEqual({
      terms: ["Staff Software Engineer", "Platform Engineer"],
      source: "fallback",
    });
  });

  it("falls back to publication and skill hints when no headline or titles exist", async () => {
    vi.mocked(getActiveCvDocument).mockResolvedValue(
      makeCv({
        personalBrief: "Backend platform engineer focused on distributed systems.",
        fields: [
          { id: "publications.0", role: "publication", value: "Developer Platform" },
          { id: "skills.0", role: "skill", value: "Site Reliability Engineering" },
          { id: "skills.1", role: "skill", value: "Distributed Systems" },
        ],
      }),
    );
    callJsonMock.mockResolvedValue({
      success: false,
      error: "LLM provider unavailable",
    });

    const result = await suggestOnboardingSearchTerms();

    expect(result).toEqual({
      terms: [
        "Developer Platform",
        "Site Reliability Engineering",
        "Distributed Systems",
      ],
      source: "fallback",
    });
  });

  it("throws a conflict when no CV has been uploaded", async () => {
    vi.mocked(getActiveCvDocument).mockResolvedValue(null);

    await expect(suggestOnboardingSearchTerms()).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "Resume must be configured before suggesting search terms.",
    });
  });

  it("throws a conflict when the CV has no usable hints or brief", async () => {
    vi.mocked(getActiveCvDocument).mockResolvedValue(
      makeCv({ personalBrief: "", fields: [] }),
    );

    await expect(suggestOnboardingSearchTerms()).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "Resume must be configured before suggesting search terms.",
    });
  });

  it("caps and deduplicates fallback search terms", () => {
    const result = buildFallbackSearchTerms({
      brief: "",
      headline: "Senior Engineer",
      positions: Array.from({ length: 12 }, (_, i) => `Platform Engineer ${i}`),
      projectNames: [],
      skillNames: [],
    });

    expect(result.source).toBe("fallback");
    expect(result.terms).toHaveLength(10);
    expect(result.terms[0]).toBe("Senior Engineer");
    expect(result.terms).not.toContain("Platform Engineer 10");
  });
});
