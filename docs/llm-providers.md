# LLM providers & prompts

Each step that uses a model — extracting CV fields, scoring, tailoring,
ghostwriting, interview notes — runs through an LLM. You choose which one, cloud
or local, and you can edit the prompts.

## Supported providers

| Provider | Notes |
|---|---|
| **OpenAI** | GPT models via the OpenAI API. |
| **Google Gemini** | The default. |
| **OpenRouter** | One key, many models, including **Claude**. Reaches models not listed here directly. |
| **OpenAI-compatible** | Any endpoint that speaks the OpenAI API. |
| **LM Studio** | A model running locally. |
| **Ollama** | A model running locally with [Ollama](https://ollama.com). |
| **Codex** | Local Codex app-server (authenticated with `codex login`; session persists in the `codex-home` volume). |
| **Claude Code** | Headless `claude -p` runs using a Claude subscription. Mint a token with `claude setup-token` and paste it into Settings (or set `CLAUDE_CODE_OAUTH_TOKEN`). |

**Claude Code** is the dedicated Claude path — it bills your Claude
subscription, not an API key. Claude via API key works through OpenRouter (or an
Anthropic-compatible gateway via the OpenAI-compatible provider). Each query
runs as an isolated pinned-version subprocess with tools, settings, MCP,
telemetry, and auto-update all disabled, a minimal environment, and a throwaway
working directory — a plain model call, nothing else.

With **LM Studio** or **Ollama**, the CV, brief, and job descriptions aren't sent
to an external service for the model steps — there's no key and no external LLM
call. Output depends on the local model you can run.

## Choosing a model

Set the model with the `MODEL` environment variable (or in Settings, which
overrides it), as `provider/model-name`:

```env
MODEL=google/gemini-3-flash-preview   # the default
```

Provider, model, and keys are changeable in **Settings** with no restart; keys
are stored locally.

## Reliability

CV Clanker uses strict JSON output where a step needs it and falls back when a
model doesn't support it. Transient failures are retried with backoff.

## Editing the prompts

Prompts are stored in the database, seeded on first run from the YAML files in
`prompts/`. Edit them in-app (Settings → Prompts) — the on-disk files are only
the seed, so editing them after first run doesn't affect a running install.
There's a prompt per task (CV extraction, tailoring, scoring, cover letters, the
ghostwriter, interview notes, and more).

Some behavior is in reusable **fragments** spliced into the larger prompts: the
CV-format rules (LaTeX vs. Word, selected automatically for the profile), writing
style, and output language.

Prompt edits can change behavior significantly; if results get worse, revert
toward the shipped defaults.
