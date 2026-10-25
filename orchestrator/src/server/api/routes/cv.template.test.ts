// @vitest-environment node
import type { Server } from "node:http";
import {
  RunTectonicError,
  runTectonic,
} from "@server/services/cv/run-tectonic";
import { runUploadPipeline } from "@server/services/cv/upload-pipeline";
import type { CvDocument } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

vi.mock("@server/services/cv/upload-pipeline", () => ({
  runUploadPipeline: vi.fn(),
}));

vi.mock("@server/services/cv/run-tectonic", () => ({
  runTectonic: vi.fn(),
  RunTectonicError: class RunTectonicError extends Error {
    readonly code: string;
    readonly stderr: string;
    constructor(message: string, code: string, stderr: string) {
      super(message);
      this.name = "RunTectonicError";
      this.code = code;
      this.stderr = stderr;
    }
  },
}));

const pipelineMock = vi.mocked(runUploadPipeline);
const tectonicMock = vi.mocked(runTectonic);

const SOURCE_TEX =
  "\\documentclass{article}\n\\begin{document}\nAda Lovelace\\\\\nAnalyst\n\\end{document}\n";
const TEMPLATE =
  "\\documentclass{article}\n\\begin{document}\n«basics.name»\\\\\n«basics.headline»\n\\end{document}\n";
const EDITED =
  "\\documentclass{article}\n\\begin{document}\n«basics.name»\n\n«basics.headline»\n\\end{document}\n";
const DEFAULTS = {
  "basics.name": "Ada Lovelace",
  "basics.headline": "Analyst",
};

describe.sequential("PUT /api/cv/:id/template", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  function pipelineSuccess(
    templatedTex: string,
    compileStderr: string | null = "upload log",
  ) {
    return {
      ok: true,
      flattenedTex: SOURCE_TEX,
      templatedTex,
      fields: [
        { id: "basics.name", role: "name", value: "Ada Lovelace" },
        { id: "basics.headline", role: "summary", value: "Analyst" },
      ],
      defaultFieldValues: DEFAULTS,
      personalBrief: "brief",
      compileStderr,
      compileAttempts: 1,
      attempts: [],
    } as unknown as Awaited<ReturnType<typeof runUploadPipeline>>;
  }

  async function seedCv(
    compileStderr: string | null = "upload log",
    templatedTex = TEMPLATE,
  ): Promise<CvDocument> {
    pipelineMock.mockResolvedValueOnce(
      pipelineSuccess(templatedTex, compileStderr),
    );
    const form = new FormData();
    form.append("name", "Ada CV");
    form.append(
      "file",
      new Blob([SOURCE_TEX], { type: "application/x-tex" }),
      "ada.tex",
    );
    const res = await fetch(`${baseUrl}/api/cv/upload-template`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { data: { cv: CvDocument } };
    return payload.data.cv;
  }

  async function putTemplate(id: string, body: unknown) {
    return fetch(`${baseUrl}/api/cv/${id}/template`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getCv(id: string): Promise<CvDocument> {
    const res = await fetch(`${baseUrl}/api/cv/${id}`);
    return ((await res.json()) as { data: CvDocument }).data;
  }

  // The route starts the edit's compile before the stored template's, so
  // the first call of a save is the edit and the second its baseline.
  function stubCompiles(edit: string | Error, baseline: string | Error) {
    tectonicMock.mockImplementation(async () => {
      const outcome =
        tectonicMock.mock.calls.length % 2 === 1 ? edit : baseline;
      if (outcome instanceof Error) throw outcome;
      return { pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]), log: outcome };
    });
  }

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    vi.clearAllMocks();
    stubCompiles("edit log", "baseline log");
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("compiles the default render of the edit and persists it", async () => {
    const cv = await seedCv();
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: CvDocument };
    expect(payload.data.templatedTex).toBe(EDITED);
    expect(payload.data.lastCompileStderr).toBe("edit log");

    expect(tectonicMock).toHaveBeenCalledTimes(2);
    expect(tectonicMock.mock.calls[0][0].renderedTex).toBe(
      "\\documentclass{article}\n\\begin{document}\nAda Lovelace\n\nAnalyst\n\\end{document}\n",
    );
    expect(tectonicMock.mock.calls[1][0].renderedTex).toBe(SOURCE_TEX);
    for (const [args] of tectonicMock.mock.calls) {
      expect(args.archive).toEqual(new Uint8Array(Buffer.from(SOURCE_TEX)));
      expect(args.entrypoint).toBeUndefined();
    }

    const stored = await getCv(cv.id);
    expect(stored.templatedTex).toBe(EDITED);
    expect(stored.flattenedTex).toBe(SOURCE_TEX);
    expect(stored.defaultFieldValues).toEqual(DEFAULTS);
  });

  it("422s an edit that drops or invents a marker, and compiles nothing", async () => {
    const cv = await seedCv();
    const res = await putTemplate(cv.id, {
      templatedTex: EDITED.replace("«basics.headline»", "«basics.title»"),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: { details: { missing: string[]; unknown: string[] } };
    };
    expect(payload.error.details.missing).toEqual(["basics.headline"]);
    expect(payload.error.details.unknown).toEqual(["basics.title"]);
    expect(tectonicMock).not.toHaveBeenCalled();
    expect((await getCv(cv.id)).templatedTex).toBe(TEMPLATE);
  });

  it("keeps the old template when the edit does not compile", async () => {
    const cv = await seedCv();
    stubCompiles(
      new RunTectonicError("tectonic exited 1", "COMPILE_FAILED", "! Oops."),
      "baseline log",
    );
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: { details: { stderr: string } };
    };
    expect(payload.error.details.stderr).toBe("! Oops.");
    const stored = await getCv(cv.id);
    expect(stored.templatedTex).toBe(TEMPLATE);
    expect(stored.lastCompileStderr).toBe("upload log");
  });

  it("400s an edit that writes a forbidden LaTeX pattern", async () => {
    const cv = await seedCv();
    const res = await putTemplate(cv.id, {
      templatedTex: EDITED.replace(
        "\\begin{document}",
        "\\begin{document}\\immediate\\write18{id}",
      ),
    });
    expect(res.status).toBe(400);
    expect(tectonicMock).not.toHaveBeenCalled();
    expect((await getCv(cv.id)).templatedTex).toBe(TEMPLATE);
  });

  it("422s an edit that leaves a marker only inside a comment", async () => {
    const cv = await seedCv();
    const res = await putTemplate(cv.id, {
      templatedTex: EDITED.replace("«basics.headline»", "% «basics.headline»"),
    });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: { details: { commented: string[] } };
    };
    expect(payload.error.details.commented).toEqual(["basics.headline"]);
    expect(tectonicMock).not.toHaveBeenCalled();
    expect((await getCv(cv.id)).templatedTex).toBe(TEMPLATE);
  });

  it("accepts an edit of a template whose marker was already only in a comment", async () => {
    const hidden = TEMPLATE.replace(
      "«basics.headline»",
      "Analyst\n% «basics.headline»",
    );
    const cv = await seedCv("upload log", hidden);
    const res = await putTemplate(cv.id, {
      templatedTex: hidden.replace("\\\\\n", "\n\n"),
    });
    expect(res.status).toBe(200);
  });

  it("422s an edit that compiles with a LaTeX error the stored template does not have", async () => {
    const cv = await seedCv();
    stubCompiles(
      [
        "error: main.tex:4: Missing $ inserted",
        "error: main.tex:3: Undefined control sequence",
        "warning: errors were issued by the TeX engine, but were ignored",
      ].join("\n"),
      "error: main.tex:9: Missing $ inserted\nwarning: errors were issued",
    );
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: { details: { texErrors: string[]; stderr: string } };
    };
    expect(payload.error.details.texErrors).toEqual([
      "Undefined control sequence",
    ]);
    expect(payload.error.details.stderr).toContain("Undefined control");
    expect((await getCv(cv.id)).templatedTex).toBe(TEMPLATE);
  });

  it("accepts an edit whose only LaTeX errors the stored template also has", async () => {
    const cv = await seedCv();
    stubCompiles(
      "error: main.tex:12: Missing $ inserted",
      "error: my cv: final.tex:9: Missing $ inserted",
    );
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(200);
    expect((await getCv(cv.id)).templatedTex).toBe(EDITED);
  });

  it("judges the edit against the stored template's stderr when that no longer compiles", async () => {
    const cv = await seedCv();
    stubCompiles(
      "error: main.tex:3: Undefined control sequence",
      new RunTectonicError(
        "tectonic exited 1",
        "NON_ZERO_EXIT",
        "error: main.tex:7: Undefined control sequence",
      ),
    );
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(200);
    expect((await getCv(cv.id)).templatedTex).toBe(EDITED);
  });

  it("fails the save when the baseline compile times out", async () => {
    const cv = await seedCv();
    stubCompiles(
      "edit log",
      new RunTectonicError("tectonic timed out", "TIMEOUT", "error: main"),
    );
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: { message: string; details: Record<string, unknown> };
    };
    expect(payload.error.message).toBe(
      "Could not compile the current template to compare the edit against: tectonic timed out",
    );
    expect(payload.error.details).toEqual({ code: "TIMEOUT" });
    expect((await getCv(cv.id)).templatedTex).toBe(TEMPLATE);
  });

  it("starts no compile when the stored template no longer renders", async () => {
    const stale = TEMPLATE.replace(
      "\\end{document}",
      "\\openout\\end{document}",
    );
    const cv = await seedCv("upload log", stale);
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(400);
    expect(tectonicMock).not.toHaveBeenCalled();
    expect((await getCv(cv.id)).templatedTex).toBe(stale);
  });

  it("409s when a re-extract replaced the template while the edit compiled", async () => {
    const cv = await seedCv();
    const replaced = TEMPLATE.replace(
      "\\begin{document}",
      "\\begin{document}%",
    );
    tectonicMock.mockImplementationOnce(async () => {
      pipelineMock.mockResolvedValueOnce(pipelineSuccess(replaced));
      const reExtract = await fetch(
        `${baseUrl}/api/cv/${cv.id}/re-extract-template`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(reExtract.status).toBe(200);
      return { pdf: new Uint8Array([0x25]), log: "" };
    });
    const res = await putTemplate(cv.id, { templatedTex: EDITED });
    expect(res.status).toBe(409);
    expect((await getCv(cv.id)).templatedTex).toBe(replaced);
  });

  it("422s a template over the byte cap", async () => {
    const cv = await seedCv();
    const settings = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxExpandedLatexBytes: 1024 * 1024 }),
    });
    expect(settings.status).toBe(200);
    const res = await putTemplate(cv.id, {
      templatedTex: EDITED + "%".repeat(1024 * 1024),
    });
    expect(res.status).toBe(422);
    expect(tectonicMock).not.toHaveBeenCalled();
  });

  it("400s an empty template", async () => {
    const cv = await seedCv();
    const res = await putTemplate(cv.id, { templatedTex: "" });
    expect(res.status).toBe(400);
    expect((await getCv(cv.id)).templatedTex).toBe(TEMPLATE);
  });

  it("422s a CV that has no template yet", async () => {
    // Such rows predate the gated upload; seeded directly, since no route
    // creates one any more.
    const { createCvDocument } = await import(
      "@server/repositories/cv-documents"
    );
    const legacy = await createCvDocument({
      name: "Legacy CV",
      originalArchive: new TextEncoder().encode(SOURCE_TEX),
      flattenedTex: SOURCE_TEX,
      fields: [{ id: "basics.name", role: "name", value: "Ada Lovelace" }],
      personalBrief: "brief",
    });
    expect(legacy.templatedTex).toBe("");

    const res = await putTemplate(legacy.id, { templatedTex: EDITED });
    expect(res.status).toBe(422);
    expect(tectonicMock).not.toHaveBeenCalled();
    expect((await getCv(legacy.id)).templatedTex).toBe("");
  });

  it("404s an unknown CV", async () => {
    const res = await putTemplate("missing", { templatedTex: EDITED });
    expect(res.status).toBe(404);
  });

  it("422s on a Word-CV profile", async () => {
    const settings = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cvSourceFormat: "docx" }),
    });
    expect(settings.status).toBe(200);
    // The format cannot change while CVs exist, so the row is unreachable
    // through the routes on a docx profile — the format check must answer
    // before the CV is even looked up.
    const res = await putTemplate("any-id", { templatedTex: EDITED });
    expect(res.status).toBe(422);
    expect(tectonicMock).not.toHaveBeenCalled();
  });
});
