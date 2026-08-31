import type { JobStatus } from "@shared/types";

export const queryKeys = {
  stats: {
    all: ["stats"] as const,
    /**
     * Keyed on the filters, so switching range or profile is a distinct cache
     * entry rather than a refetch that briefly renders the previous answer.
     */
    panel: (
      panel: "overview" | "discovery" | "applications" | "companies",
      filters: { days: number | null; profileId: string | null },
    ) => [...queryKeys.stats.all, panel, filters] as const,
  },
  settings: {
    all: ["settings"] as const,
    current: () => [...queryKeys.settings.all, "current"] as const,
  },
  cvDocuments: {
    all: ["cv-documents"] as const,
    list: () => [...queryKeys.cvDocuments.all, "list"] as const,
    detail: (id: string) =>
      [...queryKeys.cvDocuments.all, "detail", id] as const,
    extractionPromptDefault: () =>
      [...queryKeys.cvDocuments.all, "extraction-prompt-default"] as const,
  },
  coverLetterDocuments: {
    all: ["cover-letter-documents"] as const,
    list: () => [...queryKeys.coverLetterDocuments.all, "list"] as const,
    detail: (id: string) =>
      [...queryKeys.coverLetterDocuments.all, "detail", id] as const,
    extractionPromptDefault: () =>
      [
        ...queryKeys.coverLetterDocuments.all,
        "extraction-prompt-default",
      ] as const,
  },
  jobs: {
    all: ["jobs"] as const,
    list: (options?: { statuses?: JobStatus[]; view?: "list" | "full" }) =>
      [...queryKeys.jobs.all, "list", options ?? {}] as const,
    revision: (options?: { statuses?: JobStatus[] }) =>
      [...queryKeys.jobs.all, "revision", options ?? {}] as const,
    duplicates: () => [...queryKeys.jobs.all, "duplicates"] as const,
    byCompany: (employer: string) =>
      [...queryKeys.jobs.all, "by-company", employer] as const,
    detail: (id: string) => [...queryKeys.jobs.all, "detail", id] as const,
    tasks: (id: string) => [...queryKeys.jobs.all, "tasks", id] as const,
    notes: (id: string) => [...queryKeys.jobs.all, "notes", id] as const,
  },
  pipeline: {
    all: ["pipeline"] as const,
    status: () => [...queryKeys.pipeline.all, "status"] as const,
    runs: () => [...queryKeys.pipeline.all, "runs"] as const,
    runInsights: (id: string) =>
      [...queryKeys.pipeline.all, "run-insights", id] as const,
  },
  prompts: {
    all: ["prompts"] as const,
    list: () => [...queryKeys.prompts.all, "list"] as const,
    detail: (name: string) =>
      [...queryKeys.prompts.all, "detail", name] as const,
  },
  sourceConfigs: {
    all: ["source-configs"] as const,
    list: () => [...queryKeys.sourceConfigs.all, "list"] as const,
  },
  providerInstances: {
    all: ["provider-instances"] as const,
    list: () => [...queryKeys.providerInstances.all, "list"] as const,
  },
  profiles: {
    all: ["profiles"] as const,
    list: () => [...queryKeys.profiles.all, "list"] as const,
  },
  userProfiles: {
    all: ["user-profiles"] as const,
    list: () => [...queryKeys.userProfiles.all, "list"] as const,
    active: () => [...queryKeys.userProfiles.all, "active"] as const,
  },
} as const;
