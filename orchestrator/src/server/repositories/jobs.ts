/**
 * Job repository - data access layer for jobs.
 */

import { randomUUID } from "node:crypto";
import {
  DateNormalizationError,
  normalizeDatePosted,
} from "@shared/date-normalize";
import { normalizeDuplicateKey } from "@shared/duplicate-key";
import { canonicalizeJobUrl } from "@shared/job-url";
import { buildLocationEvidence } from "@shared/location-domain.js";
import { logger } from "@infra/logger";
import type {
  CreateJobInput,
  CreateJobNoteInput,
  CvFieldOverrides,
  DuplicateJobGroup,
  Job,
  JobListItem,
  JobLocationEvidence,
  JobNote,
  JobStatus,
  JobsRevisionResponse,
  SuitabilityCategory,
  UpdateJobInput,
  UpdateJobNoteInput,
} from "@shared/types";
import type {
  LocationEvidence,
  LocationEvidenceEntry,
} from "@shared/types/location";
import type { BenchSampleCategory } from "@shared/types/scoring-bench";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  isProviderInstanceSource,
  resolveSourceDisplayLabel,
} from "../services/sources/display";
import { deleteOrphanedJobPdfs } from "./job-pdfs";
import { getAllProviderInstances } from "./provider-instances";
import { db, schema } from "../db/index";

const {
  interviews,
  jobChatMessages,
  jobChatRuns,
  jobChatThreads,
  jobNotes,
  jobs,
  tasks,
} = schema;

type AppliedDuplicateMatchCandidate = {
  id: string;
  title: string;
  employer: string;
  status: Extract<JobStatus, "applied" | "in_progress">;
  appliedAt: string;
  discoveredAt: string;
};

function normalizeStatusFilter(statuses?: JobStatus[]): string | null {
  if (!statuses || statuses.length === 0) return null;
  return Array.from(new Set(statuses)).sort().join(",");
}

function parseLocationEvidence(
  raw: string | null | undefined,
): JobLocationEvidence | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return buildLocationEvidence(
      Array.isArray(parsed)
        ? (parsed as readonly LocationEvidenceEntry[])
        : (parsed as LocationEvidence),
    );
  } catch {
    return null;
  }
}

function parseStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function parseFieldOverrides(raw: unknown): CvFieldOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CvFieldOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function serializeLocationEvidence(
  evidence: JobLocationEvidence | null | undefined,
): string | null {
  if (!evidence) return null;
  return JSON.stringify(buildLocationEvidence(evidence));
}

/**
 * Get all jobs, optionally filtered by status.
 */
export async function getAllJobs(statuses?: JobStatus[]): Promise<Job[]> {
  const query =
    statuses && statuses.length > 0
      ? db
          .select()
          .from(jobs)
          .where(inArray(jobs.status, statuses))
          .orderBy(desc(jobs.discoveredAt))
      : db.select().from(jobs).orderBy(desc(jobs.discoveredAt));

  const rows = await query;
  return rows.map(mapRowToJob);
}

/**
 * Get lightweight list items for jobs, optionally filtered by status.
 */
export async function getJobListItems(
  statuses?: JobStatus[],
  employer?: string,
): Promise<JobListItem[]> {
  const selection = {
    id: jobs.id,
    source: jobs.source,
    title: jobs.title,
    employer: jobs.employer,
    jobUrl: jobs.jobUrl,
    applicationLink: jobs.applicationLink,
    datePosted: jobs.datePosted,
    deadline: jobs.deadline,
    salary: jobs.salary,
    location: jobs.location,
    status: jobs.status,
    outcome: jobs.outcome,
    closedAt: jobs.closedAt,
    profileId: jobs.profileId,
    suitabilityCategory: jobs.suitabilityCategory,
    tailoringFailureReason: jobs.tailoringFailureReason,
    jobType: jobs.jobType,
    jobFunction: jobs.jobFunction,
    salaryMinAmount: jobs.salaryMinAmount,
    salaryMaxAmount: jobs.salaryMaxAmount,
    salaryCurrency: jobs.salaryCurrency,
    repostedAt: jobs.repostedAt,
    repostCount: jobs.repostCount,
    discoveredAt: jobs.discoveredAt,
    readyAt: jobs.readyAt,
    appliedAt: jobs.appliedAt,
    updatedAt: jobs.updatedAt,
  } as const;

  const conditions = [
    statuses && statuses.length > 0
      ? inArray(jobs.status, statuses)
      : undefined,
    employer ? sql`lower(${jobs.employer}) = lower(${employer})` : undefined,
  ].filter(Boolean);
  const whereClause =
    conditions.length > 0 ? and(...conditions) : undefined;

  const baseQuery = db.select(selection).from(jobs);
  const rows = await (whereClause
    ? baseQuery.where(whereClause).orderBy(desc(jobs.discoveredAt))
    : baseQuery.orderBy(desc(jobs.discoveredAt)));

  // Resolve a human label for each row's source. Provider-instance sources
  // (`<provider>:<uuid>`) need the configured instances to map to the user's
  // display name; only load them when at least one such source is present.
  const hasProviderInstanceSource = rows.some((row) =>
    isProviderInstanceSource(row.source),
  );
  const providerInstances = hasProviderInstanceSource
    ? await getAllProviderInstances()
    : undefined;

  return rows.map((row) => ({
    ...row,
    source: row.source as JobListItem["source"],
    status: row.status as JobStatus,
    sourceLabel: resolveSourceDisplayLabel({
      source: row.source,
      providerInstances,
    }),
  }));
}

// Statuses the user is actively triaging — duplicate detection is scoped here
// so aged/terminal rows don't pollute the review surface.
const DUPLICATE_SCOPE_STATUSES: JobStatus[] = [
  "discovered",
  "selected",
  "processing",
  "ready",
];

/**
 * Group active-triage jobs that share a normalized title + company. On-demand
 * only (not part of the hot list-fetch path), so the JS grouping is cheap.
 * Returns groups of 2+ members, each ordered as the list query returns them
 * (newest discovered first); empty-key rows are excluded.
 */
export async function getDuplicateGroups(): Promise<DuplicateJobGroup[]> {
  const items = await getJobListItems(DUPLICATE_SCOPE_STATUSES);
  const byKey = new Map<string, JobListItem[]>();

  for (const item of items) {
    const key = normalizeDuplicateKey(item.title, item.employer);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      byKey.set(key, [item]);
    }
  }

  const groups: DuplicateJobGroup[] = [];
  for (const [key, jobsInGroup] of byKey) {
    if (jobsInGroup.length < 2) continue;
    const first = jobsInGroup[0];
    groups.push({
      key,
      title: first.title,
      employer: first.employer,
      jobs: jobsInGroup,
    });
  }

  // Largest clusters first so the most-impactful cleanups lead.
  groups.sort((a, b) => b.jobs.length - a.jobs.length);
  return groups;
}

export async function getAppliedDuplicateMatchCandidates(): Promise<
  AppliedDuplicateMatchCandidate[]
> {
  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      employer: jobs.employer,
      status: jobs.status,
      appliedAt: jobs.appliedAt,
      discoveredAt: jobs.discoveredAt,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["applied", "in_progress"]),
        sql`${jobs.appliedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(jobs.appliedAt));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    employer: row.employer,
    status: row.status as AppliedDuplicateMatchCandidate["status"],
    appliedAt: row.appliedAt as string,
    discoveredAt: row.discoveredAt,
  }));
}

/**
 * Get a lightweight revision token for jobs list invalidation.
 */
export async function getJobsRevision(
  statuses?: JobStatus[],
): Promise<JobsRevisionResponse> {
  const statusFilter = normalizeStatusFilter(statuses);
  const whereClause =
    statuses && statuses.length > 0
      ? inArray(jobs.status, statuses)
      : undefined;

  const baseQuery = db
    .select({
      latestUpdatedAt: sql<string | null>`max(${jobs.updatedAt})`,
      total: sql<number>`count(*)`,
    })
    .from(jobs);
  const [row] = whereClause
    ? await baseQuery.where(whereClause)
    : await baseQuery;

  const latestUpdatedAt = row?.latestUpdatedAt ?? null;
  const total = row?.total ?? 0;
  const revision = `${latestUpdatedAt ?? "none"}:${total}:${statusFilter ?? "all"}`;

  return {
    revision,
    latestUpdatedAt,
    total,
    statusFilter,
  };
}

/**
 * Get a single job by ID.
 */
export async function getJobById(id: string): Promise<Job | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ? mapRowToJob(row) : null;
}

/**
 * Reconcile transient statuses left behind by a previous process.
 *
 * `processing` rows are tailoring runs that were in flight when the server
 * stopped — the in-process runner is gone, so they're orphaned. Keep them in
 * the Tailoring tab (they can be retried in place) and stamp an interrupt
 * reason ONLY where none exists, so a real failure reason from a prior attempt
 * survives the restart. `selected` is a retired status (the staging tab was
 * removed); fold any legacy rows back into the Inbox.
 *
 * Idempotent: a clean restart has no `processing`/`selected` rows, so this is
 * a no-op. Runs once at server startup.
 */
export async function reconcileTransientStatuses(): Promise<{
  processing: number;
  selected: number;
}> {
  const processingResult = await db
    .update(jobs)
    .set({ tailoringFailureReason: "Tailoring interrupted (server restart)" })
    .where(
      and(eq(jobs.status, "processing"), isNull(jobs.tailoringFailureReason)),
    );
  const selectedResult = await db
    .update(jobs)
    .set({ status: "discovered" })
    .where(eq(jobs.status, "selected"));
  return {
    processing: processingResult.changes ?? 0,
    selected: selectedResult.changes ?? 0,
  };
}

export async function listJobNotes(jobId: string): Promise<JobNote[]> {
  const rows = await db
    .select()
    .from(jobNotes)
    .where(eq(jobNotes.jobId, jobId))
    .orderBy(
      desc(jobNotes.updatedAt),
      desc(jobNotes.createdAt),
      desc(jobNotes.id),
    );

  return rows.map(mapRowToJobNote);
}

export async function getJobNoteById(noteId: string): Promise<JobNote | null> {
  const [row] = await db.select().from(jobNotes).where(eq(jobNotes.id, noteId));
  return row ? mapRowToJobNote(row) : null;
}

export async function getJobNoteForJob(
  jobId: string,
  noteId: string,
): Promise<JobNote | null> {
  const [row] = await db
    .select()
    .from(jobNotes)
    .where(and(eq(jobNotes.id, noteId), eq(jobNotes.jobId, jobId)));
  return row ? mapRowToJobNote(row) : null;
}

export async function createJobNote(
  input: CreateJobNoteInput & { jobId: string },
): Promise<JobNote> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.insert(jobNotes).values({
    id,
    jobId: input.jobId,
    title: input.title,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  });

  const note = await getJobNoteById(id);
  if (!note) {
    throw new Error(`Failed to retrieve newly created job note with ID ${id}`);
  }
  return note;
}

export async function updateJobNote(
  input: { jobId: string; noteId: string } & UpdateJobNoteInput,
): Promise<JobNote | null> {
  const now = new Date().toISOString();

  await db
    .update(jobNotes)
    .set({
      title: input.title,
      content: input.content,
      updatedAt: now,
    })
    .where(and(eq(jobNotes.id, input.noteId), eq(jobNotes.jobId, input.jobId)));

  return getJobNoteForJob(input.jobId, input.noteId);
}

export async function deleteJobNote(input: {
  jobId: string;
  noteId: string;
}): Promise<number> {
  const result = await db
    .delete(jobNotes)
    .where(and(eq(jobNotes.id, input.noteId), eq(jobNotes.jobId, input.jobId)));

  return result.changes;
}

export async function listJobSummariesByIds(jobIds: string[]): Promise<
  Array<{
    id: string;
    title: string;
    employer: string;
  }>
> {
  if (jobIds.length === 0) return [];

  return db
    .select({
      id: jobs.id,
      title: jobs.title,
      employer: jobs.employer,
    })
    .from(jobs)
    .where(inArray(jobs.id, jobIds));
}

/**
 * Get a job by its URL (for deduplication).
 */
export async function getJobByUrl(jobUrl: string): Promise<Job | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.jobUrl, jobUrl));
  return row ? mapRowToJob(row) : null;
}

/**
 * Get all known job URLs (for deduplication / crawler optimizations).
 */
export async function getAllJobUrls(): Promise<string[]> {
  const rows = await db.select({ jobUrl: jobs.jobUrl }).from(jobs);
  return rows.map((r) => r.jobUrl);
}

async function insertJob(input: CreateJobInput): Promise<Job> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.insert(jobs).values({
    id,
    source: input.source,
    sourceJobId: input.sourceJobId ?? null,
    jobUrlDirect: input.jobUrlDirect ?? null,
    datePosted: input.datePosted ?? null,
    title: input.title,
    employer: input.employer,
    employerUrl: input.employerUrl ?? null,
    jobUrl: input.jobUrl,
    applicationLink: input.applicationLink ?? null,
    disciplines: input.disciplines ?? null,
    deadline: input.deadline ?? null,
    salary: input.salary ?? null,
    location: input.location ?? null,
    locationEvidence: serializeLocationEvidence(input.locationEvidence),
    degreeRequired: input.degreeRequired ?? null,
    starting: input.starting ?? null,
    jobDescription: input.jobDescription ?? null,
    jobType: input.jobType ?? null,
    salarySource: input.salarySource ?? null,
    salaryInterval: input.salaryInterval ?? null,
    salaryMinAmount: input.salaryMinAmount ?? null,
    salaryMaxAmount: input.salaryMaxAmount ?? null,
    salaryCurrency: input.salaryCurrency ?? null,
    isRemote: input.isRemote ?? null,
    jobLevel: input.jobLevel ?? null,
    jobFunction: input.jobFunction ?? null,
    listingType: input.listingType ?? null,
    emails: input.emails ?? null,
    companyIndustry: input.companyIndustry ?? null,
    companyLogo: input.companyLogo ?? null,
    companyUrlDirect: input.companyUrlDirect ?? null,
    companyAddresses: input.companyAddresses ?? null,
    companyNumEmployees: input.companyNumEmployees ?? null,
    companyRevenue: input.companyRevenue ?? null,
    companyDescription: input.companyDescription ?? null,
    skills: input.skills ?? null,
    experienceRange: input.experienceRange ?? null,
    companyRating: input.companyRating ?? null,
    companyReviewsCount: input.companyReviewsCount ?? null,
    vacancyCount: input.vacancyCount ?? null,
    workFromHomeType: input.workFromHomeType ?? null,
    profileId: input.profileId ?? null,
    status: "discovered",
    discoveredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const job = await getJobById(id);
  if (!job) {
    throw new Error(`Failed to retrieve newly created job with ID ${id}`);
  }
  return job;
}

function isJobUrlUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed: jobs\.job_url/i.test(error.message);
}

async function tryInsertJob(input: CreateJobInput): Promise<Job | null> {
  try {
    return await insertJob(input);
  } catch (error) {
    if (isJobUrlUniqueViolation(error)) return null;
    throw error;
  }
}

/**
 * Create jobs (or return existing jobs for duplicate URLs).
 *
 * On URL collision in the bulk path, if the incoming row carries a newer
 * `datePosted` than the existing row, treat it as a repost: bump
 * `repostCount`, set `repostedAt = now`, advance `datePosted`, and re-promote
 * the row to `discovered` if it had been shelved (either auto-aged into
 * `backlog` or manually swept into `stale`). Other user-driven statuses
 * (`selected`, `skipped`, `closed`, etc.) keep their position — those reflect
 * active work or a final decision and shouldn't be undone by a repost.
 */
/**
 * Optional per-input categorization callback for the array form of
 * `createJobs`. Invoked once per unique input as it lands in a bucket, so
 * callers (the import step) can capture the actual jobs for the run popup
 * without changing the count-based return shape.
 */
export type CreateJobsCategorizeFn = (
  bucket: "imported" | "duplicated" | "rejected",
  input: CreateJobInput,
  reason?: string,
) => void;

export async function createJobs(input: CreateJobInput): Promise<Job>;
export async function createJobs(
  inputs: CreateJobInput[],
  onCategorize?: CreateJobsCategorizeFn,
): Promise<{
  created: number;
  skipped: number;
  reposted: number;
  rejected: number;
}>;
export async function createJobs(
  inputOrInputs: CreateJobInput | CreateJobInput[],
  onCategorize?: CreateJobsCategorizeFn,
): Promise<
  Job | { created: number; skipped: number; reposted: number; rejected: number }
> {
  if (!Array.isArray(inputOrInputs)) {
    const normalized: CreateJobInput = {
      ...inputOrInputs,
      jobUrl: canonicalizeJobUrl(inputOrInputs.jobUrl),
      datePosted: normalizeDatePosted(inputOrInputs.datePosted) ?? undefined,
    };
    const inserted = await tryInsertJob(normalized);
    if (inserted) return inserted;
    const existing = await getJobByUrl(normalized.jobUrl);
    if (existing) return existing;
    throw new Error("Failed to create or resolve existing job by URL");
  }

  let rejected = 0;
  const normalizedInputs: CreateJobInput[] = [];
  for (const input of inputOrInputs) {
    try {
      normalizedInputs.push({
        ...input,
        jobUrl: canonicalizeJobUrl(input.jobUrl),
        datePosted: normalizeDatePosted(input.datePosted) ?? undefined,
      });
    } catch (error) {
      rejected += 1;
      onCategorize?.("rejected", input, "bad data");
      logger.error("Rejecting job ingestion: bad date_posted", {
        source: input.source,
        jobUrl: input.jobUrl,
        rawDatePosted:
          error instanceof DateNormalizationError
            ? error.rawValue
            : String(input.datePosted),
        message:
          error instanceof Error ? error.message : "unknown normalize error",
      });
    }
  }

  const byUrl = new Map<
    string,
    {
      input: CreateJobInput;
      count: number;
    }
  >();

  for (const input of normalizedInputs) {
    const existing = byUrl.get(input.jobUrl);
    if (existing) {
      existing.count += 1;
    } else {
      byUrl.set(input.jobUrl, { input, count: 1 });
    }
  }

  let created = 0;
  let skipped = 0;
  let reposted = 0;

  const uniqueUrls = Array.from(byUrl.keys());
  if (uniqueUrls.length === 0) {
    return { created, skipped, reposted, rejected };
  }

  const existingRows = await db
    .select({
      id: jobs.id,
      jobUrl: jobs.jobUrl,
      datePosted: jobs.datePosted,
      status: jobs.status,
      repostCount: jobs.repostCount,
    })
    .from(jobs)
    .where(inArray(jobs.jobUrl, uniqueUrls));
  const existingByUrl = new Map(existingRows.map((row) => [row.jobUrl, row]));

  for (const { input, count } of byUrl.values()) {
    const existing = existingByUrl.get(input.jobUrl);
    if (existing) {
      const incomingDate = input.datePosted ?? null;
      const isForwardShift =
        incomingDate !== null &&
        existing.datePosted !== null &&
        incomingDate > existing.datePosted;
      if (isForwardShift) {
        const now = new Date().toISOString();
        const nextStatus =
          existing.status === "backlog" || existing.status === "stale"
            ? "discovered"
            : existing.status;
        await db
          .update(jobs)
          .set({
            datePosted: incomingDate,
            repostedAt: now,
            repostCount: existing.repostCount + 1,
            status: nextStatus,
            updatedAt: now,
          })
          .where(eq(jobs.id, existing.id));
        reposted += 1;
        skipped += count - 1;
        onCategorize?.("imported", input);
      } else {
        skipped += count;
        onCategorize?.("duplicated", input);
      }
      continue;
    }

    const inserted = await tryInsertJob(input);
    if (!inserted) {
      skipped += count;
      onCategorize?.("duplicated", input);
      continue;
    }

    created += 1;
    skipped += count - 1;
    onCategorize?.("imported", input);
  }

  return { created, skipped, reposted, rejected };
}

/**
 * Create a single job (or return existing if URL matches).
 */
export async function createJob(input: CreateJobInput): Promise<Job> {
  return createJobs(input);
}

/**
 * Update a job.
 */
export async function updateJob(
  id: string,
  input: UpdateJobInput,
): Promise<Job | null> {
  const now = new Date().toISOString();
  const {
    locationEvidence,
    tailoredFields,
    cvFieldLocks,
    tailoringMatched,
    tailoringSkipped,
    coverLetterFieldOverrides,
    ...updateFields
  } = input;
  const readyAtUpdate =
    input.readyAt !== undefined
      ? { readyAt: input.readyAt }
      : input.status === "ready"
        ? { readyAt: sql`coalesce(${jobs.readyAt}, ${now})` }
        : {};
  const appliedAtUpdate =
    input.appliedAt !== undefined
      ? { appliedAt: input.appliedAt }
      : input.status === "applied"
        ? { appliedAt: sql`coalesce(${jobs.appliedAt}, ${now})` }
        : {};

  await db
    .update(jobs)
    .set({
      ...updateFields,
      ...(locationEvidence !== undefined
        ? { locationEvidence: serializeLocationEvidence(locationEvidence) }
        : {}),
      ...(tailoredFields !== undefined ? { tailoredFields } : {}),
      ...(cvFieldLocks !== undefined ? { cvFieldLocks } : {}),
      ...(tailoringMatched !== undefined ? { tailoringMatched } : {}),
      ...(tailoringSkipped !== undefined ? { tailoringSkipped } : {}),
      ...(coverLetterFieldOverrides !== undefined
        ? { coverLetterFieldOverrides }
        : {}),
      updatedAt: now,
      ...(input.status === "processing" ? { processedAt: now } : {}),
      ...readyAtUpdate,
      ...appliedAtUpdate,
    })
    .where(eq(jobs.id, id));

  return getJobById(id);
}

/**
 * Get job statistics by status.
 */
export async function getJobStats(): Promise<Record<JobStatus, number>> {
  const result = await db
    .select({
      status: jobs.status,
      count: sql<number>`count(*)`,
    })
    .from(jobs)
    .groupBy(jobs.status);

  const stats: Record<JobStatus, number> = {
    discovered: 0,
    selected: 0,
    processing: 0,
    ready: 0,
    applied: 0,
    in_progress: 0,
    backlog: 0,
    stale: 0,
    skipped: 0,
    closed: 0,
  };

  for (const row of result) {
    stats[row.status as JobStatus] = row.count;
  }

  return stats;
}

/**
 * Get jobs ready for processing (discovered with description).
 */
export async function getJobsForProcessing(limit: number = 10): Promise<Job[]> {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "discovered"),
        sql`${jobs.jobDescription} IS NOT NULL`,
      ),
    )
    .orderBy(desc(jobs.discoveredAt))
    .limit(limit);

  return rows.map(mapRowToJob);
}

/**
 * Get discovered jobs missing a suitability category.
 */
export async function getUnscoredDiscoveredJobs(
  limit?: number,
): Promise<Job[]> {
  const query = db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.status, "discovered"), isNull(jobs.suitabilityCategory)),
    )
    .orderBy(desc(jobs.discoveredAt));

  const rows =
    typeof limit === "number" ? await query.limit(limit) : await query;
  return rows.map(mapRowToJob);
}

/**
 * "Scored as one of these, and/or never scored at all" as one SQL condition.
 * The unscored half has to be an IS NULL test: `suitability_category IN (...)`
 * is never true for NULL, so a request for unscored jobs alone would silently
 * return nothing.
 */
function buildStoredCategoryFilter(categories: BenchSampleCategory[]) {
  const scored = categories.filter(
    (category): category is SuitabilityCategory => category !== "unscored",
  );
  const wantsUnscored = categories.includes("unscored");

  const clauses = [
    scored.length > 0 ? inArray(jobs.suitabilityCategory, scored) : undefined,
    wantsUnscored ? isNull(jobs.suitabilityCategory) : undefined,
  ].filter((clause) => clause !== undefined);

  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

/**
 * Draw a uniform random sample of jobs that are still alive (anything but
 * `closed`) and long enough to be worth judging.
 *
 * `minDescriptionChars` is a parameter rather than a constant here so the
 * caller can pass the scorer's own threshold: duplicating the number in the
 * repository would let the sampler and the scoring gate drift apart, and a
 * repository importing a service to read it would invert the layering.
 */
export async function getRandomScoreableJobs(args: {
  limit: number;
  minDescriptionChars: number;
  /**
   * Restricts the draw to these saved fit categories, where "unscored" means a
   * job with no category at all. Undefined means no restriction; an empty array
   * means nothing qualifies, and is answered with an empty sample rather than
   * being quietly read as "everything".
   */
  categories?: BenchSampleCategory[];
}): Promise<Job[]> {
  if (args.limit <= 0) return [];
  if (args.categories && args.categories.length === 0) return [];

  const categoryFilter = args.categories
    ? buildStoredCategoryFilter(args.categories)
    : undefined;

  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        ne(jobs.status, "closed"),
        ...(categoryFilter ? [categoryFilter] : []),
        // SQLite's one-argument trim() strips SPACES only, so the whitespace
        // set is spelled out to match JS `.trim()` — a description padded with
        // newlines would otherwise pass here and then be rejected as too short
        // by the scorer, which is exactly the drift this query must not have.
        sql`length(trim(coalesce(${jobs.jobDescription}, ''), char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) >= ${args.minDescriptionChars}`,
      ),
    )
    .orderBy(sql`random()`)
    .limit(args.limit);

  return rows.map(mapRowToJob);
}

/**
 * Delete ONE job outright, with everything hanging off it.
 *
 * `PRAGMA foreign_keys` is never enabled on the runtime connection, so the
 * `REFERENCES ... ON DELETE CASCADE` clauses in the schema are documentation,
 * not behaviour — every child row has to be swept here by hand. Missing one
 * leaves invisible rows that no screen can reach and no later delete will find.
 *
 * The job row goes FIRST on purpose: if a later statement failed, the user
 * would be left with exactly what they asked for (the job gone) plus some
 * unreachable child rows, rather than a job still sitting in the list with its
 * notes and chat history silently destroyed.
 *
 * Returns false when no row matched — the caller maps that to a 404.
 */
export async function deleteJobById(jobId: string): Promise<boolean> {
  const result = await db.delete(jobs).where(eq(jobs.id, jobId)).run();
  if (result.changes === 0) return false;

  // Chat lives in three tables, all carrying job_id.
  await db.delete(jobChatMessages).where(eq(jobChatMessages.jobId, jobId));
  await db.delete(jobChatRuns).where(eq(jobChatRuns.jobId, jobId));
  await db.delete(jobChatThreads).where(eq(jobChatThreads.jobId, jobId));
  await db.delete(jobNotes).where(eq(jobNotes.jobId, jobId));
  // Legacy tables from the stripped kanban: nothing writes them today, but they
  // are still keyed on the job, so a delete that skipped them would strand rows
  // the moment anything revives them.
  await db.delete(tasks).where(eq(tasks.applicationId, jobId));
  await db.delete(interviews).where(eq(interviews.applicationId, jobId));
  // Same self-healing sweep the other two delete paths use — it also picks up
  // any PDF orphaned by an earlier failure.
  await deleteOrphanedJobPdfs();

  return true;
}

/**
 * Delete jobs by status.
 */
export async function deleteJobsByStatus(status: JobStatus): Promise<number> {
  const result = await db.delete(jobs).where(eq(jobs.status, status)).run();
  // No FK cascade at runtime (PRAGMA foreign_keys is never enabled) — sweep
  // the deleted jobs' PDF blobs explicitly.
  await deleteOrphanedJobPdfs();
  return result.changes;
}

/**
 * Statuses each sweep scope is allowed to pull aged rows from.
 *  - `shelf`  — the passive holding tiers (Inbox / Selected / Backlog).
 *  - `active` — in-flight rows (Ready / Live), swept on explicit request only.
 * Both target the same `stale` status; the scope just bounds the source set so
 * the default sweep never touches a user's tailored/applied rows by surprise.
 */
const STALE_SWEEP_SCOPE_STATUSES = {
  shelf: ["discovered", "selected", "backlog"],
  active: ["ready", "applied", "in_progress"],
} satisfies Record<string, JobStatus[]>;

export type StaleSweepScope = keyof typeof STALE_SWEEP_SCOPE_STATUSES;

/**
 * Move every row in the scope's source statuses whose effective age
 * (`date_posted` when present, else `discovered_at`) is older than
 * `thresholdDays` into the `stale` status. Returns the total moved plus a
 * per-source-status breakdown.
 *
 * Mirrors the client's `getJobPostedValue` (datePosted ?? discoveredAt) so
 * the sweep matches what the user sees in the "Posted Xd" / "Found Xd"
 * pill. `date_posted` is mixed-format text — jobspy stores Unix-ms numeric
 * strings while every other extractor stores ISO — so the SQL CASE
 * detects all-digit strings and routes them through `unixepoch` before
 * comparison. Unparseable values fall back to `discovered_at` via COALESCE.
 */
export async function sweepStaleJobs(
  thresholdDays: number,
  scope: StaleSweepScope = "shelf",
): Promise<{
  moved: number;
  breakdown: Partial<Record<JobStatus, number>>;
}> {
  const eligibleStatuses: JobStatus[] = [...STALE_SWEEP_SCOPE_STATUSES[scope]];
  const offsetParam = `-${thresholdDays} days`;
  const cutoffClause = sql`datetime('now', ${offsetParam})`;
  // Effective age: parse date_posted (ISO or Unix-ms numeric string) and
  // fall back to discovered_at when null or unparseable. SQLite's
  // datetime() returns NULL for non-parseable inputs, which COALESCE
  // collapses to the fallback.
  const effectiveDateClause = sql`COALESCE(
    CASE
      WHEN ${jobs.datePosted} IS NULL THEN NULL
      WHEN length(${jobs.datePosted}) > 0
        AND ${jobs.datePosted} NOT GLOB '*[^0-9]*'
        THEN datetime(CAST(${jobs.datePosted} AS INTEGER) / 1000, 'unixepoch')
      ELSE datetime(${jobs.datePosted})
    END,
    datetime(${jobs.discoveredAt})
  )`;
  const ageWhere = and(
    inArray(jobs.status, eligibleStatuses),
    sql`${effectiveDateClause} < ${cutoffClause}`,
  );
  const rows = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(ageWhere);
  const breakdown: Partial<Record<JobStatus, number>> = {};
  for (const row of rows) {
    breakdown[row.status] = (breakdown[row.status] ?? 0) + 1;
  }
  const moved = rows.length;
  if (moved === 0) return { moved, breakdown };

  await db
    .update(jobs)
    .set({ status: "stale", updatedAt: sql`(datetime('now'))` })
    .where(ageWhere);

  return { moved, breakdown };
}

/**
 * Delete jobs whose suitability_category equals one of the supplied values
 * (excluding applied and in_progress jobs).
 */
export async function deleteJobsByCategory(
  categories: readonly SuitabilityCategory[],
): Promise<number> {
  if (categories.length === 0) return 0;
  const result = await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.suitabilityCategory, categories as SuitabilityCategory[]),
        ne(jobs.status, "applied"),
        ne(jobs.status, "in_progress"),
      ),
    )
    .run();
  // No FK cascade at runtime — sweep the deleted jobs' PDF blobs explicitly.
  await deleteOrphanedJobPdfs();
  return result.changes;
}

// Helper to map database row to Job type
function mapRowToJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    source: row.source as Job["source"],
    sourceJobId: row.sourceJobId ?? null,
    jobUrlDirect: row.jobUrlDirect ?? null,
    datePosted: row.datePosted ?? null,
    title: row.title,
    employer: row.employer,
    employerUrl: row.employerUrl,
    jobUrl: row.jobUrl,
    applicationLink: row.applicationLink,
    disciplines: row.disciplines,
    deadline: row.deadline,
    salary: row.salary,
    location: row.location,
    locationEvidence: parseLocationEvidence(row.locationEvidence),
    degreeRequired: row.degreeRequired,
    starting: row.starting,
    jobDescription: row.jobDescription,
    status: row.status as JobStatus,
    outcome: row.outcome ?? null,
    closedAt: row.closedAt ?? null,
    profileId: row.profileId ?? null,
    suitabilityCategory: row.suitabilityCategory ?? null,
    suitabilityReason: row.suitabilityReason,
    suitabilityModel: row.suitabilityModel ?? null,
    suitabilityEffort: row.suitabilityEffort ?? null,
    tailoredFields: parseFieldOverrides(row.tailoredFields),
    cvFieldLocks: parseStringList(row.cvFieldLocks) ?? [],
    tailoringMatched: parseStringList(row.tailoringMatched),
    tailoringSkipped: parseStringList(row.tailoringSkipped),
    tailoringFailureReason: row.tailoringFailureReason ?? null,
    cvDocumentId: row.cvDocumentId ?? null,
    pdfPath: row.pdfPath,
    coverLetterDraft: row.coverLetterDraft ?? "",
    coverLetterDocumentId: row.coverLetterDocumentId ?? null,
    coverLetterFieldOverrides: parseFieldOverrides(row.coverLetterFieldOverrides),
    coverLetterPdfPath: row.coverLetterPdfPath ?? null,
    interviewPrep: row.interviewPrep ?? "",
    jobType: row.jobType ?? null,
    salarySource: row.salarySource ?? null,
    salaryInterval: row.salaryInterval ?? null,
    salaryMinAmount: row.salaryMinAmount ?? null,
    salaryMaxAmount: row.salaryMaxAmount ?? null,
    salaryCurrency: row.salaryCurrency ?? null,
    isRemote: row.isRemote ?? null,
    jobLevel: row.jobLevel ?? null,
    jobFunction: row.jobFunction ?? null,
    listingType: row.listingType ?? null,
    emails: row.emails ?? null,
    companyIndustry: row.companyIndustry ?? null,
    companyLogo: row.companyLogo ?? null,
    companyUrlDirect: row.companyUrlDirect ?? null,
    companyAddresses: row.companyAddresses ?? null,
    companyNumEmployees: row.companyNumEmployees ?? null,
    companyRevenue: row.companyRevenue ?? null,
    companyDescription: row.companyDescription ?? null,
    skills: row.skills ?? null,
    experienceRange: row.experienceRange ?? null,
    companyRating: row.companyRating ?? null,
    companyReviewsCount: row.companyReviewsCount ?? null,
    vacancyCount: row.vacancyCount ?? null,
    workFromHomeType: row.workFromHomeType ?? null,
    repostedAt: row.repostedAt ?? null,
    repostCount: row.repostCount ?? 0,
    discoveredAt: row.discoveredAt,
    processedAt: row.processedAt,
    readyAt: row.readyAt,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRowToJobNote(row: typeof jobNotes.$inferSelect): JobNote {
  return {
    id: row.id,
    jobId: row.jobId,
    title: row.title,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
