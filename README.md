# CV Clanker

CV Clanker is a self-hosted workspace for a job search. It scrapes job boards,
optionally scores how well each posting matches you, and tailors a copy of your
CV and a cover letter for each one. It runs locally in Docker, stores everything
in a single SQLite file, and does not submit applications for you.

It's a fork of [JobOps](https://github.com/DaKheera47/job-ops), adapted to a
LaTeX/Word CV workflow and with the parts that weren't needed for that removed
(telemetry, hosted cloud, application tracking). It's a personal fork shared in
case it's useful — there's no roadmap, hosted version, or support commitment.

## What it does

- **CVs in LaTeX or Word.** You upload your own `.tex` or `.docx`. Tailoring
  edits the content of that document rather than generating a new one from a
  fixed template. LaTeX renders to PDF; Word is downloaded as a `.docx`, with a
  PDF preview.
- **Job scraping.** Built-in sources are LinkedIn, Indeed, and Glassdoor (via
  jobspy), Hiring Cafe, startup.jobs, and Working Nomads. [Apify](https://apify.com)
  actors can also be used as sources, with ready-made templates for LinkedIn and
  Indeed.
- **Tailoring from a brief.** You write a free-text "personal brief" describing
  things your CV leaves out. Per-job tailoring and an ATS keyword pass use the
  brief and the job description; a chat panel proposes edits you accept or reject.
- **LLM of your choice.** OpenAI, Gemini, OpenRouter, Codex, any OpenAI-compatible
  endpoint, or a local model via LM Studio or Ollama.
- **Local.** No accounts and no telemetry; the only outbound calls are to the LLM
  and the job sources you configure.

## Requirements

[Docker](https://docs.docker.com/get-docker/) with Compose. The image bundles the
rest (Tectonic for LaTeX, LibreOffice for Word, headless browsers).

## Install

```bash
git clone https://github.com/joaopn/cvclanker.git
cd cvclanker
docker compose up -d --build
```

Then open http://localhost:3005. The onboarding wizard covers uploading a CV,
writing a brief, choosing an LLM, and picking sources. No API key is needed to
start the app — you need one (or a local model) for the steps that call an LLM.

## How it works

1. Upload a CV (LaTeX or Word). The upload is accepted only if the app can
   reproduce your document exactly; see [docs/cvs.md](docs/cvs.md).
2. Write a personal brief — context your CV doesn't include.
3. Scrape jobs from the sources you enabled.
4. Optionally score fit, then triage from the list or the swipe view.
5. Tailor the CV and generate a cover letter per job, reviewing each change.
6. Track jobs through Inbox → Live → Closed.

## Documentation

See [`docs/`](docs/):

- [Getting started](docs/getting-started.md) — install and first run
- [CVs: LaTeX, Word & the brief](docs/cvs.md)
- [Job sources](docs/job-sources.md) and [Apify integration](docs/apify.md)
- [Tailoring & AI assist](docs/tailoring.md)
- [Tracking your hunt](docs/job-lifecycle.md)
- [LLM providers & prompts](docs/llm-providers.md)
- [Configuration](docs/configuration.md) and [FAQ](docs/faq.md)

## Relation to JobOps

Fork of [JobOps](https://github.com/DaKheera47/job-ops), diverged at commit
`01452b6`. The main differences:

| | CV Clanker | JobOps |
|---|---|---|
| CV output | LaTeX and Word `.docx` | PDF only (`.docx` import-only) |
| Apify | Any actor, plus templates | One hard-coded actor |
| Telemetry | None | Umami (opt-out) |
| Hosting | Self-host only | Self-host and paid cloud |
| Scope | CV documents | Full application tracking (Gmail, kanban, visa) |

The application-tracking, hosted-cloud, and telemetry features from JobOps were
removed. A fuller comparison is in [docs/comparison.md](docs/comparison.md).

## License

AGPLv3 + Commons Clause — see [LICENSE](LICENSE). Contributions welcome:
[CONTRIBUTING.md](CONTRIBUTING.md).
