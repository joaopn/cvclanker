import { notFound, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { getProvider, listProviders } from "@server/providers";
import * as providersRepo from "@server/repositories/provider-instances";
import * as settingsRepo from "@server/repositories/settings";
import { getDefaultProfile } from "@server/services/profiles";
import {
  formatCountryLabel,
  normalizeCountryKey,
} from "@shared/location-support.js";
import { parseSearchCitiesSetting } from "@shared/search-cities.js";
import { resolveTermJobBudgets, termKey } from "@shared/term-budgets.js";
import {
  defaultProfileConfig,
  type ExtractorRunResult,
  SOURCE_CONFIG_GLOBAL_FIELDS,
  type SourceConfigRunGlobals,
} from "@shared/types";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

export const providerInstancesRouter = Router();

const globalFieldEnum = z.enum(
  SOURCE_CONFIG_GLOBAL_FIELDS as unknown as [string, ...string[]],
);

const createSchema = z.object({
  providerId: z.string().min(1).max(50),
  actorRef: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  templateId: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  inputTemplateJson: z.string().min(1).max(50_000),
  outputMappingJson: z.string().max(50_000).optional(),
  mappings: z.record(globalFieldEnum, z.boolean()).optional(),
  maxJobs: z.number().int().positive().max(10_000).optional(),
  maxAgeDays: z.number().int().positive().max(365).optional(),
});

const updateSchema = z.object({
  actorRef: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(200).optional(),
  templateId: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  inputTemplateJson: z.string().min(1).max(50_000).optional(),
  outputMappingJson: z.string().max(50_000).optional(),
  mappings: z.record(globalFieldEnum, z.boolean()).optional(),
  // null clears the per-instance override; omit to leave unchanged.
  maxJobs: z.number().int().positive().max(10_000).nullable().optional(),
  maxAgeDays: z.number().int().positive().max(365).nullable().optional(),
});

providerInstancesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const instances = await providersRepo.getAllProviderInstances();
    const providers = listProviders().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      templates: provider.templates.map((template) => ({
        id: template.id,
        providerId: template.providerId,
        actorRef: template.actorRef,
        displayName: template.displayName,
        description: template.description,
        defaultInputTemplate: template.defaultInputTemplate,
        defaultMappings: template.defaultMappings,
        maxAgeNote: template.maxAgeNote,
        perTermRuns: template.perTermRuns === true,
      })),
      instances: instances.filter((row) => row.providerId === provider.id),
    }));
    ok(res, { providers });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

providerInstancesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const input = createSchema.parse(req.body ?? {});
    if (!getProvider(input.providerId)) {
      return fail(res, notFound(`Unknown provider: ${input.providerId}`));
    }
    const created = await providersRepo.createProviderInstance(input);
    ok(res, created);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

providerInstancesRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const patch = updateSchema.parse(req.body ?? {});
    const updated = await providersRepo.updateProviderInstance(id, patch);
    if (!updated) {
      return fail(res, notFound(`Provider instance not found: ${id}`));
    }
    ok(res, updated);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

providerInstancesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const removed = await providersRepo.deleteProviderInstance(id);
    if (!removed) {
      return fail(res, notFound(`Provider instance not found: ${id}`));
    }
    ok(res, { id });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * Test an instance: run the actor once with current config + saved
 * globals; return up to MAX_SAMPLES mapped + raw items side by side so
 * the user can verify their mapping before enabling.
 */
const MAX_SAMPLES = 5;

/** What a per-term preview searched: each term tried, and where. */
type ProviderTestSearched = {
  terms: {
    term: string;
    mapped: number;
    /** Items the actor returned that the mapper could not read. */
    unmapped: number;
    /** The preview's deadline stopped it before it returned anything. */
    unfinished?: true;
  }[];
  /**
   * Terms the preview's deadline left unsearched. A stop for any other
   * reason (postings found, unreadable rows, a failed run) is the answer, so
   * the terms after it are not counted.
   */
  untried: number;
  place: string;
};

// The profile's terms in order, each case-insensitive variant once: every
// one costs an actor run.
function distinctPreviewTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = termKey(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The place the preview searched, as a person would write it: the cities
// (only the first for a template that searches each city separately, which
// the caller has already narrowed to), else the country, else anywhere.
function describeSearchPlace(runGlobals: SourceConfigRunGlobals): string {
  const cities = parseSearchCitiesSetting(runGlobals.city);
  const countryKey = normalizeCountryKey(runGlobals.country ?? "");
  const country = countryKey ? formatCountryLabel(countryKey) : "";
  if (cities.length === 0) return country || "anywhere";
  const where = cities.join(", ");
  return country ? `${where}, ${country}` : where;
}

// Deadline for the interactive "Test actor" preview. Matches the ~300s bound
// the old synchronous Apify call imposed as a side effect — long enough for a
// slow LinkedIn actor to produce first rows, short enough that the user is
// plausibly still looking. Hitting it aborts the actor run server-side.
const PROVIDER_TEST_DEADLINE_MS = 300_000;

providerInstancesRouter.post(
  "/:id/test",
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const instance = await providersRepo.getProviderInstance(id);
      if (!instance) {
        return fail(res, notFound(`Provider instance not found: ${id}`));
      }
      const provider = getProvider(instance.providerId);
      if (!provider) {
        return fail(res, notFound(`Unknown provider: ${instance.providerId}`));
      }

      const profileConfig =
        (await getDefaultProfile())?.config ?? defaultProfileConfig();
      const runGlobals: SourceConfigRunGlobals = {
        city: profileConfig.searchCities,
        country: profileConfig.searchCountry,
        workplaceTypes: JSON.stringify(profileConfig.workplaceTypes),
        ...(profileConfig.scrapeMaxAgeDays
          ? { maxAgeDays: String(profileConfig.scrapeMaxAgeDays) }
          : {}),
      };
      // A template that runs once per term searches one term at a time, in
      // the profile's order, until one returns postings: running them all
      // would spend the deadline on the first few and report the rest
      // unsearched, and a single term often matches nothing on an actor that
      // filters on the title (valig), which reads as a broken actor.
      const template = provider.templates.find(
        (candidate) => candidate.id === instance.templateId,
      );
      const perTermRuns = template?.perTermRuns === true;
      // Likewise a template that searches each city in its own run searches
      // the first city alone: a profile can list dozens, each a run of up to
      // a few minutes, and a preview needs only one.
      if (template?.termRunInputs) {
        const [firstCity] = parseSearchCitiesSetting(runGlobals.city);
        runGlobals.city = firstCity ?? "";
      }

      const apiToken =
        instance.providerId === "apify"
          ? ((await settingsRepo.getSetting("apifyApiToken")) ?? "")
          : "";

      // Bounds this interactive preview the way the old sync client's ~300s
      // platform ceiling did, but deliberately: at the deadline the actor run
      // is aborted server-side (it stops billing) and whatever it scraped
      // still comes back as samples below. A deadline, not a cancel: a cancel
      // drops what the run scraped.
      const startedAtMs = Date.now();
      const deadline = () =>
        Date.now() - startedAtMs > PROVIDER_TEST_DEADLINE_MS;
      const runTerms = (terms: string[]) =>
        provider.run({
          instance,
          runGlobals,
          apiToken: apiToken || null,
          searchTerms: terms,
          termBudgets: perTermRuns
            ? resolveTermJobBudgets(
                terms,
                profileConfig.termJobBudget,
                profileConfig.termJobBudgets,
              )
            : undefined,
          deadline,
        });

      // Undefined only when the profile has no terms to try (the deadline
      // cannot have passed before the first), which previews as an empty,
      // successful run.
      let result: ExtractorRunResult | undefined;
      let searched: ProviderTestSearched | undefined;
      if (perTermRuns) {
        const terms = distinctPreviewTerms(profileConfig.searchTerms);
        searched = {
          terms: [],
          untried: 0,
          place: describeSearchPlace(runGlobals),
        };
        for (const [index, term] of terms.entries()) {
          if (deadline()) {
            searched.untried = terms.length - index;
            break;
          }
          const termResult = await runTerms([term]);
          const mapped = termResult.jobs.length;
          const unmapped = termResult.droppedCount ?? 0;
          // A later term the deadline cut short before it returned anything
          // is reported as unfinished, not as the preview failing: the terms
          // before it came back empty, which is the answer.
          if (
            index > 0 &&
            !termResult.success &&
            deadline() &&
            mapped === 0 &&
            unmapped === 0
          ) {
            searched.terms.push({ term, mapped, unmapped, unfinished: true });
            searched.untried = terms.length - index - 1;
            break;
          }
          result = termResult;
          searched.terms.push({ term, mapped, unmapped });
          // Rows the mapper could not read still mean the actor answered:
          // stop there so the preview shows that, rather than paying for
          // more terms that would fail the same way.
          if (!termResult.success || mapped > 0 || unmapped > 0) break;
        }
      } else {
        result = await runTerms(profileConfig.searchTerms);
      }

      const jobs = result?.jobs ?? [];
      const samples = jobs.slice(0, MAX_SAMPLES);
      if (result && !result.success) {
        // A failed run can still carry salvaged rows (timed out or aborted
        // mid-crawl) — mapping verification wants to see them.
        return ok(res, {
          outcome: "error",
          error: result.error ?? "unknown error",
          samples,
          totalMapped: jobs.length,
          ...(searched ? { searched } : {}),
        });
      }

      ok(res, {
        outcome: "ok",
        samples,
        totalMapped: jobs.length,
        ...(searched ? { searched } : {}),
      });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
