# Tracking your hunt

Jobs move through a simple lifecycle, with a few tools for managing the list.

## Inbox → Live → Closed

Every job sits somewhere in a three-part arc, spread across the tabs:

- **Inbox** — newly discovered jobs waiting for triage.
- **Live** — jobs you're working: tailoring, applied, interviewing.
- **Closed** — done, with an outcome recorded.

Jobs advance as you act on them, and you can move them by hand any time. Every
job's detail panel carries a **Stage** dropdown that moves it to any stage —
Inbox, Tailoring, Live, Interviewing, Backlog, Stale or Skipped — from wherever
it is now, including rows the ordinary buttons can't reach. Closing a job asks
for an outcome and is offered only for jobs you actually applied to; everything
else you're done with goes to Skipped, which shares the Closed tab. Moving a
closed job anywhere else clears its outcome again.

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

## Searching across every tab

**Ctrl/Cmd+K** opens a search over every job, whatever tab it sits on. Type a
job title or company name; type `@` plus a filter name and Tab to narrow to one
status. The **Ever applied** button narrows to every job you applied for however
it ended — open applications, closed ones, and ones you later skipped.

With that filter on, each still-open application (Live or Interviewing) carries
a **Rejected** button. Pressing it closes that application as rejected without
leaving the search: the window stays open and the search box empties, so a pile
of rejection emails can be worked through one company name at a time. It is
undoable like any other move.

## Filtering and bulk actions

Facet filters narrow the list (by source, status, fit, and more). Bulk actions
move, tag, or close many jobs at once, with a configurable cap (default 1000);
adjust it in Settings.

## Live progress

Long-running work (a large scrape, a batch of tailors) reports progress in the UI
as it runs, with a per-source breakdown of what was scraped, filtered, and
imported.
