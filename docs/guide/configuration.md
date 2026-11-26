---
title: Configuration
parent: User guide
nav_order: 13
---
# Configuration

Everything is set in the app, on the **Settings** page, and stored in your database. Nothing needs to be configured before the first start: the onboarding wizard collects the minimum.

## The onboarding wizard

The first time you open the app, or after starting a fresh user profile, every page sends you to a six-step wizard. You can visit the steps in any order from the list on the left.

| Step | What you do | Needed to leave the wizard |
|---|---|---|
| 1 LLM | In **Add provider**, pick a provider and fill in what it needs (key, base URL, Claude Code token, or a Codex sign-in). **Test** checks it without saving; **Add** saves it. The first provider you add is the one the app runs on; later ones are extras for the pre-filter and model benchmarking. | yes: the app's provider must pass its connection check |
| 2 CV format | LaTeX, Word or HTML. Fixed for this user profile once saved. | no |
| 3 CV | Upload your CV and edit the personal brief drafted from it, or skip. See [CVs](cvs.md). | no |
| 4 Search profile | The job titles to search for (drafted from your CV the first time) and where. | yes: the default search profile needs at least one term |
| 5 Sources | The built-in boards (all on by default) and optional [Apify](apify.md) actors. | no |
| 6 Finalize | Add a username and password, or skip; optionally give your name for downloaded files; pick a theme. | yes: the sign-in choice is recorded |

The app opens as soon as the three required facts hold. Because the LLM check runs on every page load, a key that stops working brings the wizard back. Everything here can be changed later, except the CV format.

**Import database**, beside the step list, is the way in for an existing installation: it files an exported database as a new user profile and switches to it, so the wizard disappears if that database is already set up.

## The Settings page

Settings are grouped in the left-hand list, with a search box at the top. Each section shows whether it has unsaved edits; **Save changes** stores them, **Discard changes** drops them, and **Reset section to defaults** clears that section's saved values (never your LLM key, Claude Code token, login or your name).

| Group | Section | What it holds |
|---|---|---|
| AI | **Models** | Provider, key or token, base URL, the default and task models, Claude Code reasoning effort, the pre-filter model. See [LLM providers](llm-providers.md). |
| AI | **Provider Credentials** | Keys for providers other than the configured one, for benchmarking and the pre-filter. |
| AI | **Model Benchmarking** | Compare models on a sample of your jobs. |
| AI | **Writing Style** | Tone, formality, constraints, words to avoid, output language, the cover-letter policy. |
| AI | **Context limits** | Character caps on the brief, job description, tailored content and cover letter. A longer text is refused, never silently cut. |
| Accounts & Security | **Accounts & Access** | **Enable authentication**, username, password, **Session expiry (seconds)**. |
| Accounts & Security | **User Profiles** | Switch, import, export, rename, delete and create whole databases (below). |
| Display | **Display Preferences** | Theme, Markdown in job descriptions, the [company in-flight warning](reviewing-jobs.md#the-company-in-flight-check), and **Your name** for downloaded CVs and cover letters. |
| Pipeline | **Pipeline Behavior** | Auto-tailoring, LLM scoring on or off, auto-skip, the **Scoring policy**, the Inbox stale threshold, LinkedIn live status, the LinkedIn early stop, LLM retries and timeouts, the LaTeX timeout, how many jobs each pool works on at once, the URL-fetch settings, upload size caps. |
| Prompts | **LLM Prompts** | The prompt editor. |
| Danger Zone | **Danger Zone** | Delete jobs, or clear the database (below). |

Under **Pipeline Behavior**, **Re-fetch jobs with a missing description** (off by default) makes every run open the posting page of each job it just found but could not score because the source gave too little description, and score it from that page. It costs a page fetch and a few LLM calls per job; see [Running a search](runs.md).

[Search profiles](search-profiles.md) (what to search for, where, and with which sources) and [schedules](runs.md#scheduling) have pages of their own.

## Environment variables

Optional, for advanced setups. Where a variable has a matching setting, a value saved on the Settings page wins over it, and clearing the setting falls back to the variable — so a login set with `BASIC_AUTH_*` can't be switched off from Settings. `JWT_SECRET`, when set, wins over the secret stored in the database.

To pass one on the release path, add `-e NAME=value` to the `docker run` line before the image name, recreate the container the way the [update steps](getting-started.md#release-run-the-published-image) do, and keep it on that line in every later update. On the dev path, put it in a `.env` file next to `docker-compose.yml`.

| Variable | Default | What it does |
|---|---|---|
| `LLM_PROVIDER` | `openrouter` | The LLM provider: `gemini`, `openai`, `openrouter`, `openai_compatible`, `lmstudio`, `ollama`, `codex` or `claude_code`. |
| `MODEL` | the provider's default | The default model, in the provider's own naming (`google/gemini-3-flash-preview` on OpenRouter). See [LLM providers](llm-providers.md#which-model-does-what). |
| `LLM_API_KEY` | *(unset)* | API key for that provider. |
| `LLM_BASE_URL` | *(provider default)* | The provider's endpoint. For `openai_compatible`, `lmstudio` and `ollama` it is the URL you point at (also settable in Settings). For `openai`, `gemini` and `openrouter` it replaces the vendor's endpoint (e.g. a proxy). |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(unset)* | Token for the Claude Code provider, minted with `claude setup-token`. |
| `CLAUDE_CODE_EFFORT` | *(CLI default)* | Reasoning effort for Claude Code calls. |
| `APIFY_API_TOKEN` | *(unset)* | Token for [Apify](apify.md) sources. |
| `BASIC_AUTH_USER` | *(unset)* | Username for optional login. |
| `BASIC_AUTH_PASSWORD` | *(unset)* | Password for optional login. |
| `JWT_SECRET` | *(DB-managed)* | Pin the session-signing secret externally (at least 32 characters). If unset, it's managed in the database. |
| `JWT_EXPIRY_SECONDS` | `86400` | Baseline session lifetime (24h). |
| `LLM_REQUEST_TIMEOUT_MS` | `300000` | Baseline ceiling on one LLM request (5 min). |
| `LATEX_COMPILE_TIMEOUT_MS` | `600000` | Baseline ceiling on one LaTeX compile (10 min). |
| `JOBSPY_IS_REMOTE` | `0` | Set `1` to ask JobSpy's Indeed and LinkedIn searches for remote postings only. A profile whose work arrangement is Remote alone does this anyway. |
| `PENALIZE_MISSING_SALARY` | `0` | Set `1` to demote a job one fit rating when it lists no salary. There is no Settings control for this. |

## Authentication

By default the app is **unauthenticated** — fine on `localhost`. If you expose it on a network, turn on **Enable authentication** in Settings → Accounts & Access (or the wizard's last step) with a username and password, or set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`. Authentication is on only when both are set.

With it on, the app asks you to **Sign in** before it shows anything. The session lasts 24 hours by default (**Session expiry (seconds)**, or `JWT_EXPIRY_SECONDS`) and is kept per browser tab, so a new tab signs in again. Generated documents under `/pdfs/` stay readable without signing in, so previews and download links keep working. An agent connected through [Agent access](agent-access.md) does not sign in: it uses its own token. How sign-in works is in [Sign-in](../architecture/settings-and-onboarding.md#sign-in).

## User profiles

A **user profile** is a whole database: jobs, CVs, cover letters, search profiles, sources, settings, prompts, generated documents and the sign-in secret. Each one has its own CV format, so a LaTeX hunt and a Word hunt live in two user profiles. (Not to be confused with [search profiles](search-profiles.md), several of which live inside each user profile.)

Manage them in **Settings → User Profiles**, or switch from the profile line in the side menu.

| Action | Effect |
|---|---|
| **Activate** | Switches to that user profile. The app restarts with it; a page overlay waits and reloads. Sign in again if authentication is on. |
| **New profile** | Stores the current database as a profile and restarts into a fresh install, which opens the wizard. |
| **Import profile** | Checks an exported database file and adds it as a stored profile, without touching the active one. **Activate** it to use it. |
| **Export** | Downloads a copy of that database. API keys, tokens, the login password and the sign-in secret are removed unless **Include API keys & secrets in exports** is ticked. |
| Rename, **Delete** | Rename any profile by editing its name; only stored (inactive) profiles can be deleted. |

Switching is refused while a run, a bulk action or a URL import is in flight. How the swap works is in [User Profiles: one database each](../architecture/settings-and-onboarding.md#user-profiles-one-database-each).

## Themes

Themes are chosen in **Settings → Display** or the wizard's last step: **System**, **Light** or **Dark**, with a **Light theme** and a **Dark theme** palette.

- **Light:** Sandstone *(default)*, Ice, Newsprint, VS Code Light, Grape Light
- **Dark:** Graphite Mono *(default)*, Slate Blue, Forest Amber, Nord, Crimson Noir

**System** (the default) follows your OS setting, using your light or dark pick. Your choice is remembered in this browser, not in your data.

## Data, backups & restore

Each user profile is one SQLite database. They live in the `cvclanker-data` Docker volume (release) or under `./data` (dev).

- **Back up** with **Export** on a profile's card in **Settings → User Profiles**; with several user profiles, export each one. Tick **Include API keys & secrets in exports** first if the backup should keep your API keys and login password; the file then holds them in plain text, so store it safely. On the dev path, copying `data/` while stopped works too.
- **Restore** with **Import profile** on the same page, then **Activate** the imported profile; your current data is kept as another profile, not overwritten. On a fresh install, **Import database** in the onboarding wizard does both steps. Expect to sign in again after a restore. An export made without secrets also drops the login password, so login is off afterwards unless `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` are set as environment variables.
- An export does not carry Codex or its sign-in, so on a new machine install and sign in to Codex again; a copy of the whole volume or of `data/` does carry them.

To wipe everything and start over, use the **Wipe everything** line for your path in [Getting started](getting-started.md#release-run-the-published-image) (release) or [the dev path](getting-started.md#dev-build-from-source).

## Danger Zone

**Settings → Danger Zone** deletes data in bulk. None of it can be undone, so export first if in doubt.

| Control | Deletes | Keeps |
|---|---|---|
| **Clear Jobs by Status** | Every job in the stages you tick, including application history if you tick applied ones | Everything else |
| **Clear Jobs by Fit Category** | Jobs scored at or below the chosen fit | Anything at Live or Interviewing, or ever applied to |
| **Clear Database** | All jobs, pipeline runs, generated documents and the "since the last run" bookkeeping | Settings, CVs, cover letters, search profiles, sources, schedules, prompts |

## Ports

CV Clanker serves on **http://localhost:3005** by default. To change it, edit the first number in `-p 3005:3001` on the `docker run` line (and `HOST_PORT` to match), or the left side of the `ports` mapping in `docker-compose.yml`.

How it works: [Settings and onboarding](../architecture/settings-and-onboarding.md), [System overview](../architecture/system.md)
