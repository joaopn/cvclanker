import { notFound, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { getExtractorRegistry } from "@server/extractors/registry";
import * as repo from "@server/repositories/source-configs";
import { getDefaultProfile } from "@server/services/profiles";
import { resolveSourceContextSettings } from "@server/services/source-configs/resolve";
import {
  defaultProfileConfig,
  SOURCE_CONFIG_GLOBAL_FIELDS,
  type SourceConfigRow,
  type SourceConfigRunGlobals,
  type SourceConfigSchema,
} from "@shared/types";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

export const sourceConfigsRouter = Router();

const globalFieldEnum = z.enum(
  SOURCE_CONFIG_GLOBAL_FIELDS as unknown as [string, ...string[]],
);

const upsertSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string()).optional(),
  mappings: z.record(globalFieldEnum, z.boolean()).optional(),
});

function emptyRow(extractorId: string): SourceConfigRow {
  return {
    extractorId,
    enabled: false,
    config: {},
    mappings: {},
    updatedAt: new Date(0).toISOString(),
  };
}

sourceConfigsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const [rows, registry] = await Promise.all([
      repo.getAllSourceConfigs(),
      getExtractorRegistry(),
    ]);
    const rowsByExtractor = new Map<string, SourceConfigRow>();
    for (const row of rows) rowsByExtractor.set(row.extractorId, row);

    const profileConfig =
      (await getDefaultProfile())?.config ?? defaultProfileConfig();
    // Same rule as the run route: a remote-type profile sends no geography.
    const runGlobals: SourceConfigRunGlobals = {
      city: profileConfig.remoteProfile ? "" : profileConfig.searchCities,
      country: profileConfig.remoteProfile ? "" : profileConfig.searchCountry,
      workplaceTypes: JSON.stringify(profileConfig.workplaceTypes),
      ...(profileConfig.scrapeMaxAgeDays
        ? { maxAgeDays: String(profileConfig.scrapeMaxAgeDays) }
        : {}),
    };

    type ExtractorEntry = {
      extractorId: string;
      displayName: string;
      description?: string;
      providesSources: readonly string[];
      row: SourceConfigRow;
      schema: SourceConfigSchema | null;
      effectiveSettings: Record<string, string>;
    };

    const extractors: ExtractorEntry[] = [];
    const manifestsSorted = Array.from(registry.manifests.values()).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    for (const manifest of manifestsSorted) {
      const row = rowsByExtractor.get(manifest.id) ?? emptyRow(manifest.id);
      const schema = manifest.configSchema ?? null;
      const effectiveSettings = resolveSourceContextSettings({
        schema: manifest.configSchema,
        row,
        runGlobals,
      });
      extractors.push({
        extractorId: manifest.id,
        displayName: manifest.displayName,
        description: manifest.description,
        providesSources: manifest.providesSources,
        row,
        schema,
        effectiveSettings,
      });
    }

    ok(res, { extractors });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

sourceConfigsRouter.put(
  "/:extractorId",
  async (req: Request, res: Response) => {
    try {
      const { extractorId } = req.params;
      const registry = await getExtractorRegistry();
      if (!registry.manifests.has(extractorId)) {
        return fail(res, notFound(`Unknown extractor: ${extractorId}`));
      }
      const patch = upsertSchema.parse(req.body ?? {});
      const updated = await repo.upsertSourceConfig(extractorId, patch);
      ok(res, updated);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
