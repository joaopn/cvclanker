# Tracking your hunt

Jobs move through a simple lifecycle, with a few tools for managing the list.

## Inbox → Live → Closed

Every job sits in one of three stages, shown as tabs:

- **Inbox** — newly discovered jobs waiting for triage.
- **Live** — jobs you're working: tailoring, applied, interviewing.
- **Closed** — done, with an outcome recorded.

Jobs advance as you act on them, and you can move them by hand any time.

## Fit scoring

If you enable scoring, CV Clanker rates each job against your
[personal brief](cvs.md#the-personal-brief) as **very good fit**, **good fit**, or
**bad fit**, using the title, employer, location, salary, and description. A
missing salary can optionally lower a job by one tier, and jobs with a very short
description are left unscored rather than guessed at. The tier shows as a chip on
each job.

## The swipe deck

For quick triage, the **Swipe** page shows scored jobs one card at a time — keep,
skip, done.

## Reposts, duplicates, and aging

- **Reposts** — a job re-listed with a newer date is moved back into the Inbox
  with its repost count incremented.
- **Duplicates** — a LinkedIn posting listed more than once (country subdomain,
  slug URL, second scraper) is grouped on a review screen where you close the
  copies you don't want. Nothing but the board's own posting id counts as
  proof, so identical-looking roles on *different* boards are left alone.
- **Aging** — untouched jobs move to a backlog over time; a repost can revive an
  aged-out job.

## Notes and outcomes

- **Notes** — free-text notes on any job.
- **Outcomes** — when you close a job, tag how it ended (rejected, withdrawn,
  ghosted, and so on).
- **Interviews** — jobs you're interviewing for appear in Live; you can generate
  [interview notes](tailoring.md#interview-qa) for them.

## Filtering and bulk actions

Facet filters narrow the list (by source, status, fit, and more). Bulk actions
move, tag, or close many jobs at once, with a configurable cap (default 1000);
adjust it in Settings.

## Live progress

Long-running work (a large scrape, a batch of tailors) reports progress in the UI
as it runs, with a per-source breakdown of what was scraped, filtered, and
imported.
