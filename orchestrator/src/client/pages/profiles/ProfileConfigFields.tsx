import type { SourceConfigsExtractorEntry } from "@client/api";
import type {
  LocationMatchStrictness,
  LocationSearchScope,
} from "@shared/location-preferences.js";
import {
  defaultProfileConfig,
  type ProfileConfig,
  type ProviderInstanceRow,
  type SuitabilityCategory,
} from "@shared/types";
import type React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  normalizeWorkplaceTypes,
  parseCityLocationsInput,
  parseCityLocationsSetting,
  parseSearchTermsInput,
  serializeCityLocationsSetting,
  type WorkplaceType,
} from "../orchestrator/automatic-run";
import {
  CountryField,
  LocationScopeField,
  MatchStrictnessField,
  MinFitField,
  NumberField,
  TokenizedField,
  WorkplaceTypesField,
} from "../orchestrator/run-fields";

/**
 * The Search Profile's editable fields, shared by the /profiles editor and the
 * onboarding wizard so the two cannot drift. Purely presentational: the
 * consumer owns state, mutations, and navigation.
 */

export interface EditorForm {
  name: string;
  searchTerms: string[];
  searchTermsDraft: string;
  country: string;
  cityValues: string[];
  cityDraft: string;
  workplaceTypes: WorkplaceType[];
  searchScope: LocationSearchScope;
  matchStrictness: LocationMatchStrictness;
  scrapeMaxAgeDays: string;
  scrapeSinceLastRun: boolean;
  blockedKeywords: string[];
  blockedDraft: string;
  runBudget: string;
  topN: string;
  minSuitabilityCategory: SuitabilityCategory;
  enabledSourceIds: string[];
  providerInstanceIds: string[];
}

export type ProfileConfigSection =
  | "terms"
  | "location"
  | "run"
  | "blocked"
  | "sources";

const ALL_SECTIONS: ProfileConfigSection[] = [
  "terms",
  "location",
  "run",
  "blocked",
  "sources",
];

export function formFromConfig(
  name: string,
  config: ProfileConfig,
): EditorForm {
  return {
    name,
    searchTerms: config.searchTerms,
    searchTermsDraft: "",
    country: config.searchCountry,
    cityValues: parseCityLocationsSetting(config.searchCities),
    cityDraft: "",
    workplaceTypes: config.workplaceTypes,
    searchScope: config.locationSearchScope,
    matchStrictness: config.locationMatchStrictness,
    scrapeMaxAgeDays:
      config.scrapeMaxAgeDays === null ? "" : String(config.scrapeMaxAgeDays),
    scrapeSinceLastRun: config.scrapeSinceLastRun,
    blockedKeywords: config.blockedCompanyKeywords,
    blockedDraft: "",
    runBudget: String(config.runBudget),
    topN: String(config.topN),
    minSuitabilityCategory: config.minSuitabilityCategory,
    enabledSourceIds: config.enabledSourceIds,
    providerInstanceIds: config.providerInstanceIds,
  };
}

function clampInt(
  value: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseMaxAge(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed) || parsed < 1) return null;
  return Math.min(365, parsed);
}

export function nextPinSet(
  current: string[],
  value: string,
  checked: boolean,
): string[] {
  return checked
    ? Array.from(new Set([...current, value]))
    : current.filter((item) => item !== value);
}

/** `base` is the profile's stored config (or defaults for a new one), so keys
 *  this form does not edit are carried forward rather than dropped. */
export function buildConfig(
  form: EditorForm,
  base: ProfileConfig = defaultProfileConfig(),
): ProfileConfig {
  return {
    ...base,
    searchTerms: form.searchTerms,
    searchCountry: form.country,
    searchCities: serializeCityLocationsSetting(form.cityValues) ?? "",
    workplaceTypes: form.workplaceTypes,
    locationSearchScope: form.searchScope,
    locationMatchStrictness: form.matchStrictness,
    scrapeMaxAgeDays: parseMaxAge(form.scrapeMaxAgeDays),
    scrapeSinceLastRun: form.scrapeSinceLastRun,
    blockedCompanyKeywords: form.blockedKeywords,
    runBudget: clampInt(form.runBudget, 50, 1000, 500),
    topN: clampInt(form.topN, 1, 50, 10),
    minSuitabilityCategory: form.minSuitabilityCategory,
    enabledSourceIds: form.enabledSourceIds,
    providerInstanceIds: form.providerInstanceIds,
  };
}

// `enabled` is NESTED for extractors and FLAT for instances — an
// `extractors.filter((e) => e.enabled)` silently drops every one of them.
export function enabledExtractorIdsOf(
  extractors: SourceConfigsExtractorEntry[],
): string[] {
  return extractors
    .filter((extractor) => extractor.row.enabled)
    .map((extractor) => extractor.extractorId);
}

export function enabledInstanceIdsOf(
  instances: ProviderInstanceRow[],
): string[] {
  return instances
    .filter((instance) => instance.enabled)
    .map((instance) => instance.id);
}

/**
 * A source runs only when it is ticked on the Search Profile AND enabled on the
 * Sources page. Gate Save on that intersection, never on the ticks alone: a
 * profile whose only ticks are greyed-out would otherwise save as valid and
 * then launch runs that scrape nothing. One implementation, both hosts.
 */
export function hasEffectiveSourceSelection(
  form: EditorForm,
  extractors: SourceConfigsExtractorEntry[],
  instances: ProviderInstanceRow[],
): boolean {
  const enabledExtractors = enabledExtractorIdsOf(extractors);
  const enabledInstances = enabledInstanceIdsOf(instances);
  return (
    form.enabledSourceIds.some((id) => enabledExtractors.includes(id)) ||
    form.providerInstanceIds.some((id) => enabledInstances.includes(id))
  );
}

interface ProfileConfigFieldsProps {
  form: EditorForm;
  onChange: (patch: Partial<EditorForm>) => void;
  extractors: SourceConfigsExtractorEntry[];
  instances: ProviderInstanceRow[];
  sections?: ProfileConfigSection[];
}

export const ProfileConfigFields: React.FC<ProfileConfigFieldsProps> = ({
  form,
  onChange,
  extractors,
  instances,
  sections = ALL_SECTIONS,
}) => {
  const shows = (section: ProfileConfigSection) => sections.includes(section);

  const toggleWorkplace = (workplaceType: WorkplaceType, checked: boolean) => {
    const next = checked
      ? normalizeWorkplaceTypes([...form.workplaceTypes, workplaceType])
      : form.workplaceTypes.filter((type) => type !== workplaceType);
    onChange({ workplaceTypes: next });
  };

  const toggleExtractor = (extractorId: string, checked: boolean) => {
    onChange({
      enabledSourceIds: nextPinSet(form.enabledSourceIds, extractorId, checked),
    });
  };

  const toggleInstance = (instanceId: string, checked: boolean) => {
    onChange({
      providerInstanceIds: nextPinSet(
        form.providerInstanceIds,
        instanceId,
        checked,
      ),
    });
  };

  const hasEffectiveSource = hasEffectiveSourceSelection(
    form,
    extractors,
    instances,
  );

  return (
    <>
      {shows("terms") ? (
        <Card>
          <CardHeader>
            <CardTitle>Search terms</CardTitle>
          </CardHeader>
          <CardContent>
            <TokenizedField
              id="profile-search-terms"
              values={form.searchTerms}
              draft={form.searchTermsDraft}
              parseInput={parseSearchTermsInput}
              onDraftChange={(value) => onChange({ searchTermsDraft: value })}
              onValuesChange={(value) => onChange({ searchTerms: value })}
              placeholder="Type and press Enter"
              helperText="Add multiple terms by separating with commas or pressing Enter."
              removeLabelPrefix="Remove"
            />
          </CardContent>
        </Card>
      ) : null}

      {shows("location") ? (
        <Card>
          <CardHeader>
            <CardTitle>Location</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <CountryField
                value={form.country}
                onChange={(value) => onChange({ country: value })}
              />
              <TokenizedField
                id="profile-cities"
                label="Cities"
                labelClassName="text-base font-semibold"
                values={form.cityValues}
                draft={form.cityDraft}
                parseInput={parseCityLocationsInput}
                onDraftChange={(value) => onChange({ cityDraft: value })}
                onValuesChange={(value) => onChange({ cityValues: value })}
                placeholder='e.g. "London"'
                removeLabelPrefix="Remove city"
              />
            </div>
            <WorkplaceTypesField
              value={form.workplaceTypes}
              onToggle={toggleWorkplace}
            />
            <LocationScopeField
              value={form.searchScope}
              onChange={(value) => onChange({ searchScope: value })}
            />
            <MatchStrictnessField
              value={form.matchStrictness}
              onChange={(value) => onChange({ matchStrictness: value })}
            />
          </CardContent>
        </Card>
      ) : null}

      {shows("run") ? (
        <Card>
          <CardHeader>
            <CardTitle>Run settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
              <NumberField
                id="profile-run-budget"
                label="Max jobs discovered"
                min={50}
                max={1000}
                value={form.runBudget}
                onChange={(value) => onChange({ runBudget: value })}
              />
              <NumberField
                id="profile-top-n"
                label="Resumes tailored"
                min={1}
                max={50}
                value={form.topN}
                onChange={(value) => onChange({ topN: value })}
              />
              <NumberField
                id="profile-max-age"
                label="Max job age (days)"
                min={1}
                max={365}
                value={form.scrapeMaxAgeDays}
                onChange={(value) => onChange({ scrapeMaxAgeDays: value })}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="profile-scrape-since-last-run"
                className="flex cursor-pointer items-center gap-3 text-sm"
              >
                <Checkbox
                  id="profile-scrape-since-last-run"
                  checked={form.scrapeSinceLastRun}
                  onCheckedChange={(checked) =>
                    onChange({ scrapeSinceLastRun: checked === true })
                  }
                />
                Only scrape since the last run
              </label>
              <p className="text-xs text-muted-foreground">
                Narrows each source's job age to the days elapsed since it last
                scraped successfully for this profile, rounded up — never wider
                than the cap above. A source that failed, or has not run yet,
                still gets the full window.
              </p>
            </div>
            <MinFitField
              value={form.minSuitabilityCategory}
              onChange={(value) => onChange({ minSuitabilityCategory: value })}
            />
          </CardContent>
        </Card>
      ) : null}

      {shows("blocked") ? (
        <Card>
          <CardHeader>
            <CardTitle>Blocked companies</CardTitle>
          </CardHeader>
          <CardContent>
            <TokenizedField
              id="profile-blocked"
              values={form.blockedKeywords}
              draft={form.blockedDraft}
              parseInput={parseSearchTermsInput}
              onDraftChange={(value) => onChange({ blockedDraft: value })}
              onValuesChange={(value) => onChange({ blockedKeywords: value })}
              placeholder="Company name keyword"
              helperText="Jobs from companies matching these keywords are skipped."
              removeLabelPrefix="Remove keyword"
            />
          </CardContent>
        </Card>
      ) : null}

      {shows("sources") ? (
        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Extractors
              </p>
              {extractors.length > 0 ? (
                <div className="flex flex-wrap gap-2 gap-x-4">
                  {extractors.map((extractor) => {
                    const checkboxId = `pin-extractor-${extractor.extractorId}`;
                    // Disabled on the Sources page → shown, but not selectable.
                    // Never hidden: the user has to be able to see why they
                    // cannot pick it.
                    const sourceDisabled = !extractor.row.enabled;
                    return (
                      <div
                        key={extractor.extractorId}
                        className="flex items-center gap-2"
                      >
                        <label
                          htmlFor={checkboxId}
                          className={cn(
                            "flex items-center gap-3 text-sm",
                            sourceDisabled
                              ? "cursor-not-allowed opacity-50"
                              : "cursor-pointer",
                          )}
                        >
                          <Checkbox
                            id={checkboxId}
                            disabled={sourceDisabled}
                            checked={form.enabledSourceIds.includes(
                              extractor.extractorId,
                            )}
                            onCheckedChange={(checked) =>
                              toggleExtractor(
                                extractor.extractorId,
                                checked === true,
                              )
                            }
                          />
                          {extractor.displayName}
                        </label>
                        {sourceDisabled ? (
                          <span className="text-xs text-muted-foreground">
                            disabled on the Sources page
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No extractors available.
                </p>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Apify actors
              </p>
              {instances.length > 0 ? (
                <div className="flex flex-wrap gap-2 gap-x-4">
                  {instances.map((instance) => {
                    const checkboxId = `pin-instance-${instance.id}`;
                    const sourceDisabled = !instance.enabled;
                    return (
                      <div
                        key={instance.id}
                        className="flex items-center gap-2"
                      >
                        <label
                          htmlFor={checkboxId}
                          className={cn(
                            "flex items-center gap-3 text-sm",
                            sourceDisabled
                              ? "cursor-not-allowed opacity-50"
                              : "cursor-pointer",
                          )}
                        >
                          <Checkbox
                            id={checkboxId}
                            disabled={sourceDisabled}
                            checked={form.providerInstanceIds.includes(
                              instance.id,
                            )}
                            onCheckedChange={(checked) =>
                              toggleInstance(instance.id, checked === true)
                            }
                          />
                          {instance.label}
                        </label>
                        {sourceDisabled ? (
                          <span className="text-xs text-muted-foreground">
                            disabled on the Sources page
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No Apify actors configured.
                </p>
              )}
            </div>

            {!hasEffectiveSource ? (
              <p className="text-sm text-destructive">
                Select at least one source. A source runs only when it is ticked
                here and enabled on the Sources page.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
};
