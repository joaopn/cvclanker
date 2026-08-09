# Configuration

Most settings live in the **Settings** page (stored in your database); a handful
are environment variables.

## Environment variables

Copy `.env.example` to `.env` and fill in what you need — all optional.

| Variable | Default | What it does |
|---|---|---|
| `MODEL` | `google/gemini-3-flash-preview` | The LLM to use, as `provider/model-name`. See [LLM providers](llm-providers.md). |
| `BASIC_AUTH_USER` | *(unset)* | Username for optional login. |
| `BASIC_AUTH_PASSWORD` | *(unset)* | Password for optional login. |
| `JWT_SECRET` | *(DB-managed)* | Pin the session-signing secret externally (≥32 chars). If unset, it's managed in the database. |
| `JWT_EXPIRY_SECONDS` | `86400` | Baseline session lifetime (24h); the Settings UI overrides it. |
| `JOBSPY_IS_REMOTE` | `0` | Set `1` to filter jobspy sources (Indeed/LinkedIn/Glassdoor) to remote-only. |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(unset)* | Token for the Claude Code provider, minted with `claude setup-token`. The Settings UI value overrides it. |

Provider API keys can go here too, but the Settings UI is easier — both are
stored in the database and the UI wins.

## Authentication

By default the app is **unauthenticated** — fine on `localhost`. If you expose it
on a network, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` (env or Settings)
to require a login. Sessions are JWT-based; pin the secret with `JWT_SECRET` and
tune expiry with `JWT_EXPIRY_SECONDS` or the UI.

## Profiles

A **profile** is a self-contained job search, pinning a **CV** and **cover
letter**, its **CV format** (LaTeX or Word — fixed for the profile's life), and
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

Your whole installation is one SQLite file at **`./data/jobs.db`** — jobs,
settings, CV/cover-letter archives, generated PDFs, prompts, and the session
secret.

- **Back up** by copying `data/` while stopped, or use the in-app **snapshot
  export**.
- **Restore** by dropping the file back, or via snapshot restore. The session
  secret lives in the DB, so a restore keeps you logged in.
- Codex auth, if used, lives under `data/codex-home/` — a `data/` copy carries
  it along.

Wipe and start over:

```bash
docker compose down && rm -rf data/ && docker compose up -d --build
```

## Ports

CV Clanker serves on **http://localhost:3005** by default; change the `ports`
mapping in `docker-compose.yml` (left side is the host port).
