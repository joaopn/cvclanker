// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("GET /api/jobs/search", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values([
      {
        id: "live",
        source: "linkedin",
        title: "Backend Engineer",
        employer: "Acme",
        jobUrl: "https://example.com/live",
        status: "applied",
        appliedAt: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "inbox",
        source: "linkedin",
        title: "Backend Engineer",
        employer: "Beta",
        jobUrl: "https://example.com/inbox",
        status: "discovered",
      },
    ]);
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("answers the matching list rows and their total", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/search?q=acme`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.jobs).toHaveLength(1);
    expect(body.data.jobs[0]).toMatchObject({
      id: "live",
      title: "Backend Engineer",
      employer: "Acme",
      status: "applied",
      sourceLabel: expect.any(String),
    });
  });

  it("applies a lock", async () => {
    const res = await fetch(
      `${baseUrl}/api/jobs/search?q=backend&lock=ever_applied`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jobs.map((job: { id: string }) => job.id)).toEqual([
      "live",
    ]);
  });

  it("lists the newest jobs without a query", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/search`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.total).toBe(2);
  });

  it("refuses a lock it does not know", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/search?q=acme&lock=closed`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("is not taken for a job id", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/search?q=nothing-matches`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ jobs: [], total: 0 });
  });
});
