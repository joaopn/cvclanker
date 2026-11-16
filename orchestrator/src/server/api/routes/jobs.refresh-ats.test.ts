// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

// refresh-ats matches the job's keywords against the CV read as text: on an
// HTML profile `<b>Apache</b> <b>Kafka</b>` matches "Apache Kafka".
describe.sequential("POST /api/jobs/:id/refresh-ats — CV format", () => {
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
      title: "Data Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job-1",
      status: "ready",
      tailoringMatched: [],
      tailoringSkipped: ["Apache Kafka"],
      tailoredFields: { b1: "Built <b>Apache</b> <b>Kafka</b>" },
    });
    const cvRepo = await import("@server/repositories/cv-documents");
    await cvRepo.createCvDocument({
      name: "CV",
      originalArchive: new Uint8Array(),
      flattenedTex: "",
      fields: [{ id: "b1", role: "bullet", value: "Built things" }],
      personalBrief: "",
      templatedTex: "",
      defaultFieldValues: { b1: "Built things" },
    });
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function refresh(format: string) {
    const settingsRepo = await import("@server/repositories/settings");
    await settingsRepo.setSetting("cvSourceFormat", format);
    const res = await fetch(`${baseUrl}/api/jobs/job-1/refresh-ats`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { tailoringMatched: string[]; tailoringSkipped: string[] };
    };
    return data;
  }

  it("matches an HTML CV's text, not its markup", async () => {
    expect(await refresh("html")).toMatchObject({
      tailoringMatched: ["Apache Kafka"],
      tailoringSkipped: [],
    });
  });

  it("matches the raw value on other formats", async () => {
    expect(await refresh("latex")).toMatchObject({
      tailoringMatched: [],
      tailoringSkipped: ["Apache Kafka"],
    });
  });
});
