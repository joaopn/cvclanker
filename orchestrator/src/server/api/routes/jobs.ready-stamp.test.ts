// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

/**
 * `ready_at` is the mark the overview funnel counts as "Tailored", and
 * `updateJob` coalesce-stamps it on any move to `ready`. That used to be
 * unreachable except through a real tailor or from a row already past one, so
 * the stamp could only ever be true.
 *
 * The stage switcher moves a NEVER-tailored row straight to Tailoring, which
 * makes the stamp reachable on a row nothing has tailored — and the stamp is
 * sticky, so it had to become clearable for the same reason `applied_at` did:
 * undo restores the pre-move value, and without a write path it could not.
 * This is the route half (the schema has to ACCEPT `readyAt`, which it did not);
 * `client/lib/undo.ts` is what sends it.
 */
describe.sequential("PATCH /api/jobs/:id — the ready mark", () => {
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

  async function seedJob(id: string, status: string): Promise<void> {
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values({
      id,
      source: "linkedin",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/${id}`,
      status: status as "backlog",
    });
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it("stamps ready_at when a never-tailored row is moved to Tailoring", async () => {
    await seedJob("ready-1", "backlog");

    const moved = await patch("ready-1", {
      status: "ready",
      outcome: null,
      closedAt: null,
    });

    expect(moved.status).toBe(200);
    expect(moved.body.data.readyAt).toEqual(expect.any(String));
  });

  /**
   * The undo path. Red before the schema learned `readyAt`: the field was
   * stripped by zod, the row kept its stamp, and the reverted job stayed
   * counted as Tailored for ever.
   */
  it("clears ready_at on the explicit restore undo sends", async () => {
    await seedJob("ready-2", "backlog");
    const moved = await patch("ready-2", {
      status: "ready",
      outcome: null,
      closedAt: null,
    });
    expect(moved.body.data.readyAt).toEqual(expect.any(String));

    const reverted = await patch("ready-2", {
      status: "backlog",
      outcome: null,
      closedAt: null,
      readyAt: null,
      appliedAt: null,
    });

    expect(reverted.status).toBe(200);
    expect(reverted.body.data.readyAt).toBeNull();
    expect(reverted.body.data.status).toBe("backlog");
  });

  it("keeps the FIRST ready date when a row returns to Tailoring", async () => {
    await seedJob("ready-3", "backlog");
    const first = await patch("ready-3", { status: "ready" });
    const firstStamp = first.body.data.readyAt;
    expect(firstStamp).toEqual(expect.any(String));

    // Guarantee a distinct `new Date().toISOString()` on the second write.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await patch("ready-3", { status: "applied" });
    const second = await patch("ready-3", { status: "ready" });

    expect(second.body.data.readyAt).toBe(firstStamp);
  });
});
