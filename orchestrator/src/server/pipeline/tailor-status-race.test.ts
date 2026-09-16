// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generatePdfMock = vi.fn();
vi.mock("../services/pdf", () => ({
  generatePdf: (...args: unknown[]) => generatePdfMock(...args),
}));

/**
 * `generateFinalPdf` captures the row's status at entry and used to write
 * `ready` back unconditionally at the end of the initial tailoring funnel —
 * sound only while nothing could change the status mid-tailor.
 *
 * The stage switcher can: moving a clean `processing` row is how a user frees a
 * tailor that never reported back, and if that tailor is in fact alive it
 * finishes seconds later. Promoting the row then would undo the user's move
 * from under them (and hand the undo entry a state that no longer matches).
 * The PDF is still saved either way — the work is not thrown away, only the
 * promotion is withheld.
 */
describe.sequential("generateFinalPdf respects a status moved mid-tailor", () => {
  let tempDir: string;
  let jobsRepo: Awaited<typeof import("../repositories/jobs")>;
  const CV_DOC_ID = "cv-doc-1";

  beforeEach(async () => {
    vi.resetModules();
    generatePdfMock.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-tailor-race-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    jobsRepo = await import("../repositories/jobs");
    // `cv_document_id` is a real FK; the render is mocked but the pin is not.
    const { db, schema } = await import("../db/index");
    await db.insert(schema.cvDocuments).values({
      id: CV_DOC_ID,
      name: "cv",
      originalArchive: Buffer.from(""),
      flattenedTex: "",
      createdAt: 0,
      updatedAt: 0,
    });
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const seed = async (url: string, status: "processing" | "discovered") => {
    await jobsRepo.createJobs([
      { source: "linkedin", title: "T", employer: "E", jobUrl: url },
    ]);
    const job = await jobsRepo.getJobByUrl(url);
    if (!job) throw new Error("seed failed");
    await jobsRepo.updateJob(job.id, {
      status,
      cvDocumentId: CV_DOC_ID,
    });
    return job.id;
  };

  it("keeps the user's move and still saves the PDF", async () => {
    const id = await seed("https://ex/moved", "processing");
    // The move lands while the render is in flight — which is exactly when a
    // user reaches for the switcher on a row that looks stuck.
    generatePdfMock.mockImplementation(async () => {
      await jobsRepo.updateJob(id, { status: "skipped" });
      return { success: true, pdfPath: "/pdfs/resume_moved.pdf" };
    });

    const { generateFinalPdf } = await import("./orchestrator");
    const result = await generateFinalPdf(id);

    expect(result.success).toBe(true);
    const after = await jobsRepo.getJobById(id);
    expect(after?.status).toBe("skipped");
    expect(after?.pdfPath).toBe("/pdfs/resume_moved.pdf");
  });

  it("still promotes a row that stayed in the funnel", async () => {
    const id = await seed("https://ex/stayed", "processing");
    generatePdfMock.mockResolvedValue({
      success: true,
      pdfPath: "/pdfs/resume_stayed.pdf",
    });

    const { generateFinalPdf } = await import("./orchestrator");
    const result = await generateFinalPdf(id);

    expect(result.success).toBe(true);
    const after = await jobsRepo.getJobById(id);
    expect(after?.status).toBe("ready");
    expect(after?.pdfPath).toBe("/pdfs/resume_stayed.pdf");
  });

  it("leaves a re-tailor of an out-of-funnel row exactly where it was", async () => {
    const id = await seed("https://ex/retailor", "discovered");
    await jobsRepo.updateJob(id, { status: "applied" });
    generatePdfMock.mockResolvedValue({
      success: true,
      pdfPath: "/pdfs/resume_retailor.pdf",
    });

    const { generateFinalPdf } = await import("./orchestrator");
    await generateFinalPdf(id);

    const after = await jobsRepo.getJobById(id);
    expect(after?.status).toBe("applied");
    expect(after?.pdfPath).toBe("/pdfs/resume_retailor.pdf");
  });
});
