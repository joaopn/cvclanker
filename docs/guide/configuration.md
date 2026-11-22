---
title: Configuration
parent: User guide
nav_order: 12
---
# Configuration

Everything is set in the app, on the **Settings** page, and stored in your
database. Nothing needs to be configured before the first start.

## Environment variables

Optional, for advanced setups. Where a variable has a matching setting, a value
saved on the Settings page wins over it, and clearing the setting falls back to
the variable — so a login set with `BASIC_AUTH_*` can't be switched off from
Settings. `JWT_SECRET`, when set, wins over the secret stored in the database.

To pass one on the release path, add `-e NAME=value` to the `docker run` line
before the image name, recreate the container the way the
[update steps](getting-started.md#release-run-the-published-image) do, and keep
it on that line in every later update.
On the dev path, put it in a `.env` file next to `docker-compose.yml`.

| Variable | Default | What it does |
|---|---|---|
| `MODEL` | `google/gemini-3-flash-preview` | The LLM to use, as `provider/model-name`. See [LLM providers](llm-providers.md). |
| `LLM_PROVIDER` | `openrouter` | The LLM provider: `gemini`, `openai`, `openrouter`, `openai_compatible`, `lmstudio`, `ollama`, `codex` or `claude_code`. |
| `LLM_API_KEY` | *(unset)* | API key for that provider. |
| `LLM_BASE_URL` | *(provider default)* | The provider's endpoint. For `openai_compatible`, `lmstudio` and `ollama` it is the URL you point at (also settable in Settings). For `openai`, `gemini` and `openrouter` it replaces the vendor's endpoint (e.g. a proxy). |
| `APIFY_API_TOKEN` | *(unset)* | Token for [Apify](apify.md) sources. |
| `BASIC_AUTH_USER` | *(unset)* | Username for optional login. |
| `BASIC_AUTH_PASSWORD` | *(unset)* | Password for optional login. |
| `JWT_SECRET` | *(DB-managed)* | Pin the session-signing secret externally (≥32 chars). If unset, it's managed in the database. |
| `JWT_EXPIRY_SECONDS` | `86400` | Baseline session lifetime (24h); the Settings UI overrides it. |
| `LLM_REQUEST_TIMEOUT_MS` | `300000` | Baseline ceiling on one LLM request (5 min), so a stalled provider can't freeze a pipeline run; the Settings UI overrides it. |
| `LATEX_COMPILE_TIMEOUT_MS` | `600000` | Baseline ceiling on one LaTeX (tectonic) compile (10 min). The first compile on a fresh container also downloads the packages the document pulls in, so it is far slower than every one after it; the Settings UI overrides it. |
| `JOBSPY_IS_REMOTE` | `0` | Set `1` to filter jobspy sources (Indeed/LinkedIn) to remote-only. |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(unset)* | Token for the Claude Code provider, minted with `claude setup-token`. The Settings UI value overrides it. |

## Authentication

By default the app is **unauthenticated** — fine on `localhost`. If you expose it
on a network, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` (env or Settings)
to require a login. Sessions are JWT-based; pin the secret with `JWT_SECRET` and
tune expiry with `JWT_EXPIRY_SECONDS` or the UI.

## Profiles

A **profile** is a self-contained job search, pinning a **CV** and **cover
letter**, its **CV format** (LaTeX, Word or HTML — fixed for the profile's life), and
its **sources, search terms, and location/remote** preferences. Run different
hunts side by side (e.g. "Backend, remote, Europe" vs. "Data, on-site"). Manage
them on the **Profiles** page.

## Themes

Eight palettes plus a system-preference mode, chosen in the UI:

- **Light:** Sandstone *(default)*, Ice, Newsprint, VS Code Light
- **Dark:** Graphite Mono *(default)*, Slate Blue, Forest Amber, Nord

Choose **System** to follow your OS setting with a favorite for each mode. Your
choice is remembered in the browser.

## Data, backups & restore

Each **user profile** (Settings → User Profiles) is one SQLite database — jobs, settings,
CV/cover-letter archives, generated PDFs, prompts, and the session secret. They
live in the `cvclanker-data` Docker volume (release) or under `./data` (dev; the
active one is `./data/jobs.db`).

- **Back up** with **Export** on a profile's card in **Settings → User
  Profiles**; with several user profiles, export each one. Tick **Include API keys &
  secrets in exports** first if the backup should keep your API keys and login
  password; the file then holds them in plain text, so store it safely. On the
  dev path, copying `data/` while stopped works too.
- **Restore** with **Import profile** on the same page, then **Activate** the
  imported profile; your current data is kept as another profile, not
  overwritten. On a fresh install, **Import database** in the onboarding wizard
  does both steps. Expect to sign in again after a restore. An export made
  without secrets also drops the login password, so login is off afterwards
  unless `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` are set as environment
  variables.
- Codex auth, if used, lives in the data directory under `codex-home/`; a copy
  of the volume or of `data/` carries it along, the export does not.

To wipe everything and start over on the release path, run these two lines,
then the install command again:

```bash
docker rm -f cvclanker
docker volume rm cvclanker-data
```

On the dev path (Linux or macOS shell):

```bash
docker compose down && sudo rm -rf data/ && docker compose up -d --build
```

## Ports

CV Clanker serves on **http://localhost:3005** by default. To change it, edit the
first number in `-p 3005:3001` on the `docker run` line (and `HOST_PORT` to
match), or the left side of the `ports` mapping in `docker-compose.yml`.
