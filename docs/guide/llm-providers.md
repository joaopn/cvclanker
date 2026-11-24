---
title: LLM providers and prompts
parent: User guide
nav_order: 11
---
# LLM providers & prompts

Each step that uses a model — reading your CV, scoring, tailoring, cover letters, the ghostwriter, interview notes, reading a job off a URL — runs through an LLM. You choose which one, cloud or local, and you can edit the prompts.

## Supported providers

| Provider | Notes |
|---|---|
| **OpenRouter** | The default. One key, many models, including **Claude**. Reaches models not listed here directly. |
| **OpenAI** | GPT models via the OpenAI API. The Settings model picker lists your account's models. |
| **Google Gemini** | Gemini models via Google's API. The model picker lists your account's models. |
| **OpenAI-compatible** | Any endpoint that speaks the OpenAI API; you give the base URL. |
| **LM Studio** | A model running locally (default address `localhost:1234`). |
| **Ollama** | A model running locally with [Ollama](https://ollama.com) (default address `localhost:11434`). |
| **Codex** | A local Codex app-server. Not bundled — install it in-app (**Install Codex** in Settings or the wizard); it is stored with your data and updates independently of the app image, and its sign-in session persists there too. |
| **Claude Code** | Headless `claude -p` runs using a Claude subscription. Mint a token with `claude setup-token` and paste it into Settings (or set `CLAUDE_CODE_OAUTH_TOKEN`). |

**Claude Code** is the dedicated Claude path — it bills your Claude subscription, not an API key. Claude via API key works through OpenRouter (or an Anthropic-compatible gateway via the OpenAI-compatible provider). Each query is a plain model call with the CLI's tools switched off ([how](../architecture/llm-and-scoring.md#claude-code-runs-as-a-locked-down-plain-model-call)). Settings can update the CLI inside the running container; that lasts until the next image update.

With **LM Studio** or **Ollama**, the CV, brief and job descriptions aren't sent to an external service for the model steps — there's no key and no external LLM call. Output depends on the local model you can run.

The provider is set in the onboarding wizard's first step, and changed any time in **Settings → Models**. A saved key shows only as a short hint, so you can tell "saved" from "missing".

## Which model does what

**Settings → Models** has a **Default model** and **Task-Specific Overrides**; an empty override uses the default.

| Setting | Used for |
|---|---|
| **Scoring Model** | Fit scoring. |
| **Tailoring Model** | Tailoring, cover letters, the ghostwriter, the [chat](chat.md), interview notes, CV and cover-letter extraction, drafting the brief, and suggesting search terms in onboarding. |
| **Default model** | Reading a job off a pasted URL, and the fallback for both overrides. |
| **Pre-filter model** | An optional cheap model that screens jobs before the scoring model; empty means off (see below). |
| **Reasoning effort** | Claude Code only: the effort level for every call (`low` to `max`, or the CLI's default). |

Write the model name the way the provider does, for example `google/gemini-3-flash-preview` on OpenRouter; an empty field shows the default it falls back to ([defaults](../architecture/llm-and-scoring.md#which-model-runs-which-task)). Changing the provider in Settings empties the three model fields, so a model name from one provider is not sent to another. Provider, model and keys change with no restart.

### The pre-filter

Two-stage scoring lets a cheap model screen jobs before the scoring model. The screen can only call a job a **Bad fit**; for anything else the scoring model decides from scratch, so a generous screen costs money but never accuracy. A screened-out job's reason says the main model never saw it. The screen runs in a run's scoring step and on the **Screen first** bulk action; **Recalculate match** always uses the scoring model alone, so it is the second opinion on a screened-out job. The pre-filter can use another provider, with its key saved under **Settings → Provider Credentials**.

## Time limits and rate limits

- **LLM request timeout (ms)** (Settings → Pipeline Behavior, 5 minutes by default) bounds each attempt of any call, so a stalled provider cannot freeze a run. Raise it for a slow local model.
- Failed calls are retried a few times on their own.
- A rate limit is treated as account-wide. Once **LLM rate-limit retries** are spent, every LLM call stops at once instead of failing job after job, and a run that was scoring ends. Starting new LLM work yourself (a run, **Recalculate match**, a benchmark) clears the stop.
- A failed scoring call leaves the job unscored. CV Clanker never guesses a rating.

The retry, back-off and timeout rules are in [Time limits, retries and the rate-limit stop](../architecture/llm-and-scoring.md#time-limits-retries-and-the-rate-limit-stop).

## Watching calls

The **LLM** button in the Manage header opens the call queue: the calls **Running** now and the **Recent** finished ones, live, with duration and the token count the provider reported. A badge on the button counts the calls in flight.

## Model benchmarking

**Settings → Model Benchmarking** answers "would another model, effort level or provider rate my jobs the same way, and what would it cost?". Add configurations (provider, model, Claude Code effort, optional prices per million input and output tokens), set **Jobs to sample** and which saved ratings to draw from, and press **Run benchmark**. It scores a random sample of your open jobs with each configuration, without changing any job.

Pick one column as the **Baseline**; every other column then reports how often it agrees with it, how many of the baseline's good jobs it would have thrown away and how many bad fits it caught, tokens per job, and the estimated cost ([all the measures](../architecture/llm-and-scoring.md#model-benchmarking)). One benchmark runs at a time; it survives a page reload but not a restart. To benchmark a provider other than your configured one, save its key under **Settings → Provider Credentials**.

## Writing style

**Settings → Writing Style** feeds every writing prompt: a **Preset**, **Tone**, **Formality**, **Constraints**, **Do-not-use terms**, the **Output language**, and the **Cover-letter policy** (see [Cover letters](tailoring.md#cover-letters)).

| Output language | Ghostwriter | Tailoring and cover letters |
|---|---|---|
| **Choose specific language** | that language | that language |
| **Match current resume language** | detected from your brief (English if unclear) | English |

The fit rubric is separate: it is the **Scoring policy** in Settings → Pipeline Behavior. Clearing it restores the shipped policy.

## Editing the prompts

Prompts are stored in your database, one per task (CV extraction, tailoring, scoring, cover letters, the ghostwriter, interview notes, reading a job from a URL, and more). Edit them in **Settings → LLM Prompts**: each prompt has an editor with **Save** and **Reset to default**, and a save applies from the next call. A save that is not a valid prompt is refused with the error.

A prompt you never edited follows the shipped version on every upgrade; a prompt you edited keeps your text, and **Reset to default** brings back the newest shipped one. Editing the YAML files in the repository's `prompts/` folder does nothing to a running install. Some prompts are shared pieces (**fragments**) used inside the larger ones, such as the CV-format rules, writing style and output language. See [Prompts](../architecture/llm-and-scoring.md#prompts).

Prompt edits can change behaviour significantly; if results get worse, reset toward the shipped defaults.

How it works: [LLM providers and scoring](../architecture/llm-and-scoring.md)
