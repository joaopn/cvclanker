import type { Job, ManualJobDraft, UpdateJobInput } from "@shared/types";

export function trimToNull(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Only http(s) URLs can be re-fetched. Synthetic `manual://…` URLs (paste-JD
// jobs) and anything else are not rescrapable.
export function isRescrapableUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("https://") || url.startsWith("http://"));
}

// Build the field patch for a rescrape. The description is overwritten
// unconditionally (trimmed) — it is the field partial-scrapes break, and its
// emptiness is guarded separately by the caller (→ 422). Every OTHER field is
// filled ONLY when the current stored value is missing (null/""/whitespace) and
// the fresh draft has a value — so a good existing title/salary is never
// clobbered by a weaker re-inference. `jobUrl` (identity key) and `status` are
// never touched.
export function buildRescrapeUpdate(
  job: Job,
  draft: ManualJobDraft,
): UpdateJobInput {
  const update: UpdateJobInput = {
    jobDescription: trimToNull(draft.jobDescription),
  };

  // Returns the fresh value to write, or undefined to keep the existing one:
  // fill only when the current stored value is missing (null/""/whitespace) and
  // the draft carries a real value.
  const fillMissing = (
    current: string | null | undefined,
    fresh: string | undefined,
  ): string | undefined =>
    trimToNull(current) !== null ? undefined : (trimToNull(fresh) ?? undefined);

  const title = fillMissing(job.title, draft.title);
  if (title !== undefined) update.title = title;
  const employer = fillMissing(job.employer, draft.employer);
  if (employer !== undefined) update.employer = employer;
  const location = fillMissing(job.location, draft.location);
  if (location !== undefined) update.location = location;
  const salary = fillMissing(job.salary, draft.salary);
  if (salary !== undefined) update.salary = salary;
  const deadline = fillMissing(job.deadline, draft.deadline);
  if (deadline !== undefined) update.deadline = deadline;
  const applicationLink = fillMissing(
    job.applicationLink,
    draft.applicationLink,
  );
  if (applicationLink !== undefined) update.applicationLink = applicationLink;

  return update;
}
