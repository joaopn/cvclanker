# Contributing

## What You Can Contribute

- Bug fixes and reliability improvements
- UI/UX improvements
- Extractors and integrations
- Documentation updates
- Tests and developer experience improvements

## Before You Start (Pick a Path)

| Path | Main folders | Start command(s) |
| --- | --- | --- |
| Docs/content | `docs/guide`, `docs/architecture` | Edit the Markdown pages |
| App/UI/API | `orchestrator`, `shared` | `npm --workspace orchestrator run dev` |
| Extractors | `extractors/*`, sometimes `shared` | Relevant type checks + tests |

Self-hosting, sign-in and environment-variable docs live in [`docs/guide/getting-started.md`](docs/guide/getting-started.md) and [`docs/guide/configuration.md`](docs/guide/configuration.md). How the app works inside is in [`docs/architecture/`](docs/architecture/index.md).

## Local Setup (Minimal)

Contributor baseline from repo root:

```bash
npm ci
npm --workspace orchestrator run db:migrate
npm --workspace orchestrator run dev
```

If you are working with extractors that use Indeed or LinkedIn (powered by python-jobspy), set up the Python venv once:

```bash
python3 -m venv extractors/jobspy/.venv
extractors/jobspy/.venv/bin/pip install -r extractors/jobspy/requirements.txt
```

The runner auto-detects the venv — no need to set `PYTHON_PATH`.

If you are editing docs: `docs/` is a just-the-docs site that GitHub Pages builds and publishes whenever `docs/` changes on `main`. The user guide is `docs/guide/`, how it works is `docs/architecture/`. Every page starts with front matter giving its `title`, `parent` (`User guide` or `How it works`) and `nav_order`, which place it in the sidebar. Link pages with relative `.md` links, draw diagrams as Mermaid blocks, and wrap any `{{`…`}}` text in `{% raw %}` … `{% endraw %}`.

Local URLs:

- Orchestrator UI: `http://localhost:5173`
- Orchestrator API: `http://localhost:3001`

## How to Make a Change

1. Create a branch from `origin/main`.
2. Keep the PR focused on one change or one problem.
3. If the change is user-visible, update docs (or link the relevant docs update in the same PR).
4. Include screenshots or short clips for UI changes when helpful.
5. Mention any tradeoffs or follow-up work in the PR description.

## Validation Before PR (CI-Parity Checks)

Run from the repository root:

```bash
./orchestrator/node_modules/.bin/biome ci .
npm run check:types:shared
npm --workspace orchestrator run check:types
npm --workspace gradcracker-extractor run check:types
npm --workspace ukvisajobs-extractor run check:types
npm --workspace orchestrator run build:client
npm --workspace orchestrator run test:run
```

If tests fail due to a `better-sqlite3` Node ABI mismatch, rebuild it and rerun tests:

```bash
npm --workspace orchestrator rebuild better-sqlite3
```

CI runs on Node 22.

## Project-Specific Standards

Before editing server routes/services, read [`AGENTS.md`](./AGENTS.md) for repository standards, especially:

- `/api/*` response contract and status/code mapping
- Correlation/request IDs (`x-request-id`) and logging context
- Shared logger usage in core server paths (no direct `console.*`)
- SSE helper usage
- Redaction/sanitization defaults for logs and error details
- Minimal webhook and LLM payload defaults
