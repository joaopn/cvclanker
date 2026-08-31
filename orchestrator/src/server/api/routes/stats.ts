/**
 * Read-only aggregates for the Stats surface.
 *
 * Every endpoint takes the same two filters and returns a self-contained
 * payload for one tab, so a tab switch fetches only what it renders.
 */

import { badRequest, notFound } from "@infra/errors";
import { asyncRoute, ok } from "@infra/http";
import { getProfile } from "@server/repositories/profiles";
import {
  getApplicationStats,
  getCompanyStats,
  getDiscoveryStats,
  getOverviewStats,
} from "@server/repositories/stats";
import type { StatsQuery } from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const statsRouter = Router();

/**
 * `days` is bounded at ten years. Past that the range is indistinguishable
 * from all-time, and `datetime('now', '-N days')` leaves the range SQLite can
 * represent and answers NULL — which would quietly return an empty page
 * instead of an error.
 */
const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
  profileId: z.string().trim().min(1).optional(),
});

async function parseQuery(req: Request): Promise<StatsQuery> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest("Invalid stats query", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const profileId = parsed.data.profileId ?? null;
  if (profileId !== null) {
    // A typo'd id would otherwise render as a page of zeros that looks like a
    // real answer.
    const profile = await getProfile(profileId);
    if (!profile) {
      throw notFound(`Search Profile not found: ${profileId}`);
    }
  }

  return { sinceDays: parsed.data.days ?? null, profileId };
}

statsRouter.get(
  "/overview",
  asyncRoute(async (req: Request, res: Response) => {
    ok(res, await getOverviewStats(await parseQuery(req)));
  }),
);

statsRouter.get(
  "/discovery",
  asyncRoute(async (req: Request, res: Response) => {
    ok(res, await getDiscoveryStats(await parseQuery(req)));
  }),
);

statsRouter.get(
  "/applications",
  asyncRoute(async (req: Request, res: Response) => {
    ok(res, await getApplicationStats(await parseQuery(req)));
  }),
);

statsRouter.get(
  "/companies",
  asyncRoute(async (req: Request, res: Response) => {
    ok(res, await getCompanyStats(await parseQuery(req)));
  }),
);
