import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Manual jobs API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  describe("POST /api/manual-jobs/fetch", () => {
    it("rejects invalid URLs", async () => {
      const res = await fetch(`${baseUrl}/api/manual-jobs/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not-a-valid-url" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects empty payload", async () => {
      const res = await fetch(`${baseUrl}/api/manual-jobs/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  it("infers manual jobs and rejects empty payloads", async () => {
    const badRes = await fetch(`${baseUrl}/api/manual-jobs/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(badRes.status).toBe(400);

    const { inferManualJobDetails } = await import(
      "@server/services/manualJob"
    );
    vi.mocked(inferManualJobDetails).mockResolvedValue({
      job: { title: "Backend Engineer", employer: "Acme" },
      warning: null,
    });

    const res = await fetch(`${baseUrl}/api/manual-jobs/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription: "Role description" }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.job.title).toBe("Backend Engineer");
  });

  it("imports manual jobs and generates a fallback URL", async () => {
    const { processJob } = await import("@server/pipeline/index");
    const { scoreJobSuitability } = await import("@server/services/scorer");
    vi.mocked(scoreJobSuitability).mockResolvedValue({
      category: "very_good_fit",
      reason: "Strong fit",
      model: "stub-model",
      effort: null,
    });

    const res = await fetch(`${baseUrl}/api/manual-jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job: {
          title: "Backend Engineer",
          employer: "Acme",
          jobDescription: "Great role",
        },
      }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.source).toBe("manual");
    expect(body.data.jobUrl).toMatch(/^manual:\/\//);
    expect(vi.mocked(processJob)).toHaveBeenCalledWith(body.data.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
});

describe.sequential("detached batch URL import", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    const { resetUrlImportBatchForTests } = await import(
      "@server/services/url-import/batch-store"
    );
    resetUrlImportBatchForTests();
  });

  afterEach(async () => {
    const { resetUrlImportBatchForTests } = await import(
      "@server/services/url-import/batch-store"
    );
    resetUrlImportBatchForTests();
    await stopServer({ server, closeDb, tempDir });
  });

  const start = (urls: string[]) =>
    fetch(`${baseUrl}/api/manual-jobs/import-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });

  async function waitForTerminal() {
    return vi.waitFor(async () => {
      const res = await fetch(`${baseUrl}/api/manual-jobs/import-batch`);
      const { data } = await res.json();
      expect(data.batch).not.toBeNull();
      expect(data.batch.status).not.toBe("running");
      return data.batch;
    });
  }

  it("answers with the batch id alone and runs the import detached", async () => {
    const res = await start(["https://example.com/a"]);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(Object.keys(data)).toEqual(["batchId"]);

    const batch = await waitForTerminal();
    expect(batch.batchId).toBe(data.batchId);
    expect(batch.requested).toBe(1);
  });

  // The whole point of carrying the URL list: a client attaching mid-run must
  // be able to render every row, not only the settled ones.
  it("exposes the full requested list from the start", async () => {
    const urls = ["https://example.com/a", "https://example.com/b"];
    await start(urls);
    const res = await fetch(`${baseUrl}/api/manual-jobs/import-batch`);
    const { data } = await res.json();
    expect(data.batch.urls).toEqual(urls);
    expect(data.batch.requested).toBe(2);
    await waitForTerminal();
  });

  it("refuses a second import while one is running", async () => {
    await start(["https://example.com/a"]);
    const { startUrlImportBatch } = await import(
      "@server/services/url-import/batch-store"
    );
    // Hold the singleton so the second POST is guaranteed to collide.
    const held = startUrlImportBatch({
      urls: ["https://example.com/held"],
      concurrency: 1,
      importUrl: () => new Promise(() => {}),
    });
    // Without this the whole assertion could be skipped by a timing change.
    expect(held).not.toBeNull();
    const second = await start(["https://example.com/b"]);
    expect(second.status).toBe(409);
  });

  it("rejects a list over the cap before any batch exists", async () => {
    const urls = Array.from(
      { length: 51 },
      (_, i) => `https://example.com/${i}`,
    );
    const res = await start(urls);
    expect(res.status).toBe(400);
    const listed = await fetch(`${baseUrl}/api/manual-jobs/import-batch`);
    expect((await listed.json()).data.batch).toBeNull();
  });

  it("cancel refuses when nothing is running", async () => {
    const res = await fetch(`${baseUrl}/api/manual-jobs/import-batch/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("answers duplicate for a URL that differs from a saved job's only by tracking parameters", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const existing = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/1",
      jobDescription: "Existing role",
    });
    const { fetchJobDraft } = await import("@server/services/manualJob");
    vi.mocked(fetchJobDraft).mockResolvedValueOnce({
      job: {
        title: "Backend Engineer",
        employer: "Acme",
        jobDescription: "Existing role",
      },
      usage: null,
      warning: null,
    });
    const { scoreJobSuitability } = await import("@server/services/scorer");
    vi.mocked(scoreJobSuitability).mockClear();

    await start(["https://example.com/jobs/1?utm_source=newsletter"]);
    const batch = await waitForTerminal();

    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]).toMatchObject({
      ok: true,
      status: "duplicate",
      jobId: existing.id,
    });
    expect(batch.duplicates).toBe(1);
    expect(batch.succeeded).toBe(0);
    expect(vi.mocked(scoreJobSuitability)).not.toHaveBeenCalled();
  });

  // Rows stored before URLs were canonicalized keep their raw URL; looking up
  // only the canonical form would miss them and insert a second copy.
  it("still answers duplicate for a row stored under a raw, uncanonicalized URL", async () => {
    const rawUrl = "https://example.com/jobs/2?utm_source=newsletter";
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values({
      id: "legacy-raw",
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: rawUrl,
      status: "discovered",
    });
    const { fetchJobDraft } = await import("@server/services/manualJob");
    vi.mocked(fetchJobDraft).mockResolvedValueOnce({
      job: {
        title: "Backend Engineer",
        employer: "Acme",
        jobDescription: "Existing role",
      },
      usage: null,
      warning: null,
    });

    await start([rawUrl]);
    const batch = await waitForTerminal();

    expect(batch.results[0]).toMatchObject({
      ok: true,
      status: "duplicate",
      jobId: "legacy-raw",
    });
  });

  describe("a failed row finished by hand", () => {
    // A created job starts a fire-and-forget scoring run; let it finish before
    // the outer teardown closes the DB (same allowance as the `/import` test).
    afterEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const rowUrl = "https://example.com/jobs/image-posting";
    const usage = {
      promptTokens: 4259,
      completionTokens: 584,
      totalTokens: 4843,
      totalMillions: 0.004843,
    };

    async function importOneParseFailure() {
      const { fetchJobDraft } = await import("@server/services/manualJob");
      vi.mocked(fetchJobDraft).mockResolvedValueOnce({
        job: { title: "Data Engineer", location: "Vienna" },
        usage,
        warning: null,
      });
      await start([rowUrl]);
      const batch = await waitForTerminal();
      expect(batch.results[0]).toMatchObject({ code: "PARSE_FAILED" });
      return batch.batchId as string;
    }

    const getDraft = (batchId: string, url: string) =>
      fetch(
        `${baseUrl}/api/manual-jobs/import-batch/draft?${new URLSearchParams({ batchId, url })}`,
      );

    const save = (body: unknown) =>
      fetch(`${baseUrl}/api/manual-jobs/import-batch/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const completeJob = {
      title: "Data Engineer",
      employer: "Acme",
      jobDescription: "Typed in by hand",
      location: "Vienna",
    };

    it("serves what the fetch read, and nothing for another import", async () => {
      const batchId = await importOneParseFailure();
      const res = await getDraft(batchId, rowUrl);
      expect((await res.json()).data.draft).toEqual({
        title: "Data Engineer",
        location: "Vienna",
      });
      const other = await getDraft("another-import", rowUrl);
      expect((await other.json()).data.draft).toBeNull();
      const bad = await fetch(`${baseUrl}/api/manual-jobs/import-batch/draft`);
      expect(bad.status).toBe(400);
    });

    it("creates the job, scores it and turns the row saved", async () => {
      const batchId = await importOneParseFailure();
      const { scoreJobSuitability } = await import("@server/services/scorer");
      vi.mocked(scoreJobSuitability).mockClear();

      const res = await save({ batchId, url: rowUrl, job: completeJob });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data).toMatchObject({ ok: true, status: "created" });

      const jobsRepo = await import("@server/repositories/jobs");
      const job = await jobsRepo.getJobById(body.data.jobId);
      expect(job).toMatchObject({
        source: "manual",
        status: "discovered",
        title: "Data Engineer",
        employer: "Acme",
        jobDescription: "Typed in by hand",
        location: "Vienna",
        jobUrl: rowUrl,
      });
      await vi.waitFor(() =>
        expect(vi.mocked(scoreJobSuitability)).toHaveBeenCalledTimes(1),
      );

      const listed = await fetch(`${baseUrl}/api/manual-jobs/import-batch`);
      const { batch } = (await listed.json()).data;
      expect(batch).toMatchObject({ succeeded: 1, failed: 0 });
      expect(batch.results[0]).toMatchObject({
        ok: true,
        status: "created",
        jobId: body.data.jobId,
        usage,
      });
    });

    it("answers duplicate for a job already saved, and counts a second save once", async () => {
      const batchId = await importOneParseFailure();
      const first = await save({ batchId, url: rowUrl, job: completeJob });
      const firstId = (await first.json()).data.jobId;

      const second = await save({ batchId, url: rowUrl, job: completeJob });
      expect((await second.json()).data).toMatchObject({
        status: "duplicate",
        jobId: firstId,
      });

      const listed = await fetch(`${baseUrl}/api/manual-jobs/import-batch`);
      expect((await listed.json()).data.batch).toMatchObject({
        succeeded: 1,
        duplicates: 0,
        failed: 0,
      });
    });

    it("falls back to the row's URL when the job URL is cleared or malformed", async () => {
      const batchId = await importOneParseFailure();
      const res = await save({
        batchId,
        url: rowUrl,
        job: { ...completeJob, jobUrl: "not a url" },
      });
      const jobsRepo = await import("@server/repositories/jobs");
      const job = await jobsRepo.getJobById((await res.json()).data.jobId);
      expect(job?.jobUrl).toBe(rowUrl);
    });

    it("refuses a job missing a required field", async () => {
      const batchId = await importOneParseFailure();
      for (const field of ["title", "employer", "jobDescription"] as const) {
        const res = await save({
          batchId,
          url: rowUrl,
          job: { ...completeJob, [field]: "   " },
        });
        expect(res.status).toBe(400);
      }
    });

    // Long fetched descriptions must not be refused: the batch import takes
    // them, and the form is pre-filled from what it took.
    it("accepts a description longer than the single-job import allows", async () => {
      const batchId = await importOneParseFailure();
      const res = await save({
        batchId,
        url: rowUrl,
        job: { ...completeJob, jobDescription: "x".repeat(60000) },
      });
      expect(res.status).toBe(200);
    });

    it("saves against a replaced import but leaves the newer one alone", async () => {
      const batchId = await importOneParseFailure();
      // The newer import holds the SAME url, failed — so only the import-id
      // check keeps the save from resolving the newer row.
      const newerBatchId = await importOneParseFailure();
      expect(newerBatchId).not.toBe(batchId);

      const res = await save({ batchId, url: rowUrl, job: completeJob });
      expect((await res.json()).data).toMatchObject({ status: "created" });

      const listed = await fetch(`${baseUrl}/api/manual-jobs/import-batch`);
      const { batch } = (await listed.json()).data;
      expect(batch.batchId).toBe(newerBatchId);
      expect(batch).toMatchObject({ succeeded: 0, failed: 1 });
      expect(batch.results[0]).toMatchObject({ status: "failed" });
    });

    it("refuses a row URL that is not http(s)", async () => {
      const batchId = await importOneParseFailure();
      const res = await save({
        batchId,
        url: "javascript:alert(1)",
        job: completeJob,
      });
      expect(res.status).toBe(400);
    });
  });

  it("streams a snapshot on connect", async () => {
    await start(["https://example.com/a"]);
    await waitForTerminal();

    const res = await fetch(`${baseUrl}/api/manual-jobs/import-batch/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      while (!text.includes('"snapshot"')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
    }
    expect(text).toContain('"snapshot"');
    expect(text).toContain("https://example.com/a");
  });
});
