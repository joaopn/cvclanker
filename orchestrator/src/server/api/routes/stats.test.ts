// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("GET /api/stats", () => {
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

  async function seedJob(job: {
    id: string;
    profileId?: string | null;
    suitability?: string | null;
    status?: string;
    appliedAt?: string | null;
    employer?: string;
  }) {
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values({
      id: job.id,
      source: "linkedin",
      title: `Job ${job.id}`,
      employer: job.employer ?? "Acme",
      jobUrl: `https://example.com/${job.id}`,
      status: (job.status ?? "discovered") as "discovered",
      suitabilityCategory: (job.suitability ?? null) as "good_fit" | null,
      discoveredAt: new Date().toISOString(),
      appliedAt: job.appliedAt ?? null,
      profileId: job.profileId ?? null,
    });
  }

  async function seedProfile(id: string, name: string) {
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.profiles).values({ id, name, configJson: {} });
  }

  it("returns the overview in the standard envelope", async () => {
    await seedJob({ id: "a", suitability: "good_fit" });
    await seedJob({ id: "b", suitability: "bad_fit" });

    const res = await fetch(`${baseUrl}/api/stats/overview`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.found).toBe(2);
    expect(body.data.goodFit).toBe(1);
    expect(body.data.funnel).toHaveLength(5);
    expect(body.meta.requestId).toBeTruthy();
  });

  it("serves each tab's endpoint", async () => {
    await seedJob({ id: "a" });
    for (const path of ["discovery", "applications", "companies"]) {
      const res = await fetch(`${baseUrl}/api/stats/${path}`);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }
  });

  it("reports that term attribution and per-run yield are unavailable", async () => {
    const res = await fetch(`${baseUrl}/api/stats/discovery`);
    const body = await res.json();
    expect(body.data.termAttributionAvailable).toBe(false);
    expect(body.data.perRunYieldAvailable).toBe(false);
  });

  it("applies the profile filter", async () => {
    await seedProfile("p1", "Remote");
    await seedJob({ id: "a", profileId: "p1" });
    await seedJob({ id: "b", profileId: null });

    const res = await fetch(`${baseUrl}/api/stats/overview?profileId=p1`);
    const body = await res.json();
    expect(body.data.found).toBe(1);
  });

  it("rejects an unknown profile rather than answering with zeros", async () => {
    const res = await fetch(`${baseUrl}/api/stats/overview?profileId=nope`);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it.each([
    "0",
    "-5",
    "abc",
    "4000",
  ])("rejects days=%s", async (days: string) => {
    const res = await fetch(`${baseUrl}/api/stats/overview?days=${days}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_REQUEST");
  });

  it("accepts a valid day range", async () => {
    await seedJob({ id: "a" });
    const res = await fetch(`${baseUrl}/api/stats/overview?days=30`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.found).toBe(1);
  });
});
