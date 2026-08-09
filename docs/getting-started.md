# Getting started

CV Clanker runs as a single Docker container on your own machine.

## Prerequisites

- **[Docker](https://docs.docker.com/get-docker/)** with Compose.
- An **LLM API key** (OpenAI, Gemini, or OpenRouter are easiest) — or a **local**
  model via LM Studio / Ollama, which needs no key. See
  [LLM providers](llm-providers.md).

The image bundles everything else it needs (Tectonic for LaTeX, LibreOffice for
Word, headless browsers, the Claude Code CLI) and builds locally — nothing is
pulled from a registry. The Codex CLI is not bundled: install it in-app when
you pick the Codex provider; it lives in `data/` and updates independently of
the image.

## Install & run

```bash
git clone https://github.com/joaopn/cvclanker.git
cd cvclanker
docker compose up -d --build
```

The first build takes a few minutes. When it finishes, open
**http://localhost:3005**. To change the port, edit the `ports` mapping in
`docker-compose.yml`.

## First run

The onboarding wizard walks you through:

1. **Upload your CV** — a LaTeX `.tex`/`.zip` or a Word `.docx`. CV Clanker
   verifies it can reproduce your document exactly before accepting it; see
   [CVs](cvs.md).
2. **Write a personal brief** — first-person notes about your experience and
   anything your CV leaves out. Tailoring draws on this, so it's worth a few real
   paragraphs. CV Clanker can draft a starting point from your CV.
3. **Suggest search terms** — proposed from your CV; edit to taste.
4. **Pick your LLM provider** — choose a provider and model, paste a key (or
   point at a local endpoint). Changeable any time in Settings.
5. **Choose job sources** — enable the boards you want, including
   [Apify](apify.md) actors.

Everything here can be revisited later, except your CV *format* (LaTeX vs. Word),
which is fixed per profile.

## Your first hunt

1. Run a **scrape** — jobs stream into the Inbox as sources report in.
2. **Triage** on the main list or the [swipe deck](job-lifecycle.md).
3. Open a job and **tailor** it: review the CV edits and
   [ATS coverage](tailoring.md), accept what you like, generate a cover letter.
4. **Download** the result (PDF for LaTeX, `.docx` for Word) and apply yourself.

## Where your data lives

Everything is one SQLite file: **`./data/jobs.db`**, mounted into the container —
jobs, settings, CV/cover-letter archives, generated PDFs, prompts, and the
session secret. Back up the `data/` folder (or use the in-app snapshot export)
and you've backed up your whole install.

## Everyday operations

```bash
docker compose logs -f --tail=200 cvclanker   # watch logs
docker compose down                           # stop
git pull && docker compose up -d --build      # update and rebuild

# Wipe everything (destructive: deletes all jobs, CVs, PDFs)
docker compose down && rm -rf data/ && docker compose up -d --build
```

## Running from source

To run from source rather than the Docker image, see
**[CONTRIBUTING.md](../CONTRIBUTING.md)** for the dev setup and commands.
