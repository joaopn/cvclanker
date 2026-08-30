// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `applied_at` is the permanent "this was applied to" mark. `updateJob` used to
 * stamp it only on the move to `applied`, but the stage switcher offers
 * `ready -> in_progress` directly — so every job that took that route closed
 * out looking like it was never applied to. This backfill stamps the rows that
 * already went through that hole, and must leave every never-applied row alone.
 */
describe.sequential("applied_at backfill", () => {
  let tempDir: string;
  async function boot() {
    vi.resetModules();
    await import("./migrate");
    await import("./index");
  }

  /** Raw handle — the backfill's inputs include columns Drizzle's insert shapes. */
  async function raw(): Promise<import("better-sqlite3").Database> {
    const { default: Database } = await import("better-sqlite3");
    return new Database(join(tempDir, "jobs.db"));
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-applied-backfill-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await boot();
  });

  afterEach(async () => {
    const { closeDb } = await import("./index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  interface SeedRow {
    id: string;
    status: string;
    outcome?: string | null;
    readyAt?: string | null;
    closedAt?: number | null;
    updatedAt?: string;
    discoveredAt?: string;
    appliedAt?: string | null;
  }

  /**
   * Insert straight through SQL: the point of these tests is what the migration
   * makes of raw column values, including the space-separated `datetime('now')`
   * form that no repo writer produces.
   */
  async function seed(rows: SeedRow[]): Promise<void> {
    const handle = await raw();
    const stmt = handle.prepare(
      `INSERT INTO jobs (id, source, title, employer, job_url, status, outcome,
         ready_at, closed_at, applied_at, discovered_at, created_at, updated_at)
       VALUES (?, 'linkedin', 'T', 'E', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      stmt.run(
        row.id,
        `https://ex/${row.id}`,
        row.status,
        row.outcome ?? null,
        row.readyAt ?? null,
        row.closedAt ?? null,
        row.appliedAt ?? null,
        row.discoveredAt ?? "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        row.updatedAt ?? "2026-01-02T00:00:00.000Z",
      );
    }
    handle.close();
  }

  async function appliedAtOf(id: string): Promise<string | null> {
    const handle = await raw();
    const row = handle
      .prepare("SELECT applied_at FROM jobs WHERE id = ?")
      .get(id) as { applied_at: string | null } | undefined;
    handle.close();
    return row?.applied_at ?? null;
  }

  it("stamps a row that reached Interviewing without ever being applied", async () => {
    await seed([
      {
        id: "interviewing",
        status: "in_progress",
        readyAt: "2026-05-01T09:00:00.000Z",
      },
    ]);

    await boot();

    expect(await appliedAtOf("interviewing")).toBe("2026-05-01T09:00:00.000Z");
  });

  it("stamps a bare applied row that was never stamped", async () => {
    await seed([
      {
        id: "bare-applied",
        status: "applied",
        readyAt: "2026-05-01T09:00:00.000Z",
      },
    ]);

    await boot();

    expect(await appliedAtOf("bare-applied")).toBe("2026-05-01T09:00:00.000Z");
  });

  it("stamps a closed row whose outcome proves it was applied to", async () => {
    await seed([
      {
        id: "rejected",
        status: "closed",
        outcome: "rejected",
        readyAt: "2026-05-02T09:00:00.000Z",
        closedAt: 1786711161,
      },
    ]);

    await boot();

    expect(await appliedAtOf("rejected")).toBe("2026-05-02T09:00:00.000Z");
  });

  it.each([
    "withdrawn",
    "ghosted",
  ])("stamps a closed row with the %s outcome", async (outcome) => {
    await seed([
      {
        id: `closed-${outcome}`,
        status: "closed",
        outcome,
        closedAt: 1786711161,
      },
    ]);

    await boot();

    expect(await appliedAtOf(`closed-${outcome}`)).not.toBeNull();
  });

  /**
   * The ambiguity guard. The every-boot rebuild folds the legacy `expired`
   * status — an auto-expiry marker for stale postings, never applied to — into
   * `closed` + 'other', alongside the genuinely post-apply 'offer_accepted' /
   * 'offer_declined'. Treating 'other' as evidence would stamp every legacy
   * expired row and inflate the rejection statistics the mark exists for.
   */
  it("leaves a closed row with the ambiguous 'other' outcome unmarked", async () => {
    await seed([
      {
        id: "other-outcome",
        status: "closed",
        outcome: "other",
        readyAt: "2026-05-02T09:00:00.000Z",
        closedAt: 1786711161,
      },
    ]);

    await boot();

    expect(await appliedAtOf("other-outcome")).toBeNull();
  });

  /**
   * The exclusions — each one a row the user never applied to. Stamping any of
   * them would inflate the rejection count the mark exists to make countable.
   */
  it("leaves a duplicate-closed row unmarked", async () => {
    await seed([
      {
        id: "dupe",
        status: "closed",
        outcome: "duplicated",
        closedAt: 1786711161,
      },
    ]);

    await boot();

    expect(await appliedAtOf("dupe")).toBeNull();
  });

  it("leaves a closed row with no outcome unmarked", async () => {
    await seed([{ id: "no-outcome", status: "closed", closedAt: 1786711161 }]);

    await boot();

    expect(await appliedAtOf("no-outcome")).toBeNull();
  });

  it.each([
    "skipped",
    "discovered",
    "ready",
    "backlog",
    "stale",
    "processing",
  ])("leaves a %s row unmarked", async (status) => {
    await seed([
      { id: `shelf-${status}`, status, readyAt: "2026-05-01T09:00:00.000Z" },
    ]);

    await boot();

    expect(await appliedAtOf(`shelf-${status}`)).toBeNull();
  });

  it("never overwrites a stamp the app already wrote", async () => {
    await seed([
      {
        id: "already",
        status: "in_progress",
        appliedAt: "2026-03-03T03:03:03.000Z",
        readyAt: "2026-05-01T09:00:00.000Z",
      },
    ]);

    await boot();

    expect(await appliedAtOf("already")).toBe("2026-03-03T03:03:03.000Z");
  });

  /**
   * Format normalisation. `applied_at` is read by the client's Applied date
   * filter, which resolves a space-separated datetime in the HOST zone — so a
   * verbatim copy of `updated_at` would shift the row by the host offset, and
   * `closed_at` is unix SECONDS, a third format again.
   */
  it("converts an integer closed_at (unix seconds) to ISO", async () => {
    await seed([
      {
        id: "from-closed",
        status: "closed",
        outcome: "rejected",
        closedAt: 1786711161,
      },
    ]);

    await boot();

    expect(await appliedAtOf("from-closed")).toBe(
      new Date(1786711161 * 1000).toISOString(),
    );
  });

  /**
   * `datetime('now')` — the DEFAULT on `discovered_at`/`updated_at`, and what
   * `sweepStaleJobs`/`sweepLiveClosedJobs` write — is UTC but carries no zone
   * marker, so `Date.parse` resolves it in the HOST zone. The backfill appends
   * the Z explicitly.
   *
   * The TZ override is load-bearing: the container runs at UTC, where a bare
   * parse and a Z-suffixed parse give the identical instant, so without it this
   * test passes with the normalisation deleted and guards nothing. Verified by
   * mutation — with the TZ set, removing the branch shifts the result by the
   * zone offset and this fails.
   */
  it("converts a space-separated updated_at to ISO, reading it as UTC", async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      await seed([
        {
          id: "from-updated",
          status: "in_progress",
          updatedAt: "2026-05-04 11:22:33",
        },
      ]);

      await boot();

      expect(await appliedAtOf("from-updated")).toBe(
        "2026-05-04T11:22:33.000Z",
      );
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it("passes an already-ISO updated_at through unchanged", async () => {
    await seed([
      {
        id: "iso-updated",
        status: "in_progress",
        readyAt: null,
        closedAt: null,
        updatedAt: "2026-08-14T12:39:21.720Z",
      },
    ]);

    await boot();

    expect(await appliedAtOf("iso-updated")).toBe("2026-08-14T12:39:21.720Z");
  });

  it("falls back through ready_at then closed_at then updated_at", async () => {
    await seed([
      {
        id: "no-ready",
        status: "closed",
        outcome: "ghosted",
        readyAt: null,
        closedAt: 1786711161,
        updatedAt: "2026-08-14T12:39:21.720Z",
      },
    ]);

    await boot();

    // closed_at wins over updated_at when ready_at is absent.
    expect(await appliedAtOf("no-ready")).toBe(
      new Date(1786711161 * 1000).toISOString(),
    );
  });

  it("falls all the way through to discovered_at", async () => {
    await seed([
      {
        id: "only-discovered",
        status: "in_progress",
        readyAt: null,
        closedAt: null,
        updatedAt: "not-a-date",
        discoveredAt: "2026-02-02T02:02:02.000Z",
      },
    ]);

    await boot();

    expect(await appliedAtOf("only-discovered")).toBe(
      "2026-02-02T02:02:02.000Z",
    );
  });

  /**
   * No usable timestamp anywhere. Leaving it NULL under-reports one job;
   * writing a fabricated date would corrupt the column the Applied date filter
   * reads for everyone.
   */
  it("leaves a row with no usable timestamp unmarked rather than inventing one", async () => {
    await seed([
      {
        id: "no-timestamps",
        status: "in_progress",
        readyAt: null,
        closedAt: null,
        updatedAt: "not-a-date",
        discoveredAt: "also-not-a-date",
      },
    ]);

    await boot();

    expect(await appliedAtOf("no-timestamps")).toBeNull();
  });

  /**
   * `closed_at` is unix SECONDS by every current writer, but the outcome PATCH
   * takes an unvalidated client int and the stripped timeline stack wrote a
   * user-chosen instant — so a legacy row holding MILLISECONDS is plausible.
   * `new Date(1.79e12 * 1000)` is a valid Date in year ~56,700, and writing it
   * would put a row at the top of every applied-date sort for ever and pass any
   * open-ended range filter. Out-of-range candidates fall through instead.
   */
  it("rejects an out-of-range closed_at instead of stamping year 56,700", async () => {
    await seed([
      {
        id: "ms-valued",
        status: "closed",
        outcome: "rejected",
        readyAt: null,
        closedAt: 1786711161000, // milliseconds in a seconds column
        updatedAt: "2026-08-14T12:39:21.720Z",
      },
    ]);

    await boot();

    // Falls through to updated_at rather than writing the absurd date.
    expect(await appliedAtOf("ms-valued")).toBe("2026-08-14T12:39:21.720Z");
  });

  /**
   * Idempotency, made observable. Re-running the backfill over an already
   * stamped row re-derives the IDENTICAL value from the same `ready_at`, so an
   * unguarded second pass is invisible — the earlier version of this test
   * passed with the null-guard deleted. Moving `ready_at` between boots makes a
   * re-stamp show up as a different value.
   */
  it("is a no-op on a second boot even when its source timestamp has moved", async () => {
    await seed([
      {
        id: "stable",
        status: "in_progress",
        readyAt: "2026-05-01T09:00:00.000Z",
      },
    ]);

    await boot();
    const first = await appliedAtOf("stable");
    expect(first).toBe("2026-05-01T09:00:00.000Z");

    const handle = await raw();
    handle
      .prepare("UPDATE jobs SET ready_at = ? WHERE id = ?")
      .run("2026-07-07T07:07:07.000Z", "stable");
    handle.close();

    await boot();

    expect(await appliedAtOf("stable")).toBe(first);
  });

  it("stamps only applied_at, leaving the rest of the row alone", async () => {
    await seed([
      {
        id: "untouched",
        status: "closed",
        outcome: "rejected",
        readyAt: "2026-05-02T09:00:00.000Z",
        closedAt: 1786711161,
      },
    ]);

    await boot();

    const handle = await raw();
    const row = handle
      .prepare(
        "SELECT status, outcome, ready_at, closed_at FROM jobs WHERE id = ?",
      )
      .get("untouched") as {
      status: string;
      outcome: string;
      ready_at: string;
      closed_at: number;
    };
    handle.close();

    expect(row.status).toBe("closed");
    expect(row.outcome).toBe("rejected");
    expect(row.ready_at).toBe("2026-05-02T09:00:00.000Z");
    expect(row.closed_at).toBe(1786711161);
  });
});
