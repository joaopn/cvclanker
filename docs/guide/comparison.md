---
title: CV Clanker vs. JobOps
parent: User guide
nav_order: 15
---
# CV Clanker vs. JobOps

CV Clanker is a fork of **[JobOps](https://github.com/DaKheera47/job-ops)**, intentionally independent of it since the fork ([why](../architecture/system.md#independent-of-upstream-jobops)).

JobOps is a broad application-tracking suite (Gmail integration, visa checks, a kanban pipeline, an optional paid cloud). CV Clanker keeps the scraping and CV tailoring, uses your own LaTeX, Word or HTML document instead of a fixed schema, and drops the Gmail tracking, visa checks, kanban, cloud and telemetry features in favour of a simpler stage-based tracker of its own.

Both are AGPLv3 + Commons Clause, self-hosted via Docker on port 3005, backed by a single SQLite file, and **neither auto-applies**.

## At a glance

| | **CV Clanker** | **JobOps** (upstream) |
|---|---|---|
| **CV output** | **LaTeX + real Word `.docx` + HTML**, plus PDF preview | PDF only (RxResume / LaTeX / Typst); `.docx` import-only |
| **CV model** | Your own `.tex` / `.docx` / `.html`, any shape, + a free-text brief | Fixed Reactive Resume v5 schema |
| **Tailoring** | Field-level edits over your real document + ATS coverage | Field-scoped (summary / headline / skills / projects) |
| **Apify** | **Any actor + three curated LinkedIn templates** | Narrow (one hard-coded Seek actor) |
| **Job sources** | Indeed, LinkedIn, Hiring Cafe, startup.jobs, Working Nomads, plus Himalayas, We Work Remotely and Jobicy for remote searches, + Apify | ~13 boards incl. Adzuna, Gradcracker, UK Visa Jobs, Seek |
| **Cover letters** | Dedicated LaTeX substrate, per-job generate | Ghostwriter text drafts |
| **Job lifecycle** | Inbox, Tailoring, Live, Interviewing, Backlog, Stale, Closed + swipe deck + repost and duplicate detection + Stats | Kanban (applied → offer → rejected) + watchlist |
| **Post-application tracking** | — *(removed)* | Gmail auto-detection |
| **Visa sponsorship** | — *(removed)* | Licensed-sponsor register checks |
| **Telemetry** | **None** | Umami (opt-out) + analytics dashboard |
| **LLM providers** | OpenAI, Gemini, OpenRouter, Codex, Claude Code, OpenAI-compatible, LM Studio, Ollama | Similar, plus a dedicated GLM path |
| **Themes** | 10 palettes (5 light + 5 dark) | Minimal / undocumented |
| **Hosting** | Self-host only (GHCR image or local build) | Self-host (GHCR image) **+ paid cloud** |

## Choosing between them

- CV Clanker fits if your CV is LaTeX, Word or HTML and you want a local, self-hosted tool without inbox access or telemetry.
- JobOps fits if you want application tracking (Gmail, kanban, visa checks), more region-specific boards, or a hosted option.

---

*Upstream details reflect a snapshot around **July 2026**; check the [JobOps repo](https://github.com/DaKheera47/job-ops) for its current state.*
