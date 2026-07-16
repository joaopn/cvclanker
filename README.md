# CV Clanker

Self-hosted job search workspace built around a LaTeX-native CV pipeline,
with Word (`.docx`) as an alternative CV substrate. Scrapes job boards,
scores fit, tailors your CV and a cover letter per job, and tracks them
through an inbox/live/closed lifecycle. Runs locally in Docker. Does not
auto-apply.

## What this is

Workflow:

1. Upload a LaTeX CV (single `.tex` or zip with `\input{}`). The server
   flattens it, has the LLM extract a templated `.tex` plus a JSON of
   substitutable fields, then verifies the round-trip by recompiling and
   diffing the PDF text against the original. Partial extractions are
   rejected — there is no "mostly worked" state.
2. Write a `personal_brief` — long-form free text describing context the
   CV doesn't capture (side projects, things you've used in passing).
3. Scrape jobs from LinkedIn, Indeed, Glassdoor (via jobspy), Hiring Cafe,
   Working Nomads, startup.jobs, and Golang Jobs.
4. Per job, tailor the CV at the field level (JSON-Patch edits over the
   flattened TeX) using `personal_brief + JD + currentContent`, plus an
   ATS-keyword pass that surfaces matched/skipped JD terms. Generate a
   cover letter against the same substrate.
5. Render with Tectonic. Review and edit through a chat panel that
   proposes accept/reject patches against either document.
6. Move the job through Inbox → Live → Closed with outcome tagging.

Word CVs: a User Profile can use `.docx` instead of LaTeX — the choice is
made once, at onboarding, and is permanent for that profile. The server
extracts the document's text, the LLM names the tailorable spans (it never
writes markup), and the upload is gated on exact text equality plus a
successful LibreOffice conversion. Tailoring then rewrites those spans, so
the file you download is a `.docx`; the PDF is only a preview. Cover
letters remain LaTeX-only.

LLM providers: OpenAI, Gemini, OpenRouter, Codex, or any
OpenAI-compatible endpoint. Prompts are stored in the database (seeded from `prompts/` YAML defaults) and editable in-app. Both CV-tailoring prompts are format-aware: the server splices in the rules for the profile's CV format (`prompts/fragments/cv-format-latex.yaml` / `cv-format-docx.yaml`).

## Where it came from

Fork of [JobOps](https://github.com/DaKheera47/jobops). Diverged at
commit `01452b6`. The fork is intentionally independent — no GHCR pulls,
no upstream pings, no analytics, no CI.

Removed:
- Telemetry (Umami client/server, fingerprint, reverse proxy).
- CI workflows and FUNDING.
- Reactive Resume integration and the RxResume-era tailoring UI.
- Gmail / Tracking Inbox / post-application stack.
- In-progress kanban + application stage tracking.
- Tracer link rewriting + click analytics.
- Visa sponsorship, demo mode, conversion analytics, outbound webhooks,
  DB backup.
- Region-specific extractors: Adzuna, Gradcracker, UK Visa Jobs, Seek.
- Bundled documentation site.

Replaced or added:
- LaTeX CV substrate: flatten → Eta render → Tectonic compile, with a
  pdftotext content-equivalence gate on upload.
- `personal_brief` substrate; the rigid `cvContentSchema` is gone — the
  tailored JSON mirrors whatever shape the source CV uses.
- Field-level tailoring via JSON-Patch over flattened TeX, plus an
  ATS-coverage sidecar (matched/skipped JD keywords).
- Word (`.docx`) CV substrate: server-owned marker splicing over
  LLM-selected text spans, an exact-text-equality upload gate, and
  LibreOffice/unoserver conversion for PDF previews.
- Cover-letter document substrate with its own gated upload, per-job
  Generate, and Edit/PDF tab toggle.
- Job lifecycle redesign: Inbox / Live / Closed tabs, repost detection,
  pipeline-bound auto-aging, posted-date sort, outcome tagging.
- Batch URL import via streaming sheet.
- LLM observability: structured per-call logs, live call queue, status
  button, persistent upload spinner.
- User-editable LLM prompts, stored in the DB and seeded from `prompts/` YAML defaults.
- Onboarding wizard with a CV upload step.

## Operator manual

### Run

```bash
docker compose up -d --build
```

App is at `http://localhost:3005`. The image builds locally from the
included [`Dockerfile`](Dockerfile); nothing is pulled from a registry.

### Persistent state

- `data/` — SQLite DB (`data/jobs.db`) — the complete installation: jobs, settings, CV/cover-letter archives, generated PDFs, prompts, and the JWT secret all live inside it. Gitignored. Back this up (or use the in-app snapshot export).
- `prompts/` — baked into the image as the SEED defaults for the DB prompts table. Edit live prompts in-app, not on disk.
- `codex-home` named volume — Codex provider auth, if used.

### Configuration

LLM provider keys and any env overrides go in `./.env` (optional). See
the Settings page in the UI for in-app config (provider selection,
scoring toggle, tailoring opt-in, prompt overrides).

### Common operations

```bash
# Tail logs
docker compose logs -f --tail=200 cvclanker

# Stop
docker compose down

# Wipe state (destructive — deletes all jobs, CVs, generated PDFs)
docker compose down
rm -rf data/
docker compose up -d --build
```

## License

**AGPLv3 + Commons Clause** — see [LICENSE](LICENSE).
