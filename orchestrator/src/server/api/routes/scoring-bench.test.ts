import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Scoring bench API routes", () => {
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

  async function startRun(body: unknown) {
    return fetch(`${baseUrl}/api/scoring-bench/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a request with no configurations", async () => {
    const response = await startRun({ sampleSize: 5, configs: [] });
    expect(response.status).toBe(400);
  });

  it("rejects a non-positive sample size", async () => {
    const response = await startRun({
      sampleSize: 0,
      configs: [{ model: "m" }],
    });
    expect(response.status).toBe(400);
  });

  it("accepts a large sample size — the size is the user's call, not ours", async () => {
    const response = await startRun({
      sampleSize: 5000,
      configs: [{ model: "m" }],
    });
    expect(response.status).toBe(200);
  });

  it("returns the claimed run, labelling configurations the client left blank", async () => {
    // The single-run conflict itself is pinned deterministically against the
    // store (services/scoring-bench/run.test.ts): over HTTP the run finishes
    // before a second request can land, because the test database has no
    // scoreable jobs to classify.
    const response = await startRun({
      sampleSize: 1,
      configs: [{ model: "m" }, { label: "Cheap", model: "n" }],
    });
    const body = (await response.json()) as {
      data: {
        run: { id: string; configs: Array<{ label: string; model: string }> };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.run.id).toBeTruthy();
    expect(body.data.run.configs.map((config) => config.label)).toEqual([
      "Config 1",
      "Cheap",
    ]);
  });

  it("records the categories a run was drawn from, deduped", async () => {
    // A payload repeating one category must not count its way to the full
    // length and be read as "all of them".
    const response = await startRun({
      sampleSize: 1,
      categories: ["good_fit", "good_fit", "good_fit", "good_fit", "good_fit"],
      configs: [{ model: "m" }],
    });
    const body = (await response.json()) as {
      data: { run: { sampleCategories: string[] } };
    };

    expect(response.status).toBe(200);
    expect(body.data.run.sampleCategories).toEqual(["good_fit"]);
  });

  it("defaults to every category when the client sends none", async () => {
    const response = await startRun({
      sampleSize: 1,
      configs: [{ model: "m" }],
    });
    const body = (await response.json()) as {
      data: { run: { sampleCategories: string[] } };
    };

    expect(body.data.run.sampleCategories).toEqual([
      "great_fit",
      "very_good_fit",
      "good_fit",
      "bad_fit",
      "unscored",
    ]);
  });

  it("rejects an empty category selection rather than reading it as everything", async () => {
    const response = await startRun({
      sampleSize: 1,
      categories: [],
      configs: [{ model: "m" }],
    });

    expect(response.status).toBe(400);
  });

  it("rejects a negative price", async () => {
    const response = await startRun({
      sampleSize: 1,
      configs: [{ model: "m", inputCostPerMillion: -1 }],
    });

    expect(response.status).toBe(400);
  });

  it("reports nothing to cancel when idle", async () => {
    const response = await fetch(`${baseUrl}/api/scoring-bench/cancel`, {
      method: "POST",
    });
    const body = (await response.json()) as { data: { cancelled: boolean } };
    expect(response.status).toBe(200);
    expect(body.data.cancelled).toBe(false);
  });
});
