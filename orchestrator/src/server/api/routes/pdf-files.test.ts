import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

const PDF_BYTES = Buffer.from("%PDF-1.7 fake body", "utf8");
const DOCX_BYTES = Buffer.from("PK fake docx body", "latin1");

describe.sequential("GET /pdfs/:filename", () => {
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

  it("serves a stored resume PDF with inline headers", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({ jobId: "job-1", kind: "resume", data: PDF_BYTES });

    const res = await fetch(`${baseUrl}/pdfs/resume_job-1.pdf?v=cachebust`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // Disposition TYPE only. A `filename` parameter here would take
    // precedence over the download surfaces' `download` attribute and save
    // every CV as `resume_<jobId>.pdf` — B47, which this assertion previously
    // pinned in place.
    expect(res.headers.get("content-disposition")).toBe("inline");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(PDF_BYTES);
  });

  it("serves a stored cover-letter PDF", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({
      jobId: "job-2",
      kind: "cover_letter",
      data: PDF_BYTES,
    });

    const res = await fetch(`${baseUrl}/pdfs/cover_letter_job-2.pdf`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  // B47: the value is irrelevant — ANY filename the server pins wins over the
  // client's `download` attribute, so the guard is that the parameter is
  // absent, not that it holds some particular name.
  it("pins no filename on either format, so the download attribute wins", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({ jobId: "job-b47", kind: "resume", data: PDF_BYTES });
    await upsertJobPdf({
      jobId: "job-b47",
      kind: "resume_docx",
      data: DOCX_BYTES,
    });

    for (const name of ["resume_job-b47.pdf", "resume_job-b47.docx"]) {
      const res = await fetch(`${baseUrl}/pdfs/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).not.toMatch(/filename/i);
    }
  });

  it("404s when no blob row exists", async () => {
    const res = await fetch(`${baseUrl}/pdfs/resume_missing-job.pdf`);
    expect(res.status).toBe(404);
  });

  it("404s on a malformed filename", async () => {
    const res = await fetch(`${baseUrl}/pdfs/evil..%2Fjobs.db`);
    expect(res.status).toBe(404);
  });

  it("serves a tailored .docx as an attachment with the Word MIME", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({
      jobId: "job-4",
      kind: "resume_docx",
      data: DOCX_BYTES,
    });

    const res = await fetch(`${baseUrl}/pdfs/resume_job-4.docx?v=cachebust`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // The type is the explicit signal; the filename parameter is the part that
    // overrode the client — see the resume-PDF case above.
    expect(res.headers.get("content-disposition")).toBe("attachment");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(DOCX_BYTES);
  });

  it("404s a cover-letter .docx (cover letters are LaTeX-only)", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({
      jobId: "job-5",
      kind: "resume_docx",
      data: DOCX_BYTES,
    });

    const res = await fetch(`${baseUrl}/pdfs/cover_letter_job-5.docx`);
    expect(res.status).toBe(404);
  });

  it("404s a .docx request when only the PDF exists", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({ jobId: "job-6", kind: "resume", data: PDF_BYTES });

    const res = await fetch(`${baseUrl}/pdfs/resume_job-6.docx`);
    expect(res.status).toBe(404);
  });

  it("upsert replaces the stored bytes for the same job and kind", async () => {
    const { upsertJobPdf } = await import("@server/repositories/job-pdfs");
    await upsertJobPdf({ jobId: "job-3", kind: "resume", data: PDF_BYTES });
    const updated = Buffer.from("%PDF-1.7 updated body", "utf8");
    await upsertJobPdf({ jobId: "job-3", kind: "resume", data: updated });

    const res = await fetch(`${baseUrl}/pdfs/resume_job-3.pdf`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(updated);
  });
});
