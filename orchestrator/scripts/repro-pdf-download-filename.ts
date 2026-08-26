/**
 * Reproduction (B47): every generated-document download saves as
 * `resume_<jobId>.pdf` instead of the `Person_Employer.pdf` the UI asks for.
 *
 * `pdfFilesRouter` sends `Content-Disposition: <type>; filename="<the URL's
 * own basename>"`. A filename parameter there takes precedence over an
 * anchor's `download` attribute, so all six client download surfaces — each of
 * which computes `${person}_${employer}` via safeFilenamePart — are silently
 * overridden. The `express.static` mount this route replaced in `700eae7` sent
 * no Content-Disposition at all, which is why the names used to come through.
 *
 * The fix keeps the disposition TYPE (load-bearing: `attachment` stops a
 * browser rendering a .docx, `inline` lets the PDF preview in its iframe) and
 * drops only the filename parameter.
 *
 * Exits non-zero while the bug exists.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "cvclanker-repro-pdfname-"));
process.env.DATA_DIR = tempDir;
process.env.NODE_ENV = "test";

await import("../src/server/db/migrate");
const { upsertJobPdf } = await import("../src/server/repositories/job-pdfs");
const { pdfFilesRouter } = await import("../src/server/api/routes/pdf-files");
const express = (await import("express")).default;

const JOB_ID = "8991016d-3b13-4a02-bd56-6cd6458b50f6";

await upsertJobPdf({
  jobId: JOB_ID,
  kind: "resume",
  data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
});
await upsertJobPdf({
  jobId: JOB_ID,
  kind: "resume_docx",
  data: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
});

const app = express();
app.use("/pdfs", pdfFilesRouter);
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

async function dispositionFor(filename: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/pdfs/${filename}`);
  const disposition = res.headers.get("content-disposition") ?? "";
  // Drain the body before returning: an unread ReadableStream keeps the
  // socket bound, and this script's whole job is to exit deterministically.
  const body = await res.arrayBuffer();
  if (!res.ok) throw new Error(`${filename} -> HTTP ${res.status}`);
  if (body.byteLength === 0) throw new Error(`${filename} -> empty body`);
  return disposition;
}

let pdf = "";
let docx = "";
try {
  pdf = await dispositionFor(`resume_${JOB_ID}.pdf`);
  docx = await dispositionFor(`resume_${JOB_ID}.docx`);
} finally {
  // In a finally so a genuine failure above still closes the socket and the
  // DB handle and removes the tempdir, instead of leaking one per run.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import("../src/server/db/index");
  closeDb();
  await rm(tempDir, { recursive: true, force: true });
}

const failures: string[] = [];

// The defect: a filename parameter at all. Its VALUE is irrelevant — any
// filename the server pins wins over the client's `download` attribute.
if (/filename\s*=/i.test(pdf)) {
  failures.push(
    `PDF pins a filename the client cannot override: ${JSON.stringify(pdf)}`,
  );
}
if (/filename\s*=/i.test(docx)) {
  failures.push(
    `DOCX pins a filename the client cannot override: ${JSON.stringify(docx)}`,
  );
}

// The disposition TYPE must survive the fix, or the .docx renders as garbage
// in a tab and the PDF preview iframe starts downloading instead of showing.
if (!/^\s*inline\b/i.test(pdf)) {
  failures.push(`PDF lost its inline disposition: ${JSON.stringify(pdf)}`);
}
if (!/^\s*attachment\b/i.test(docx)) {
  failures.push(
    `DOCX lost its attachment disposition: ${JSON.stringify(docx)}`,
  );
}

if (failures.length > 0) {
  for (const line of failures) console.error(`FAIL: ${line}`);
  process.exit(1);
}

console.log(
  `PASS: dispositions carry no filename, so the download attribute wins (pdf=${JSON.stringify(pdf)}, docx=${JSON.stringify(docx)}).`,
);
