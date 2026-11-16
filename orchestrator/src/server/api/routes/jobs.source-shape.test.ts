// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

// GET /api/jobs/:id reports the shape of the job's own tailored HTML source,
// read from its stored copy by the same zip test /pdfs answers with.
describe.sequential("GET /api/jobs/:id — tailoredSourceShape", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values({
      id: "job-1",
      source: "linkedin",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job-1",
      status: "ready",
    });
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function shape(): Promise<unknown> {
    const res = await fetch(`${baseUrl}/api/jobs/job-1`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { tailoredSourceShape?: unknown };
    };
    return data.tailoredSourceShape;
  }

  async function store(data: Buffer, kind = "resume_html" as const) {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({ jobId: "job-1", kind, data });
  }

  it("is null when the job has no tailored HTML source", async () => {
    await store(Buffer.from("%PDF-1.7"), "resume" as never);
    expect(await shape()).toBeNull();
  });

  it("is file for a page and bundle for a zip", async () => {
    await store(Buffer.from("<!doctype html><p>x</p>"));
    expect(await shape()).toBe("file");
    await store(Buffer.from("PK\u0003\u0004 a zip", "latin1"));
    expect(await shape()).toBe("bundle");
  });
});
