// @vitest-environment node
import type { Server } from "node:http";
import type { CvField } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

const SAMPLE_FIELDS: CvField[] = [
  { id: "basics.name", role: "name", value: "Ada Lovelace" },
];

const SAMPLE_BRIEF = "I'm Ada — I write algorithms.";

const SAMPLE_TEX =
  "\\documentclass{article}\n\\begin{document}\nAda Lovelace\n\\end{document}\n";

describe.sequential("CV API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  async function seedCv(): Promise<string> {
    const { createCvDocument } = await import(
      "@server/repositories/cv-documents"
    );
    const created = await createCvDocument({
      name: "ada",
      originalArchive: new TextEncoder().encode(SAMPLE_TEX),
      flattenedTex: SAMPLE_TEX,
      fields: SAMPLE_FIELDS,
      personalBrief: SAMPLE_BRIEF,
    });
    return created.id;
  }

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  // The ungated legacy upload and re-extract routes are gone (B86): a CV
  // only ever enters through the gated upload-template pipeline.
  it("has no ungated legacy upload route", async () => {
    const form = new FormData();
    form.append("file", new Blob([SAMPLE_TEX]), "ada.tex");
    const res = await fetch(`${baseUrl}/api/cv`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(404);
  });

  it("has no ungated legacy re-extract route", async () => {
    const id = await seedCv();
    const res = await fetch(`${baseUrl}/api/cv/${id}/re-extract`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("round-trips name and personal-brief edits via PATCH", async () => {
    const id = await seedCv();

    const updated = await fetch(`${baseUrl}/api/cv/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed CV",
        personalBrief: "I now have postgres experience.",
      }),
    });
    expect(updated.status).toBe(200);
    const payload = (await updated.json()) as {
      data: {
        name: string;
        personalBrief: string;
        fields: CvField[];
      };
    };
    expect(payload.data.name).toBe("Renamed CV");
    expect(payload.data.personalBrief).toBe("I now have postgres experience.");
    expect(payload.data.fields).toEqual(SAMPLE_FIELDS);

    const removed = await fetch(`${baseUrl}/api/cv/${id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const missing = await fetch(`${baseUrl}/api/cv/${id}`);
    expect(missing.status).toBe(404);
  });

  it("rejects PATCH with 422 when personalBrief exceeds maxBriefChars", async () => {
    const id = await seedCv();

    // Default maxBriefChars is 200_000; send 200_001 to exceed it.
    const oversized = "x".repeat(200_001);
    const res = await fetch(`${baseUrl}/api/cv/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personalBrief: oversized }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details: { field: string; observed: number; max: number };
      };
    };
    expect(payload.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(payload.error.details.field).toBe("personalBrief");
    expect(payload.error.details.observed).toBe(200_001);
    expect(payload.error.details.max).toBe(200_000);
  });

  it("rejects PATCH with 422 when extractionPrompt exceeds maxExtractionPromptChars", async () => {
    const id = await seedCv();

    const oversized = "x".repeat(100_001);
    const res = await fetch(`${baseUrl}/api/cv/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extractionPrompt: oversized }),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: {
        code: string;
        details: { field: string; observed: number; max: number };
      };
    };
    expect(payload.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(payload.error.details.field).toBe("extractionPrompt");
    expect(payload.error.details.max).toBe(100_000);
  });

  it("accepts PATCH with personalBrief at the maxBriefChars boundary", async () => {
    const id = await seedCv();

    // Length of EXACTLY 200_000 should pass.
    const atCap = "x".repeat(200_000);
    const res = await fetch(`${baseUrl}/api/cv/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personalBrief: atCap }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { personalBrief: string };
    };
    expect(payload.data.personalBrief.length).toBe(200_000);
  });
});
