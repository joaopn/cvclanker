---
title: System overview
parent: How it works
nav_order: 1
---
# System overview

CV Clanker is one Docker container. Inside it a Node/Express server serves the React client and a JSON API, keeps everything in a single SQLite file under the data directory, and shells out to helper programs (the job-board extractors, Tectonic, LibreOffice, Chromium, `pdftotext`, Camoufox, the Codex and Claude Code CLIs) when a piece of work needs them. Nothing runs outside the container, and the only outbound traffic is to the LLM provider and the job sources you configure.

Using it: [Getting started](../guide/getting-started.md), [Configuration](../guide/configuration.md)

## How it works

```mermaid
flowchart LR
  B["Browser: React client"] -->|"/api JSON + SSE"| S["Express server"]
  B -->|"/pdfs"| S
  S --> DB[("data/jobs.db SQLite")]
  S --> X["Built-in extractors: Python and TS"]
  S --> AP["Apify actors"]
  S --> L["LLM providers: HTTP APIs, Codex CLI, Claude Code CLI"]
  S --> T["Tectonic: LaTeX to PDF"]
  S --> U["unoserver + LibreOffice: Word to PDF"]
  S --> CH["Chromium: HTML CV to PDF"]
  S --> P["pdftotext: CV equivalence check"]
  S --> W["Camoufox: Hiring Cafe, page fetch fallback"]
  X --> JB["Job boards"]
  SC["Run scheduler, in-process"] --> S
```

The server is the only long-lived process. A pipeline run, a tailor, a cover letter or a CV upload is a piece of server code that calls out to one of the helpers above and writes the result back to SQLite; the client polls or listens for it.

### What the server answers

| Path | What it serves |
|---|---|
| `/api/*` | The JSON API. Every answer has the same envelope: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, plus a request id (also sent as the `x-request-id` header) that appears in the logs. |
| `/api/...` streams | Long work reports progress as Server-Sent Events: pipeline run progress, bulk job-action batches, the ghostwriter chat, batch import of jobs by URL, the LLM call queue and the scoring benchmark. |
| `/pdfs/*` | Generated CV and cover-letter documents, read out of the database (see [Tailoring and cover letters](tailoring.md)). |
| `/health` | A liveness probe; the image's and the compose file's healthchecks call it every 30 s. |
| anything else | The client app (`index.html`), so every client route is a deep link. |

### Boot

```mermaid
sequenceDiagram
  participant C as Container start
  participant M as migrate.ts
  participant S as Server
  C->>M: create the Codex home, then run migrations
  M->>M: bring jobs.db up to the current schema, seed prompts
  C->>S: start the server
  S->>S: apply settings that override environment values
  S->>S: discover and register the extractors
  S->>S: mark tailors cut off by a restart as interrupted
  S->>S: listen on 3001
  S->>S: sign-in session cleanup, then every hour
  S->>S: start the run scheduler, first pass immediately
```

If the extractor registry cannot be built, the server does not start: in production the process exits rather than run with sources missing. The same boot step that marks interrupted tailors also returns any job left at the transient `selected` status to the Inbox. The scheduler's first pass runs straight after boot, so a scheduled run that came due while the container was down fires once, never a backfill of every missed slot (see [Pipeline runs](pipeline-runs.md)).

### What lives in the data directory

The data directory is `/app/data` inside the container: `./data` on the dev path, the `cvclanker-data` volume on the release path.

| Path | Holds |
|---|---|
| `jobs.db` (+ `-wal`, `-shm`) | The whole active workspace: jobs, CVs, cover letters, generated documents, search profiles, sources, runs, schedules, settings, prompts, chat threads, secrets. |
| `user-profiles/` | The inactive [user profiles](settings-and-onboarding.md), each a complete database file swapped in when you switch. |
| `codex/`, `codex-home/` | The Codex CLI, installed at runtime from Settings, and its login. |

### The main tables

| Table | Holds |
|---|---|
| `jobs`, `job_notes`, `job_pdfs` | Every job ever discovered, its notes, and the generated documents as BLOBs. |
| `cv_documents`, `cover_letter_documents` | The uploaded CVs (source, template, extracted fields) and the cover-letter documents. |
| `profiles`, `source_scrape_watermarks` | Search profiles and, per profile and source, how far back the last scrape reached. |
| `source_configs`, `provider_instances` | Configured sources: built-in extractors and Apify actors. |
| `pipeline_runs`, `run_schedules` | Run history with per-run detail, and the schedules that start runs. |
| `job_chat_threads`, `job_chat_messages`, `job_chat_runs` | The ghostwriter chat per job. |
| `settings`, `prompts` | Settings values and the live prompt YAML (with its shipped default for Reset). |
| `runtime_secrets`, `llm_provider_credentials`, `auth_sessions` | The sign-in signing secret, keys for providers other than the configured one, and sign-in sessions. |

### Programs in the image

| Program | Used for |
|---|---|
| Tectonic 0.15.0 | Compiling LaTeX CVs; never run with shell escape. |
| `pdftotext` (poppler) | The CV upload gate: the templated PDF's text must match the original's. |
| LibreOffice Writer + unoserver | Converting Word CVs to a PDF preview, through a long-lived conversion daemon. |
| Chromium headless shell (Playwright) | Printing HTML CVs to PDF: one shared browser, JavaScript off, every request answered from the uploaded files. |
| Python 3 + python-jobspy | The LinkedIn and Indeed extractor. |
| Camoufox | Hiring Cafe scraping and the browser tier of reading a job off its URL: a Firefox build that gets past bot checks, driven through Playwright. |
| Claude Code CLI | The `claude -p` LLM provider, pinned to the version the provider was verified against. |
| Codex CLI | Not baked in: installed into the data directory from Settings or the wizard, so it updates without a new image. |

## Design decisions

### One SQLite file holds everything

The database is the install: jobs, CVs, prompts, settings, secrets and even the generated documents (stored as BLOBs rather than files) all live in `jobs.db`. Copying the data directory moves a complete workspace, importing a database during onboarding restores one, and a user profile is simply another database file swapped into place. The file runs in SQLite's WAL journal mode.

### Migrations run at every boot

There is no separate upgrade step. Before the server starts, `migrate.ts` creates missing tables, adds missing columns, rebuilds tables whose shape changed and drops the tables of features that were removed. Any older database, including one imported from another install, is brought to the current schema on start.

### TypeScript runs through tsx, not a build

The server runs its TypeScript sources directly through `tsx`; only the client is bundled (by Vite, at image build). That keeps the image simple and stack traces readable, at the cost that a broken import is a boot failure rather than a build failure.

### A least-privilege container

The app runs an agentic CLI over text scraped from the internet and feeds untrusted documents to Tectonic, LibreOffice, Chromium and Camoufox, so the realistic escalation path is a parser bug. The compose file and the release `docker run` line drop every Linux capability and forbid privilege escalation; the whole workload was verified to run that way. The one cost: root loses its override on file permissions, so the data directory must be writable by uid 0, which it is by default.

### Sign-in is optional, and off by default

When `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are both set (in Settings or the environment), every `/api` request except sign-in and sign-out, and every request outside `/api` other than a GET or HEAD, needs a session token from the sign-in page. With neither set, anyone who can reach the port can use the app: it is built to be bound to localhost or a trusted network. See [Settings and onboarding](settings-and-onboarding.md).

### Independent of upstream JobOps

CV Clanker started as a fork of JobOps. The fork removed telemetry, version polling, the original project's hosted images and CI, and keeps it that way: no analytics calls and no links back to the original project's services. The only workflow in the repository publishes this documentation site, and the only outbound calls the app makes are the ones you configure.

### Two ways to run: release and dev

Users run the published image `ghcr.io/joaopn/cvclanker:latest` with a single `docker run` line that applies the same hardening as compose and keeps the data in a Docker volume named `cvclanker-data`; updating is pull, remove, and the same line again, so the volume is reattached. The dev path clones the repository and runs `docker compose up -d --build`, which builds from source and keeps the data in `./data`. Nothing has to be configured before the first start, because every setting lives in the app, so there is no `.env` step; environment variables remain only as optional overrides. The compose file names the image after the release, so a dev build carries the release name locally: the two paths should not share a machine.

### Codex installs at runtime, Claude Code is baked

Codex is installed into the data directory from Settings, so it can update independently of the image. Claude Code is baked in at a pinned version, because the provider passes it a specific set of flags and the Settings panel shows which version those were verified against.

### Two browsers, each for what it can do

The image carries Chromium for printing HTML CVs and Camoufox for the sites that check for bots, and no plain Firefox. Chromium gives the cleanest PDF of a web page, but sites behind Cloudflare answer headless Chromium with a challenge page (hiring.cafe does), so scraping stays on Camoufox. When Hiring Cafe's first page load fails, the extractor retries once in a fresh Camoufox rather than falling back to another browser.

### Word conversion goes through a daemon

Word CVs convert through `unoserver`, a long-lived LibreOffice process, rather than a cold `soffice --convert-to` per file: real CVs were found to hang the cold path indefinitely while converting fine through the daemon.

## Where it lives

| Path | What |
|---|---|
| `orchestrator/src/server/index.ts`, `orchestrator/src/server/app.ts` | Boot sequence, middleware, sign-in guard, static serving. |
| `orchestrator/src/server/api/routes/` | One router per API area. |
| `orchestrator/src/server/db/` | Schema, boot migrations, user-profile database files. |
| `orchestrator/src/server/services/`, `orchestrator/src/server/pipeline/` | The domain logic and the run pipeline. |
| `orchestrator/src/client/` | The React app; `App.tsx` holds the routes. |
| `shared/src/` | Logic and types used by both server and client (location matching, duplicates, settings registry). |
| `extractors/` | The built-in job-board scrapers, discovered at boot. |
| `Dockerfile`, `docker-compose.yml` | The image (with every helper program) and the hardened service. |
