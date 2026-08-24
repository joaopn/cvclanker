// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.fn();

vi.mock("./llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

vi.mock("./modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

vi.mock("./prompts", () => ({
  loadPrompt: vi.fn().mockResolvedValue({
    name: "job-fetch-from-url",
    description: "",
    system: "stub-system",
    user: "stub-user",
    modelHints: {},
  }),
}));

import { inferManualJobDetails } from "./manualJob";

describe("inferManualJobDetails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a warning when LlmService reports a missing API key", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "LLM API key not set",
    });

    const result = await inferManualJobDetails("JD text");

    expect(result.job).toEqual({});
    expect(result.warning).toContain("LLM API key not set");
  });

  it("returns a warning when LlmService reports a generic failure", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "Upstream 500",
    });

    const result = await inferManualJobDetails("JD text");

    expect(result.job).toEqual({});
    expect(result.warning).toContain("AI inference failed");
  });

  it("normalizes a successful response into a manual job draft", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        title: "Backend Engineer",
        employer: "Acme",
        location: "",
        salary: " 100k ",
        deadline: "",
        jobUrl: "",
        applicationLink: "",
        jobType: "",
        jobLevel: "",
        jobFunction: "",
        disciplines: "",
        degreeRequired: "",
        starting: "",
        jobDescription: "",
      },
    });

    const result = await inferManualJobDetails("JD text");

    expect(result.warning).toBeUndefined();
    expect(result.job).toEqual({
      title: "Backend Engineer",
      employer: "Acme",
      salary: "100k",
    });
  });
});

describe("readSettledPageContent", () => {
  const NAV_ERROR = new Error(
    "page.content: Unable to retrieve content because the page is navigating and changing the content.",
  );

  function fakePage(contentImpl: () => Promise<string>) {
    return {
      content: vi.fn(contentImpl),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("playwright").Page;
  }

  it("returns the content when the first read succeeds", async () => {
    const page = fakePage(async () => "<html>ok</html>");
    const { readSettledPageContent } = await import("./manualJob");

    await expect(readSettledPageContent(page)).resolves.toBe("<html>ok</html>");
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it("waits out an in-flight navigation and re-reads", async () => {
    let calls = 0;
    const page = fakePage(async () => {
      calls += 1;
      if (calls < 3) throw NAV_ERROR;
      return "<html>settled</html>";
    });
    const { readSettledPageContent } = await import("./manualJob");

    await expect(readSettledPageContent(page)).resolves.toBe(
      "<html>settled</html>",
    );
    expect(page.content).toHaveBeenCalledTimes(3);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
    expect(page.waitForLoadState).toHaveBeenCalledWith("load", {
      timeout: 2_000,
    });
  });

  it("rethrows the navigation error after three losing reads", async () => {
    const page = fakePage(async () => {
      throw NAV_ERROR;
    });
    const { readSettledPageContent } = await import("./manualJob");

    await expect(readSettledPageContent(page)).rejects.toBe(NAV_ERROR);
    expect(page.content).toHaveBeenCalledTimes(3);
  });

  it("rethrows any other error immediately, without retrying", async () => {
    const crash = new Error("Target closed");
    const page = fakePage(async () => {
      throw crash;
    });
    const { readSettledPageContent } = await import("./manualJob");

    await expect(readSettledPageContent(page)).rejects.toBe(crash);
    expect(page.content).toHaveBeenCalledTimes(1);
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });
});
