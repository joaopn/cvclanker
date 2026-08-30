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

describe("rewriteUrlForFetch", () => {
  const GUEST = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

  // The reported URL, verbatim from LinkedIn's own copy-link (B56). The
  // trademark sign arrives percent-encoded and the path ends in a slash.
  const SLUGGED =
    "https://www.linkedin.com/jobs/view/data-scientist-onsite-london-phd-preferred-at-welltower%E2%84%A2-inc-nyse-well-4460359035/";

  it("rewrites a slugged job URL to the guest endpoint", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    expect(rewriteUrlForFetch(SLUGGED)).toBe(`${GUEST}/4460359035`);
  });

  it("rewrites both URL shapes for one posting to the same guest URL", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    const bare = "https://www.linkedin.com/jobs/view/4460359035/";
    expect(rewriteUrlForFetch(bare)).toBe(`${GUEST}/4460359035`);
    expect(rewriteUrlForFetch(SLUGGED)).toBe(rewriteUrlForFetch(bare));
  });

  it("rewrites a bare job URL with no trailing slash", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    expect(
      rewriteUrlForFetch("https://www.linkedin.com/jobs/view/4460359035"),
    ).toBe(`${GUEST}/4460359035`);
  });

  it("rewrites a country-subdomain job URL", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    expect(
      rewriteUrlForFetch(
        "https://uk.linkedin.com/jobs/view/senior-engineer-at-acme-4460359035",
      ),
    ).toBe(`${GUEST}/4460359035`);
  });

  it("takes the id anchored at the end, not the first number in the slug", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    // An unanchored capture would read "170000" out of the salary and import
    // this posting under a different job's identity.
    expect(
      rewriteUrlForFetch(
        "https://www.linkedin.com/jobs/view/engineer-170000-gbp-at-acme-4460359035",
      ),
    ).toBe(`${GUEST}/4460359035`);
  });

  it("leaves a LinkedIn URL that is not a job view untouched", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    const profile = "https://www.linkedin.com/in/someone-123456789";
    expect(rewriteUrlForFetch(profile)).toBe(profile);
  });

  it("leaves a lookalike host untouched", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    const lookalike = "https://notlinkedin.com/jobs/view/4460359035";
    expect(rewriteUrlForFetch(lookalike)).toBe(lookalike);
  });

  it("leaves a non-LinkedIn job URL untouched", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    const other = "https://boards.greenhouse.io/acme/jobs/4460359035";
    expect(rewriteUrlForFetch(other)).toBe(other);
  });

  it("returns unparseable input unchanged", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    expect(rewriteUrlForFetch("not a url")).toBe("not a url");
  });

  it("reads the path, so a tracking query string does not defeat the rewrite", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    // LinkedIn's share/copy appends these, so it is a shape users routinely
    // paste (live-captured examples: shared/src/job-url.test.ts). It works
    // because the rule reads `.pathname`; a rule written against the raw URL
    // string would break here and nowhere else in this block.
    expect(
      rewriteUrlForFetch(
        `${SLUGGED}?position=1&pageNum=0&refId=abc%3D%3D&trackingId=xyz%3D%3D`,
      ),
    ).toBe(`${GUEST}/4460359035`);
  });

  it("does not rewrite a job path whose id is too short to be a posting id", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    // The shared rule requires six digits or more, where the old local regex
    // took any run of digits. Recording the narrowing rather than leaving it
    // implicit: every LinkedIn id in a real database is ten digits (measured
    // 2026-08-30, 161 of 161 rows), and an id this short reaches the SPA and
    // its 502 rather than producing wrong data.
    const short = "https://www.linkedin.com/jobs/view/12345";
    expect(rewriteUrlForFetch(short)).toBe(short);
  });

  it("rewrites any deeper path under /jobs/view that ends in an id", async () => {
    const { rewriteUrlForFetch } = await import("./manualJob");

    // A mechanical consequence of the delegation, pinned so it is a recorded
    // behaviour rather than a surprise: the old regex anchored the WHOLE path
    // and left a deeper one alone, while the shared rule gates on the
    // `/jobs/view/` prefix and anchors the id at the tail. The segment below
    // is synthetic — whether LinkedIn serves such a path, and whether the
    // trailing number would be the posting id there, is NOT established here.
    expect(
      rewriteUrlForFetch(
        "https://www.linkedin.com/jobs/view/someSubPath/4460359035",
      ),
    ).toBe(`${GUEST}/4460359035`);
  });
});
