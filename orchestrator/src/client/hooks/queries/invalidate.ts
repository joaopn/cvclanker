import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/client/lib/queryKeys";

export async function invalidateJobData(
  queryClient: QueryClient,
  jobId?: string | null,
): Promise<void> {
  if (!jobId) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    return;
  }

  await queryClient.invalidateQueries({
    queryKey: [...queryKeys.jobs.all, "list"] as const,
  });
  await queryClient.invalidateQueries({
    queryKey: [...queryKeys.jobs.all, "revision"] as const,
  });
  await queryClient.invalidateQueries({
    queryKey: [...queryKeys.jobs.all, "search"] as const,
  });
  await queryClient.invalidateQueries({
    queryKey: queryKeys.jobs.detail(jobId),
  });
  await queryClient.invalidateQueries({
    queryKey: queryKeys.jobs.tasks(jobId),
  });
}

export async function invalidateSettingsData(
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
}
