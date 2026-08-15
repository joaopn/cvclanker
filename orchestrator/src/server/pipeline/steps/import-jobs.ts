import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import type { CreateJobInput } from "@shared/types";
import { progressHelpers } from "../progress";
import { captureRunJobs, toCapturedRunJob } from "../run-job-capture";

export async function importJobsStep(args: {
  discoveredJobs: CreateJobInput[];
  // Search Profile driving this run, stamped onto every row this import
  // creates. Undefined for runs with no profile (API callers passing raw
  // config), which leaves those rows unattributed.
  profileId?: string;
}): Promise<{
  created: number;
  skipped: number;
  reposted: number;
  rejected: number;
}> {
  logger.info("Importing discovered jobs");

  const groups = new Map<string, CreateJobInput[]>();
  for (const job of args.discoveredJobs) {
    // Attribution rides the insert, so a URL collision keeps whichever
    // profile discovered the row first.
    const attributed: CreateJobInput = args.profileId
      ? { ...job, profileId: args.profileId }
      : job;
    const bucket = groups.get(job.source);
    if (bucket) {
      bucket.push(attributed);
    } else {
      groups.set(job.source, [attributed]);
    }
  }

  let created = 0;
  let skipped = 0;
  let reposted = 0;
  let rejected = 0;

  for (const [source, jobsForSource] of groups) {
    const result = await jobsRepo.createJobs(
      jobsForSource,
      (bucket, input, reason) => {
        captureRunJobs(source, bucket, [toCapturedRunJob(input, reason)]);
      },
    );
    created += result.created;
    skipped += result.skipped;
    reposted += result.reposted;
    rejected += result.rejected;
    progressHelpers.recordSourceJobsImported(source, {
      imported: result.created,
      reposted: result.reposted,
      duplicated: result.skipped,
      rejected: result.rejected,
    });
  }

  logger.info("Import step complete", {
    created,
    skipped,
    reposted,
    rejected,
  });

  progressHelpers.importComplete(created, skipped);

  return { created, skipped, reposted, rejected };
}
