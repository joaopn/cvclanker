# Job sources

CV Clanker pulls postings from several job boards at once, de-duplicates them,
and filters by your location and remote/hybrid/on-site preferences. This page
covers the **built-in** sources; for the Apify marketplace, see
[Apify integration](apify.md).

## Built-in sources

| Source | Powered by | Notes |
|---|---|---|
| **Indeed** | jobspy | Country-aware |
| **LinkedIn** | jobspy | |
| **Glassdoor** | jobspy | |
| **Hiring Cafe** | headless browser | Fetches full descriptions |
| **startup.jobs** | startup.jobs scraper | Startup / remote-leaning |
| **Working Nomads** | Working Nomads API | Remote-focused |
| **Manual** | you + the LLM | Paste a URL or a list; see below |

> Indeed, LinkedIn, and Glassdoor are all served by a single scraper
> (**jobspy**), so in the pipeline view they're grouped under that one engine.

You enable or disable sources on the **Sources** page. Only enabled sources run
when you scrape.

## Per-source settings

Each source has its own configuration (on the Sources page), typically:

- **Max jobs per term** — cap the results pulled for each search keyword.
- **Max age (days)** — ignore postings older than N days. Leave unset to keep
  each source's own default.
- **Search cities** — override the location used for the search.
- **Workplace types** — filter for `remote`, `hybrid`, and/or `on-site`.

Location and remote preferences ultimately come from your active
[profile](configuration.md#profiles), so a single run has one coherent location
intent applied across every source.

## Location compatibility

Not every board can serve every location. When you run a scrape, CV Clanker
checks each source against your requested location and **skips the ones that
can't honor it** (rather than returning unusable results). If *no* source is compatible with
the location you asked for, the run tells you so instead of silently returning
nothing. Jobs that come back but don't actually match your location intent are
dropped, and the pipeline banner reconciles what was scraped vs. what was
filtered out.

You can also **block companies** by keyword — any posting whose employer matches
is dropped during discovery.

### Remote-only shortcut

The `JOBSPY_IS_REMOTE` environment variable (default `0`) filters jobspy sources
to remote-only postings. See [Configuration](configuration.md).

## Manual entry

Some jobs you find yourself. Two ways to bring them in:

- **Single URL** — paste a job link and CV Clanker fetches the page (with a real
  browser) and has the LLM extract the title, employer, and description.
- **Batch import** — paste a list of URLs in the batch import sheet and it works
  through them, streaming progress as it goes.

Manually added jobs land in the same Inbox and get the same scoring and
tailoring as scraped ones.

## Reposts and duplicates

- **Reposts:** if a job URL shows up again with a newer posting date, CV Clanker
  bumps its repost count and pulls it back into the Inbox so you don't miss a
  re-listing.
- **Duplicates:** a LinkedIn posting listed more than once — under a country
  subdomain, a slug URL, or via a second scraper — is grouped for review so you
  triage it once. Only LinkedIn ids are read today, and only that board's own
  posting id counts as proof: the same role appearing on two *different* boards
  is deliberately left alone, because closing a job that merely looks similar
  loses an opening you wanted.

More on all of this in [Tracking your hunt](job-lifecycle.md).

## Adding more sources

In addition to the built-in sources, you can use [Apify](apify.md) actors as
sources, including LinkedIn and Indeed scrapers.
