---
title: Stats
parent: User guide
nav_order: 10
---
# Stats

The Stats screen turns the jobs you already have into numbers: how much came in, which boards, search profiles and search terms are earning their place, what happened to your applications, and which companies are worth your time. Open it with the **Stats** segment of the **Swipe | Manage | Schedule | Stats** switch at the top of the screen. Everything on it is read-only and worked out from your jobs when you open it; nothing is recorded specially for it.

Two rows of buttons set the filters:

- the date range: **7d**, **30d**, **90d** (the default) or **All**;
- the search profile: **All profiles**, or one button per profile.

The choices reset when you leave the page. Five tabs show the numbers: Overview, Discovery, Job profile, Applications and Companies.

## What the words mean

| Figure | Counts | Can change later? |
|---|---|---|
| Found | every job found in the range | no |
| Scored | jobs that have a fit rating | yes, a rescore replaces it |
| Good fit or better (Good+) | jobs rated Good fit, Very good fit or Great fit | yes |
| Tailored | jobs that were ever tailored | no |
| Applied | jobs carrying the permanent [applied mark](job-lifecycle.md#the-permanent-applied-mark), however they ended | no |
| Closed | jobs with an outcome recorded (rejected, ghosted, …) | |
| Fit rate, hit rate | Good+ divided by **scored** jobs; a dash when nothing is scored | |

Undoing a move on the Manage screen also undoes its tailored or applied mark, so a mis-click does not leave a job counted for ever.

## Overview

- **Tiles**: Jobs found, Good fit or better, Tailored, Applied.
- **Where jobs stop**: the funnel Found → Scored → Good fit → Tailored → Applied. You can tailor and apply to anything, not only good fits, so the last two bars can be longer than the one above them; the panel says so when that happens.
- **Scorer versus you**: for each fit rating (and Unscored), how many jobs you skipped, applied to, tailored without applying, or left untouched. Each column means "got this far and no further", and a skip outranks everything.
- **Activity**: one square per day that found jobs, shaded by how many (UTC days).

## Discovery

- **Boards**: jobs, scored, Good+ and fit rate per board. LinkedIn and Indeed are separate lines even though one scraper fetches both, and each Apify actor appears under its own name.
- **Search Profiles**: the same per profile. A job belongs to the profile whose run first found it. Jobs found by no profile (added by hand, or found before this was recorded) show as **Unattributed**; jobs of a deleted profile as **Deleted profile**.
- **Yield per run** shows as not available, and says why: per-run counts are kept in memory during a run only.

## Job profile: which search terms pay off

The **By source** panel comes first: per board, how many jobs it returned, what share of them have a title naming one of the search terms of the profile that found them, and the fit rate of both halves. A board with a low share returns a lot of titles your terms do not name; comparing the two fit rates tells you whether those are worth scoring.

Below it, each profile that found jobs in the range gets a table with one row per current search term and a final **No term in title** row; the Unattributed table comes last. A job is credited to a term by its **title**: every word of the term must appear in the title, in any order, ignoring capitals and accents (`+` and `#` count as part of a word, so "C++" and "C#" stay apart). A title naming two terms counts under both, so a profile's rows can add up to more than its total. Jobs added by hand are left out and counted in a note.

This measures what titles say, not which search found the job. Several boards run all your terms as one combined search, so "which term found it" cannot be known for them, but a title can be read for every job. The cost: a search for "ML Engineer" that returns "Machine Learning Engineer" lands under **No term in title**.

Every column of the term tables counts **scored** jobs only: **Scored jobs**, **Good+**, **Applied** (scored jobs you applied to at any point), **Applied rate** and **Fit rate**. Click a column heading to sort every table by it: ascending, then descending, then back to alphabetical (**Term** just flips between Z–A and A–Z); **No term in title** always stays last.

This rule differs from the Manage screen's **Job title** filter badges, which look for the term as plain text inside the title, so the two can disagree on a title that has the words in another order.

## Applications

The range here applies to when you applied, not when the job was found.

- **Tiles**: **Applications**; **Heard back** (rejections plus interviews, as a share of applications); **Median reply** (days from applying to closing, closed applications only); **Outstanding**.
- **What happened**: every application falls into exactly one bucket:

| Bucket | Rule |
|---|---|
| Advanced to interview | the job is at Interviewing |
| Rejected | closed as rejected |
| Marked ghosted | closed as ghosted |
| Closed for another reason | any other outcome |
| No answer in 21 days | still at Applied, sent more than 21 days ago |
| Still waiting | still at Applied |
| Moved out of applications | anything else: reopened, skipped or shelved after applying |

- **How long replies took**: a histogram in 0–3, 4–7, 8–14, 15–21 and 22+ days. A narrow date range keeps recent applications whose slow replies have not arrived yet, so it reads faster than reality.
- **Waiting on**: the 20 oldest applications still at Applied with no outcome, with days waiting (red from 21 days) and whether the posting is still live, closed, or not checked.

**Heard back** is a floor: there is no stage history, so a job that reached Interviewing and was later closed for another reason no longer shows that it had a reply.

## Companies

- **Companies**: the top 25 companies by Good+ jobs, with postings, Good+, hit rate and how many you applied to; the note says how many companies there are in total. A company is its name ignoring capitals, the same rule the company dialog uses, so two spellings of one company stay two rows.
- **Posting churn**: jobs re-posted at least once, jobs whose LinkedIn posting is reported closed, and how many jobs have had a live-status check at all.

How it works: [Stats](../architecture/stats.md)
