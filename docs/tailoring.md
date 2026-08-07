# Tailoring & AI assist

Per job, CV Clanker can edit the CV, generate a cover letter, report which of the
job's keywords the CV covers, and generate interview notes. Every change is
proposed for you to accept or reject.

## CV tailoring

Tailoring uses your personal brief, the job description, and the current CV
content, and proposes edits at the field level (patches for LaTeX; span rewrites
for Word).

- Edits are limited to information in the brief or the job description; the model
  is instructed not to invent experience.
- [Locked fields](cvs.md#locked-fields) are excluded from proposals.
- Rendering: tailored LaTeX recompiles with Tectonic; tailored Word repackages a
  `.docx`.

Tailoring is opt-in (enable it in Settings) and runs per job or in bulk. Failed
tailors are kept so they can be retried.

## ATS keyword coverage

Alongside the tailored CV, an ATS pass extracts the notable terms from the job
description and reports:

- **Matched** — terms the CV and brief cover.
- **Skipped** — terms in the job that weren't found in the brief.

If a skipped term reflects real experience, add it to the brief and re-tailor.
Coverage can be refreshed for a job at any time.

## The ghostwriter chat panel

The ghostwriter is a per-job chat for changes that don't fit a single tailoring
pass. It responds with edit proposals you accept or reject, edits one document
per turn (CV, cover letter, or brief), and leaves locked fields alone.

## Cover letters

Cover letters use a LaTeX cover-letter template you upload once (checked on
upload the same way as a LaTeX CV). Use **Generate** on a job, edit the draft in
the ghostwriter, and switch between the **Edit** and **PDF** tabs.

Cover letters are always LaTeX, including for Word CV profiles.

## Interview Q&A

For a job, CV Clanker can generate interview notes from the brief, tailored CV,
and job description: a summary of how to frame yourself, likely questions with
suggested angles, and questions to ask the interviewer. It's a manual step.

## Watching calls

LLM activity is visible: a live call queue shows requests in flight, and per-call
logs record model, provider, token counts, duration, and status. See
[LLM providers](llm-providers.md).
