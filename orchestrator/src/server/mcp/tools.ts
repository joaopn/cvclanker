import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { jobNoteSchema } from "@server/api/routes/jobs";
import * as cvRepo from "@server/repositories/cv-documents";
import * as jobsRepo from "@server/repositories/jobs";
import { getActivePersonalBrief } from "@server/services/brief";
import { getActiveCoverLetterDocument } from "@server/services/cover-letter/active";
import { resolveCvSourceFormat } from "@server/services/cv/cv-format";
import { cvFieldText } from "@server/services/cv/html/field-text";
import { getActiveCvDocument } from "@server/services/cv-active";
import { buildCoverLetterSnapshot } from "@server/services/ghostwriter-context";
import { getEffectiveSettings } from "@server/services/settings";
import {
  type CoverLetterDocument,
  type CvDocument,
  JOB_SEARCH_LOCKS,
  type Job,
  SUITABILITY_CATEGORIES,
} from "@shared/types";

type StringProperty = {
  type: "string";
  description: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
};

type IntegerProperty = {
  type: "integer";
  description: string;
  required?: boolean;
  minimum?: number;
  maximum?: number;
};

type EnumProperty = {
  type: "enum";
  description: string;
  required?: boolean;
  values: readonly string[];
};

type PropertyDeclaration = StringProperty | IntegerProperty | EnumProperty;

export type InputDeclaration = Record<string, PropertyDeclaration>;

type PropertyValue<P> = P extends { type: "integer" }
  ? number
  : P extends { type: "enum"; values: readonly (infer V)[] }
    ? V
    : string;

type InputOf<D extends InputDeclaration> = {
  [K in keyof D as D[K] extends { required: true } ? K : never]: PropertyValue<
    D[K]
  >;
} & {
  [K in keyof D as D[K] extends { required: true } ? never : K]?: PropertyValue<
    D[K]
  >;
};

export type InputValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export interface CompiledInput {
  jsonSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
  validate: (raw: unknown) => InputValidation;
}

function propertySchema(
  property: PropertyDeclaration,
): Record<string, unknown> {
  switch (property.type) {
    case "string":
      return {
        type: "string",
        description: property.description,
        ...(property.minLength !== undefined
          ? { minLength: property.minLength }
          : {}),
        ...(property.maxLength !== undefined
          ? { maxLength: property.maxLength }
          : {}),
      };
    case "integer":
      return {
        type: "integer",
        description: property.description,
        ...(property.minimum !== undefined
          ? { minimum: property.minimum }
          : {}),
        ...(property.maximum !== undefined
          ? { maximum: property.maximum }
          : {}),
      };
    case "enum":
      return {
        type: "string",
        enum: [...property.values],
        description: property.description,
      };
  }
}

function propertyError(
  name: string,
  property: PropertyDeclaration,
  value: unknown,
): string | null {
  switch (property.type) {
    case "string": {
      if (typeof value !== "string") {
        return `Property "${name}" must be a string`;
      }
      const length = [...value].length;
      if (property.minLength !== undefined && length < property.minLength) {
        return `Property "${name}" must be at least ${property.minLength} characters`;
      }
      if (property.maxLength !== undefined && length > property.maxLength) {
        return `Property "${name}" must be at most ${property.maxLength} characters`;
      }
      return null;
    }
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `Property "${name}" must be an integer`;
      }
      if (property.minimum !== undefined && value < property.minimum) {
        return `Property "${name}" must be at least ${property.minimum}`;
      }
      if (property.maximum !== undefined && value > property.maximum) {
        return `Property "${name}" must be at most ${property.maximum}`;
      }
      return null;
    case "enum":
      if (typeof value !== "string" || !property.values.includes(value)) {
        return `Property "${name}" must be one of: ${property.values.join(", ")}`;
      }
      return null;
  }
}

/**
 * The JSON Schema `tools/list` shows and the validator `tools/call` runs, both
 * from one declaration so the two cannot disagree.
 */
export function compileInputDeclaration(
  declaration: InputDeclaration,
): CompiledInput {
  const entries = Object.entries(declaration);
  const jsonSchema: CompiledInput["jsonSchema"] = {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([name, property]) => [name, propertySchema(property)]),
    ),
    required: entries
      .filter(([, property]) => property.required === true)
      .map(([name]) => name),
    additionalProperties: false,
  };

  const validate = (raw: unknown): InputValidation => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "Arguments must be an object" };
    }
    const input = raw as Record<string, unknown>;
    for (const name of Object.keys(input)) {
      if (!Object.hasOwn(declaration, name)) {
        return { ok: false, error: `Unknown property "${name}"` };
      }
    }
    const value: Record<string, unknown> = {};
    for (const [name, property] of entries) {
      if (input[name] === undefined || input[name] === null) {
        if (property.required === true) {
          return { ok: false, error: `Missing required property "${name}"` };
        }
        continue;
      }
      const error = propertyError(name, property, input[name]);
      if (error !== null) return { ok: false, error };
      value[name] = input[name];
    }
    return { ok: true, value };
  };

  return { jsonSchema, validate };
}

export type McpToolAccess = "read" | "write";

export interface McpTool {
  name: string;
  description: string;
  access: McpToolAccess;
  needsBrief: boolean;
  input: CompiledInput;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

function defineTool<const D extends InputDeclaration>(tool: {
  name: string;
  description: string;
  access: McpToolAccess;
  needsBrief?: boolean;
  input: D;
  handler: (input: InputOf<D>) => Promise<unknown>;
}): McpTool {
  return {
    name: tool.name,
    description: tool.description,
    access: tool.access,
    needsBrief: tool.needsBrief ?? false,
    input: compileInputDeclaration(tool.input),
    handler: (input) => tool.handler(input as InputOf<D>),
  };
}

const JOB_NOT_FOUND = "Job not found";
const SEARCH_DEFAULT_LIMIT = 50;

type CompactJobSource = Pick<
  Job,
  | "id"
  | "title"
  | "employer"
  | "location"
  | "status"
  | "suitabilityCategory"
  | "source"
  | "datePosted"
  | "jobUrl"
  | "applicationLink"
>;

function compactJob(job: CompactJobSource) {
  return {
    id: job.id,
    title: job.title,
    employer: job.employer,
    location: job.location,
    status: job.status,
    fit: job.suitabilityCategory,
    source: job.source,
    datePosted: job.datePosted,
    jobUrl: job.jobUrl,
    applicationLink: job.applicationLink,
  };
}

async function requireJob(id: string): Promise<Job> {
  const job = await jobsRepo.getJobById(id);
  if (!job) throw new Error(JOB_NOT_FOUND);
  return job;
}

const jobIdInput = {
  id: { type: "string", required: true, description: "The job's id." },
} as const;

const MCP_TOOLS: McpTool[] = [
  defineTool({
    name: "search_jobs",
    description:
      'Search jobs with one phrase matched at word starts inside a single field (title, employer or location): its words must sit next to each other, in order, and every word but the last must be typed in full, so "senior eng" finds "Senior Engineer" but "sen eng" finds nothing, and neither finds a Senior role at an Engineering firm. Search one term at a time, such as the employer alone. Rows where the last word was typed in full come first, then the most recently found; total counts every match. An empty query lists the most recently found jobs; lock narrows to one status, or to every job ever applied to. Each row carries fit, the verdict on how well the job fits, best first: great_fit, very_good_fit, good_fit, bad_fit, or null when the job is not scored yet. minFit keeps only jobs scored at that verdict or better, before any limit applies, and total then counts only those; it does not sort the rows by fit.',
    access: "read",
    input: {
      query: {
        type: "string",
        description:
          'One phrase matched at word starts inside a single field, words adjacent and in order, every word but the last typed in full ("senior eng" finds "Senior Engineer"); leave out to list the most recently found jobs.',
      },
      lock: {
        type: "enum",
        values: JOB_SEARCH_LOCKS,
        description: "Narrow to one status, or ever_applied.",
      },
      minFit: {
        type: "enum",
        values: SUITABILITY_CATEGORIES,
        description:
          "Keep only jobs whose fit verdict is this one or better (great_fit, very_good_fit, good_fit, bad_fit, best first); jobs not scored yet are left out.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: jobsRepo.JOB_SEARCH_RESULT_LIMIT,
        description: `How many jobs to return, up to ${jobsRepo.JOB_SEARCH_RESULT_LIMIT} (default ${SEARCH_DEFAULT_LIMIT}).`,
      },
    },
    handler: async (input) => {
      const result = await jobsRepo.searchJobListItems({
        query: input.query ?? "",
        lock: input.lock ?? null,
        minFit: input.minFit ?? null,
      });
      return {
        total: result.total,
        jobs: result.jobs
          .slice(0, input.limit ?? SEARCH_DEFAULT_LIMIT)
          .map(compactJob),
      };
    },
  }),
  defineTool({
    name: "get_job",
    description:
      "Read one job: its posting, description, salary, deadline, fit verdict and its reason, applied date and live posting status.",
    access: "read",
    input: jobIdInput,
    handler: async (input) => {
      const job = await requireJob(input.id);
      return {
        ...compactJob(job),
        jobDescription: job.jobDescription,
        salary: job.salary,
        deadline: job.deadline,
        fitReason: job.suitabilityReason,
        appliedAt: job.appliedAt,
        liveClosed: job.liveClosed,
        liveApplicants: job.liveApplicants,
        liveEasyApply: job.liveEasyApply,
        liveStatusCheckedAt: job.liveStatusCheckedAt,
      };
    },
  }),
  defineTool({
    name: "get_job_documents",
    description:
      "Read a job's application documents: the paths of its CV and cover letter PDFs when they exist, and the cover letter text.",
    access: "read",
    input: jobIdInput,
    handler: async (input) => {
      const job = await requireJob(input.id);
      let coverLetter: CoverLetterDocument | null = null;
      try {
        coverLetter = await getActiveCoverLetterDocument();
      } catch (error) {
        logger.warn("Failed to load active cover letter for MCP documents", {
          jobId: job.id,
          error: sanitizeUnknown(error),
        });
      }
      return {
        cvPdf: job.pdfPath ? `/pdfs/resume_${job.id}.pdf` : null,
        coverLetterPdf: job.coverLetterPdfPath
          ? `/pdfs/cover_letter_${job.id}.pdf`
          : null,
        coverLetterText: buildCoverLetterSnapshot(job, coverLetter),
      };
    },
  }),
  defineTool({
    name: "get_tailored_cv",
    description:
      "Read the CV as tailored for a job: each CV field with its tailored value, or the CV's own value where the job has no tailoring for it.",
    access: "read",
    input: jobIdInput,
    handler: async (input) => {
      const job = await requireJob(input.id);
      let cv: CvDocument | null;
      if (job.cvDocumentId) {
        cv = await cvRepo.getCvDocumentById(job.cvDocumentId);
        if (!cv) {
          throw new Error("The CV this job was tailored with no longer exists");
        }
      } else {
        cv = await getActiveCvDocument();
        if (!cv) throw new Error("No CV uploaded yet");
      }
      const format = resolveCvSourceFormat(await getEffectiveSettings());
      const overrides = job.tailoredFields ?? {};
      return {
        cvDocumentId: cv.id,
        fields: cv.fields.map((field) => ({
          id: field.id,
          role: field.role,
          value: cvFieldText(overrides[field.id] ?? field.value, format),
        })),
      };
    },
  }),
  defineTool({
    name: "get_personal_brief",
    description:
      "Read the candidate's personal brief: free-form background beyond what the CV says.",
    access: "read",
    needsBrief: true,
    input: {},
    handler: async () => ({ brief: await getActivePersonalBrief() }),
  }),
  defineTool({
    name: "mark_applied",
    description:
      "Mark a Ready job as applied. Only a job in the Ready status can be marked applied.",
    access: "write",
    input: jobIdInput,
    handler: async (input) => {
      const job = await requireJob(input.id);
      if (job.status !== "ready") {
        throw new Error(
          `Only a Ready job can be marked applied (this one is ${job.status})`,
        );
      }
      // No `appliedAt`: an explicit value overwrites the mark, while the bare
      // status change stamps only when none is set, keeping the first date.
      const updated = await jobsRepo.updateJob(job.id, { status: "applied" });
      if (!updated) throw new Error(JOB_NOT_FOUND);
      return {
        id: updated.id,
        status: updated.status,
        appliedAt: updated.appliedAt,
      };
    },
  }),
  defineTool({
    name: "add_job_note",
    description: "Add a note with a title and text to a job.",
    access: "write",
    input: {
      ...jobIdInput,
      title: {
        type: "string",
        required: true,
        description: "The note's title.",
      },
      content: {
        type: "string",
        required: true,
        description: "The note's text.",
      },
    },
    handler: async (input) => {
      const parsed = jobNoteSchema.safeParse({
        title: input.title,
        content: input.content,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid note",
        );
      }
      const job = await requireJob(input.id);
      const note = await jobsRepo.createJobNote({
        jobId: job.id,
        ...parsed.data,
      });
      return { noteId: note.id };
    },
  }),
];

const TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

export function listMcpTools(): readonly McpTool[] {
  return MCP_TOOLS;
}

export function getMcpTool(name: string): McpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
