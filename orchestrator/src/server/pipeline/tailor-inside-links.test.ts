// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const llmAdjustMock = vi.fn();
vi.mock("../services/cv", () => ({
  llmAdjustContent: (...args: unknown[]) => llmAdjustMock(...args),
}));

const activeCvMock = vi.fn();
vi.mock("../services/cv-active", () => ({
  getActiveCvDocument: (...args: unknown[]) => activeCvMock(...args),
}));

// summarizeJob hands the tailoring call the fields whose marker sits inside
// a link, read from the HTML CV's template envelope, so a value carrying a
// link is dropped there rather than failing the render.
describe.sequential("summarizeJob — the link context on an HTML profile", () => {
  let tempDir: string;
  let jobId: string;

  beforeEach(async () => {
    vi.resetModules();
    llmAdjustMock.mockReset();
    llmAdjustMock.mockResolvedValue({ success: false, error: "stop here" });
    activeCvMock.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-inside-links-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    const jobsRepo = await import("../repositories/jobs");
    await jobsRepo.createJobs([
      { source: "linkedin", title: "T", employer: "E", jobUrl: "https://ex/1" },
    ]);
    jobId = (await jobsRepo.getJobByUrl("https://ex/1"))?.id ?? "";
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function onProfile(format: string) {
    const settingsRepo = await import("../repositories/settings");
    await settingsRepo.setSetting("cvSourceFormat", format);
  }

  function cv(templatedTex: string) {
    return {
      id: "cv-1",
      personalBrief: "",
      fields: [{ id: "site", role: "url", value: "site" }],
      templatedTex,
      defaultFieldValues: {},
    };
  }

  it("passes the envelope's insideLinks on an HTML profile", async () => {
    await onProfile("html");
    activeCvMock.mockResolvedValue(
      cv(JSON.stringify({ html: "<p>⟦site⟧</p>", insideLinks: ["site"] })),
    );
    const { summarizeJob } = await import("./orchestrator");
    await summarizeJob(jobId);
    expect(llmAdjustMock.mock.calls[0][0].insideLinks).toEqual(["site"]);
  });

  it("passes none on a LaTeX profile", async () => {
    await onProfile("latex");
    activeCvMock.mockResolvedValue(cv("\\\\name{«site»}"));
    const { summarizeJob } = await import("./orchestrator");
    await summarizeJob(jobId);
    expect(llmAdjustMock.mock.calls[0][0].insideLinks).toBeUndefined();
  });

  it("fails the tailor, before any LLM call, on a damaged HTML template", async () => {
    await onProfile("html");
    activeCvMock.mockResolvedValue(cv('{"parts":{}}'));
    const { summarizeJob } = await import("./orchestrator");
    expect(await summarizeJob(jobId)).toEqual({
      success: false,
      error: "The stored CV template cannot be read; upload the CV again.",
    });
    expect(llmAdjustMock).not.toHaveBeenCalled();
  });
});
