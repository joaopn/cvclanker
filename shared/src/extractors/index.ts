import { z } from "zod";

export const EXTRACTOR_SOURCE_IDS = [
  "indeed",
  "linkedin",
  "glassdoor",
  "hiringcafe",
  "startupjobs",
  "workingnomads",
  "himalayas",
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
}

export const EXTRACTOR_SOURCE_METADATA: Record<
  ExtractorSourceId,
  ExtractorSourceMetadata
> = {
  indeed: { label: "Indeed", order: 20, category: "pipeline" },
  linkedin: { label: "LinkedIn", order: 30, category: "pipeline" },
  glassdoor: { label: "Glassdoor", order: 40, category: "pipeline" },
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
  manual: { label: "Manual", order: 110, category: "manual" },
};

export const PIPELINE_EXTRACTOR_SOURCE_IDS = EXTRACTOR_SOURCE_IDS.filter(
  (source) => EXTRACTOR_SOURCE_METADATA[source].category === "pipeline",
);

/**
 * Which extractor produces each platform. jobspy is a single extractor that
 * provides indeed/linkedin/glassdoor; the rest are 1:1. Used to surface the
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
