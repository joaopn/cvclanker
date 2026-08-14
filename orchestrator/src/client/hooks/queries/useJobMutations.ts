import * as api from "@client/api";
import type {
  CreateJobNoteInput,
  Job,
  JobNote,
  UpdateJobNoteInput,
} from "@shared/types";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/client/lib/queryKeys";
import { invalidateJobData } from "./invalidate";

export function useJobNotesQuery(jobId: string | null) {
  return useQuery<JobNote[]>({
    queryKey: queryKeys.jobs.notes(jobId ?? "none"),
    queryFn: () => api.getJobNotes(jobId as string),
    enabled: !!jobId,
  });
}

export async function invalidateJobNotesData(
  queryClient: QueryClient,
  jobId: string,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: queryKeys.jobs.notes(jobId),
  });
}

export function useUpdateJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: Partial<Job> }) =>
      api.updateJob(id, update),
    onSuccess: async (_data, variables) => {
      await invalidateJobData(queryClient, variables.id);
    },
  });
}

export function useMarkAsAppliedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.markAsApplied(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.jobs.detail(id) });
      const previousJob = queryClient.getQueryData<Job>(
        queryKeys.jobs.detail(id),
      );
      queryClient.setQueryData<Job>(queryKeys.jobs.detail(id), (current) =>
        current ? { ...current, status: "applied" } : current,
      );
      return { previousJob, id };
    },
    onError: (_error, _id, context) => {
      if (context?.id) {
        queryClient.setQueryData(
          queryKeys.jobs.detail(context.id),
          context.previousJob,
        );
      }
    },
    onSettled: async (_data, _error, id) => {
      await invalidateJobData(queryClient, id);
    },
  });
}

export function useSkipJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.skipJob(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.jobs.detail(id) });
      const previousJob = queryClient.getQueryData<Job>(
        queryKeys.jobs.detail(id),
      );
      queryClient.setQueryData<Job>(queryKeys.jobs.detail(id), (current) =>
        current ? { ...current, status: "skipped" } : current,
      );
      return { previousJob, id };
    },
    onError: (_error, _id, context) => {
      if (context?.id) {
        queryClient.setQueryData(
          queryKeys.jobs.detail(context.id),
          context.previousJob,
        );
      }
    },
    onSettled: async (_data, _error, id) => {
      await invalidateJobData(queryClient, id);
    },
  });
}

export function useRescoreJobMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    // The unscreened call stays one-argument: `api.rescoreJob(id, undefined)`
    // would still send the same request, but it breaks every strict
    // `toHaveBeenCalledWith(id)` assertion pinning this path.
    mutationFn: (input: { id: string; prefilter?: boolean }) =>
      input.prefilter
        ? api.rescoreJob(input.id, { prefilter: true })
        : api.rescoreJob(input.id),
    onSuccess: async (_data, input) => {
      await invalidateJobData(queryClient, input.id);
    },
  });
}

export function useGenerateJobPdfMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.generateJobPdf(id),
    onSuccess: async (_data, id) => {
      await invalidateJobData(queryClient, id);
    },
  });
}

export function useCreateJobNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      input,
    }: {
      jobId: string;
      input: CreateJobNoteInput;
    }) => api.createJobNote(jobId, input),
    onSuccess: async (_data, variables) => {
      await invalidateJobNotesData(queryClient, variables.jobId);
    },
  });
}

export function useUpdateJobNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      noteId,
      input,
    }: {
      jobId: string;
      noteId: string;
      input: UpdateJobNoteInput;
    }) => api.updateJobNote(jobId, noteId, input),
    onSuccess: async (_data, variables) => {
      await invalidateJobNotesData(queryClient, variables.jobId);
    },
  });
}

export function useDeleteJobNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, noteId }: { jobId: string; noteId: string }) =>
      api.deleteJobNote(jobId, noteId),
    onSuccess: async (_data, variables) => {
      await invalidateJobNotesData(queryClient, variables.jobId);
    },
  });
}
