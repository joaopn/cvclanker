# FAQ

### Does CV Clanker apply to jobs for me?

No. It prepares tailored documents but doesn't submit anything. You review each
tailored CV and cover letter and apply yourself.

### Is my data private?

Yes. CV Clanker is self-hosted and stores everything in a local SQLite file.
There's no telemetry, no analytics, and no accounts. The only outbound traffic is
to the LLM provider you choose (or nowhere, with a local model), to the job
sources you enable when you scrape, and to Apify if you set up
[Apify actors](apify.md).

### Does it cost anything?

CV Clanker itself is free and open source (AGPLv3 + Commons Clause). Your only
costs are external and optional: LLM usage (pay-as-you-go, or $0 with a local
model) and Apify (only if you use it, billed by Apify).

### Do I need an API key to try it?

No. The app boots without one — you only need a key for the steps that call a
model (scoring, tailoring), or you can point it at a local model and use no key.

### Can I use Claude / GPT / Gemini / a local model?

All of them. OpenAI and Gemini directly, **Claude** with a Claude subscription
via the Claude Code provider (or per-token via OpenRouter), any
OpenAI-compatible endpoint, and local models via LM Studio or Ollama. See
[LLM providers](llm-providers.md).

### Should I use LaTeX or Word?

LaTeX if you already have a `.tex` résumé; Word if you want an editable `.docx`
to submit. See [CVs](cvs.md#latex-or-word).

### Why was my CV upload rejected?

CV Clanker refuses any upload it can't reproduce exactly. For LaTeX, make sure it
compiles with Tectonic and that any `\input{}` files are in the `.zip`. See
[CVs](cvs.md#latex-cvs).

### What do I need to run it?

Just Docker — the image bundles LaTeX, LibreOffice, and browsers. The first build
takes a few minutes.

### Does it work offline?

Almost entirely. With a local LLM, only scraping job boards needs the internet.

### Can I run more than one job search?

Yes — use [profiles](configuration.md#profiles), each with its own CV, sources,
and location.

### Is there a hosted / cloud version?

No — it's self-host only. (Its upstream, JobOps, offers a paid cloud — see the
[comparison](comparison.md).)
