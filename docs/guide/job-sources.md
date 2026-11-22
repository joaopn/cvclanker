---
title: Job sources
parent: User guide
nav_order: 4
---
# Job sources

CV Clanker pulls postings from several job boards at once, filters them by your search profile's location and blocked companies, and drops links it already has. This page covers the **built-in** sources; for the Apify marketplace, see [Apify integration](apify.md).

## Built-in sources

| Source | Powered by | Runs on | Notes |
|---|---|---|---|
| **Indeed** | JobSpy | any profile | Country-aware: Indeed also gets the profile's country. |
| **LinkedIn** | JobSpy | any profile | |
| **Hiring Cafe** | a headless browser | any profile | Fetches each job's full description. Its date filter is approximate (it knows when it indexed a posting, not when it was published). |
| **startup.jobs** | startup.jobs scraper | a profile with a country or a city | Startup and remote-leaning. Ignores max job age. |
| **Working Nomads** | Working Nomads API | any profile | Remote-focused. Ignores cities and max job age. |
| **Himalayas** | Himalayas API | remote profiles only | |
| **We Work Remotely** | category feeds | remote profiles only | |
| **Jobicy** | Jobicy API | remote profiles only | |
| **Manual** | you | | Jobs you add by URL; see below. |

Indeed and LinkedIn are both served by one scraper, **JobSpy**, so on the Sources page and in the run banner they appear under that one card. Glassdoor no longer runs ([why](../architecture/job-sources.md#retire-a-dead-source-never-delete-it)); jobs it found earlier keep their label and can still be filtered by source.

## Turning sources on

The **Sources** page has two tabs: **Built-in** and **Apify (paid API)**. Each built-in board has a card with an enable tick; a disabled source never runs.

Which enabled sources a run actually uses is decided per [search profile](search-profiles.md#sources-per-profile): a source runs only when it is enabled here and ticked on the profile being run. Under each card's title, **Enable in all profiles** and **Disable in all profiles** tick or untick that source on every search profile at once.

## Per-source settings

Each card has two parts:

- **Source-specific defaults**: the card's own values, such as "Max jobs per term", JobSpy's "Country (Indeed)", startup.jobs' "Detail concurrency", We Work Remotely's "Category feeds" or Jobicy's "Geo filter".
- **Global field mappings**: City, Country, Workplace types, Max jobs per term (budget) and Max job age (days). When a mapping is ticked, the run's value, which comes from the search profile, overrides the card's own value; unticked, the card's value is used.

The budget mapping is on by default, so the per-term number on a card is normally replaced by the profile's **Max jobs discovered** divided over terms and boards. **Show raw** shows the settings the source would receive right now, worked out from the default search profile.

## Which sources can serve a run

The remote-only boards are skipped on a profile that is not remote, and startup.jobs is skipped when the profile has neither a country nor a city. The Run menu shows a skipped source greyed out with the reason. If none of the selected built-in sources can serve the profile, the run fails with a "No compatible sources" message instead of returning nothing. Which of the returned jobs are kept is on [Search profiles](search-profiles.md#location-filtering).

### Remote-only JobSpy searches

The `JOBSPY_IS_REMOTE` environment variable (default `0`) asks JobSpy's LinkedIn and Indeed searches for remote postings only. A profile whose work arrangement is Remote alone already does this, so the variable matters only for profiles that also allow hybrid or on-site. See [Configuration](configuration.md#environment-variables).

## Adding jobs by hand

Some jobs you find yourself. **Fetch URLs** in the Manage header opens the **Import URLs** sheet: paste up to 50 job links, one per line, and CV Clanker reads each page and fills in the title, employer and description. Added jobs land in the Inbox with the source "Manual" and are scored and tailored like scraped ones. See [Tracking your hunt](job-lifecycle.md#adding-jobs-by-url) for the details, including what to do when a page cannot be read.

## Links CV Clanker already has

A posting found again by a later run is counted as **Duplicated** in the run banner instead of being stored twice, even when its link carries different tracking parameters ([how links are compared](../architecture/duplicates.md#same-link-url-canonicalisation)). If it comes back with a newer posting date it counts as a repost. Reposts, and the same LinkedIn posting listed under different links, are covered in [Tracking your hunt](job-lifecycle.md#reposts).

## Adding more sources

Besides the built-in boards you can run [Apify](apify.md) actors as sources, from three ready-made LinkedIn templates or any actor you configure yourself.

How it works: [Job sources](../architecture/job-sources.md), [Location matching](../architecture/location-matching.md)
