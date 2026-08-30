// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

/**
 * `POST /api/jobs/:id/apply` is every "Mark applied" surface — the Ready
 * panel's button, the detail panel's button, and the `a` keyboard shortcut all
 * reach it through `useMarkAsAppliedMutation`.
 *
 * It used to send an explicit `appliedAt`, which takes `updateJob`'s
 * pass-through branch instead of the `coalesce(applied_at, now)` one — so it
 * OVERWROTE the mark rather than stamping it once. `applied_at` is the
 * permanent record that a job was applied to (it is what separates a real
 * rejection from a job never applied to), and it doubles as the column the
 * Applied date filter reads, so a silent re-date moved the row under that
 * filter too.
 */
describe.sequential("POST /api/jobs/:id/apply — the permanent apply mark", () => {
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
      status: status as "ready",
    });
  }

  async function apply(id: string) {
    const res = await fetch(`${baseUrl}/api/jobs/${id}/apply`, {
      method: "POST",
    });
    return { status: res.status, body: await res.json() };
  }

  async function patchStatus(id: string, status: string) {
    const res = await fetch(`${baseUrl}/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return res.status;
  }

  it("stamps applied_at on the first apply", async () => {
    await seedJob("apply-1", "ready");

    const { status, body } = await apply("apply-1");

    expect(status).toBe(200);
    expect(body.data.status).toBe("applied");
    expect(body.data.appliedAt).toEqual(expect.any(String));
  });

  /**
   * The regression this file exists for. Apply, stage-switch back to Tailoring
   * (which `JobStageSwitcher` allows in both directions), apply again — the
   * ORIGINAL apply date must survive. Mutation check: restoring the route's
   * explicit `appliedAt` makes this fail.
   */
  it("keeps the original date when a job is applied to a second time", async () => {
    await seedJob("apply-2", "ready");
    const first = await apply("apply-2");
    const firstStamp = first.body.data.appliedAt;
    expect(firstStamp).toEqual(expect.any(String));

    // Guarantee a distinct `new Date().toISOString()` on the second write.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await patchStatus("apply-2", "ready")).toBe(200);
    const second = await apply("apply-2");

    expect(second.body.data.appliedAt).toBe(firstStamp);
  });

  it("keeps the mark when the job is later closed out", async () => {
    await seedJob("apply-3", "ready");
    const applied = await apply("apply-3");
    const stamp = applied.body.data.appliedAt;

    const res = await fetch(`${baseUrl}/api/jobs/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "mark_closed",
        jobIds: ["apply-3"],
        options: { outcome: "rejected" },
      }),
    });
    const body = await res.json();

    expect(body.data.results[0].job.status).toBe("closed");
    expect(body.data.results[0].job.appliedAt).toBe(stamp);
  });

  /**
   * Undo. The mark is sticky and nothing else in the app can clear it, so
   * without `appliedAt` in the undo payload a mis-pressed "Mark applied"
   * (`a` on the wrong row) left a permanent Applied badge on a job that was
   * never applied to, and the ever-applied filter kept it for ever. Undo means
   * "this action did not happen"; the mark stays permanent against everything
   * else, which the other tests here pin.
   */
  it("lets undo clear a mark it had just created", async () => {
    await seedJob("apply-undo", "ready");
    const applied = await apply("apply-undo");
    expect(applied.body.data.appliedAt).toEqual(expect.any(String));

    // Exactly what `restoreJobStates` sends from the pre-action snapshot.
    const res = await fetch(`${baseUrl}/api/jobs/apply-undo`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "ready",
        outcome: null,
        closedAt: null,
        appliedAt: null,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("ready");
    expect(body.data.appliedAt).toBeNull();
  });

  it("restores the original date when undo carries one", async () => {
    await seedJob("apply-undo-2", "ready");
    const applied = await apply("apply-undo-2");
    const stamp = applied.body.data.appliedAt;

    // Undoing a later move to Interviewing restores the snapshot's stamp.
    await patchStatus("apply-undo-2", "in_progress");
    const res = await fetch(`${baseUrl}/api/jobs/apply-undo-2`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "applied", appliedAt: stamp }),
    });
    const body = await res.json();

    expect(body.data.appliedAt).toBe(stamp);
  });

  it("404s an unknown job", async () => {
    const { status } = await apply("does-not-exist");

    expect(status).toBe(404);
  });
});
