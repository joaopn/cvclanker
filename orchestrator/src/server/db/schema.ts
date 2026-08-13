/**
 * Database schema using Drizzle ORM with SQLite.
 */

import {
  APPLICATION_OUTCOMES,
  APPLICATION_TASK_TYPES,
  INTERVIEW_OUTCOMES,
  INTERVIEW_TYPES,
  JOB_CHAT_EDIT_STATUSES,
  JOB_CHAT_MESSAGE_ROLES,
  JOB_CHAT_MESSAGE_STATUSES,
  JOB_CHAT_RUN_STATUSES,
  SUITABILITY_CATEGORIES,
} from "@shared/types";
import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const cvDocuments = sqliteTable("cv_documents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  originalArchive: blob("original_archive", { mode: "buffer" }).notNull(),
  flattenedTex: text("flattened_tex").notNull(),
  fields: text("fields", { mode: "json" }).notNull().default(sql`('[]')`),
  personalBrief: text("personal_brief").notNull().default(""),
  // 5e substrate columns. Empty defaults so existing 5d-era rows survive the
  // ALTER. Render path still uses `flattened_tex` + `fields` until 5e.4
  // cuts over.
  templatedTex: text("templated_tex").notNull().default(""),
  defaultFieldValues: text("default_field_values", { mode: "json" })
    .notNull()
    .default(sql`('{}')`),
  lastCompileStderr: text("last_compile_stderr"),
  compileAttempts: integer("compile_attempts").notNull().default(0),
  // 5e.3a: per-CV system prompt override. Empty string means "use the
  // server default at extraction time" (the cv-template-extract YAML).
  // Capped at 50KB at the API layer.
  extractionPrompt: text("extraction_prompt").notNull().default(""),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const coverLetterDocuments = sqliteTable("cover_letter_documents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  originalArchive: blob("original_archive", { mode: "buffer" }).notNull(),
  flattenedTex: text("flattened_tex").notNull(),
  fields: text("fields", { mode: "json" }).notNull().default(sql`('[]')`),
  templatedTex: text("templated_tex").notNull().default(""),
  defaultFieldValues: text("default_field_values", { mode: "json" })
    .notNull()
    .default(sql`('{}')`),
  lastCompileStderr: text("last_compile_stderr"),
  compileAttempts: integer("compile_attempts").notNull().default(0),
  extractionPrompt: text("extraction_prompt").notNull().default(""),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),

  // From crawler
  source: text("source").notNull().default("linkedin"),
  sourceJobId: text("source_job_id"),
  jobUrlDirect: text("job_url_direct"),
  datePosted: text("date_posted"),
  title: text("title").notNull(),
  employer: text("employer").notNull(),
  employerUrl: text("employer_url"),
  jobUrl: text("job_url").notNull().unique(),
  applicationLink: text("application_link"),
  disciplines: text("disciplines"),
  deadline: text("deadline"),
  salary: text("salary"),
  location: text("location"),
  locationEvidence: text("location_evidence"),
  degreeRequired: text("degree_required"),
  starting: text("starting"),
  jobDescription: text("job_description"),

  // JobSpy fields (nullable for other sources)
  jobType: text("job_type"),
  salarySource: text("salary_source"),
  salaryInterval: text("salary_interval"),
  salaryMinAmount: real("salary_min_amount"),
  salaryMaxAmount: real("salary_max_amount"),
  salaryCurrency: text("salary_currency"),
  isRemote: integer("is_remote", { mode: "boolean" }),
  jobLevel: text("job_level"),
  jobFunction: text("job_function"),
  listingType: text("listing_type"),
  emails: text("emails"),
  companyIndustry: text("company_industry"),
  companyLogo: text("company_logo"),
  companyUrlDirect: text("company_url_direct"),
  companyAddresses: text("company_addresses"),
  companyNumEmployees: text("company_num_employees"),
  companyRevenue: text("company_revenue"),
  companyDescription: text("company_description"),
  skills: text("skills"),
  experienceRange: text("experience_range"),
  companyRating: real("company_rating"),
  companyReviewsCount: integer("company_reviews_count"),
  vacancyCount: integer("vacancy_count"),
  workFromHomeType: text("work_from_home_type"),

  // Orchestrator enrichments
  status: text("status", {
    enum: [
      "discovered",
      "selected",
      "processing",
      "ready",
      "applied",
      "in_progress",
      "backlog",
      "stale",
      "skipped",
      "closed",
    ],
  })
    .notNull()
    .default("discovered"),
  outcome: text("outcome", { enum: APPLICATION_OUTCOMES }),
  closedAt: integer("closed_at", { mode: "number" }),
  // 5g repost tracking. `repostedAt` set whenever an import collision
  // observes a forward `datePosted` shift; `repostCount` is incremented
  // alongside. Backlog rows re-promote to `discovered` on the same shift.
  repostedAt: text("reposted_at"),
  repostCount: integer("repost_count").notNull().default(0),
  suitabilityCategory: text("suitability_category", {
    enum: SUITABILITY_CATEGORIES,
  }),
  suitabilityReason: text("suitability_reason"),
  tailoredFields: text("tailored_fields", { mode: "json" })
    .notNull()
    .default(sql`('{}')`),
  cvFieldLocks: text("cv_field_locks", { mode: "json" })
    .notNull()
    .default(sql`('[]')`),
  tailoringMatched: text("tailoring_matched", { mode: "json" }),
  tailoringSkipped: text("tailoring_skipped", { mode: "json" }),
  tailoringFailureReason: text("tailoring_failure_reason"),
  cvDocumentId: text("cv_document_id").references(() => cvDocuments.id, {
    onDelete: "set null",
  }),
  pdfPath: text("pdf_path"),
  coverLetterDraft: text("cover_letter_draft").notNull().default(""),
  coverLetterDocumentId: text("cover_letter_document_id").references(
    () => coverLetterDocuments.id,
    { onDelete: "set null" },
  ),
  coverLetterFieldOverrides: text("cover_letter_field_overrides", {
    mode: "json",
  })
    .notNull()
    .default(sql`('{}')`),
  coverLetterPdfPath: text("cover_letter_pdf_path"),
  interviewPrep: text("interview_prep").notNull().default(""),

  // Timestamps
  discoveredAt: text("discovered_at").notNull().default(sql`(datetime('now'))`),
  processedAt: text("processed_at"),
  readyAt: text("ready_at"),
  appliedAt: text("applied_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Generated job PDFs (tailored resume + cover letter) stored as BLOBs so the
// DB is the complete portable installation. No .references(): the runtime
// connection never enables PRAGMA foreign_keys, so cascade would be dead
// code — cleanup is explicit at the delete sites.
export const jobPdfs = sqliteTable(
  "job_pdfs",
  {
    jobId: text("job_id").notNull(),
    kind: text("kind", {
      enum: ["resume", "cover_letter", "resume_docx"],
    }).notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.jobId, table.kind] }),
  }),
);

// Server-internal secrets (currently just the JWT signing secret). Not a
// settings-registry row: registry values echo through GET /api/settings, and
// a signing secret must have no read surface.
export const runtimeSecrets = sqliteTable("runtime_secrets", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Credentials for providers OTHER than the configured one, so a provider can
// be called without first being made the app's provider (the benchmark's
// columns today; a cheap scoring pre-filter later). Deliberately not
// settings-registry rows: the registry holds ONE key/base-URL pair, belonging
// to whichever provider is configured, and a second one has nowhere to live
// there. `api_key` is exposed only as a 4-character hint, never read back.
export const llmProviderCredentials = sqliteTable("llm_provider_credentials", {
  provider: text("provider").primaryKey(),
  apiKey: text("api_key"),
  baseUrl: text("base_url"),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// LLM prompts: `content` is the live raw YAML; `default_content` the baked
// image default (Reset copies it over content, no filesystem involved).
export const prompts = sqliteTable("prompts", {
  name: text("name").primaryKey(),
  content: text("content").notNull(),
  defaultContent: text("default_content").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  applicationId: text("application_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  type: text("type", { enum: APPLICATION_TASK_TYPES }).notNull(),
  title: text("title").notNull(),
  dueDate: integer("due_date", { mode: "number" }),
  isCompleted: integer("is_completed", { mode: "boolean" })
    .notNull()
    .default(false),
  notes: text("notes"),
});

export const jobNotes = sqliteTable(
  "job_notes",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    jobUpdatedIndex: index("idx_job_notes_job_updated").on(
      table.jobId,
      table.updatedAt,
    ),
  }),
);

export const interviews = sqliteTable("interviews", {
  id: text("id").primaryKey(),
  applicationId: text("application_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  scheduledAt: integer("scheduled_at", { mode: "number" }).notNull(),
  durationMins: integer("duration_mins"),
  type: text("type", { enum: INTERVIEW_TYPES }).notNull(),
  outcome: text("outcome", { enum: INTERVIEW_OUTCOMES }),
});

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
  status: text("status", {
    enum: ["running", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("running"),
  jobsDiscovered: integer("jobs_discovered").notNull().default(0),
  jobsProcessed: integer("jobs_processed").notNull().default(0),
  errorMessage: text("error_message"),
  configSnapshot: text("config_snapshot"),
  requestedConfig: text("requested_config", { mode: "json" }),
  effectiveConfig: text("effective_config", { mode: "json" }),
  resultSummary: text("result_summary", { mode: "json" }),
});

export const jobChatThreads = sqliteTable(
  "job_chat_threads",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    lastMessageAt: text("last_message_at"),
    activeRootMessageId: text("active_root_message_id"),
  },
  (table) => ({
    jobUpdatedIndex: index("idx_job_chat_threads_job_updated").on(
      table.jobId,
      table.updatedAt,
    ),
  }),
);

export const jobChatMessages = sqliteTable(
  "job_chat_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => jobChatThreads.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    role: text("role", { enum: JOB_CHAT_MESSAGE_ROLES }).notNull(),
    content: text("content").notNull().default(""),
    status: text("status", { enum: JOB_CHAT_MESSAGE_STATUSES })
      .notNull()
      .default("partial"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    version: integer("version").notNull().default(1),
    replacesMessageId: text("replaces_message_id"),
    parentMessageId: text("parent_message_id"),
    activeChildId: text("active_child_id"),
    proposedEdit: text("proposed_edit", { mode: "json" }),
    editStatus: text("edit_status", { enum: JOB_CHAT_EDIT_STATUSES }),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    threadCreatedIndex: index("idx_job_chat_messages_thread_created").on(
      table.threadId,
      table.createdAt,
    ),
  }),
);

export const jobChatRuns = sqliteTable(
  "job_chat_runs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => jobChatThreads.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text("status", { enum: JOB_CHAT_RUN_STATUSES })
      .notNull()
      .default("running"),
    model: text("model"),
    provider: text("provider"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    completedAt: integer("completed_at", { mode: "number" }),
    requestId: text("request_id"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    threadStatusIndex: index("idx_job_chat_runs_thread_status").on(
      table.threadId,
      table.status,
    ),
  }),
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const sourceConfigs = sqliteTable("source_configs", {
  extractorId: text("extractor_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  configJson: text("config_json", { mode: "json" })
    .notNull()
    .default(sql`('{}')`),
  mappingsJson: text("mappings_json", { mode: "json" })
    .notNull()
    .default(sql`('{}')`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const providerInstances = sqliteTable(
  "provider_instances",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    actorRef: text("actor_ref").notNull(),
    label: text("label").notNull(),
    templateId: text("template_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    inputTemplateJson: text("input_template_json").notNull(),
    outputMappingJson: text("output_mapping_json").notNull().default("{}"),
    mappingsJson: text("mappings_json", { mode: "json" })
      .notNull()
      .default(sql`('{}')`),
    maxJobs: integer("max_jobs"),
    maxAgeDays: integer("max_age_days"),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    providerIndex: index("idx_provider_instances_provider").on(
      table.providerId,
    ),
  }),
);

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  configJson: text("config_json", { mode: "json" })
    .notNull()
    .default(sql`('{}')`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// When a Search Profile last scraped a given source successfully, used by the
// profile's "scrape since the last run" flag to narrow each source's max-age
// window. `source_key` is the discovery task's source id: an extractor
// manifest id, or `<providerId>:<instanceId>` for a provider instance. No
// REFERENCES clause — the runtime connection never enables PRAGMA
// foreign_keys, so cleanup is explicit at the delete sites (profiles repo,
// db/clear.ts).
export const sourceScrapeWatermarks = sqliteTable(
  "source_scrape_watermarks",
  {
    profileId: text("profile_id").notNull(),
    sourceKey: text("source_key").notNull(),
    lastScrapedAt: text("last_scraped_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.sourceKey] }),
  }),
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    subject: text("subject").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "number" }),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    expiresAtIndex: index("idx_auth_sessions_expires_at").on(table.expiresAt),
    revokedAtIndex: index("idx_auth_sessions_revoked_at").on(table.revokedAt),
  }),
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type JobNoteRow = typeof jobNotes.$inferSelect;
export type NewJobNoteRow = typeof jobNotes.$inferInsert;
export type InterviewRow = typeof interviews.$inferSelect;
export type NewInterviewRow = typeof interviews.$inferInsert;
export type PipelineRunRow = typeof pipelineRuns.$inferSelect;
export type NewPipelineRunRow = typeof pipelineRuns.$inferInsert;
export type JobChatThreadRow = typeof jobChatThreads.$inferSelect;
export type NewJobChatThreadRow = typeof jobChatThreads.$inferInsert;
export type JobChatMessageRow = typeof jobChatMessages.$inferSelect;
export type NewJobChatMessageRow = typeof jobChatMessages.$inferInsert;
export type JobChatRunRow = typeof jobChatRuns.$inferSelect;
export type NewJobChatRunRow = typeof jobChatRuns.$inferInsert;
export type SettingsRow = typeof settings.$inferSelect;
export type NewSettingsRow = typeof settings.$inferInsert;
export type SourceConfigDbRow = typeof sourceConfigs.$inferSelect;
export type NewSourceConfigDbRow = typeof sourceConfigs.$inferInsert;
export type ProviderInstanceDbRow = typeof providerInstances.$inferSelect;
export type NewProviderInstanceDbRow = typeof providerInstances.$inferInsert;
export type CvDocumentRow = typeof cvDocuments.$inferSelect;
export type NewCvDocumentRow = typeof cvDocuments.$inferInsert;
export type ProfileDbRow = typeof profiles.$inferSelect;
export type NewProfileDbRow = typeof profiles.$inferInsert;
