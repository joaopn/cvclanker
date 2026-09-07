import { z } from "zod";

export const EXTRACTOR_SOURCE_IDS = [
  "indeed",
  "linkedin",
  "glassdoor",
  "hiringcafe",
  "startupjobs",
  "workingnomads",
  "himalayas",
  "weworkremotely",
  "jobicy",
  "manual",
] as const;

export type ExtractorSourceId = (typeof EXTRACTOR_SOURCE_IDS)[number];

export interface ExtractorSourceMetadata {
  label: string;
  order: number;
  category: "pipeline" | "manual";
  requiresCredentials?: boolean;
  ukOnly?: boolean;
  /** Remote-only board: runnable only when the Search Profile is remote-type. */
  remoteProfileOnly?: boolean;
  /**
   * Withdrawn from the pipeline. The id stays in EXTRACTOR_SOURCE_IDS so
   * historical `jobs.source` rows keep their label and stay filterable.
   *
   * This flag is HALF of a retirement, not a kill switch: it gates only
   * PIPELINE_EXTRACTOR_SOURCE_IDS (the registry's available sources, the run
   * route's zod enum, the client's source list). The Run menu, health probing
   * and Profile pin expansion all key on `manifest.providesSources` instead, so
   * a retired source MUST also be removed from every manifest that provides it.
   * Marking one retired while leaving it in `providesSources` is worse than not
   * retiring it: the Run menu would still offer the platform, and the tick would
   * then 400 the whole run against the filtered enum. `resolveCatalogMismatches`
   * in the server's extractor registry enforces the pairing.
   */
  retired?: boolean;
}

export const EXTRACTOR_SOURCE_METADATA: Record<
  ExtractorSourceId,
  ExtractorSourceMetadata
> = {
  indeed: { label: "Indeed", order: 20, category: "pipeline" },
  linkedin: { label: "LinkedIn", order: 30, category: "pipeline" },
  // Retired (B70): dead upstream in python-jobspy — the location lookup 400s on
  // a doubled slash the library builds, and the csrf token its GraphQL search
  // needs cannot be fetched at all any more (every candidate page is bot-walled),
  // so it returned zero jobs on every run while reporting success. 1.1.82 is the
  // latest release, so there is nothing to upgrade to. Kept here, and only here,
  // so rows scraped before the retirement still render.
  glassdoor: {
    label: "Glassdoor",
    order: 40,
    category: "pipeline",
    retired: true,
  },
  hiringcafe: { label: "Hiring Cafe", order: 70, category: "pipeline" },
  startupjobs: { label: "startup.jobs", order: 80, category: "pipeline" },
  workingnomads: {
    label: "Working Nomads",
    order: 90,
    category: "pipeline",
  },
  himalayas: {
    label: "Himalayas",
    order: 92,
    category: "pipeline",
    remoteProfileOnly: true,
  },
  weworkremotely: {
    label: "We Work Remotely",
    order: 94,
    category: "pipeline",
    remoteProfileOnly: true,
  },
  jobicy: {
    label: "Jobicy",
    order: 96,
    category: "pipeline",
    remoteProfileOnly: true,
  },
  manual: { label: "Manual", order: 110, category: "manual" },
};

export const PIPELINE_EXTRACTOR_SOURCE_IDS = EXTRACTOR_SOURCE_IDS.filter(
  (source) =>
    EXTRACTOR_SOURCE_METADATA[source].category === "pipeline" &&
    !EXTRACTOR_SOURCE_METADATA[source].retired,
);

/**
 * Which extractor produces each platform. jobspy is a single extractor that
 * provides indeed/linkedin; the rest are 1:1. Used to surface the
 * underlying scraper (e.g. "jobspy") rather than the platform (e.g. "LinkedIn").
 */
export const EXTRACTOR_ID_BY_SOURCE: Record<ExtractorSourceId, string> = {
  indeed: "jobspy",
  linkedin: "jobspy",
  glassdoor: "jobspy",
  hiringcafe: "hiringcafe",
  startupjobs: "startupjobs",
  workingnomads: "workingnomads",
  himalayas: "himalayas",
  weworkremotely: "weworkremotely",
  jobicy: "jobicy",
  manual: "manual",
};

export function sourceExtractorLabel(source: ExtractorSourceId): string {
  return EXTRACTOR_ID_BY_SOURCE[source];
}

/** Whether this extractor's board is runnable only on a remote-type profile. */
export function isRemoteProfileOnlyExtractor(extractorId: string): boolean {
  return EXTRACTOR_SOURCE_IDS.some(
    (source) =>
      EXTRACTOR_ID_BY_SOURCE[source] === extractorId &&
      EXTRACTOR_SOURCE_METADATA[source].remoteProfileOnly === true,
  );
}

const extractorSourceTuple = EXTRACTOR_SOURCE_IDS as unknown as [
  ExtractorSourceId,
  ...ExtractorSourceId[],
];

export const extractorSourceEnum = z.enum(extractorSourceTuple);

export function isExtractorSourceId(value: string): value is ExtractorSourceId {
  return EXTRACTOR_SOURCE_IDS.includes(value as ExtractorSourceId);
}

export function sourceLabel(source: ExtractorSourceId): string {
  return EXTRACTOR_SOURCE_METADATA[source].label;
}

export function sortSources<T extends { source: ExtractorSourceId }>(
  values: T[],
): T[] {
  return [...values].sort(
    (left, right) =>
      EXTRACTOR_SOURCE_METADATA[left.source].order -
      EXTRACTOR_SOURCE_METADATA[right.source].order,
  );
}
