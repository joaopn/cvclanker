/**
 * Reproduction (B51): a job that was never generated renders a cover-letter
 * PDF containing the UPLOADED template's letter body.
 *
 * `renderCoverLetterPdf` merges `{...document.defaultFieldValues, ...job
 * .coverLetterFieldOverrides}`. `defaultFieldValues` is the uploaded document
 * verbatim — the upload gate re-renders the template with them and demands a
 * zero pdftotext diff, and the extract rejects empty field values — so a job
 * with no overrides renders the letter the user wrote for some other
 * application, as if it had been tailored for this one.
 *
 * The fix gives the single `role: "body"` field a per-job baseline of empty
 * (`coverLetterJobBaseline`), leaving every other field on its default.
 *
 * This drives the REAL service against a temp DB, with TECTONIC_BIN pointed
 * at a stub that captures the rendered .tex and emits a placeholder PDF, then
 * asserts the boilerplate is absent from what was compiled.
 *
 * Exits non-zero while the bug exists.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "cvclanker-repro-clbody-"));
const capturedTexPath = join(tempDir, "captured.tex");

// Both are read at module load by the modules below, so they must be set
// before the first import.
process.env.DATA_DIR = tempDir;
process.env.NODE_ENV = "test";

// Stub tectonic: the real binary is invoked with the entrypoint .tex as its
// final argument and is expected to leave <basename>.pdf beside it. Capture
// the tex we were asked to compile, then satisfy the contract.
const stubPath = join(tempDir, "tectonic-stub.sh");
await writeFile(
  stubPath,
  [
    "#!/bin/sh",
    "for last; do :; done",
    `cp "$last" "${capturedTexPath}"`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: /bin/sh parameter expansion, not a JS placeholder.
    'printf %s "%PDF-1.4 stub" > "${last%.tex}.pdf"',
    "exit 0",
  ].join("\n"),
  { mode: 0o755 },
);
process.env.TECTONIC_BIN = stubPath;

const TEMPLATE_BODY =
  "Dear Other Company, I have long admired your work in logistics.";
const JOB_ID = "3f1c2b90-91b1-4f1e-9a53-6b0a2f0f5d21";

await import("../src/server/db/migrate");
const coverLetterRepo = await import(
  "../src/server/repositories/cover-letter-documents"
);
const jobsRepo = await import("../src/server/repositories/jobs");
const { renderCoverLetterPdf } = await import(
  "../src/server/services/cover-letter/render"
);

const doc = await coverLetterRepo.createCoverLetterDocument({
  name: "letter.tex",
  originalArchive: Buffer.from("not-a-zip"),
  flattenedTex: "irrelevant",
  fields: [
    { id: "recipient", role: "name", value: "Hiring Team" },
    { id: "letter.body", role: "body", value: TEMPLATE_BODY },
  ],
  templatedTex:
    "\\documentclass{article}\\begin{document}«recipient»\n«letter.body»\\end{document}",
  defaultFieldValues: {
    recipient: "Hiring Team",
    "letter.body": TEMPLATE_BODY,
  },
  lastCompileStderr: null,
  compileAttempts: 0,
  extractionPrompt: "",
});

await jobsRepo.createJobs([
  {
    source: "linkedin",
    title: "Backend Engineer",
    employer: "Acme",
    jobUrl: `https://example.com/${JOB_ID}`,
    jobDescription: "",
  },
]);
const [job] = await jobsRepo.getJobListItems();
if (!job) {
  console.error("FAIL: could not seed a job");
  await rm(tempDir, { recursive: true, force: true });
  process.exit(1);
}
// The job carries NO cover-letter overrides: nothing was ever generated.
await jobsRepo.updateJob(job.id, { coverLetterDocumentId: doc.id });

const result = await renderCoverLetterPdf({ jobId: job.id });
if (!result.success) {
  console.error(`FAIL: render did not succeed: ${result.error}`);
  await rm(tempDir, { recursive: true, force: true });
  process.exit(1);
}

const compiled = await readFile(capturedTexPath, "utf8");
await rm(tempDir, { recursive: true, force: true });

const leakedBody = compiled.includes(TEMPLATE_BODY);
const keptOtherDefaults = compiled.includes("Hiring Team");

if (leakedBody) {
  console.error(
    "FAIL (bug present): the rendered cover letter carries the uploaded template's body:",
  );
  console.error(`  ${TEMPLATE_BODY}`);
  process.exit(1);
}
if (!keptOtherDefaults) {
  console.error(
    "FAIL: non-body defaults were dropped too — the baseline should blank ONLY the body field.",
  );
  process.exit(1);
}

console.log(
  "PASS: the body rendered empty for a never-generated job, and non-body defaults survived.",
);
