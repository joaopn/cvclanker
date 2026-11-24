---
title: FAQ
parent: User guide
nav_order: 14
---
# FAQ

### Does CV Clanker apply to jobs for me?

No. It prepares tailored documents but doesn't submit anything. You review each tailored CV and cover letter and apply yourself.

### Is my data private?

Yes. CV Clanker is self-hosted and stores everything in a local SQLite file. There's no telemetry, no analytics, and no account to create. The only outbound traffic is to the LLM provider you choose (or nowhere, with a local model), to the job sources you enable when you scrape, to Apify if you set up [Apify actors](apify.md), to the job pages you import by URL, and to LinkedIn when you ask for a live-status check.

### Does it cost anything?

CV Clanker itself is free and open source (AGPLv3 + Commons Clause). Your only costs are external and optional: LLM usage (pay-as-you-go, or $0 with a local model) and Apify (only if you use it, billed by Apify).

### Do I need an API key to try it?

You need a working LLM, but not necessarily a key. The onboarding wizard keeps the rest of the app closed until an LLM connection passes its check; a local model (LM Studio or Ollama) needs no key, and Claude Code uses a Claude subscription instead. See [LLM providers](llm-providers.md).

### Can I use Claude / GPT / Gemini / a local model?

All of them. OpenAI and Gemini directly, **Claude** with a Claude subscription via the Claude Code provider (or per-token via OpenRouter), any OpenAI-compatible endpoint, and local models via LM Studio or Ollama. See [LLM providers](llm-providers.md).

### Should I use LaTeX, Word or HTML?

LaTeX if you already have a `.tex` résumé; Word if you want an editable `.docx` to submit; HTML if your CV is a self-contained web page. See [CVs](cvs.md#which-format).

### Why was my CV upload rejected?

CV Clanker refuses any upload it can't reproduce exactly. For LaTeX, make sure it compiles with Tectonic and that any `\input{}` files are in the `.zip`. See [CVs](cvs.md#latex-cvs).

### What do I need to run it?

Just Docker — the image bundles LaTeX, LibreOffice, and browsers. The first start downloads the image.

### Does it work offline?

Almost entirely. With a local LLM, only scraping job boards (and importing jobs by URL) needs the internet. The first LaTeX compile on a fresh install also downloads the LaTeX packages your CV uses.

### Can I run more than one job search?

Yes. A [search profile](search-profiles.md) holds one search's terms, location and sources, and a run can work through several profiles one after another. Each [user profile](configuration.md#user-profiles) is a separate database with its own CV, so a second CV (or a second CV format) means a second user profile.

### Why didn't a job I expected show up?

Open the run banner's **Rejected** count: it lists every posting the run dropped and why, usually the profile's location settings or a blocked company. See [Location filtering](search-profiles.md#location-filtering). A link CV Clanker already had is counted under **Duplicated** instead.

### Is there a hosted / cloud version?

No — it's self-host only. (Its upstream, JobOps, offers a paid cloud — see the [comparison](comparison.md).)
