/**
 * Repository for job_pdfs — generated job PDFs (tailored resume + cover
 * letter) stored as BLOBs. jobs.pdf_path / cover_letter_pdf_path keep only
 * the canonical relative filename as an existence flag; the bytes live here.
 *
 * No FK cascade exists at runtime (PRAGMA foreign_keys is never enabled), so
 * every jobs-delete path must clean up explicitly via deleteOrphanedJobPdfs.
 */

import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index";

const { jobPdfs, jobs } = schema;

export type JobPdfKind =
  | "resume"
  | "cover_letter"
  | "resume_docx"
  | "resume_html";

export async function upsertJobPdf(input: {
  jobId: string;
  kind: JobPdfKind;
  data: Buffer;
}): Promise<void> {
  await db
    .insert(jobPdfs)
    .values({
      jobId: input.jobId,
      kind: input.kind,
      data: input.data,
    })
    .onConflictDoUpdate({
      target: [jobPdfs.jobId, jobPdfs.kind],
      set: {
        data: input.data,
        updatedAt: sql`(datetime('now'))`,
      },
    });
}

export async function getJobPdf(
  jobId: string,
  kind: JobPdfKind,
): Promise<Buffer | null> {
  const [row] = await db
    .select({ data: jobPdfs.data })
    .from(jobPdfs)
    .where(and(eq(jobPdfs.jobId, jobId), eq(jobPdfs.kind, kind)));
  return row?.data ?? null;
}

/**
 * The first four bytes of a stored document (enough to tell a zip). Only
 * those reach JS; SQLite still reads the value to take them.
 */
export async function getJobPdfHead(
  jobId: string,
  kind: JobPdfKind,
): Promise<Buffer | null> {
  const [row] = await db
    .select({ head: sql<Buffer>`substr(${jobPdfs.data}, 1, 4)` })
    .from(jobPdfs)
    .where(and(eq(jobPdfs.jobId, jobId), eq(jobPdfs.kind, kind)));
  return row?.head ?? null;
}

/**
 * Remove blob rows whose job no longer exists. Called after bulk job deletes
 * (and safe to call any time — also self-heals historical orphans).
 */
export async function deleteOrphanedJobPdfs(): Promise<number> {
  const result = await db
    .delete(jobPdfs)
    .where(notInArray(jobPdfs.jobId, db.select({ id: jobs.id }).from(jobs)))
    .run();
  return result.changes;
}
