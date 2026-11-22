---
title: Getting started
parent: User guide
nav_order: 1
---
# Getting started

CV Clanker runs as a single Docker container on your own machine.

## Prerequisites

- **[Docker](https://docs.docker.com/get-docker/)**. The dev path also needs git and Docker Compose (included with Docker Desktop).
- An **LLM API key** (OpenAI, Gemini, or OpenRouter are easiest), a Claude subscription through the Claude Code provider, or a **local** model via LM Studio / Ollama, which needs no key. See [LLM providers](llm-providers.md).

The image, `ghcr.io/joaopn/cvclanker`, bundles everything else it needs. The one exception is the Codex CLI: if you pick the Codex provider, install it in-app (it is kept with your data). See [Programs in the image](../architecture/system.md#programs-in-the-image).

The published image is built for x86-64 (amd64) machines; on an Apple Silicon Mac or another ARM machine it may not start, or run slowly under emulation. The dev path builds the image for your own machine instead (not yet tested on ARM).

There are two ways to run it. Pick one: they keep their data in different places, so switching later starts with an empty app (move your data across with the export and import below).

## Release: run the published image

```bash
docker run -d --name cvclanker -p 3005:3001 -e HOST_PORT=3005 --cap-drop ALL --security-opt no-new-privileges -v cvclanker-data:/app/data --restart unless-stopped ghcr.io/joaopn/cvclanker:latest
```

The first start downloads the image. When it is up, open **http://localhost:3005**. Your data lives in a Docker volume named `cvclanker-data`, which survives updates and container removal.

| To | Run |
|---|---|
| Stop | `docker stop cvclanker` |
| Start again | `docker start cvclanker` |
| Watch the logs | `docker logs -f --tail=200 cvclanker` |
| Wipe everything (deletes all jobs, CVs, PDFs) | `docker rm -f cvclanker`, then `docker volume rm cvclanker-data`, then the install command again |

To update, paste these three lines. The last one is the same command as above, so your data volume is reattached — if you retype it, keep the `-v cvclanker-data:/app/data` part, or the app starts empty. If you added any `-e` options, add them to the last line too:

```bash
docker pull ghcr.io/joaopn/cvclanker:latest
docker rm -f cvclanker
docker run -d --name cvclanker -p 3005:3001 -e HOST_PORT=3005 --cap-drop ALL --security-opt no-new-privileges -v cvclanker-data:/app/data --restart unless-stopped ghcr.io/joaopn/cvclanker:latest
```

To use a different port, change the first number in `-p 3005:3001` (and `HOST_PORT` to match).

## Dev: build from source

```bash
git clone https://github.com/joaopn/cvclanker.git
cd cvclanker
docker compose up -d --build
```

The build takes several minutes. Your data lives in `./data` inside the clone. These commands are for a Linux or macOS shell.

| To | Run |
|---|---|
| Update | `git pull && docker compose down && docker compose up -d --build` |
| Stop | `docker compose down` |
| Start again | `docker compose up -d` |
| Watch the logs | `docker compose logs -f --tail=200 cvclanker` |
| Wipe everything (deletes all jobs, CVs, PDFs) | `docker compose down && sudo rm -rf data/ && docker compose up -d --build` |

Don't run both paths on one machine: they use the same container name and port, and a later `docker run` could start your dev build instead of the release.

## First run

The first time you open the app, the onboarding wizard walks you through six steps (you can visit them in any order):

1. **Add an LLM provider** — choose a provider and model, paste a key (or point at a local endpoint), **Test** it and **Add** it. The app needs a working LLM to go further. See [LLM providers](llm-providers.md).
2. **Pick your CV format** — LaTeX, Word or HTML. This is fixed for this user profile.
3. **Upload your CV** — a LaTeX `.tex`/`.zip`, a Word `.docx`, or an HTML `.html`/`.zip`. CV Clanker verifies it can reproduce your document exactly before accepting it, and drafts a **personal brief**: first-person notes about your experience and anything your CV leaves out. Tailoring draws on the brief, so it's worth editing into a few real paragraphs. See [CVs](cvs.md).
4. **Set up a search profile** — the job titles to search for (drafted from your CV; edit to taste) and where. See [Search profiles](search-profiles.md).
5. **Choose job sources** — the built-in boards are all on by default; add [Apify](apify.md) actors if you want them.
6. **Finish** — add a username and password, or skip; optionally give your name for downloaded files; pick a theme.

Everything here can be changed later in the app, except the CV format. To work in another format, create another [user profile](configuration.md#user-profiles). If you already have a CV Clanker database, **Import database** beside the step list brings it in instead.

## Your first hunt

1. **Run a search** — press **Run pipeline**, then **Run**. The banner shows each source's progress; new jobs land in the Inbox and are scored. See [Running a search](runs.md).
2. **Triage** on the Manage list or the [swipe deck](reviewing-jobs.md).
3. **Tailor** a job and review the result: the CV edits, the [keyword coverage](tailoring.md#ats-keyword-coverage), and a cover letter if you want one.
4. **Download** the result (PDF for LaTeX, `.docx` for Word, the page or `.zip` for HTML), apply yourself, and mark the job applied to [track it](job-lifecycle.md).

## Where your data lives

All your data (jobs, CVs, settings, generated documents) is one database per user profile, kept in the `cvclanker-data` volume (release) or under `./data` (dev). Back it up with **Export** in **Settings → User Profiles**, and restore it with **Import profile** there (or **Import database** in the onboarding wizard); see [Data, backups & restore](configuration.md#data-backups--restore).

## Running from source

To run from source rather than the Docker image, see **[CONTRIBUTING.md](https://github.com/joaopn/cvclanker/blob/main/CONTRIBUTING.md)** for the dev setup and commands.

How it works: [System overview](../architecture/system.md)
