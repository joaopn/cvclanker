import { conflict, notFound, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import * as profilesRepo from "@server/repositories/profiles";
import * as profilesService from "@server/services/profiles";
import {
  MAX_BLOCKED_COMPANY_KEYWORD_LENGTH,
  MAX_BLOCKED_COMPANY_KEYWORDS,
} from "@shared/blocked-companies.js";
import { profileConfigSchema } from "@shared/types";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

export const profilesRouter = Router();

const configPatchSchema = profileConfigSchema.partial();

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  config: configPatchSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  config: configPatchSchema.optional(),
});

const blockCompanySchema = z.object({
  employer: z.string().trim().min(1).max(MAX_BLOCKED_COMPANY_KEYWORD_LENGTH),
  profileIds: z.array(z.string().min(1)).min(1),
});

profilesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const profiles = await profilesRepo.getAllProfiles();
    const defaultProfile = await profilesService.getDefaultProfile();
    ok(res, { profiles, defaultProfileId: defaultProfile?.id ?? null });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

profilesRouter.post("/", async (req: Request, res: Response) => {
  try {
    const input = createSchema.parse(req.body ?? {});
    const created = await profilesRepo.createProfile(input);
    ok(res, created);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * Add a company to the blocked list of several Search Profiles at once — the
 * "Blacklist" action on a company's job list. Future runs skip the company;
 * jobs already discovered are untouched.
 */
profilesRouter.post("/block-company", async (req: Request, res: Response) => {
  try {
    const input = blockCompanySchema.parse(req.body ?? {});
    const result = await profilesService.blockCompanyOnProfiles(input);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return fail(res, notFound(`Profile not found: ${result.profileId}`));
      }
      return fail(
        res,
        conflict(
          `"${result.profileName}" already has the maximum of ${MAX_BLOCKED_COMPANY_KEYWORDS} blocked companies. Remove one before adding another.`,
        ),
      );
    }
    ok(res, { blocked: result.blocked, alreadyBlocked: result.alreadyBlocked });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

profilesRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const patch = updateSchema.parse(req.body ?? {});
    const updated = await profilesRepo.updateProfile(id, patch);
    if (!updated) {
      return fail(res, notFound(`Profile not found: ${id}`));
    }
    ok(res, updated);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

profilesRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await profilesService.deleteProfileById(id);
    if (!result.ok) {
      if (result.reason === "last") {
        return fail(
          res,
          conflict(
            "Cannot delete the last profile — at least one is required.",
          ),
        );
      }
      return fail(res, notFound(`Profile not found: ${id}`));
    }
    ok(res, { id });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

profilesRouter.post("/:id/set-default", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const profile = await profilesService.setDefaultProfile(id);
    if (!profile) {
      return fail(res, notFound(`Profile not found: ${id}`));
    }
    ok(res, { defaultProfileId: profile.id });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

profilesRouter.post("/:id/duplicate", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const duplicated = await profilesService.duplicateProfile(id);
    if (!duplicated) {
      return fail(res, notFound(`Profile not found: ${id}`));
    }
    ok(res, duplicated);
  } catch (error) {
    fail(res, toAppError(error));
  }
});
