// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("MCP tools", () => {
  let tempDir: string;
  let tools: Awaited<typeof import("./tools")>;
  let jobsRepo: Awaited<typeof import("../repositories/jobs")>;
  let cvRepo: Awaited<typeof import("../repositories/cv-documents")>;
  let dbModule: Awaited<typeof import("../db/index")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-mcp-tools-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    dbModule = await import("../db/index");
    jobsRepo = await import("../repositories/jobs");
    cvRepo = await import("../repositories/cv-documents");
    tools = await import("./tools");
  });

  afterEach(async () => {
    dbModule.closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("input declarations", () => {
    const declaration = {
      lock: {
        type: "enum",
        values: ["ready", "applied"],
        description: "A lock.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "A limit.",
      },
      id: { type: "string", required: true, description: "An id." },
      title: { type: "string", maxLength: 5, description: "A title." },
    } as const;

    it("declares and enforces an enum", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.jsonSchema.properties.lock).toEqual({
        type: "string",
        enum: ["ready", "applied"],
        description: "A lock.",
      });
      expect(compiled.validate({ id: "a", lock: "applied" })).toEqual({
        ok: true,
        value: { id: "a", lock: "applied" },
      });
      expect(compiled.validate({ id: "a", lock: "skipped" })).toEqual({
        ok: false,
        error: 'Property "lock" must be one of: ready, applied',
      });
    });

    it("declares and enforces integer bounds", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.jsonSchema.properties.limit).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "A limit.",
      });
      expect(compiled.validate({ id: "a", limit: 10 })).toMatchObject({
        ok: true,
      });
      expect(compiled.validate({ id: "a", limit: 11 })).toEqual({
        ok: false,
        error: 'Property "limit" must be at most 10',
      });
      expect(compiled.validate({ id: "a", limit: 0 })).toEqual({
        ok: false,
        error: 'Property "limit" must be at least 1',
      });
    });

    it("declares and enforces a required property", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.jsonSchema.required).toEqual(["id"]);
      expect(compiled.validate({ limit: 2 })).toEqual({
        ok: false,
        error: 'Missing required property "id"',
      });
    });

    it("declares and enforces a string's maximum length", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.jsonSchema.properties.title).toEqual({
        type: "string",
        maxLength: 5,
        description: "A title.",
      });
      expect(compiled.validate({ id: "a", title: "short" })).toMatchObject({
        ok: true,
      });
      expect(compiled.validate({ id: "a", title: "longer" })).toEqual({
        ok: false,
        error: 'Property "title" must be at most 5 characters',
      });
    });

    it("counts a string's length in code points", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.validate({ id: "a", title: "ab\u{1F600}cd" })).toEqual({
        ok: true,
        value: { id: "a", title: "ab\u{1F600}cd" },
      });
    });

    it("treats an optional property sent as null as absent", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.validate({ id: "a", limit: null })).toEqual({
        ok: true,
        value: { id: "a" },
      });
    });

    it("treats a required property sent as null as missing", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.validate({ id: null })).toEqual({
        ok: false,
        error: 'Missing required property "id"',
      });
    });

    it("refuses an undeclared property", () => {
      const compiled = tools.compileInputDeclaration(declaration);

      expect(compiled.jsonSchema.additionalProperties).toBe(false);
      expect(compiled.validate({ id: "a", status: "ready" })).toEqual({
        ok: false,
        error: 'Unknown property "status"',
      });
    });
  });

  const call = (name: string, input: Record<string, unknown>) => {
    const tool = tools.getMcpTool(name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool.handler(input);
  };

  const COMPACT_KEYS = [
    "id",
    "title",
    "employer",
    "location",
    "status",
    "source",
    "datePosted",
    "jobUrl",
    "applicationLink",
  ].sort();

  let seq = 0;
  const seedJob = async (status?: "ready" | "applied" | "discovered") => {
    seq += 1;
    const job = await jobsRepo.createJob({
      source: "manual",
      title: `Platform Engineer ${seq}`,
      employer: "Acme",
      jobUrl: `https://example.com/jobs/${seq}`,
    });
    if (status && status !== "discovered") {
      await jobsRepo.updateJob(job.id, { status });
    }
    return job.id;
  };

  it("search_jobs honours the lock and the limit", async () => {
    await seedJob("ready");
    await seedJob("ready");
    await seedJob("ready");
    await seedJob("applied");

    const result = (await call("search_jobs", { lock: "ready", limit: 2 })) as {
      total: number;
      jobs: { status: string }[];
    };

    expect(result.total).toBe(3);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.every((job) => job.status === "ready")).toBe(true);
    expect(Object.keys(result.jobs[0]).sort()).toEqual(COMPACT_KEYS);
  });

  it("search_jobs returns 50 jobs when no limit is given", async () => {
    for (let i = 0; i < 51; i += 1) await seedJob();

    const result = (await call("search_jobs", {})) as {
      total: number;
      jobs: unknown[];
    };

    expect(result.total).toBe(51);
    expect(result.jobs).toHaveLength(50);
  });

  it("get_job returns exactly the curated keys", async () => {
    const id = await seedJob("ready");
    await jobsRepo.updateJob(id, {
      salary: "EUR 70,000",
      deadline: "2026-12-31",
      appliedAt: "2026-02-03T04:05:06.000Z",
    });

    const result = (await call("get_job", { id })) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(
      [
        "id",
        "title",
        "employer",
        "location",
        "status",
        "source",
        "datePosted",
        "jobUrl",
        "applicationLink",
        "jobDescription",
        "salary",
        "deadline",
        "suitabilityCategory",
        "suitabilityReason",
        "appliedAt",
        "liveClosed",
        "liveApplicants",
        "liveEasyApply",
        "liveStatusCheckedAt",
      ].sort(),
    );
    expect(result).toMatchObject({
      id,
      salary: "EUR 70,000",
      deadline: "2026-12-31",
      appliedAt: "2026-02-03T04:05:06.000Z",
    });
  });

  it("get_tailored_cv reads the pinned CV and shows a tailored value over the default", async () => {
    const pinned = await cvRepo.createCvDocument({
      name: "Pinned CV",
      originalArchive: new Uint8Array(),
      flattenedTex: "",
      fields: [
        { id: "summary", role: "summary", value: "Pinned summary" },
        { id: "b1", role: "bullet", value: "Pinned bullet" },
      ],
      personalBrief: "",
      templatedTex: "",
      defaultFieldValues: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const active = await cvRepo.createCvDocument({
      name: "Newer CV",
      originalArchive: new Uint8Array(),
      flattenedTex: "",
      fields: [
        { id: "summary", role: "summary", value: "Newer summary" },
        { id: "b1", role: "bullet", value: "Newer bullet" },
      ],
      personalBrief: "",
      templatedTex: "",
      defaultFieldValues: { summary: "Newer summary", b1: "Newer bullet" },
    });
    expect(active.id).not.toBe(pinned.id);
    const id = await seedJob("ready");
    await jobsRepo.updateJob(id, {
      cvDocumentId: pinned.id,
      tailoredFields: { b1: "Built Kafka pipelines for Example Corp" },
    });

    const result = await call("get_tailored_cv", { id });

    expect(result).toEqual({
      cvDocumentId: pinned.id,
      fields: [
        { id: "summary", role: "summary", value: "Pinned summary" },
        {
          id: "b1",
          role: "bullet",
          value: "Built Kafka pipelines for Example Corp",
        },
      ],
    });
  });

  const seedCv = (name: string, value: string) =>
    cvRepo.createCvDocument({
      name,
      originalArchive: new Uint8Array(),
      flattenedTex: "",
      fields: [{ id: "b1", role: "bullet", value }],
      personalBrief: "",
      templatedTex: "",
      defaultFieldValues: {},
    });

  it("get_tailored_cv refuses when the pinned CV no longer exists", async () => {
    const pinned = await seedCv("Pinned CV", "Pinned bullet");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedCv("Newer CV", "Newer bullet");
    const id = await seedJob("ready");
    await jobsRepo.updateJob(id, { cvDocumentId: pinned.id });
    dbModule.db.run(sql`PRAGMA foreign_keys = OFF`);
    await cvRepo.deleteCvDocument(pinned.id);
    expect((await jobsRepo.getJobById(id))?.cvDocumentId).toBe(pinned.id);

    await expect(call("get_tailored_cv", { id })).rejects.toThrow(
      /^The CV this job was tailored with no longer exists$/,
    );
  });

  it("get_tailored_cv gives an HTML CV's values as text", async () => {
    const settingsRepo = await import("../repositories/settings");
    await settingsRepo.setSetting("cvSourceFormat", "html");
    await seedCv("HTML CV", "Built things");
    const id = await seedJob("ready");
    await jobsRepo.updateJob(id, {
      tailoredFields: { b1: "Built <b>Apache</b> Kafka at Acme" },
    });

    const result = (await call("get_tailored_cv", { id })) as {
      fields: { value: string }[];
    };

    expect(result.fields.map((field) => field.value)).toEqual([
      "Built Apache Kafka at Acme",
    ]);
  });

  it("get_job_documents gives the job's cover letter text", async () => {
    const coverLetterRepo = await import(
      "../repositories/cover-letter-documents"
    );
    await coverLetterRepo.createCoverLetterDocument({
      name: "Cover letter",
      originalArchive: new Uint8Array(),
      flattenedTex: "",
      fields: [
        { id: "letter.body", role: "body", value: "Dear Example Corp, ..." },
      ],
      templatedTex: "",
      defaultFieldValues: { "letter.body": "Dear Example Corp, ..." },
    });
    const id = await seedJob("ready");
    await jobsRepo.updateJob(id, {
      coverLetterFieldOverrides: {
        "letter.body": "Dear Acme, I would like to join your platform team.",
      },
    });

    const result = (await call("get_job_documents", { id })) as {
      coverLetterText: string;
    };

    expect(result.coverLetterText).toBe(
      "Dear Acme, I would like to join your platform team.",
    );
  });

  it("get_job_documents gives a PDF path only when its flag is set", async () => {
    const without = await seedJob("ready");
    const withPdfs = await seedJob("ready");
    await jobsRepo.updateJob(withPdfs, {
      pdfPath: `resume_${withPdfs}.pdf`,
      coverLetterPdfPath: `cover_letter_${withPdfs}.pdf`,
    });

    expect(await call("get_job_documents", { id: without })).toEqual({
      cvPdf: null,
      coverLetterPdf: null,
      coverLetterText: "",
    });
    expect(await call("get_job_documents", { id: withPdfs })).toEqual({
      cvPdf: `/pdfs/resume_${withPdfs}.pdf`,
      coverLetterPdf: `/pdfs/cover_letter_${withPdfs}.pdf`,
      coverLetterText: "",
    });
  });

  it("mark_applied keeps a Ready job's first applied date", async () => {
    const id = await seedJob("ready");
    const firstApplied = "2026-01-02T03:04:05.000Z";
    await jobsRepo.updateJob(id, { appliedAt: firstApplied });

    const result = await call("mark_applied", { id });

    expect(result).toEqual({ id, status: "applied", appliedAt: firstApplied });
  });

  it("mark_applied refuses a job that is not Ready and leaves it unchanged", async () => {
    const id = await seedJob("discovered");

    await expect(call("mark_applied", { id })).rejects.toThrow(
      "Only a Ready job can be marked applied (this one is discovered)",
    );

    const after = await jobsRepo.getJobById(id);
    expect(after?.status).toBe("discovered");
    expect(after?.appliedAt).toBeNull();
  });

  const countNotes = async () =>
    (await dbModule.db.select().from(dbModule.schema.jobNotes)).length;

  it("add_job_note adds a note to a job", async () => {
    const id = await seedJob("ready");

    const result = (await call("add_job_note", {
      id,
      title: "Recruiter call",
      content: "Spoke to Jane Q. Doe at Acme.",
    })) as { noteId: string };

    const notes = await jobsRepo.listJobNotes(id);
    expect(notes.map((note) => note.id)).toEqual([result.noteId]);
  });

  it("add_job_note refuses an empty title without writing a note", async () => {
    const id = await seedJob("ready");

    await expect(
      call("add_job_note", { id, title: "   ", content: "Some text" }),
    ).rejects.toThrow(/^title: /);

    expect(await countNotes()).toBe(0);
  });

  it("add_job_note refuses an unknown job without writing a note", async () => {
    await expect(
      call("add_job_note", {
        id: "no-such-job",
        title: "Recruiter call",
        content: "Some text",
      }),
    ).rejects.toThrow(/^Job not found$/);

    expect(await countNotes()).toBe(0);
  });
});
