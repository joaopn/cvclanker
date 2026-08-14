// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("POST /api/jobs/actions — 5g action variants", () => {
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

  async function seedJob(overrides: {
    id: string;
    status: string;
    outcome?: string | null;
    closedAt?: number | null;
    jobUrl?: string;
    tailoringFailureReason?: string | null;
  }) {
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values({
      id: overrides.id,
      source: "linkedin",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: overrides.jobUrl ?? `https://example.com/${overrides.id}`,
      status: overrides.status as
        | "discovered"
        | "selected"
        | "ready"
        | "applied"
        | "in_progress"
        | "backlog"
        | "stale"
        | "skipped"
        | "closed",
      outcome: (overrides.outcome ?? null) as
        | "rejected"
        | "withdrawn"
        | "ghosted"
        | "other"
        | null,
      closedAt: overrides.closedAt ?? null,
      tailoringFailureReason: overrides.tailoringFailureReason ?? null,
    });
  }

  async function postAction(body: unknown) {
    const res = await fetch(`${baseUrl}/api/jobs/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it("move_to_backlog accepts discovered + selected", async () => {
    await seedJob({ id: "job-5a", status: "discovered" });
    await seedJob({ id: "job-5b", status: "selected" });

    const { body } = await postAction({
      action: "move_to_backlog",
      jobIds: ["job-5a", "job-5b"],
    });

    expect(body.data.succeeded).toBe(2);
    for (const result of body.data.results) {
      expect(result.job.status).toBe("backlog");
    }
  });

  it("mark_closed sets status, outcome, closedAt", async () => {
    await seedJob({ id: "job-6", status: "applied" });

    const { body } = await postAction({
      action: "mark_closed",
      jobIds: ["job-6"],
      options: { outcome: "rejected" },
    });

    expect(body.data.results[0].job.status).toBe("closed");
    expect(body.data.results[0].job.outcome).toBe("rejected");
    expect(body.data.results[0].job.closedAt).toBeGreaterThan(0);
  });

  it("mark_closed rejects without an outcome", async () => {
    await seedJob({ id: "job-7", status: "applied" });

    const res = await fetch(`${baseUrl}/api/jobs/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "mark_closed",
        jobIds: ["job-7"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("mark_closed rejects pre-applied statuses", async () => {
    await seedJob({ id: "job-8", status: "ready" });

    const { body } = await postAction({
      action: "mark_closed",
      jobIds: ["job-8"],
      options: { outcome: "withdrawn" },
    });

    expect(body.data.failed).toBe(1);
  });

  it("mark_duplicated closes active rows with the duplicated outcome", async () => {
    await seedJob({ id: "job-dup-1", status: "discovered" });
    await seedJob({ id: "job-dup-2", status: "selected" });

    const { body } = await postAction({
      action: "mark_duplicated",
      jobIds: ["job-dup-1", "job-dup-2"],
    });

    expect(body.data.succeeded).toBe(2);
    for (const result of body.data.results) {
      expect(result.job.status).toBe("closed");
      expect(result.job.outcome).toBe("duplicated");
      expect(result.job.closedAt).toBeGreaterThan(0);
    }
  });

  it("mark_duplicated rejects terminal statuses", async () => {
    await seedJob({ id: "job-dup-3", status: "closed", outcome: "rejected" });

    const { body } = await postAction({
      action: "mark_duplicated",
      jobIds: ["job-dup-3"],
    });

    expect(body.data.failed).toBe(1);
    expect(body.data.results[0].error.code).toBe("INVALID_REQUEST");
  });

  it("reopen rotates skipped/closed back to the inbox and clears outcome", async () => {
    await seedJob({
      id: "job-9a",
      status: "closed",
      outcome: "rejected",
      closedAt: 1700000000,
    });
    await seedJob({ id: "job-9b", status: "skipped" });

    const { body } = await postAction({
      action: "reopen",
      jobIds: ["job-9a", "job-9b"],
    });

    expect(body.data.succeeded).toBe(2);
    for (const result of body.data.results) {
      expect(result.job.status).toBe("discovered");
      expect(result.job.outcome).toBeNull();
      expect(result.job.closedAt).toBeNull();
    }
  });

  it("skip is now allowed from selected and backlog (not just discovered/ready)", async () => {
    await seedJob({ id: "job-10a", status: "selected" });
    await seedJob({ id: "job-10b", status: "backlog" });

    const { body } = await postAction({
      action: "skip",
      jobIds: ["job-10a", "job-10b"],
    });

    expect(body.data.succeeded).toBe(2);
    for (const result of body.data.results) {
      expect(result.job.status).toBe("skipped");
    }
  });

  it("move_to_stale accepts discovered + selected + backlog", async () => {
    await seedJob({ id: "stale-1", status: "discovered" });
    await seedJob({ id: "stale-2", status: "selected" });
    await seedJob({ id: "stale-3", status: "backlog" });

    const { body } = await postAction({
      action: "move_to_stale",
      jobIds: ["stale-1", "stale-2", "stale-3"],
    });

    expect(body.data.succeeded).toBe(3);
    for (const result of body.data.results) {
      expect(result.job.status).toBe("stale");
    }
  });

  it("move_to_stale rejects from non-source statuses", async () => {
    await seedJob({ id: "stale-4", status: "applied" });

    const { body } = await postAction({
      action: "move_to_stale",
      jobIds: ["stale-4"],
    });

    expect(body.data.succeeded).toBe(0);
    expect(body.data.failed).toBe(1);
    expect(body.data.results[0].error.code).toBe("INVALID_REQUEST");
  });

  it("move_to_inbox promotes a stale row to discovered", async () => {
    await seedJob({ id: "stale-5", status: "stale" });

    const { body } = await postAction({
      action: "move_to_inbox",
      jobIds: ["stale-5"],
    });

    expect(body.data.succeeded).toBe(1);
    expect(body.data.results[0].job.status).toBe("discovered");
  });

  it("move_to_inbox rejects from non-stale statuses", async () => {
    await seedJob({ id: "stale-6", status: "backlog" });

    const { body } = await postAction({
      action: "move_to_inbox",
      jobIds: ["stale-6"],
    });

    expect(body.data.succeeded).toBe(0);
    expect(body.data.failed).toBe(1);
  });

  it("skip is allowed from stale", async () => {
    await seedJob({ id: "stale-7", status: "stale" });

    const { body } = await postAction({
      action: "skip",
      jobIds: ["stale-7"],
    });

    expect(body.data.succeeded).toBe(1);
    expect(body.data.results[0].job.status).toBe("skipped");
  });

  it("sweep-stale moves matching rows and reports per-source breakdown", async () => {
    const { db, schema } = await import("@server/db/index");
    const { sql } = await import("drizzle-orm");
    // Old rows that should be swept.
    await seedJob({ id: "sweep-old-discovered", status: "discovered" });
    await seedJob({ id: "sweep-old-selected", status: "selected" });
    await seedJob({ id: "sweep-old-backlog", status: "backlog" });
    // Fresh row that should NOT be swept.
    await seedJob({ id: "sweep-fresh", status: "discovered" });
    // Ready row should never be swept regardless of age.
    await seedJob({ id: "sweep-ready-old", status: "ready" });

    await db
      .update(schema.jobs)
      .set({ discoveredAt: sql`datetime('now', '-30 days')` })
      .where(
        sql`${schema.jobs.id} IN ('sweep-old-discovered', 'sweep-old-selected', 'sweep-old-backlog', 'sweep-ready-old')`,
      );

    const res = await fetch(`${baseUrl}/api/jobs/sweep-stale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholdDays: 14 }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      data: {
        moved: number;
        breakdown: { discovered: number; selected: number; backlog: number };
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.moved).toBe(3);
    expect(payload.data.breakdown).toEqual({
      discovered: 1,
      selected: 1,
      backlog: 1,
    });

    // Verify the actual table state.
    const rows = await db
      .select({ id: schema.jobs.id, status: schema.jobs.status })
      .from(schema.jobs);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId["sweep-old-discovered"]).toBe("stale");
    expect(byId["sweep-old-selected"]).toBe("stale");
    expect(byId["sweep-old-backlog"]).toBe("stale");
    expect(byId["sweep-fresh"]).toBe("discovered");
    expect(byId["sweep-ready-old"]).toBe("ready");
  });

  it("sweep-stale scope=active sweeps aged ready/applied/in_progress, leaves shelf rows", async () => {
    const { db, schema } = await import("@server/db/index");
    const { sql } = await import("drizzle-orm");
    await seedJob({ id: "sweep-active-ready", status: "ready" });
    await seedJob({ id: "sweep-active-applied", status: "applied" });
    await seedJob({ id: "sweep-active-inprogress", status: "in_progress" });
    // Shelf row must NOT be swept under the active scope.
    await seedJob({ id: "sweep-active-discovered", status: "discovered" });

    await db
      .update(schema.jobs)
      .set({ discoveredAt: sql`datetime('now', '-30 days')` })
      .where(
        sql`${schema.jobs.id} IN ('sweep-active-ready', 'sweep-active-applied', 'sweep-active-inprogress', 'sweep-active-discovered')`,
      );

    const res = await fetch(`${baseUrl}/api/jobs/sweep-stale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholdDays: 14, scope: "active" }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      data: { moved: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.moved).toBe(3);

    const rows = await db
      .select({ id: schema.jobs.id, status: schema.jobs.status })
      .from(schema.jobs);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId["sweep-active-ready"]).toBe("stale");
    expect(byId["sweep-active-applied"]).toBe("stale");
    expect(byId["sweep-active-inprogress"]).toBe("stale");
    expect(byId["sweep-active-discovered"]).toBe("discovered");
  });

  it("sweep-stale prefers date_posted over discovered_at and handles Unix-ms strings", async () => {
    const { db, schema } = await import("@server/db/index");
    const { sql } = await import("drizzle-orm");
    // Old posting, fresh discovery (the typical repost-redeposit case) — SHOULD sweep.
    await seedJob({ id: "sweep-posted-old-iso", status: "discovered" });
    // Jobspy-style Unix-ms numeric string, old — SHOULD sweep.
    await seedJob({ id: "sweep-posted-old-msec", status: "discovered" });
    // Fresh date_posted but old discovered_at — should NOT sweep (date_posted wins).
    await seedJob({ id: "sweep-posted-fresh", status: "discovered" });

    await db
      .update(schema.jobs)
      .set({
        datePosted: sql`strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')`,
        discoveredAt: sql`datetime('now', '-2 days')`,
      })
      .where(sql`${schema.jobs.id} = 'sweep-posted-old-iso'`);

    // Unix-ms 30 days ago, stringified.
    const msecCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await db
      .update(schema.jobs)
      .set({
        datePosted: String(msecCutoff),
        discoveredAt: sql`datetime('now', '-2 days')`,
      })
      .where(sql`${schema.jobs.id} = 'sweep-posted-old-msec'`);

    await db
      .update(schema.jobs)
      .set({
        datePosted: sql`strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 days')`,
        discoveredAt: sql`datetime('now', '-60 days')`,
      })
      .where(sql`${schema.jobs.id} = 'sweep-posted-fresh'`);

    const res = await fetch(`${baseUrl}/api/jobs/sweep-stale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholdDays: 14 }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      data: { moved: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.moved).toBe(2);

    const rows = await db
      .select({ id: schema.jobs.id, status: schema.jobs.status })
      .from(schema.jobs);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId["sweep-posted-old-iso"]).toBe("stale");
    expect(byId["sweep-posted-old-msec"]).toBe("stale");
    expect(byId["sweep-posted-fresh"]).toBe("discovered");
  });

  it("sweep-stale rejects invalid thresholdDays", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/sweep-stale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholdDays: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects with 422 when jobDescription exceeds maxJobDescriptionChars", async () => {
    await seedJob({ id: "job-jd", status: "discovered" });
    const oversized = "x".repeat(100_001);
    const res = await fetch(`${baseUrl}/api/jobs/job-jd`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription: oversized }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: {
        code: string;
        details: { field: string; observed: number; max: number };
      };
    };
    expect(payload.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(payload.error.details.field).toBe("jobDescription");
    expect(payload.error.details.max).toBe(100_000);
  });

  it("PATCH rejects with 422 when coverLetterDraft exceeds maxCoverLetterChars", async () => {
    await seedJob({ id: "job-cl", status: "ready" });
    const oversized = "x".repeat(50_001);
    const res = await fetch(`${baseUrl}/api/jobs/job-cl`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coverLetterDraft: oversized }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: {
        code: string;
        details: { field: string; observed: number; max: number };
      };
    };
    expect(payload.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(payload.error.details.field).toBe("coverLetterDraft");
    expect(payload.error.details.max).toBe(50_000);
  });

  it("PATCH accepts great_fit and it survives the migrated DB's CHECK", async () => {
    await seedJob({ id: "job-great", status: "discovered" });
    const res = await fetch(`${baseUrl}/api/jobs/job-great`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suitabilityCategory: "great_fit" }),
    });
    expect(res.status).toBe(200);

    const { db, schema } = await import("@server/db/index");
    const rows = await db
      .select({
        id: schema.jobs.id,
        suitabilityCategory: schema.jobs.suitabilityCategory,
      })
      .from(schema.jobs);
    const stored = rows.find((r) => r.id === "job-great");
    expect(stored?.suitabilityCategory).toBe("great_fit");
  });

  it("GET /duplicates returns active-triage jobs grouped by title + company", async () => {
    // seedJob uses the same title/employer for every row, so two active rows
    // form one duplicate group.
    await seedJob({ id: "dups-a", status: "discovered" });
    await seedJob({ id: "dups-b", status: "selected" });
    // A terminal row with the same identity must NOT join the group.
    await seedJob({ id: "dups-c", status: "closed", outcome: "rejected" });

    const res = await fetch(`${baseUrl}/api/jobs/duplicates`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      data: { groups: Array<{ jobs: Array<{ id: string }> }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.groups).toHaveLength(1);
    expect(payload.data.groups[0].jobs.map((j) => j.id).sort()).toEqual([
      "dups-a",
      "dups-b",
    ]);
  });

  // Rescrape: only the two guard paths are unit-tested here. Both short-circuit
  // BEFORE fetchJobDraft (status check, then URL check), so no network/browser
  // is touched and this vi.mock-free harness stays hermetic. Do NOT add a
  // happy-path rescrape test here — a non-processing, http-URL job would run the
  // real fetchAndExtractJobContent → live network. The happy path is browser
  // smoke only.
  it("rescrape rejects a processing job before any fetch", async () => {
    await seedJob({ id: "rescrape-proc", status: "processing" });

    const { body } = await postAction({
      action: "rescrape",
      jobIds: ["rescrape-proc"],
    });

    expect(body.data.succeeded).toBe(0);
    expect(body.data.failed).toBe(1);
    expect(body.data.results[0].error.code).toBe("INVALID_REQUEST");
  });

  it("rescrape rejects a non-http (manual://) URL before any fetch", async () => {
    await seedJob({
      id: "rescrape-manual",
      status: "discovered",
      jobUrl: "manual://11111111-1111-1111-1111-111111111111",
    });

    const { body } = await postAction({
      action: "rescrape",
      jobIds: ["rescrape-manual"],
    });

    expect(body.data.succeeded).toBe(0);
    expect(body.data.failed).toBe(1);
    expect(body.data.results[0].error.code).toBe("INVALID_REQUEST");
  });

  it("clear_score drops the stored suitability without moving the job", async () => {
    const { db, schema } = await import("@server/db/index");
    await seedJob({ id: "job-cs1", status: "discovered" });
    await seedJob({ id: "job-cs2", status: "backlog" });
    const { eq } = await import("drizzle-orm");
    for (const id of ["job-cs1", "job-cs2"]) {
      await db
        .update(schema.jobs)
        .set({ suitabilityCategory: "good_fit", suitabilityReason: "why" })
        .where(eq(schema.jobs.id, id));
    }

    const { body } = await postAction({
      action: "clear_score",
      jobIds: ["job-cs1", "job-cs2"],
    });

    expect(body.data.succeeded).toBe(2);
    for (const result of body.data.results) {
      expect(result.job.suitabilityCategory).toBeNull();
      // The reason has to go too, or the row reads as unscored while still
      // showing the old explanation.
      expect(result.job.suitabilityReason).toBeNull();
    }
    // The job keeps its status and its place in the list.
    expect(body.data.results[0].job.status).toBe("discovered");
    expect(body.data.results[1].job.status).toBe("backlog");
  });

  it("clear_score is a no-op on an already-unscored job, not an error", async () => {
    await seedJob({ id: "job-cs3", status: "discovered" });

    const { body } = await postAction({
      action: "clear_score",
      jobIds: ["job-cs3"],
    });

    expect(body.data.succeeded).toBe(1);
    expect(body.data.results[0].job.suitabilityCategory).toBeNull();
  });

  it("clear_score refuses a job that is mid-tailor", async () => {
    await seedJob({ id: "job-cs4", status: "processing" });

    const { body } = await postAction({
      action: "clear_score",
      jobIds: ["job-cs4"],
    });

    expect(body.data.failed).toBe(1);
    expect(body.data.results[0].ok).toBe(false);
    expect(body.data.results[0].error.message).toMatch(/not clearable/i);
  });

  it("delete removes the row outright, from any status", async () => {
    await seedJob({ id: "job-del-1", status: "discovered" });
    await seedJob({ id: "job-del-2", status: "applied" });

    const { body } = await postAction({
      action: "delete",
      jobIds: ["job-del-1", "job-del-2"],
    });

    expect(body.data.succeeded).toBe(2);
    const { db, schema } = await import("@server/db/index");
    const rows = await db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(rows).toHaveLength(0);
  });

  it("delete sweeps the rows hanging off the job", async () => {
    // PRAGMA foreign_keys is never enabled, so nothing cascades — if these are
    // not swept by hand they become unreachable rows no later delete can find.
    await seedJob({ id: "job-del-3", status: "discovered" });
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobNotes).values({
      id: "note-1",
      jobId: "job-del-3",
      title: "Note",
      content: "Body",
    });
    await db.insert(schema.jobChatThreads).values({
      id: "thread-1",
      jobId: "job-del-3",
    });
    await db.insert(schema.jobChatMessages).values({
      id: "msg-1",
      threadId: "thread-1",
      jobId: "job-del-3",
      role: "user",
      content: "hi",
    });
    await db.insert(schema.jobPdfs).values({
      jobId: "job-del-3",
      kind: "resume",
      data: Buffer.from("pdf"),
    });

    const { body } = await postAction({
      action: "delete",
      jobIds: ["job-del-3"],
    });

    expect(body.data.succeeded).toBe(1);
    expect(await db.select().from(schema.jobNotes)).toHaveLength(0);
    expect(await db.select().from(schema.jobChatThreads)).toHaveLength(0);
    expect(await db.select().from(schema.jobChatMessages)).toHaveLength(0);
    expect(await db.select().from(schema.jobPdfs)).toHaveLength(0);
  });

  it("delete refuses a job that is actively being tailored", async () => {
    await seedJob({ id: "job-del-4", status: "processing" });

    const { body } = await postAction({
      action: "delete",
      jobIds: ["job-del-4"],
    });

    expect(body.data.failed).toBe(1);
    expect(body.data.results[0].ok).toBe(false);
    expect(body.data.results[0].error.message).toMatch(/being tailored/i);
    const { db, schema } = await import("@server/db/index");
    expect(await db.select().from(schema.jobs)).toHaveLength(1);
  });

  it("delete accepts a FAILED tailor, which sits at the same status", async () => {
    await seedJob({
      id: "job-del-5",
      status: "processing",
      tailoringFailureReason: "tectonic exited 1",
    });

    const { body } = await postAction({
      action: "delete",
      jobIds: ["job-del-5"],
    });

    expect(body.data.succeeded).toBe(1);
  });

  it("delete reports a missing job without failing its siblings", async () => {
    await seedJob({ id: "job-del-6", status: "discovered" });

    const { body } = await postAction({
      action: "delete",
      jobIds: ["job-del-6", "job-does-not-exist"],
    });

    expect(body.data.succeeded).toBe(1);
    expect(body.data.failed).toBe(1);
  });

  describe("rescore screening", () => {
    async function scorerMock() {
      const scorer = await import("@server/services/scorer");
      return vi.mocked(scorer.scoreJobSuitability);
    }

    it("goes straight to the scoring model by default", async () => {
      await seedJob({ id: "job-rs-1", status: "discovered" });
      const scoreJobSuitability = await scorerMock();
      scoreJobSuitability.mockResolvedValue({
        category: "good_fit",
        reason: "fine",
        model: "big-model",
        effort: null,
      });

      await postAction({ action: "rescore", jobIds: ["job-rs-1"] });

      // The whole point of the default: a manual rescore is the second opinion
      // on anything the screen removed, so it must not screen.
      expect(scoreJobSuitability).toHaveBeenCalledWith(
        expect.objectContaining({ id: "job-rs-1" }),
        expect.any(String),
        { prefilter: false },
      );
    });

    it("opts into the screen when the request asks for it", async () => {
      await seedJob({ id: "job-rs-2", status: "discovered" });
      const scoreJobSuitability = await scorerMock();
      scoreJobSuitability.mockResolvedValue({
        category: "bad_fit",
        reason: "screened out",
        model: "cheap-model",
        effort: null,
      });

      const { body } = await postAction({
        action: "rescore",
        jobIds: ["job-rs-2"],
        options: { prefilter: true },
      });

      expect(scoreJobSuitability).toHaveBeenCalledWith(
        expect.objectContaining({ id: "job-rs-2" }),
        expect.any(String),
        { prefilter: true },
      );
      // A screened rescore may write bad_fit, but it never moves the job —
      // auto-skip lives in the pipeline's scoring step alone.
      expect(body.data.results[0].job.status).toBe("discovered");
      expect(body.data.results[0].job.suitabilityCategory).toBe("bad_fit");
    });

    it("rejects a non-boolean prefilter", async () => {
      const res = await fetch(`${baseUrl}/api/jobs/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rescore",
          jobIds: ["job-rs-3"],
          options: { prefilter: "yes" },
        }),
      });
      expect(res.status).toBe(400);
    });
  });
});
