# Apify integration

[Apify](https://apify.com) is a marketplace of ready-made web scrapers (called
**actors**). CV Clanker can use an Apify actor as a job source, in addition to
the [built-in boards](job-sources.md) — including LinkedIn and Indeed scrapers,
or any other actor.

## Setup

1. Create an account at [apify.com](https://apify.com) and copy your API token.
2. In CV Clanker, go to **Sources → Apify** and paste it.

The token is stored locally and used only to call your own Apify account. From
here you add actors via a template or by configuring one yourself.

## Templates

Templates come with the input shape and output mapping already set up. Choose one
and give it a name:

- **LinkedIn Jobs Scraper**
- **Cheap Scraper (LinkedIn)** — a lower-cost alternative
- **Indeed**

For the URL-driven LinkedIn scrapers, CV Clanker builds the search URL from your
current search terms and location at run time, rather than using a stored URL.

## Configuring your own actor

In **Sources → Apify → Add actor**, provide:

1. **Actor reference** — the actor's ID (e.g. `username/actor-name`).
2. **Input template** — the JSON the actor expects, with placeholders for the
   values CV Clanker fills in per run (search terms, location, and the limits
   below).
3. **Output mapping** — which fields in the actor's results map to a job's title,
   employer, URL, description, location, remote flag, and posting date.

Results missing required fields are skipped (and counted in the logs) rather than
imported incomplete.

## Per-instance settings

Each actor is an independent instance with its own **name**, **max jobs**, **max
age (days)**, and **enabled** toggle. Only enabled instances run when you scrape.

## How it runs

Each enabled instance runs as its own source alongside the built-in boards,
labeled with the name you gave it. Its jobs go into the same Inbox and get the
same de-duplication, [scoring](job-lifecycle.md), and [tailoring](tailoring.md).
Runs have a timeout so a stuck actor can't hang the pipeline.

## Cost

Apify actors are billed by Apify, on your account — CV Clanker calls them with
your token. Some charge per result or per compute unit, so check an actor's
pricing on Apify and use **Max jobs** / **Max age** to limit run size.
