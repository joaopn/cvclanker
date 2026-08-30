/**
 * Database migration script - creates tables if they don't exist
 * and brings legacy schemas up to the current shape.
 */

import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { getDataDir } from "../config/dataDir";

const DB_PATH = join(getDataDir(), "jobs.db");

const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);

const migrations: string[] = [
  // Drop tables for stripped features (safe if missing).
  `DROP TABLE IF EXISTS design_resume_assets`,
  `DROP TABLE IF EXISTS design_resume_documents`,
  `DROP TABLE IF EXISTS post_application_message_candidates`,
  `DROP TABLE IF EXISTS post_application_message_links`,
  `DROP TABLE IF EXISTS post_application_messages`,
  `DROP TABLE IF EXISTS post_application_sync_runs`,
  `DROP TABLE IF EXISTS post_application_integrations`,
  `DROP TABLE IF EXISTS stage_events`,
  `DROP TABLE IF EXISTS tracer_click_events`,
  `DROP TABLE IF EXISTS tracer_links`,
  `DROP TABLE IF EXISTS backup_runs`,

  // Canonical tables.
  `CREATE TABLE IF NOT EXISTS cv_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_archive BLOB NOT NULL,
    flattened_tex TEXT NOT NULL,
    fields TEXT NOT NULL DEFAULT '[]',
    personal_brief TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  // Cover-letter substrate. Mirrors cv_documents' shape (post-5e); the upload
  // pipeline reuses the same flatten → compile → extract-loop machinery.
  // No personal_brief column — that lives on the CV side and is fed into
  // the cover-letter generate prompt at request time.
  `CREATE TABLE IF NOT EXISTS cover_letter_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_archive BLOB NOT NULL,
    flattened_tex TEXT NOT NULL,
    fields TEXT NOT NULL DEFAULT '[]',
    templated_tex TEXT NOT NULL DEFAULT '',
    default_field_values TEXT NOT NULL DEFAULT '{}',
    last_compile_stderr TEXT,
    compile_attempts INTEGER NOT NULL DEFAULT 0,
    extraction_prompt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'linkedin',
    source_job_id TEXT,
    job_url_direct TEXT,
    date_posted TEXT,
    job_type TEXT,
    salary_source TEXT,
    salary_interval TEXT,
    salary_min_amount REAL,
    salary_max_amount REAL,
    salary_currency TEXT,
    is_remote INTEGER,
    job_level TEXT,
    job_function TEXT,
    listing_type TEXT,
    emails TEXT,
    company_industry TEXT,
    company_logo TEXT,
    company_url_direct TEXT,
    company_addresses TEXT,
    company_num_employees TEXT,
    company_revenue TEXT,
    company_description TEXT,
    skills TEXT,
    experience_range TEXT,
    company_rating REAL,
    company_reviews_count INTEGER,
    vacancy_count INTEGER,
    work_from_home_type TEXT,
    title TEXT NOT NULL,
    employer TEXT NOT NULL,
    employer_url TEXT,
    job_url TEXT NOT NULL UNIQUE,
    application_link TEXT,
    disciplines TEXT,
    deadline TEXT,
    salary TEXT,
    location TEXT,
    location_evidence TEXT,
    degree_required TEXT,
    starting TEXT,
    job_description TEXT,
    status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN ('discovered', 'processing', 'ready', 'applied', 'in_progress', 'skipped', 'expired')),
    outcome TEXT,
    closed_at INTEGER,
    suitability_category TEXT CHECK(suitability_category IS NULL OR suitability_category IN ('great_fit', 'very_good_fit', 'good_fit', 'bad_fit')),
    suitability_reason TEXT,
    tailored_fields TEXT NOT NULL DEFAULT '{}',
    tailoring_matched TEXT,
    tailoring_skipped TEXT,
    cv_document_id TEXT REFERENCES cv_documents(id) ON DELETE SET NULL,
    pdf_path TEXT,
    cover_letter_draft TEXT NOT NULL DEFAULT '',
    interview_prep TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    ready_at TEXT,
    applied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
    jobs_discovered INTEGER NOT NULL DEFAULT 0,
    jobs_processed INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    config_snapshot TEXT,
    requested_config TEXT,
    effective_config TEXT,
    result_summary TEXT
  )`,

  // Mirrored in db/user-profiles.ts#createFreshLiveDb — keep in lockstep.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS job_chat_threads (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT,
    active_root_message_id TEXT,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS job_chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'partial' CHECK(status IN ('complete', 'partial', 'cancelled', 'failed')),
    tokens_in INTEGER,
    tokens_out INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    replaces_message_id TEXT,
    parent_message_id TEXT,
    active_child_id TEXT,
    proposed_edit TEXT,
    edit_status TEXT CHECK(edit_status IS NULL OR edit_status IN ('pending', 'accepted', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES job_chat_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS job_chat_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'cancelled', 'failed')),
    model TEXT,
    provider TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    request_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES job_chat_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    due_date INTEGER,
    is_completed INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    FOREIGN KEY (application_id) REFERENCES jobs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS job_notes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS interviews (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    duration_mins INTEGER,
    type TEXT NOT NULL,
    outcome TEXT,
    FOREIGN KEY (application_id) REFERENCES jobs(id) ON DELETE CASCADE
  )`,

  // Add new columns on top of legacy DBs (safe to skip when already present).
  `ALTER TABLE jobs ADD COLUMN tailoring_matched TEXT`,
  `ALTER TABLE jobs ADD COLUMN tailoring_skipped TEXT`,
  `ALTER TABLE jobs ADD COLUMN cv_document_id TEXT REFERENCES cv_documents(id) ON DELETE SET NULL`,
  `ALTER TABLE jobs ADD COLUMN cover_letter_draft TEXT NOT NULL DEFAULT ''`,
  // Idempotent ALTER so the jobs-rebuild SELECT below can reference
  // `tailored_fields` directly instead of hardcoding `'{}' AS
  // tailored_fields`. Without this, every boot wipes per-job tailoring back
  // to '{}' (the rebuild runs on every startup).
  `ALTER TABLE jobs ADD COLUMN tailored_fields TEXT NOT NULL DEFAULT '{}'`,
  // suitability_category replaces suitability_score (numeric → categorical
  // enum). Idempotent ALTER lets the rebuild's SELECT reference the new
  // column directly. Legacy DBs without it pick up NULL on first boot.
  `ALTER TABLE jobs ADD COLUMN suitability_category TEXT`,
  `ALTER TABLE job_chat_messages ADD COLUMN proposed_edit TEXT`,
  `ALTER TABLE job_chat_messages ADD COLUMN edit_status TEXT`,
  `ALTER TABLE cv_documents ADD COLUMN personal_brief TEXT NOT NULL DEFAULT ''`,

  // Phase 5d dropped the legacy LLM-generated `template` / `content` columns
  // on cv_documents (replaced by per-field `fields`). That rebuild used to
  // live here in the SQL array and ran UNCONDITIONALLY every boot — but the
  // rebuilt table only listed the pre-5e columns, so it silently dropped the
  // 5e columns (`templated_tex`, `default_field_values`, `last_compile_stderr`,
  // `compile_attempts`, `extraction_prompt`), and the additive ALTERs further
  // down then re-added them with empty defaults. Net effect: every reboot
  // wiped `templated_tex`, flipping every CV back to "Older CV format" and
  // demanding a re-extract. The rebuild now lives in a guarded JS block near
  // the bottom of this file that only fires when the legacy columns actually
  // still exist, and carries the full current shape forward.
  //
  // This defensive ALTER stays: legacy DBs predating `fields` need the column
  // before the guarded rebuild's SELECT can reference it. Idempotent via the
  // duplicate-column skip.
  `ALTER TABLE cv_documents ADD COLUMN fields TEXT NOT NULL DEFAULT '[]'`,

  // 5g repost-tracking columns. Additive, idempotent via duplicate-column
  // skip below. Has to run BEFORE the rebuild block — the rebuild's
  // INSERT SELECT references `reposted_at` / `repost_count` from `jobs`, so
  // legacy DBs without those columns would otherwise fail the SELECT.
  `ALTER TABLE jobs ADD COLUMN reposted_at TEXT`,
  `ALTER TABLE jobs ADD COLUMN repost_count INTEGER NOT NULL DEFAULT 0`,

  // Cover-letter columns. Same defensive-ALTER pattern as 5g — must run
  // BEFORE the rebuild block so the INSERT SELECT can reference them.
  // Idempotent via the duplicate-column-name skip below.
  `ALTER TABLE jobs ADD COLUMN cover_letter_document_id TEXT REFERENCES cover_letter_documents(id) ON DELETE SET NULL`,
  `ALTER TABLE jobs ADD COLUMN cover_letter_field_overrides TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE jobs ADD COLUMN cover_letter_pdf_path TEXT`,

  // 5i: per-job CV field locks (JSON array of fieldIds the LLM tailoring
  // and chat accept-edit paths must leave alone). Defensive ALTER before
  // the canonical rebuild so the INSERT SELECT can reference it on legacy
  // DBs. Idempotent via the duplicate-column-name skip below.
  `ALTER TABLE jobs ADD COLUMN cv_field_locks TEXT NOT NULL DEFAULT '[]'`,

  // Interview QA: per-job, user-generated interview strategy (freeform
  // markdown). Same defensive-ALTER-before-rebuild pattern — the rebuild's
  // INSERT SELECT references `interview_prep` from `jobs`, so legacy DBs
  // need the column first. Idempotent via the duplicate-column-name skip.
  `ALTER TABLE jobs ADD COLUMN interview_prep TEXT NOT NULL DEFAULT ''`,

  // What scored the job: the model that produced the stored category, and the
  // claude_code reasoning effort the call ran at (null on every other
  // provider). Same defensive-ALTER-before-rebuild pattern as the columns
  // above — the rebuild's INSERT SELECT references both, so legacy DBs need
  // them first. Idempotent via the duplicate-column-name skip.
  `ALTER TABLE jobs ADD COLUMN suitability_model TEXT`,
  `ALTER TABLE jobs ADD COLUMN suitability_effort TEXT`,

  // Which Search Profile's run discovered the row (null for manual imports and
  // for everything that predates attribution). Same defensive-ALTER-before-
  // rebuild pattern as the columns above — the rebuild's INSERT SELECT
  // references it, so legacy DBs need the column first. Idempotent via the
  // duplicate-column-name skip.
  `ALTER TABLE jobs ADD COLUMN profile_id TEXT`,

  // Live LinkedIn posting status (fetch_live_status action): whether the
  // posting stopped accepting applications, the applicant-count caption, and
  // when the check ran. Same defensive-ALTER-before-rebuild pattern — the
  // rebuild's INSERT SELECT references all three, so legacy DBs need the
  // columns first. Idempotent via the duplicate-column-name skip.
  `ALTER TABLE jobs ADD COLUMN live_closed INTEGER`,
  `ALTER TABLE jobs ADD COLUMN live_applicants TEXT`,
  `ALTER TABLE jobs ADD COLUMN live_status_checked_at TEXT`,

  // Canonical jobs-table rebuild. Originally added in 5d to drop unused
  // columns (tailored_summary/headline/skills, tracer_links_enabled,
  // sponsor_match_*); 5g extended it with the new status + outcome enums and
  // the repost-tracking columns. Runs every boot; on a fresh DB it's a
  // round-trip with zero rows. The CASE expressions remap legacy enum values
  // forward for any pre-5g rows that might still be in flight.
  `PRAGMA foreign_keys = OFF`,
  `DROP TABLE IF EXISTS jobs_new`,
  `CREATE TABLE jobs_new (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'linkedin',
    source_job_id TEXT,
    job_url_direct TEXT,
    date_posted TEXT,
    job_type TEXT,
    salary_source TEXT,
    salary_interval TEXT,
    salary_min_amount REAL,
    salary_max_amount REAL,
    salary_currency TEXT,
    is_remote INTEGER,
    job_level TEXT,
    job_function TEXT,
    listing_type TEXT,
    emails TEXT,
    company_industry TEXT,
    company_logo TEXT,
    company_url_direct TEXT,
    company_addresses TEXT,
    company_num_employees TEXT,
    company_revenue TEXT,
    company_description TEXT,
    skills TEXT,
    experience_range TEXT,
    company_rating REAL,
    company_reviews_count INTEGER,
    vacancy_count INTEGER,
    work_from_home_type TEXT,
    title TEXT NOT NULL,
    employer TEXT NOT NULL,
    employer_url TEXT,
    job_url TEXT NOT NULL UNIQUE,
    application_link TEXT,
    disciplines TEXT,
    deadline TEXT,
    salary TEXT,
    location TEXT,
    location_evidence TEXT,
    degree_required TEXT,
    starting TEXT,
    job_description TEXT,
    status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN ('discovered', 'selected', 'processing', 'ready', 'applied', 'in_progress', 'backlog', 'stale', 'skipped', 'closed')),
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('rejected', 'withdrawn', 'ghosted', 'duplicated', 'other')),
    closed_at INTEGER,
    profile_id TEXT,
    suitability_category TEXT CHECK(suitability_category IS NULL OR suitability_category IN ('great_fit', 'very_good_fit', 'good_fit', 'bad_fit')),
    suitability_reason TEXT,
    suitability_model TEXT,
    suitability_effort TEXT,
    tailored_fields TEXT NOT NULL DEFAULT '{}',
    cv_field_locks TEXT NOT NULL DEFAULT '[]',
    tailoring_matched TEXT,
    tailoring_skipped TEXT,
    cv_document_id TEXT REFERENCES cv_documents(id) ON DELETE SET NULL,
    pdf_path TEXT,
    cover_letter_draft TEXT NOT NULL DEFAULT '',
    cover_letter_document_id TEXT REFERENCES cover_letter_documents(id) ON DELETE SET NULL,
    cover_letter_field_overrides TEXT NOT NULL DEFAULT '{}',
    cover_letter_pdf_path TEXT,
    interview_prep TEXT NOT NULL DEFAULT '',
    reposted_at TEXT,
    repost_count INTEGER NOT NULL DEFAULT 0,
    live_closed INTEGER,
    live_applicants TEXT,
    live_status_checked_at TEXT,
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    ready_at TEXT,
    applied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `INSERT INTO jobs_new (
    id, source, source_job_id, job_url_direct, date_posted, job_type,
    salary_source, salary_interval, salary_min_amount, salary_max_amount,
    salary_currency, is_remote, job_level, job_function, listing_type, emails,
    company_industry, company_logo, company_url_direct, company_addresses,
    company_num_employees, company_revenue, company_description, skills,
    experience_range, company_rating, company_reviews_count, vacancy_count,
    work_from_home_type, title, employer, employer_url, job_url,
    application_link, disciplines, deadline, salary, location,
    location_evidence, degree_required, starting, job_description, status,
    outcome, closed_at, profile_id, suitability_category, suitability_reason,
    suitability_model, suitability_effort, tailored_fields,
    cv_field_locks,
    tailoring_matched, tailoring_skipped, cv_document_id,
    pdf_path, cover_letter_draft,
    cover_letter_document_id, cover_letter_field_overrides, cover_letter_pdf_path,
    interview_prep,
    reposted_at, repost_count,
    live_closed, live_applicants, live_status_checked_at,
    discovered_at, processed_at, ready_at,
    applied_at, created_at, updated_at
  )
  SELECT
    id, source, source_job_id, job_url_direct, date_posted, job_type,
    salary_source, salary_interval, salary_min_amount, salary_max_amount,
    salary_currency, is_remote, job_level, job_function, listing_type, emails,
    company_industry, company_logo, company_url_direct, company_addresses,
    company_num_employees, company_revenue, company_description, skills,
    experience_range, company_rating, company_reviews_count, vacancy_count,
    work_from_home_type, title, employer, employer_url, job_url,
    application_link, disciplines, deadline, salary, location,
    location_evidence, degree_required, starting, job_description,
    CASE WHEN status = 'expired' THEN 'closed' ELSE status END AS status,
    CASE
      WHEN status = 'expired' AND outcome IS NULL THEN 'other'
      WHEN outcome = 'no_response' THEN 'ghosted'
      WHEN outcome IN ('offer_accepted', 'offer_declined') THEN 'other'
      ELSE outcome
    END AS outcome,
    closed_at, profile_id, suitability_category, suitability_reason,
    suitability_model, suitability_effort,
    tailored_fields,
    COALESCE(cv_field_locks, '[]') AS cv_field_locks,
    tailoring_matched, tailoring_skipped, cv_document_id,
    pdf_path, cover_letter_draft,
    cover_letter_document_id,
    COALESCE(cover_letter_field_overrides, '{}') AS cover_letter_field_overrides,
    cover_letter_pdf_path,
    COALESCE(interview_prep, '') AS interview_prep,
    COALESCE(reposted_at, NULL) AS reposted_at,
    COALESCE(repost_count, 0) AS repost_count,
    live_closed, live_applicants, live_status_checked_at,
    discovered_at, processed_at,
    ready_at, applied_at, created_at, updated_at
  FROM jobs`,
  `DROP TABLE jobs`,
  `ALTER TABLE jobs_new RENAME TO jobs`,
  `PRAGMA foreign_keys = ON`,

  // Indices.
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_discovered_at ON jobs(discovered_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status_discovered_at ON jobs(status, discovered_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at ON pipeline_runs(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_application_id ON tasks(application_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_interviews_application_id ON interviews(application_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_notes_job_updated ON job_notes(job_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_chat_threads_job_updated ON job_chat_threads(job_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_chat_messages_thread_created ON job_chat_messages(thread_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_job_chat_messages_parent ON job_chat_messages(parent_message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_chat_runs_thread_status ON job_chat_runs(thread_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked_at ON auth_sessions(revoked_at)`,

  // Backfill duplicate-running-runs guard rail.
  `WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY started_at DESC, id DESC) AS rank_in_thread
      FROM job_chat_runs
      WHERE status = 'running'
    )
    UPDATE job_chat_runs
    SET
      status = 'failed',
      error_code = COALESCE(error_code, 'CONFLICT'),
      error_message = COALESCE(error_message, 'Recovered duplicate running run during migration'),
      completed_at = COALESCE(completed_at, CAST(strftime('%s', 'now') AS INTEGER)),
      updated_at = datetime('now')
    WHERE id IN (SELECT id FROM ranked WHERE rank_in_thread > 1)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_job_chat_runs_thread_running_unique
   ON job_chat_runs(thread_id)
   WHERE status = 'running'`,

  // 5e CV substrate columns. Additive, idempotent via duplicate-column-name
  // skip below. The runtime path still uses flattened_tex + fields for
  // rendering until 5e.4 cuts over.
  `ALTER TABLE cv_documents ADD COLUMN templated_tex TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE cv_documents ADD COLUMN default_field_values TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE cv_documents ADD COLUMN last_compile_stderr TEXT`,
  `ALTER TABLE cv_documents ADD COLUMN compile_attempts INTEGER NOT NULL DEFAULT 0`,

  // 5e.3a: per-CV system prompt. The user can override the entire LLM
  // system prompt (default = the server's cv-template-extract YAML).
  // Empty value means "use the server default at extraction time".
  `ALTER TABLE cv_documents ADD COLUMN extraction_prompt TEXT NOT NULL DEFAULT ''`,

  // Tailoring failure reason. Set on any failed processJob, cleared on the
  // next successful summarizeJob. Nullable; null = "no recorded failure".
  `ALTER TABLE jobs ADD COLUMN tailoring_failure_reason TEXT`,

  // Drop legacy settings keys that are no longer read by the app.
  `DELETE FROM settings WHERE key IN (
     'jobspyHoursOld',
     'jobspySites',
     'jobspyLinkedinFetchDescription',
     'jobspyIsRemote',
     'openrouterApiKey',
     'webhookUrl',
     'pipelineWebhookUrl'
   )`,

  // Per-extractor configuration. One row per *extractor* (manifest.id):
  // jobspy / hiringcafe / startupjobs / workingnomads. The
  // original phase-10 schema keyed on `source_id` (per-platform: indeed /
  // linkedin / glassdoor / hiringcafe / ...). The collapse from per-platform
  // to per-extractor happens in the JS-driven rebuild below — it merges
  // legacy per-platform rows into per-extractor rows, picking the
  // first-priority config row and OR'ing the `enabled` flag across each
  // extractor's sub-platforms. Per CLAUDE.md's "one canonical rebuild only"
  // rule, this CREATE TABLE IF NOT EXISTS now declares the post-rename
  // shape directly — no parallel rebuild block appended.
  `CREATE TABLE IF NOT EXISTS source_configs (
     extractor_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL DEFAULT 0,
     config_json TEXT NOT NULL DEFAULT '{}',
     mappings_json TEXT NOT NULL DEFAULT '{}',
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,

  // User-managed instances of marketplace-provider actors (Apify today,
  // extensible to other providers). Each row is one configured actor; the
  // pipeline iterates enabled rows alongside built-in extractor manifests.
  `CREATE TABLE IF NOT EXISTS provider_instances (
     id TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL,
     actor_ref TEXT NOT NULL,
     label TEXT NOT NULL,
     template_id TEXT,
     enabled INTEGER NOT NULL DEFAULT 0,
     input_template_json TEXT NOT NULL,
     output_mapping_json TEXT NOT NULL DEFAULT '{}',
     mappings_json TEXT NOT NULL DEFAULT '{}',
     max_jobs INTEGER,
     max_age_days INTEGER,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_provider_instances_provider
     ON provider_instances(provider_id)`,
  // Additive: existing DBs predate max_jobs (skipped on dup-column, see loop).
  `ALTER TABLE provider_instances ADD COLUMN max_jobs INTEGER`,
  // Additive: existing DBs predate max_age_days (skipped on dup-column).
  `ALTER TABLE provider_instances ADD COLUMN max_age_days INTEGER`,

  // Profiles: named, selectable scrape sets (location + terms + run knobs +
  // pinned sources) that become the runtime source of truth for a run. One
  // JSON config blob per row, UUID PK — mirrors provider_instances. No
  // rebuild block per the "one canonical rebuild only" rule; the first-boot
  // seed of a "Default" profile lives in the guarded JS block near the
  // bottom of this file (after the SQL array, so later ALTERs exist).
  `CREATE TABLE IF NOT EXISTS profiles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     config_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,

  // Generated job PDFs (tailored resume + cover letter) as BLOBs, so the DB
  // is the complete portable installation. No REFERENCES clause: the runtime
  // connection never enables PRAGMA foreign_keys, so a cascade would be dead
  // code — cleanup is explicit at the delete sites (db/clear.ts, the
  // jobs-repo bulk deletes). Backfill from the legacy data/pdfs files lives
  // in a guarded JS block near the bottom of this file.
  `CREATE TABLE IF NOT EXISTS job_pdfs (
     job_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('resume','cover_letter','resume_docx')),
     data BLOB NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (job_id, kind)
   )`,

  // Per-(Search Profile × source) high-water mark of the last successful
  // scrape, driving the profile's "scrape since the last run" window. No
  // REFERENCES clause: the runtime connection never enables PRAGMA
  // foreign_keys, so cleanup is explicit at the delete sites (profiles repo,
  // db/clear.ts).
  `CREATE TABLE IF NOT EXISTS source_scrape_watermarks (
     profile_id TEXT NOT NULL,
     source_key TEXT NOT NULL,
     last_scraped_at TEXT NOT NULL,
     PRIMARY KEY (profile_id, source_key)
   )`,

  // Server-internal secrets (currently just the JWT signing secret).
  // Deliberately NOT settings-registry rows: registry values echo through
  // GET /api/settings, and a signing secret must have no read surface.
  // Legacy DATA_DIR/jwt-secret file import lives in a guarded JS block
  // near the bottom of this file.
  `CREATE TABLE IF NOT EXISTS runtime_secrets (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,

  // Credentials for providers OTHER than the configured one. Not
  // settings-registry rows: the registry has room for exactly one key/base-URL
  // pair, belonging to whichever provider is configured.
  `CREATE TABLE IF NOT EXISTS llm_provider_credentials (
     provider TEXT PRIMARY KEY,
     api_key TEXT,
     base_url TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,

  // LLM prompts. `content` is the live raw YAML document; `default_content`
  // is the baked image default so Reset needs no filesystem. Seeded/refreshed
  // from PROMPTS_DIR by the guarded JS block near the bottom of this file.
  `CREATE TABLE IF NOT EXISTS prompts (
     name TEXT PRIMARY KEY,
     content TEXT NOT NULL,
     default_content TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

console.log("🔧 Running database migrations...");

for (const migration of migrations) {
  try {
    sqlite.exec(migration);
    console.log("✅ Migration applied");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    const isAlterAdd = /alter table \S+ add column/i.test(migration);
    if (isAlterAdd && lower.includes("duplicate column name")) {
      console.log("↩️ Migration skipped (column already exists)");
      continue;
    }

    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

// Source-configs migration + backfill.
//
// Two scenarios funnel through here:
//
// 1. Legacy per-platform shape (`source_id` PK, one row per platform —
//    indeed / linkedin / glassdoor / hiringcafe / ...). Phase 10b collapse
//    folds those into per-extractor rows (manifest.id): jobspy carries
//    Indeed + LinkedIn + Glassdoor; everything else is 1:1. First-priority
//    platform's config wins; `enabled` is OR'd across sub-platforms; the
//    legacy `location_override` config key is renamed to `searchCities`
//    in-place (matches the field rename in the extractor manifests).
//
// 2. Fresh DB or already-migrated. SQL migrations created the
//    `extractor_id`-shaped table already; this block backfills one row per
//    pipeline extractor with default enabled=1 and any pre-Phase-10 legacy
//    AppSettings keys folded in. Idempotent via INSERT OR IGNORE.
try {
  const PLATFORM_TO_EXTRACTOR: Record<string, string> = {
    indeed: "jobspy",
    linkedin: "jobspy",
    glassdoor: "jobspy",
    hiringcafe: "hiringcafe",
    workingnomads: "workingnomads",
    startupjobs: "startupjobs",
    manual: "manual",
  };
  // Mirrors EXTRACTOR_SOURCE_METADATA[*].order in shared/extractors. Inlined
  // here so migrate.ts doesn't need to import shared TS at boot. The
  // first-priority platform's config wins when collapsing per-extractor.
  const PLATFORM_ORDER: Record<string, number> = {
    indeed: 20,
    linkedin: 30,
    glassdoor: 40,
    hiringcafe: 70,
    startupjobs: 80,
    workingnomads: 90,
    manual: 110,
  };
  const PIPELINE_EXTRACTOR_IDS = [
    "jobspy",
    "hiringcafe",
    "startupjobs",
    "workingnomads",
    "himalayas",
    "weworkremotely",
    "jobicy",
  ];

  const tableCols = sqlite
    .prepare("PRAGMA table_info(source_configs)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(tableCols.map((c) => c.name));
  const isLegacyShape =
    colNames.has("source_id") && !colNames.has("extractor_id");

  const remapLegacyConfigKey = (raw: string): string => {
    if (!raw) return "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "{}";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "{}";
    }
    if (
      typeof parsed.location_override === "string" &&
      parsed.searchCities === undefined
    ) {
      parsed.searchCities = parsed.location_override;
    }
    delete parsed.location_override;
    return JSON.stringify(parsed);
  };

  if (isLegacyShape) {
    const legacyRows = sqlite
      .prepare(
        `SELECT source_id, enabled, config_json, mappings_json, updated_at
         FROM source_configs`,
      )
      .all() as Array<{
      source_id: string;
      enabled: number;
      config_json: string;
      mappings_json: string;
      updated_at: string;
    }>;

    legacyRows.sort(
      (a, b) =>
        (PLATFORM_ORDER[a.source_id] ?? 9999) -
        (PLATFORM_ORDER[b.source_id] ?? 9999),
    );

    type Aggregated = {
      config_json: string;
      mappings_json: string;
      enabled: number;
      updated_at: string;
    };
    const merged = new Map<string, Aggregated>();
    for (const row of legacyRows) {
      const extractorId = PLATFORM_TO_EXTRACTOR[row.source_id];
      if (!extractorId) continue;
      const existing = merged.get(extractorId);
      if (!existing) {
        merged.set(extractorId, {
          config_json: remapLegacyConfigKey(row.config_json),
          mappings_json: row.mappings_json || "{}",
          enabled: row.enabled ? 1 : 0,
          updated_at: row.updated_at,
        });
      } else {
        existing.enabled = existing.enabled || row.enabled ? 1 : 0;
      }
    }

    sqlite.exec("DROP TABLE IF EXISTS source_configs_new");
    sqlite.exec(
      `CREATE TABLE source_configs_new (
         extractor_id TEXT PRIMARY KEY,
         enabled INTEGER NOT NULL DEFAULT 0,
         config_json TEXT NOT NULL DEFAULT '{}',
         mappings_json TEXT NOT NULL DEFAULT '{}',
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    const insertNew = sqlite.prepare(
      `INSERT INTO source_configs_new
         (extractor_id, enabled, config_json, mappings_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [extractorId, row] of merged) {
      insertNew.run(
        extractorId,
        row.enabled,
        row.config_json,
        row.mappings_json,
        row.updated_at,
      );
    }
    sqlite.exec("DROP TABLE source_configs");
    sqlite.exec("ALTER TABLE source_configs_new RENAME TO source_configs");
    console.log("✅ source_configs collapsed per-platform → per-extractor");
  }

  const getSetting = sqlite.prepare("SELECT value FROM settings WHERE key = ?");
  const readSetting = (key: string): string | null => {
    const row = getSetting.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };

  const sharedMaxPerTerm = readSetting("jobspyResultsWanted");
  const jobspyCountryIndeed = readSetting("jobspyCountryIndeed");
  const jobspyLocation = readSetting("jobspyLocation");
  const searchCities = readSetting("searchCities");
  const startupjobsMaxJobsPerTerm = readSetting("startupjobsMaxJobsPerTerm");

  const insertRow = sqlite.prepare(
    `INSERT OR IGNORE INTO source_configs
       (extractor_id, enabled, config_json, mappings_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  );

  for (const extractorId of PIPELINE_EXTRACTOR_IDS) {
    const config: Record<string, string> = {};
    if (sharedMaxPerTerm) config.max_jobs_per_term = sharedMaxPerTerm;
    if (extractorId === "jobspy") {
      if (jobspyCountryIndeed) config.country_indeed = jobspyCountryIndeed;
      if (jobspyLocation && jobspyLocation !== searchCities) {
        config.searchCities = jobspyLocation;
      }
    }
    if (extractorId === "startupjobs" && startupjobsMaxJobsPerTerm) {
      config.max_jobs_per_term = startupjobsMaxJobsPerTerm;
    }
    insertRow.run(extractorId, 1, JSON.stringify(config), "{}");
  }
  console.log("✅ source_configs backfill applied");

  // Rename jobspyCountryIndeed → searchCountry, then drop the four legacy
  // settings keys. Must run AFTER the source_configs backfill above, which
  // reads these keys; running it as part of the SQL `migrations[]` array
  // would fire before the JS backfill and clobber the values.
  if (jobspyCountryIndeed) {
    const existingSearchCountry = readSetting("searchCountry");
    if (!existingSearchCountry) {
      const insertSetting = sqlite.prepare(
        `INSERT INTO settings (key, value, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`,
      );
      insertSetting.run("searchCountry", jobspyCountryIndeed);
    }
  }

  sqlite
    .prepare(
      `DELETE FROM settings WHERE key IN (
         'jobspyResultsWanted',
         'jobspyCountryIndeed',
         'jobspyLocation',
         'startupjobsMaxJobsPerTerm'
       )`,
    )
    .run();
  console.log("✅ legacy settings keys dropped");

  // Drop the golangjobs extractor. Idempotent — re-runs are no-ops once
  // the rows are gone. The jobs delete cascades to dependent rows via
  // the existing ON DELETE CASCADE on tasks / interviews / job_notes /
  // job_chat_*.
  const removedSourceConfig = sqlite
    .prepare(`DELETE FROM source_configs WHERE extractor_id = 'golangjobs'`)
    .run();
  const removedJobs = sqlite
    .prepare(`DELETE FROM jobs WHERE source = 'golangjobs'`)
    .run();
  if (removedSourceConfig.changes > 0 || removedJobs.changes > 0) {
    console.log(
      `✅ golangjobs dropped (source_configs rows: ${removedSourceConfig.changes}, jobs rows: ${removedJobs.changes})`,
    );
  }
} catch (error) {
  console.error("❌ source_configs backfill failed:", error);
  process.exit(1);
}

// Phase 5d legacy-column drop on cv_documents — guarded.
//
// Only rebuilds when the legacy `template` / `content` columns are still
// present (a pre-5d DB). Once they're gone the block no-ops forever, so it
// can never clobber columns added by later ALTERs. The rebuild carries the
// FULL current shape forward (including the 5e columns), which is why it has
// to run here, AFTER the SQL `migrations[]` array has ensured those columns
// exist — selecting them in the array would fail on legacy DBs.
try {
  const cvCols = sqlite
    .prepare("PRAGMA table_info(cv_documents)")
    .all() as Array<{ name: string }>;
  const cvColNames = new Set(cvCols.map((c) => c.name));
  const hasLegacyCvColumns =
    cvColNames.has("template") || cvColNames.has("content");

  if (hasLegacyCvColumns) {
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec("DROP TABLE IF EXISTS cv_documents_new");
    sqlite.exec(`CREATE TABLE cv_documents_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      original_archive BLOB NOT NULL,
      flattened_tex TEXT NOT NULL,
      fields TEXT NOT NULL DEFAULT '[]',
      personal_brief TEXT NOT NULL DEFAULT '',
      templated_tex TEXT NOT NULL DEFAULT '',
      default_field_values TEXT NOT NULL DEFAULT '{}',
      last_compile_stderr TEXT,
      compile_attempts INTEGER NOT NULL DEFAULT 0,
      extraction_prompt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sqlite.exec(`INSERT INTO cv_documents_new (
      id, name, original_archive, flattened_tex, fields, personal_brief,
      templated_tex, default_field_values, last_compile_stderr,
      compile_attempts, extraction_prompt, created_at, updated_at
    )
    SELECT
      id, name, original_archive, flattened_tex, fields, personal_brief,
      templated_tex, default_field_values, last_compile_stderr,
      compile_attempts, extraction_prompt, created_at, updated_at
    FROM cv_documents`);
    sqlite.exec("DROP TABLE cv_documents");
    sqlite.exec("ALTER TABLE cv_documents_new RENAME TO cv_documents");
    sqlite.exec("PRAGMA foreign_keys = ON");
    console.log("✅ cv_documents legacy template/content columns dropped");
  }
} catch (error) {
  console.error("❌ cv_documents legacy-column rebuild failed:", error);
  process.exit(1);
}

// job_pdfs CHECK-constraint widening (adds the 'resume_docx' kind) — guarded.
//
// The kind column carries a CHECK constraint, and SQLite offers no ALTER for
// it — the only way to see the current constraint text is the table's own
// CREATE statement in sqlite_master, and the only way to change it is a
// rebuild. Only rebuilds when the stored SQL predates the widening (no
// 'resume_docx' in it); afterwards the block no-ops forever. Runs before the
// blob backfill below purely for locality — the backfill inserts only
// resume/cover_letter rows, valid under both constraint shapes.
try {
  const jobPdfsMaster = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='job_pdfs'",
    )
    .get() as { sql: string } | undefined;

  if (jobPdfsMaster && !jobPdfsMaster.sql.includes("resume_docx")) {
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec("DROP TABLE IF EXISTS job_pdfs_new");
    sqlite.exec(`CREATE TABLE job_pdfs_new (
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('resume','cover_letter','resume_docx')),
      data BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, kind)
    )`);
    sqlite.exec(`INSERT INTO job_pdfs_new (job_id, kind, data, updated_at)
    SELECT job_id, kind, data, updated_at FROM job_pdfs`);
    sqlite.exec("DROP TABLE job_pdfs");
    sqlite.exec("ALTER TABLE job_pdfs_new RENAME TO job_pdfs");
    sqlite.exec("PRAGMA foreign_keys = ON");
    console.log("✅ job_pdfs kind constraint widened to include resume_docx");
  }
} catch (error) {
  console.error("❌ job_pdfs kind-constraint rebuild failed:", error);
  process.exit(1);
}

// Job-PDF blob backfill + path normalization.
//
// Older installs stored generated PDFs on disk under DATA_DIR/pdfs and kept
// ABSOLUTE paths in jobs.pdf_path / cover_letter_pdf_path. Now the bytes
// live in job_pdfs and the columns hold the canonical relative filename
// (resume_<id>.pdf / cover_letter_<id>.pdf) purely as an existence flag. Per
// row and kind:
//   - blob row already exists  → just normalize the column (crash recovery).
//   - legacy file found        → import bytes, normalize the column.
//   - file genuinely absent    → NULL the column (client shows "no PDF";
//                                re-render is pure tectonic, no LLM cost).
//   - file exists but unreadable (EACCES/IO) → skip + log, retry next boot;
//     the pointer must survive while the bytes are still recoverable.
// Idempotent: after a clean pass every non-empty column has a blob row and
// the canonical name, so subsequent boots reduce to a no-op SELECT. Never
// deletes disk files — the user cleans data/pdfs manually.
try {
  const pdfDir = join(getDataDir(), "pdfs");
  const KINDS = [
    { column: "pdf_path", kind: "resume", prefix: "resume" },
    {
      column: "cover_letter_pdf_path",
      kind: "cover_letter",
      prefix: "cover_letter",
    },
  ] as const;

  const hasBlob = sqlite.prepare(
    "SELECT 1 FROM job_pdfs WHERE job_id = ? AND kind = ?",
  );
  const insertBlob = sqlite.prepare(
    "INSERT INTO job_pdfs (job_id, kind, data) VALUES (?, ?, ?)",
  );

  for (const { column, kind, prefix } of KINDS) {
    const rows = sqlite
      .prepare(
        `SELECT id, ${column} AS path FROM jobs
         WHERE ${column} IS NOT NULL AND ${column} != ''`,
      )
      .all() as Array<{ id: string; path: string }>;

    for (const row of rows) {
      const canonicalName = `${prefix}_${row.id}.pdf`;
      const setColumn = (value: string | null) => {
        if (value !== row.path) {
          sqlite
            .prepare(`UPDATE jobs SET ${column} = ? WHERE id = ?`)
            .run(value, row.id);
        }
      };

      if (hasBlob.get(row.id, kind)) {
        setColumn(canonicalName);
        continue;
      }

      const candidates = [
        ...(isAbsolute(row.path) ? [row.path] : []),
        join(pdfDir, basename(row.path)),
        join(pdfDir, canonicalName),
      ];
      const filePath = candidates.find((p) => existsSync(p));
      if (!filePath) {
        setColumn(null);
        continue;
      }

      try {
        insertBlob.run(row.id, kind, readFileSync(filePath));
        setColumn(canonicalName);
      } catch (readError) {
        console.error(
          `⚠️ job_pdfs backfill: could not import ${filePath} for job ${row.id} (${kind}) — leaving pointer for retry next boot:`,
          readError,
        );
      }
    }
  }
} catch (error) {
  console.error("❌ job_pdfs backfill failed:", error);
  process.exit(1);
}

// Legacy JWT-secret file import.
//
// The signing secret used to live at DATA_DIR/jwt-secret (mode 0600); it now
// lives in runtime_secrets so a DB snapshot restores working sessions. Import
// the file's value once so existing sessions stay valid across the cutover:
// only when no row exists yet, and only when the file's content passes the
// same ≥32-char minimum jwt.ts enforces (a shorter file is NOT imported — the
// server lazy-generates a fresh secret instead of throwing like the old file
// path did; sessions are invalidated, nothing crashes). The file is left on
// disk for the user to delete manually. Idempotent via the row-exists guard.
try {
  const secretRow = sqlite
    .prepare("SELECT 1 FROM runtime_secrets WHERE key = 'jwt_secret'")
    .get();
  if (!secretRow) {
    const legacyPath = join(getDataDir(), "jwt-secret");
    if (existsSync(legacyPath)) {
      const content = readFileSync(legacyPath, "utf8").trim();
      if (content.length >= 32) {
        sqlite
          .prepare(
            "INSERT INTO runtime_secrets (key, value) VALUES ('jwt_secret', ?)",
          )
          .run(content);
        console.log("✅ imported legacy jwt-secret file into runtime_secrets");
      } else {
        console.log(
          "↩️ legacy jwt-secret file too short to import — a fresh secret will be generated on first use",
        );
      }
    }
  }
} catch (error) {
  console.error("❌ jwt-secret import failed:", error);
  process.exit(1);
}

// Prompt seeding + default refresh.
//
// The baked image copy under PROMPTS_DIR is the SEED source; the live prompt
// text lives in the `prompts` table (`content`), with the baked default kept
// beside it (`default_content`) so Reset needs no filesystem. Per file:
//   - no row                     → insert content = default_content = file.
//   - file changed vs stored default:
//       row UNEDITED (content === default_content) → refresh BOTH (image
//         upgrades transparently reach untouched prompts);
//       row EDITED → refresh default_content only (user text never clobbered;
//         the Reset button converges them again).
//   - file identical to stored default → no-op (steady-state boots write
//     nothing and don't churn updated_at).
// A missing/unreadable prompts dir is silently skipped — the tools-image test
// environment has no /app/prompts, and a snapshot restored onto a prompt-less
// host must still boot. Rows whose file disappeared from a future image are
// LEFT in place (they keep working and stay listed).
try {
  const promptsDir = (process.env.PROMPTS_DIR ?? "").trim() || "/app/prompts";

  const getRow = sqlite.prepare(
    "SELECT content, default_content FROM prompts WHERE name = ?",
  );
  const insertRow = sqlite.prepare(
    "INSERT INTO prompts (name, content, default_content) VALUES (?, ?, ?)",
  );
  const refreshBoth = sqlite.prepare(
    "UPDATE prompts SET content = ?, default_content = ?, updated_at = datetime('now') WHERE name = ?",
  );
  const refreshDefault = sqlite.prepare(
    "UPDATE prompts SET default_content = ?, updated_at = datetime('now') WHERE name = ?",
  );

  const walk = (subdir: string): void => {
    const fullDir = join(promptsDir, subdir);
    let entries: Dirent[];
    try {
      entries = readdirSync(fullDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const name = relPath.slice(0, -".yaml".length);

      let file: string;
      try {
        file = readFileSync(join(promptsDir, relPath), "utf8");
      } catch (readError) {
        console.error(`⚠️ prompts seed: could not read ${relPath}:`, readError);
        continue;
      }

      const row = getRow.get(name) as
        | { content: string; default_content: string }
        | undefined;
      if (!row) {
        insertRow.run(name, file, file);
        continue;
      }
      if (file === row.default_content) continue;
      if (row.content === row.default_content) {
        refreshBoth.run(file, file, name);
      } else {
        refreshDefault.run(file, name);
      }
    }
  };

  walk("");
} catch (error) {
  console.error("❌ prompts seed failed:", error);
  process.exit(1);
}

// Seed a "Default" profile from the current effective scrape settings —
// guarded + empty-only.
//
// Runs ONLY when `profiles` is empty, so it can never overwrite a
// user-created profile or re-run per boot (the cv_documents per-boot-wipe
// lesson). Lives here, after the SQL `migrations[]` array, so the
// source_configs / provider_instances backfills above have already populated
// the rows this reads. Values are inlined (no @shared import at boot), and a
// bad/missing setting falls back to the same default the shared parser would
// use on read. NOT field-for-field with `defaultProfileConfig()` despite the
// overlap: `remoteProfile`, `remoteLocationBlocklist` and `scrapeSinceLastRun`
// are absent here and come from the parser's own per-field fallback instead.
try {
  const profileCount = (
    sqlite.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }
  ).n;

  if (profileCount === 0) {
    const readSetting = (key: string): string | null => {
      const row = sqlite
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };
    const parseStringArray = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === "string")
          : [];
      } catch {
        return [];
      }
    };
    const parseIntOrNull = (raw: string | null): number | null => {
      if (!raw) return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const enabledSourceIds = (
      sqlite
        .prepare("SELECT extractor_id FROM source_configs WHERE enabled = 1")
        .all() as Array<{ extractor_id: string }>
    ).map((r) => r.extractor_id);
    const providerInstanceIds = (
      sqlite
        .prepare("SELECT id FROM provider_instances WHERE enabled = 1")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);

    const workplaceTypes = parseStringArray(readSetting("workplaceTypes"));

    const config = {
      searchTerms: parseStringArray(readSetting("searchTerms")),
      searchCountry: readSetting("searchCountry") ?? "",
      searchCities: readSetting("searchCities") ?? "",
      workplaceTypes:
        workplaceTypes.length > 0
          ? workplaceTypes
          : ["remote", "hybrid", "onsite"],
      locationSearchScope:
        readSetting("locationSearchScope") ?? "selected_only",
      locationMatchStrictness:
        readSetting("locationMatchStrictness") ?? "flexible",
      scrapeMaxAgeDays: parseIntOrNull(readSetting("scrapeMaxAgeDays")),
      blockedCompanyKeywords: parseStringArray(
        readSetting("blockedCompanyKeywords"),
      ),
      runBudget: 500,
      topN: 10,
      minSuitabilityCategory:
        readSetting("minSuitabilityCategory") ?? "good_fit",
      enabledSourceIds,
      providerInstanceIds,
    };

    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO profiles (id, name, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, "Default", JSON.stringify(config), now, now);

    // Point defaultProfileId at the seed unless one is already set.
    if (!readSetting("defaultProfileId")) {
      sqlite
        .prepare(
          `INSERT INTO settings (key, value, created_at, updated_at)
           VALUES (?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, updated_at = datetime('now')`,
        )
        .run("defaultProfileId", id);
    }
    console.log("✅ seeded Default profile from current settings");
  }
} catch (error) {
  console.error("❌ profiles seed failed:", error);
  process.exit(1);
}

// Seed the user-profile self-identity name — guarded, absent-only.
//
// Every database ("user profile") self-describes via a `userProfileName`
// settings row so the user-profiles store can list closed files by name.
// Absent-only: a rename must never be overwritten on a later boot. Existing
// installs self-identify as "Default" on first boot after upgrade; the fresh
// DB created after "New profile" gets the same seed.
try {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("userProfileName") as { value: string } | undefined;
  if (!row) {
    sqlite
      .prepare(
        `INSERT INTO settings (key, value, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`,
      )
      .run("userProfileName", "Default");
    console.log("✅ seeded userProfileName");
  }
} catch (error) {
  console.error("❌ userProfileName seed failed:", error);
  process.exit(1);
}

// An empty `enabledSourceIds` used to mean "every enabled extractor". It now
// means "no extractors" — a tick means what it says. Without this backfill,
// every Search Profile carrying an empty list would silently stop scraping.
// Runs last, so the source_configs backfill and the profiles seed have both
// populated the world it reads.
//
// `providerInstanceIds` is deliberately NOT backfilled: an empty list there
// ALREADY means "no Apify actors", so those profiles run none today. Filling
// it would start spending the user's money on every run.
try {
  const profileRows = sqlite
    .prepare("SELECT id, config_json FROM profiles")
    .all() as Array<{ id: string; config_json: string }>;

  if (profileRows.length > 0) {
    const enabledExtractorIds = (
      sqlite
        .prepare("SELECT extractor_id FROM source_configs WHERE enabled = 1")
        .all() as Array<{ extractor_id: string }>
    ).map((r) => r.extractor_id);

    const update = sqlite.prepare(
      "UPDATE profiles SET config_json = ?, updated_at = datetime('now') WHERE id = ?",
    );

    let backfilled = 0;
    for (const row of profileRows) {
      let config: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.config_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        config = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      const current = config.enabledSourceIds;
      const isEmpty = !Array.isArray(current) || current.length === 0;
      if (!isEmpty) continue;

      config.enabledSourceIds = enabledExtractorIds;
      update.run(JSON.stringify(config), row.id);
      backfilled += 1;
    }

    if (backfilled > 0) {
      // Honest log: with nothing enabled, an empty list is backfilled with an
      // empty list — same effective behavior as before, but no source will run
      // until one is enabled on the Sources page.
      console.log(
        enabledExtractorIds.length > 0
          ? `✅ backfilled enabledSourceIds on ${backfilled} profile(s) with ${enabledExtractorIds.length} enabled extractor(s)`
          : `⚠️ ${backfilled} profile(s) had no source selection and no extractor is enabled — enable one on the Sources page`,
      );
    }
  }
} catch (error) {
  console.error("❌ enabledSourceIds backfill failed:", error);
  process.exit(1);
}

// The borderline-indeed Apify template was removed. An instance still pointing
// at it cannot run — the provider returns "Unknown Apify template id" and the
// source reports Failed on every run — so disable it rather than leaving that
// error to repeat. The row is kept, not deleted: it holds the user's own label
// and caps, and it stays visible on the Sources page so they can remove it (or
// re-point it) deliberately.
try {
  const orphaned = sqlite
    .prepare(
      "SELECT id, label FROM provider_instances WHERE template_id = ? AND enabled = 1",
    )
    .all("borderline-indeed") as Array<{ id: string; label: string }>;

  if (orphaned.length > 0) {
    sqlite
      .prepare(
        "UPDATE provider_instances SET enabled = 0 WHERE template_id = ? AND enabled = 1",
      )
      .run("borderline-indeed");
    console.log(
      `⚠️ disabled ${orphaned.length} provider instance(s) using the removed borderline-indeed template: ${orphaned
        .map((row) => row.label)
        .join(", ")} — delete them on the Sources page`,
    );
  }
} catch (error) {
  console.error("❌ borderline-indeed instance cleanup failed:", error);
  process.exit(1);
}

// `applied_at` is the permanent "this was applied to" mark — what separates a
// closed job the user applied to (a real rejection) from one they never
// applied to at all. It is stamped by `updateJob`, but until the same commit
// as this block it fired only on the move to `applied`, and the stage switcher
// offers `ready -> in_progress` DIRECTLY. Every job that took that route is
// unstamped, and closing one produced `closed` + an outcome + a NULL
// `applied_at`: a row that reads as never-applied when it definitively was.
//
// Rows with positive evidence of an application are stamped from the best
// timestamp still on the row. The evidence outcomes are exactly
// {rejected, withdrawn, ghosted}: `mark_closed` is guarded to
// {applied, in_progress} and the detail panel renders its Mark Closed control
// only for those two, so a closure carrying one of them came from an applied
// row. `mark_duplicated` closes from {discovered, selected, processing, ready}
// and always writes 'duplicated'. `skipped` means never applied, and a `closed`
// row with a NULL outcome is no evidence at all.
//
// 'other' is DELIBERATELY EXCLUDED, and this is the subtle one. The rebuild
// above (see the status/outcome CASE pair) folds THREE different histories into
// it: the legacy `expired` status — an auto-expiry marker for stale postings,
// i.e. rows NEVER applied to — becomes `closed` + 'other', and so do the
// genuinely post-apply 'offer_accepted' / 'offer_declined'. The value cannot
// tell them apart, so treating it as evidence would stamp every legacy expired
// row as applied and inflate exactly the rejection statistics this mark exists
// to make countable. What excluding it costs is narrow by comparison: a row
// closed as 'other' that took the ready -> in_progress shortcut. Anything
// closed as 'other' that passed through `applied` is already stamped, because
// the coalesce fired at the time. Missing evidence must never buy a mark.
//
// The true apply instant is unrecoverable; it lies in [ready_at, closed_at].
// `ready_at` is the tightest real lower bound (tailor, then apply, usually in
// one sitting), `closed_at` anchors a row that was never tailored.
//
// Every source is normalised to ISO before it is written. `applied_at` is
// currently a clean ISO-8601 UTC column (its only writer is `updateJob` with
// toISOString()), while `closed_at` is INTEGER unix SECONDS and
// `discovered_at`/`updated_at` carry a `(datetime('now'))` DEFAULT whose
// space-separated form Date.parse reads in the HOST zone. Copying either in
// verbatim would put two formats in one column and shift the Applied date
// filter by the host offset.
//
// Idempotent: the WHERE matches only `applied_at IS NULL`, so a second boot
// matches nothing — and post-fix no new row can enter the population, since
// both `applied` and `in_progress` now stamp live. It runs here, after the SQL
// migrations array, so the every-boot `jobs` rebuild (which carries applied_at
// in both its INSERT and SELECT lists) has already completed.
try {
  const candidates = sqlite
    .prepare(
      `SELECT id, ready_at, closed_at, updated_at, discovered_at
       FROM jobs
       WHERE applied_at IS NULL
         AND (
           status IN ('applied', 'in_progress')
           OR (status = 'closed' AND outcome IN ('rejected', 'withdrawn', 'ghosted'))
         )`,
    )
    .all() as Array<{
    id: string;
    ready_at: string | null;
    closed_at: number | null;
    updated_at: string | null;
    discovered_at: string | null;
  }>;

  if (candidates.length > 0) {
    // SQLite's `datetime('now')` is UTC but emits "YYYY-MM-DD HH:MM:SS" with no
    // zone marker, which Date.parse resolves in the host zone — hence the
    // explicit Z. Anything unparseable returns null so the caller falls through
    // to the next source rather than writing a bad value.
    // A stamp must land between "the app could plausibly have existed" and now.
    const MIN_STAMP_MS = Date.parse("2000-01-01T00:00:00.000Z");
    const MAX_STAMP_MS = Date.now();
    const inRange = (ms: number): boolean =>
      Number.isFinite(ms) && ms >= MIN_STAMP_MS && ms <= MAX_STAMP_MS;

    const toIso = (value: string | null): string | null => {
      if (!value) return null;
      const raw = value.trim();
      if (!raw) return null;
      const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
        ? `${raw.replace(" ", "T")}Z`
        : raw;
      const ms = Date.parse(candidate);
      return inRange(ms) ? new Date(ms).toISOString() : null;
    };

    const secondsToIso = (value: number | null): string | null => {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const ms = value * 1000;
      // Out-of-range covers the millisecond-valued legacy row: 1.79e12 seconds
      // is year ~56,700, which `new Date()` accepts happily.
      return inRange(ms) ? new Date(ms).toISOString() : null;
    };

    const update = sqlite.prepare(
      "UPDATE jobs SET applied_at = ? WHERE id = ? AND applied_at IS NULL",
    );

    let stamped = 0;
    let unresolved = 0;
    const run = sqlite.transaction(() => {
      for (const row of candidates) {
        const stamp =
          toIso(row.ready_at) ??
          secondsToIso(row.closed_at) ??
          toIso(row.updated_at) ??
          toIso(row.discovered_at);
        if (!stamp) {
          // Every timestamp on the row was absent or unparseable. Leaving it
          // NULL under-reports one job; inventing a date would corrupt the
          // date filter for everyone.
          unresolved += 1;
          continue;
        }
        update.run(stamp, row.id);
        stamped += 1;
      }
    });
    run();

    if (stamped > 0) {
      console.log(
        `✅ backfilled applied_at on ${stamped} job(s) that reached Interviewing or were closed out without an apply stamp`,
      );
    }
    if (unresolved > 0) {
      console.log(
        `⚠️ ${unresolved} applied job(s) had no usable timestamp to backfill applied_at from — left unmarked`,
      );
    }
  }
} catch (error) {
  console.error("❌ applied_at backfill failed:", error);
  process.exit(1);
}

sqlite.close();
console.log("🎉 Database migrations complete!");
