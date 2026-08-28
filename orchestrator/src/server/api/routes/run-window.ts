import type { ExtractorRegistry } from "@server/extractors/registry";
import { getProvider } from "@server/providers";
import type { ExtractorSourceId } from "@shared/extractors";
import { bucketWindowDays } from "@shared/scrape-window.js";
import type {
  ProviderInstanceRow,
  SourceConfigRow,
  SourceConfigSchema,
} from "@shared/types";

/**
 * Why a run's requested scrape window is refused.
 *
 * `over_cap` — wider than the max job age configured for the source. The
 * ceiling is the user's own standing policy, so exceeding it is refused rather
 * than clamped: a run that silently scraped less than asked is the outcome this
 * whole surface exists to remove.
 *
 * `over_bucket` — the source expresses recency as a fixed set of windows and
 * would snap the request DOWN to its widest one. Same failure as `over_cap`
 * from the user's side (less coverage than asked for) but invisible to the cap
 * check, since the request is under the ceiling.
 *
 * Only an EXPLICIT window is gated. The "since last run" narrowing can reach a
 * clamping actor too — a 45-day gap on an uncapped profile asks for 45 and gets
 * 30 — but that path is self-correcting rather than lossy: the mark records the
 * BUCKETED window (`instanceWindowFrom` in `discover-jobs.ts`), so it holds and
 * the next run reaches back over what was missed. An explicit window has no
 * such second chance, because the user asked for exactly this span once.
 */
export type RunWindowViolationKind = "over_cap" | "over_bucket";

export interface RunWindowViolation {
  /** Discovery task id: extractor manifest id, or `<provider>:<instance>`. */
  sourceKey: string;
  label: string;
  kind: RunWindowViolationKind;
  /** The widest window this source will honour, in days. */
  limitDays: number;
}

/**
 * Whether the run's global max-age reaches a given extractor at all.
 *
 * `resolveSourceContextSettings` applies the per-source config BEFORE the
 * global-mapping loop, so an extractor whose `maxAgeDays` mapping is unticked
 * honours its own stored value and ignores the run entirely. Such a source
 * cannot exceed the run's ceiling because the run never reaches it — gating it
 * would refuse a run over a limit that does not apply.
 */
export function extractorHonoursRunWindow(
  manifest: { configSchema?: SourceConfigSchema },
  row: Pick<SourceConfigRow, "mappings"> | undefined,
): boolean {
  const mapping = manifest.configSchema?.globalMappings.find(
    (candidate) => candidate.globalField === "maxAgeDays",
  );
  if (!mapping) return false;
  // Same expression as `resolveSourceContextSettings` — the runtime authority.
  // Defaulting to `true` instead would disagree with it for any manifest that
  // ships `enabledByDefault: false`, refusing runs over a ceiling that never
  // reaches the source.
  const userMapped = row?.mappings?.maxAgeDays;
  return userMapped ?? mapping.enabledByDefault;
}

/** The fixed windows an instance's actor accepts, if it has any. */
export function instanceMaxAgeBuckets(
  instance: ProviderInstanceRow,
): readonly number[] | undefined {
  if (!instance.templateId) return undefined;
  const template = getProvider(instance.providerId)?.templates.find(
    (candidate) => candidate.id === instance.templateId,
  );
  const buckets = template?.maxAgeBuckets;
  return buckets && buckets.length > 0 ? buckets : undefined;
}

/**
 * Every reason the run's requested window cannot be honoured by the sources it
 * would run. The caller refuses the whole run on a non-empty result: starting
 * anyway would scrape a narrower window than asked for on some sources and the
 * configured one on others, which is not a result anyone asked for.
 */
export function findRunWindowViolations(args: {
  windowDays: number | undefined;
  profileMaxAgeDays: number | null | undefined;
  sources: readonly ExtractorSourceId[] | undefined;
  registry: ExtractorRegistry | null;
  sourceConfigs: readonly SourceConfigRow[];
  instances: readonly ProviderInstanceRow[];
}): RunWindowViolation[] {
  const { windowDays } = args;
  if (typeof windowDays !== "number") return [];

  const violations: RunWindowViolation[] = [];
  const configByExtractor = new Map(
    args.sourceConfigs.map((row) => [row.extractorId, row]),
  );

  // Extractors, once per manifest: a fan-out task shares one window, and
  // reporting it per platform would name the same limit three times.
  const seenManifests = new Set<string>();
  for (const source of args.sources ?? []) {
    const manifest = args.registry?.manifestBySource.get(source);
    if (!manifest || seenManifests.has(manifest.id)) continue;
    seenManifests.add(manifest.id);
    if (
      !extractorHonoursRunWindow(manifest, configByExtractor.get(manifest.id))
    )
      continue;
    const cap = args.profileMaxAgeDays;
    if (typeof cap === "number" && cap > 0 && windowDays > cap) {
      violations.push({
        sourceKey: manifest.id,
        label: manifest.displayName,
        kind: "over_cap",
        limitDays: cap,
      });
    }
  }

  for (const instance of args.instances) {
    // A per-instance max age wins over the Profile's, so it is this actor's
    // ceiling; discovery writes the narrowed value onto the instance, which is
    // why a smaller run window legitimately overrides it.
    const cap = instance.maxAgeDays ?? args.profileMaxAgeDays;
    const sourceKey = `${instance.providerId}:${instance.id}`;
    if (typeof cap === "number" && cap > 0 && windowDays > cap) {
      violations.push({
        sourceKey,
        label: instance.label,
        kind: "over_cap",
        limitDays: cap,
      });
      continue;
    }
    const buckets = instanceMaxAgeBuckets(instance);
    if (buckets && bucketWindowDays(windowDays, buckets) < windowDays) {
      violations.push({
        sourceKey,
        label: instance.label,
        kind: "over_bucket",
        limitDays: buckets[buckets.length - 1],
      });
    }
  }

  return violations;
}

/** One sentence naming what to change, for the 400 the route returns. */
export function describeRunWindowViolations(
  windowDays: number,
  violations: readonly RunWindowViolation[],
): string {
  const parts = violations.map(
    (violation) =>
      `${violation.label} (${
        violation.kind === "over_cap"
          ? `max job age ${violation.limitDays}d`
          : `cannot look back past ${violation.limitDays}d`
      })`,
  );
  // The remedy differs by kind: a cap is the user's own setting and can be
  // raised, while a bucket is the actor's fixed enum and cannot — telling
  // someone to raise a max job age they cannot escape would send them in
  // circles.
  const remedy = violations.every(
    (violation) => violation.kind === "over_bucket",
  )
    ? "Lower the window or deselect them."
    : violations.some((violation) => violation.kind === "over_bucket")
      ? "Lower the window, raise the max job age where it is a setting, or deselect them."
      : "Lower the window, raise their max job age, or deselect them.";
  return `A ${windowDays}-day run window is wider than these sources allow: ${parts.join(", ")}. ${remedy}`;
}
