import { notFound, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { getProvider, listProviders } from "@server/providers";
import * as providersRepo from "@server/repositories/provider-instances";
import * as settingsRepo from "@server/repositories/settings";
import { getDefaultProfile } from "@server/services/profiles";
import {
  defaultProfileConfig,
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
      const searchTerms = profileConfig.searchTerms;

      const apiToken =
        instance.providerId === "apify"
          ? ((await settingsRepo.getSetting("apifyApiToken")) ?? "")
          : "";

      const result = await provider.run({
        instance,
        runGlobals,
        apiToken: apiToken || null,
        searchTerms,
      });

      if (!result.success) {
        return ok(res, {
          outcome: "error",
          error: result.error ?? "unknown error",
          samples: [],
        });
      }

      const samples = result.jobs.slice(0, MAX_SAMPLES);
      ok(res, {
        outcome: "ok",
        samples,
        totalMapped: result.jobs.length,
      });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
