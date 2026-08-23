import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import type {
  CreateJobInput,
  ExtractorRunResult,
  JobSource,
} from "@shared/types";
import type { ProviderRunContext, ProviderRunner } from "../types";
import { ApifyApiError, type ApifyRunOutcome, runApifyActor } from "./client";
import {
  applyFreeformMapping,
  FreeformMappingError,
  parseMappingSpec,
} from "./freeform-mapper";
import { APIFY_TEMPLATES, findApifyTemplate } from "./templates";
import {
  TemplateSubstitutionError,
  substituteInputTemplate,
} from "./template-substitute";

function providerSourceId(instanceId: string): JobSource {
  return `apify:${instanceId}` as JobSource;
}

async function runApifyInstance(
  context: ProviderRunContext,
): Promise<ExtractorRunResult> {
  const { instance, apiToken, runGlobals, searchTerms, shouldCancel } = context;

  if (shouldCancel?.()) {
    return { success: true, jobs: [] };
  }

  if (!apiToken) {
    return {
      success: false,
      jobs: [],
      error: "Apify API token is not configured. Add it on the Sources tab.",
    };
  }

  const template = instance.templateId
    ? findApifyTemplate(instance.templateId)
    : undefined;

  if (instance.templateId && !template) {
    return {
      success: false,
      jobs: [],
      error: `Unknown Apify template id: ${instance.templateId}`,
    };
  }

  let resolvedInput: unknown;
  try {
    resolvedInput = substituteInputTemplate({
      templateJson: instance.inputTemplateJson,
      runGlobals,
      searchTerms,
      placeholderMinimums: template?.placeholderMinimums,
      maxJobs: instance.maxJobs,
      maxAgeDays: instance.maxAgeDays,
    });
  } catch (error) {
    const message =
      error instanceof TemplateSubstitutionError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Failed to substitute input template";
    return { success: false, jobs: [], error: message };
  }

  // URL-driven actors (LinkedIn) compute their search URLs from the live run
  // context (search terms + location) so the configured location is honored
  // and stale, location-pinned URLs stored on the instance are overridden.
  if (template?.buildInput) {
    try {
      resolvedInput = template.buildInput(context, resolvedInput);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to build actor input";
      return { success: false, jobs: [], error: message };
    }
  }

  let runOutcome: ApifyRunOutcome;
  try {
    runOutcome = await runApifyActor({
      token: apiToken,
      actorRef: instance.actorRef,
      input: resolvedInput,
      shouldCancel,
    });
  } catch (error) {
    if (error instanceof ApifyApiError) {
      return { success: false, jobs: [], error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, jobs: [], error: message };
  }
  const datasetItems = runOutcome.items;

  const sourceId = providerSourceId(instance.id);
  const mapped: CreateJobInput[] = [];
  let droppedCount = 0;

  if (template) {
    for (const item of datasetItems) {
      if (shouldCancel?.()) break;
      try {
        const job = template.mapItem(item, { sourceId });
        if (job) mapped.push(job);
        else droppedCount += 1;
      } catch (error) {
        droppedCount += 1;
        logger.warn("Curated Apify mapper threw on item", {
          actorRef: instance.actorRef,
          templateId: instance.templateId,
          error: sanitizeUnknown(error),
        });
      }
    }
  } else {
    let spec;
    try {
      spec = parseMappingSpec(instance.outputMappingJson);
    } catch (error) {
      const message =
        error instanceof FreeformMappingError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Output mapping invalid";
      return { success: false, jobs: [], error: message };
    }
    for (const item of datasetItems) {
      if (shouldCancel?.()) break;
      const job = applyFreeformMapping({ spec, item, sourceId });
      if (job) mapped.push(job);
      else droppedCount += 1;
    }
  }

  if (droppedCount > 0) {
    logger.info("Apify mapper dropped items missing required fields", {
      actorRef: instance.actorRef,
      templateId: instance.templateId ?? null,
      droppedCount,
      mappedCount: mapped.length,
      totalCount: datasetItems.length,
    });
  }

  if (runOutcome.status !== "SUCCEEDED") {
    // The run died — its own timeout, or an abort — after scraping these
    // rows. success:false + jobs carries them out: discovery imports what was
    // paid for while the source still reads as failed, so its scrape
    // watermark stays put and a retry is offered (B42's salvage half).
    const how =
      runOutcome.status === "TIMED-OUT" ? "timed out" : "was aborted";
    return {
      success: false,
      jobs: mapped,
      droppedCount,
      error: `Actor run ${how} after scraping ${datasetItems.length} item(s); kept the ${mapped.length} job(s) mapped from them`,
    };
  }
  return { success: true, jobs: mapped, droppedCount };
}

export const apifyProvider: ProviderRunner = {
  id: "apify",
  displayName: "Apify",
  templates: APIFY_TEMPLATES,
  run: runApifyInstance,
};
