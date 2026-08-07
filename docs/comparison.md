# CV Clanker vs. JobOps

CV Clanker is a fork of **[JobOps](https://github.com/DaKheera47/job-ops)**,
diverged at commit `01452b6` and intentionally independent since.

JobOps is a broad application-tracking suite (Gmail integration, visa checks, a
kanban pipeline, an optional paid cloud). CV Clanker keeps the scraping and CV
tailoring, uses your own LaTeX or Word document instead of a fixed schema, and
drops the tracking, cloud, and telemetry features.

Both are AGPLv3 + Commons Clause, self-hosted via Docker on port 3005, backed by
a single SQLite file, and **neither auto-applies**.

## At a glance

| | **CV Clanker** | **JobOps** (upstream) |
|---|---|---|
| **CV output** | **LaTeX + real Word `.docx`**, plus PDF preview | PDF only (RxResume / LaTeX / Typst); `.docx` import-only |
| **CV model** | Your own `.tex` / `.docx`, any shape, + a free-text brief | Fixed Reactive Resume v5 schema |
| **Tailoring** | Field-level edits over your real document + ATS coverage | Field-scoped (summary / headline / skills / projects) |
| **Apify** | **Any actor + curated LinkedIn & Indeed templates** | Narrow (one hard-coded Seek actor) |
| **Job sources** | Indeed, LinkedIn, Glassdoor, Hiring Cafe, startup.jobs, Working Nomads, + Apify | ~13 boards incl. Adzuna, Gradcracker, UK Visa Jobs, Seek |
| **Cover letters** | Dedicated LaTeX substrate, per-job generate | Ghostwriter text drafts |
| **Job lifecycle** | Inbox / Live / Closed + swipe + repost detection | Kanban (applied → offer → rejected) + watchlist |
| **Post-application tracking** | — *(removed)* | Gmail auto-detection |
| **Visa sponsorship** | — *(removed)* | Licensed-sponsor register checks |
| **Telemetry** | **None** | Umami (opt-out) + analytics dashboard |
| **LLM providers** | OpenAI, Gemini, OpenRouter, Codex, OpenAI-compatible, LM Studio, Ollama | Similar, plus a dedicated Claude/GLM path |
| **Themes** | 8 palettes (4 light + 4 dark) | Minimal / undocumented |
| **Hosting** | Self-host only, local build | Self-host (GHCR image) **+ paid cloud** |

## Choosing between them

- CV Clanker fits if your CV is LaTeX or Word and you want a local, self-hosted
  tool without tracking or telemetry.
- JobOps fits if you want application tracking (Gmail, kanban, visa checks), more
  region-specific boards, or a hosted option.

---

*Upstream details reflect a snapshot around **July 2026**; check the
[JobOps repo](https://github.com/DaKheera47/job-ops) for its current state.*
