---
title: Getting started
parent: User guide
nav_order: 1
---
# Getting started

CV Clanker runs as a single Docker container on your own machine.

## Prerequisites

- **[Docker](https://docs.docker.com/get-docker/)**. The dev path also needs git
  and Docker Compose (included with Docker Desktop).
- An **LLM API key** (OpenAI, Gemini, or OpenRouter are easiest) — or a **local**
  model via LM Studio / Ollama, which needs no key. See
  [LLM providers](llm-providers.md).

The image, `ghcr.io/joaopn/cvclanker`, bundles everything else it needs
(Tectonic for LaTeX, LibreOffice for Word, headless browsers, the Claude Code
CLI). The Codex CLI is not bundled: install it in-app when
you pick the Codex provider; it is stored with your data and updates
independently of the image.

The published image is built for x86-64 (amd64) machines; on an Apple Silicon
Mac or another ARM machine it may not start, or run slowly under emulation. The
dev path builds the image for your own machine instead (not yet tested on ARM).

There are two ways to run it. Pick one: they keep their data in different
places, so switching later starts with an empty app (move your data across with
the export and import below).

## Release: run the published image

```bash
docker run -d --name cvclanker -p 3005:3001 -e HOST_PORT=3005 --cap-drop ALL --security-opt no-new-privileges -v cvclanker-data:/app/data --restart unless-stopped ghcr.io/joaopn/cvclanker:latest
```

The first start downloads the image. When it is up, open
**http://localhost:3005**. Your data lives in a Docker volume named
`cvclanker-data`, which survives updates and container removal.

| To | Run |
|---|---|
| Stop | `docker stop cvclanker` |
| Start again | `docker start cvclanker` |
| Watch the logs | `docker logs -f --tail=200 cvclanker` |
| Wipe everything (deletes all jobs, CVs, PDFs) | `docker rm -f cvclanker`, then `docker volume rm cvclanker-data`, then the install command again |

To update, paste these three lines. The last one is the same command as above,
so your data volume is reattached — if you retype it, keep the
`-v cvclanker-data:/app/data` part, or the app starts empty. If you added any
`-e` options, add them to the last line too:

```bash
docker pull ghcr.io/joaopn/cvclanker:latest
docker rm -f cvclanker
docker run -d --name cvclanker -p 3005:3001 -e HOST_PORT=3005 --cap-drop ALL --security-opt no-new-privileges -v cvclanker-data:/app/data --restart unless-stopped ghcr.io/joaopn/cvclanker:latest
```

To use a different port, change the first number in `-p 3005:3001` (and
`HOST_PORT` to match).

## Dev: build from source

```bash
git clone https://github.com/joaopn/cvclanker.git
cd cvclanker
docker compose up -d --build
```

The build takes several minutes. Your data lives in `./data` inside the clone.
These commands are for a Linux or macOS shell.

| To | Run |
|---|---|
| Update | `git pull && docker compose down && docker compose up -d --build` |
| Stop | `docker compose down` |
| Start again | `docker compose up -d` |
| Watch the logs | `docker compose logs -f --tail=200 cvclanker` |
| Wipe everything (deletes all jobs, CVs, PDFs) | `docker compose down && sudo rm -rf data/ && docker compose up -d --build` |

Don't run both paths on one machine: they use the same container name and port,
and the dev build is tagged with the release image's name, so a later
`docker run` would start your dev build instead of the release.

## First run

The onboarding wizard walks you through:

1. **Upload your CV** — a LaTeX `.tex`/`.zip`, a Word `.docx`, or an HTML
   `.html`/`.zip`. CV Clanker
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
4. **Download** the result (PDF for LaTeX, `.docx` for Word, the page or `.zip`
   for HTML) and apply yourself.

## Where your data lives

Everything is one SQLite database per user profile (Settings → User Profiles) —
jobs, settings, CV/cover-letter archives, generated PDFs, prompts, and the
session secret. It lives in the
`cvclanker-data` volume (release) or under `./data` (dev).

To back up, open **Settings → User Profiles** and click **Export** on a
profile to download it (with several user profiles, export each one). Tick **Include
API keys & secrets in exports** first if the backup should keep your API keys
(the file then holds them in plain text). To restore, use **Import profile** on
the same page, then **Activate** the imported profile; your current data is kept
as another profile, not overwritten. On a fresh install, **Import database** in
the onboarding wizard does both steps. Expect to sign in again after a restore.

## Running from source

To run from source rather than the Docker image, see
**[CONTRIBUTING.md](https://github.com/joaopn/cvclanker/blob/main/CONTRIBUTING.md)** for the dev setup and commands.
