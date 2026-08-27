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
