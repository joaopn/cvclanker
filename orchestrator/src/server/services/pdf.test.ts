// @vitest-environment node
import type { CvDocument, CvField } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SAMPLE_FIELDS: CvField[] = [
  { id: "basics.name", role: "name", value: "Ada Lovelace" },
];

const FAKE_CV: CvDocument = {
  id: "cv-1",
  name: "Ada CV",
  flattenedTex: "\\documentclass{article}\n\\name{Ada Lovelace}\n",
  fields: SAMPLE_FIELDS,
  personalBrief: "",
  templatedTex: "\\documentclass{article}\n\\name{«basics.name»}\n",
  defaultFieldValues: { "basics.name": "Ada Lovelace" },
  lastCompileStderr: null,
  compileAttempts: 0,
  extractionPrompt: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

vi.mock("@server/repositories/cv-documents", () => ({
  getCvDocumentById: vi.fn(),
  getCvDocumentArchive: vi.fn(),
}));

vi.mock("@server/repositories/job-pdfs", () => ({
  upsertJobPdf: vi.fn(),
}));

vi.mock("@server/services/cv/run-tectonic", async () => {
  const actual = await vi.importActual<
    typeof import("@server/services/cv/run-tectonic")
  >("@server/services/cv/run-tectonic");
  return {
    ...actual,
    runTectonic: vi.fn(),
  };
});

// generatePdf now reads the profile's CV format; the real settings service
// opens SQLite at module load.
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

// Keeps the real ConvertDocxError class for the instanceof branch.
vi.mock("@server/services/cv/docx/convert-docx-pdf", async () => {
  const actual = await vi.importActual<
    typeof import("@server/services/cv/docx/convert-docx-pdf")
  >("@server/services/cv/docx/convert-docx-pdf");
  return {
    ...actual,
    convertDocxToPdf: vi.fn(),
  };
});

import * as cvRepo from "@server/repositories/cv-documents";
import { upsertJobPdf } from "@server/repositories/job-pdfs";
import {
  ConvertDocxError,
  convertDocxToPdf,
} from "@server/services/cv/docx/convert-docx-pdf";
import { normalizeStoryPart } from "@server/services/cv/docx/normalize-runs";
import { parseDocx } from "@server/services/cv/docx/parse-docx";
import { spliceMarkers } from "@server/services/cv/docx/splice-markers";
import { simpleDoc } from "@server/services/cv/docx/test/fixture-builder";
import {
  RunTectonicError,
  runTectonic,
} from "@server/services/cv/run-tectonic";
import { getEffectiveSettings } from "@server/services/settings";
import {
  splitTailoringFailure,
  TAILORING_FAILURE_DETAIL_MAX_CHARS,
} from "@shared/tailoring-failure";
import { createAppSettings } from "@shared/testing/factories";
import { generatePdf } from "./pdf";

// A REAL template envelope over the fixture (parse → normalize → splice), so
// the docx cases exercise the real substituteParts / zipDocxParts.
const DOCX_ARCHIVE = simpleDoc();
const DOCX_FIELD_ID = "experience.0.bullet.0";
const DOCX_DEFAULT_VALUE =
  "Led migration of the rendering fleet to a queue-based architecture.";

function buildDocxCv(): CvDocument {
  const pkg = parseDocx(DOCX_ARCHIVE);
  for (const doc of pkg.storyParts.values()) normalizeStoryPart(doc);
  const parts = spliceMarkers(pkg.storyParts, pkg.storyPartOrder, [
    { id: DOCX_FIELD_ID, value: DOCX_DEFAULT_VALUE, segmentId: 2 },
  ]);
  return {
    ...FAKE_CV,
    id: "cv-docx",
    fields: [{ id: DOCX_FIELD_ID, role: "bullet", value: DOCX_DEFAULT_VALUE }],
    templatedTex: JSON.stringify({ parts: Object.fromEntries(parts) }),
    defaultFieldValues: { [DOCX_FIELD_ID]: DOCX_DEFAULT_VALUE },
  };
}

const DOCX_CV = buildDocxCv();

function useDocxProfile(): void {
  vi.mocked(getEffectiveSettings).mockResolvedValue(
    createAppSettings({ cvSourceFormat: "docx" }),
  );
  vi.mocked(cvRepo.getCvDocumentById).mockResolvedValue(DOCX_CV);
  vi.mocked(cvRepo.getCvDocumentArchive).mockResolvedValue(
    Buffer.from(DOCX_ARCHIVE),
  );
}

beforeEach(() => {
  vi.mocked(cvRepo.getCvDocumentById).mockResolvedValue(FAKE_CV);
  vi.mocked(cvRepo.getCvDocumentArchive).mockResolvedValue(
    Buffer.from("\\documentclass{article}\n", "utf8"),
  );
  vi.mocked(runTectonic).mockResolvedValue({
    pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    log: "",
  });
  vi.mocked(getEffectiveSettings).mockResolvedValue(createAppSettings());
  vi.mocked(convertDocxToPdf).mockResolvedValue(
    new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("generatePdf", () => {
  it("renders the templated CV with default field values when no overrides are supplied", async () => {
    const result = await generatePdf({
      jobId: "job-42",
      cvDocumentId: "cv-1",
    });

    expect(result.success).toBe(true);
    expect(result.pdfPath).toBe("resume_job-42.pdf");

    expect(upsertJobPdf).toHaveBeenCalledTimes(1);
    const upsertArgs = vi.mocked(upsertJobPdf).mock.calls[0][0];
    expect(upsertArgs.jobId).toBe("job-42");
    expect(upsertArgs.kind).toBe("resume");
    expect(upsertArgs.data.subarray(0, 4).toString("ascii")).toBe("%PDF");

    expect(runTectonic).toHaveBeenCalledWith(
      expect.objectContaining({
        renderedTex: "\\documentclass{article}\n\\name{Ada Lovelace}\n",
      }),
    );
  });

  it("substitutes overrides on top of defaults via the «marker» path", async () => {
    const result = await generatePdf({
      jobId: "job-43",
      cvDocumentId: "cv-1",
      overrides: { "basics.name": "Ada L. Byron" },
    });

    expect(result.success).toBe(true);
    expect(runTectonic).toHaveBeenCalledWith(
      expect.objectContaining({
        renderedTex: "\\documentclass{article}\n\\name{Ada L. Byron}\n",
      }),
    );
  });

  it("hard-fails when overrides are non-empty but the rendered tex equals the default-substituted baseline", async () => {
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce({
      ...FAKE_CV,
      // CV with a marker the override doesn't address — render falls back
      // to defaults and is identical to the default-only baseline.
      templatedTex: "\\documentclass{article}\n\\name{«basics.name»}\n",
      defaultFieldValues: { "basics.name": "Ada Lovelace" },
    });

    const result = await generatePdf({
      jobId: "job-44",
      cvDocumentId: "cv-1",
      overrides: { "ghost.field": "ignored" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no actual change to the CV/);
    expect(upsertJobPdf).not.toHaveBeenCalled();
  });

  it("names the written ids against the CV's own, with a true field count", async () => {
    // Field-id drift is the thing this failure exists to diagnose, so the two
    // id lists and the CV's real field count are the whole payload.
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce({
      ...FAKE_CV,
      templatedTex: "\\documentclass{article}\n\\name{«basics.name»}\n",
      defaultFieldValues: { "basics.name": "Ada Lovelace" },
      fields: [
        { id: "basics.name", role: "name", value: "Ada Lovelace" },
        { id: "basics.email", role: "email", value: "ada@example.com" },
      ],
    });

    const result = await generatePdf({
      jobId: "job-44c",
      cvDocumentId: "cv-1",
      overrides: { "ghost.field": "ignored" },
    });

    const { detail } = splitTailoringFailure(result.error);
    expect(detail).toContain("Field ids the tailoring wrote (1):");
    expect(detail).toContain("  ghost.field");
    // The real count, not the width of a slice.
    expect(detail).toContain("Field ids the active CV document has (2):");
    expect(detail).toContain("  basics.name");
    expect(detail).toContain("  basics.email");
  });

  it("marks the cut when the CV has more fields than the list shows", async () => {
    const fields: CvField[] = Array.from({ length: 30 }, (_, i) => ({
      id: `f.${i}`,
      role: "bullet" as const,
      value: `v${i}`,
    }));
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce({
      ...FAKE_CV,
      templatedTex: "\\documentclass{article}\n\\name{«basics.name»}\n",
      defaultFieldValues: { "basics.name": "Ada Lovelace" },
      fields,
    });

    const result = await generatePdf({
      jobId: "job-44d",
      cvDocumentId: "cv-1",
      overrides: { "ghost.field": "ignored" },
    });

    const { detail } = splitTailoringFailure(result.error);
    expect(detail).toContain("Field ids the active CV document has (30):");
    // A silently truncated list would read as the whole set.
    expect(detail).toContain("… (5 more)");
    expect(detail).not.toContain("  f.25");
  });

  it("renders successfully when overrides are no-op but allowBaselineRender is true", async () => {
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce({
      ...FAKE_CV,
      templatedTex: "\\documentclass{article}\n\\name{«basics.name»}\n",
      defaultFieldValues: { "basics.name": "Ada Lovelace" },
    });

    const result = await generatePdf({
      jobId: "job-44b",
      cvDocumentId: "cv-1",
      overrides: { "ghost.field": "ignored" },
      allowBaselineRender: true,
    });

    expect(result.success).toBe(true);
    expect(result.pdfPath).toBe("resume_job-44b.pdf");
  });

  it("hard-fails when the CV has no templatedTex (legacy upload)", async () => {
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce({
      ...FAKE_CV,
      templatedTex: "",
      defaultFieldValues: {},
    });

    const result = await generatePdf({
      jobId: "job-45",
      cvDocumentId: "cv-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not have an extracted template/);
  });

  it("returns a failure when the CV document does not exist", async () => {
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce(null);
    const result = await generatePdf({
      jobId: "job-1",
      cvDocumentId: "missing",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CV document not found/);
  });

  it("returns a failure when tectonic exits non-zero", async () => {
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError("compile failed", "NON_ZERO_EXIT", "log"),
    );
    const result = await generatePdf({
      jobId: "job-1",
      cvDocumentId: "cv-1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LaTeX compile failed/);
    expect(upsertJobPdf).not.toHaveBeenCalled();
  });

  it("carries the tectonic log into the failure detail", async () => {
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError(
        "compile failed",
        "NON_ZERO_EXIT",
        "! Misplaced alignment tab character &.\nl.42 Pricing & Underwriting",
      ),
    );
    const result = await generatePdf({
      jobId: "job-1",
      cvDocumentId: "cv-1",
    });

    expect(result.success).toBe(false);
    const { summary, detail } = splitTailoringFailure(result.error);
    expect(summary).toBe("LaTeX compile failed: compile failed");
    // The stderr is the only thing that names the offending line; before this
    // it was carried on the error object and thrown away here.
    expect(detail).toContain("Misplaced alignment tab character");
    expect(detail).toContain("l.42 Pricing & Underwriting");
  });

  it("keeps only the TAIL of a long tectonic log, where the error is", async () => {
    const chatter = Array.from(
      { length: 200 },
      (_, i) => `[package chatter line ${i}]`,
    ).join("\n");
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError(
        "compile failed",
        "NON_ZERO_EXIT",
        `${chatter}\n! Undefined control sequence.`,
      ),
    );
    const result = await generatePdf({
      jobId: "job-1",
      cvDocumentId: "cv-1",
    });

    const { detail } = splitTailoringFailure(result.error);
    expect(detail).toContain("! Undefined control sequence.");
    expect(detail).toContain("earlier line(s)");
    expect(detail).not.toContain("[package chatter line 0]");
  });

  it("cuts a log of SHORT lines at the line limit, well under the char cap", async () => {
    // The line limit is the binding one on ordinary logs; without this the
    // constant was deletable with the suite green.
    const stderr = Array.from({ length: 500 }, (_, i) => `l.${i} short`).join(
      "\n",
    );
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError("compile failed", "NON_ZERO_EXIT", stderr),
    );
    const result = await generatePdf({ jobId: "job-1", cvDocumentId: "cv-1" });

    const { detail } = splitTailoringFailure(result.error);
    const body = (detail ?? "").split("\n").slice(1); // drop the elision marker
    expect(body).toHaveLength(40);
    expect(body.at(-1)).toBe("l.499 short");
    expect(detail).toContain("(460 earlier line(s))");
    // Nowhere near the character cap — the LINE limit is what bound this.
    expect((detail ?? "").length).toBeLessThan(
      TAILORING_FAILURE_DETAIL_MAX_CHARS / 2,
    );
  });

  it("keeps the END of a log whose tail alone exceeds the detail cap", async () => {
    // The regression the two truncation directions caused: the tail selection
    // keeps the last 40 lines, then a head-slice at the cap threw the last of
    // them away — discarding the error and calling the result "truncated".
    const fatLine = "warning: ".padEnd(400, "x");
    const stderr = `${Array.from({ length: 40 }, () => fatLine).join("\n")}\n! THE ACTUAL ERROR`;
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError("compile failed", "NON_ZERO_EXIT", stderr),
    );
    const result = await generatePdf({ jobId: "job-1", cvDocumentId: "cv-1" });

    const { detail } = splitTailoringFailure(result.error);
    expect(detail).toContain("! THE ACTUAL ERROR");
    expect(detail).not.toContain("(truncated)");
    expect((detail ?? "").length).toBeLessThanOrEqual(
      TAILORING_FAILURE_DETAIL_MAX_CHARS,
    );
  });

  it("keeps the end of a single line longer than the whole budget", async () => {
    const stderr = `${"a".repeat(5000)}! TRAILING ERROR`;
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError("compile failed", "NON_ZERO_EXIT", stderr),
    );
    const result = await generatePdf({ jobId: "job-1", cvDocumentId: "cv-1" });

    const { detail } = splitTailoringFailure(result.error);
    expect(detail).toContain("! TRAILING ERROR");
    expect((detail ?? "").length).toBeLessThanOrEqual(
      TAILORING_FAILURE_DETAIL_MAX_CHARS,
    );
  });

  it("omits the detail entirely when tectonic gave no log", async () => {
    vi.mocked(runTectonic).mockRejectedValueOnce(
      new RunTectonicError("compile failed", "NON_ZERO_EXIT", "   "),
    );
    const result = await generatePdf({
      jobId: "job-1",
      cvDocumentId: "cv-1",
    });

    expect(result.error).toBe("LaTeX compile failed: compile failed");
    expect(splitTailoringFailure(result.error).detail).toBeNull();
  });
});

describe("generatePdf on a Word profile", () => {
  beforeEach(() => {
    useDocxProfile();
  });

  it("persists the tailored .docx and its converted PDF", async () => {
    const result = await generatePdf({
      jobId: "job-50",
      cvDocumentId: "cv-docx",
      overrides: { [DOCX_FIELD_ID]: "Rebuilt the rendering fleet on a queue." },
    });

    expect(result.success).toBe(true);
    // Unchanged filename: the converted PDF rides the same `resume` kind, so
    // every caller and client surface keeps working.
    expect(result.pdfPath).toBe("resume_job-50.pdf");

    expect(runTectonic).not.toHaveBeenCalled();
    expect(upsertJobPdf).toHaveBeenCalledTimes(2);

    const [docxUpsert, pdfUpsert] = vi
      .mocked(upsertJobPdf)
      .mock.calls.map((call) => call[0]);
    // The .docx is the authoritative artifact and is persisted first.
    expect(docxUpsert.kind).toBe("resume_docx");
    expect(docxUpsert.jobId).toBe("job-50");
    expect(docxUpsert.data.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(pdfUpsert.kind).toBe("resume");
    expect(pdfUpsert.data.subarray(0, 4).toString("ascii")).toBe("%PDF");

    // The converter received the rendered docx, and the tailored text made it
    // into the document.
    const converted = vi.mocked(convertDocxToPdf).mock.calls[0][0].docx;
    expect(Buffer.from(converted).toString("latin1")).not.toContain(
      `⟦${DOCX_FIELD_ID}`,
    );
  });

  it("hard-fails a no-op tailoring without persisting or converting", async () => {
    const result = await generatePdf({
      jobId: "job-51",
      cvDocumentId: "cv-docx",
      overrides: { "ghost.field": "ignored" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no actual change to the CV/);
    expect(upsertJobPdf).not.toHaveBeenCalled();
    expect(convertDocxToPdf).not.toHaveBeenCalled();
  });

  it("renders a no-op override set when allowBaselineRender is true", async () => {
    const result = await generatePdf({
      jobId: "job-52",
      cvDocumentId: "cv-docx",
      overrides: { "ghost.field": "ignored" },
      allowBaselineRender: true,
    });

    expect(result.success).toBe(true);
    expect(upsertJobPdf).toHaveBeenCalledTimes(2);
  });

  it("persists nothing when the conversion fails", async () => {
    vi.mocked(convertDocxToPdf).mockRejectedValueOnce(
      new ConvertDocxError("daemon down", "UNAVAILABLE", "spawn ENOENT"),
    );

    const result = await generatePdf({
      jobId: "job-53",
      cvDocumentId: "cv-docx",
      overrides: { [DOCX_FIELD_ID]: "Rebuilt the fleet." },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PDF conversion failed/);
    // The ordering invariant: no stranded .docx blob on a conversion failure.
    expect(upsertJobPdf).not.toHaveBeenCalled();
  });

  it("carries the LibreOffice log into the failure detail", async () => {
    // Word-CV profiles never reach the LaTeX arm, so without this the whole
    // feature delivers them nothing.
    vi.mocked(convertDocxToPdf).mockRejectedValueOnce(
      new ConvertDocxError(
        "daemon down",
        "UNAVAILABLE",
        "Error: unoserver refused the connection on port 2003",
      ),
    );

    const result = await generatePdf({
      jobId: "job-53",
      cvDocumentId: "cv-docx",
      overrides: { [DOCX_FIELD_ID]: "Rebuilt the fleet." },
    });

    const { summary, detail } = splitTailoringFailure(result.error);
    expect(summary).toBe("PDF conversion failed: daemon down");
    expect(detail).toBe("Error: unoserver refused the connection on port 2003");
  });

  it("fails when the template references an unknown field", async () => {
    vi.mocked(cvRepo.getCvDocumentById).mockResolvedValueOnce({
      ...DOCX_CV,
      // Defaults no longer cover the spliced marker → leftover on render.
      defaultFieldValues: {},
    });

    const result = await generatePdf({
      jobId: "job-54",
      cvDocumentId: "cv-docx",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not render the CV template/);
    expect(upsertJobPdf).not.toHaveBeenCalled();
    expect(convertDocxToPdf).not.toHaveBeenCalled();
  });
});
