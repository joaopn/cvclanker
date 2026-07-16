import { existsSync, rmSync } from "node:fs";
import {
  badRequest,
  conflict,
  notFound,
  toAppError,
  unprocessableEntity,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { closeDb } from "@server/db/index";
import { exportSnapshot, validateSnapshot } from "@server/db/snapshot";
import {
  activateStoredProfile,
  createFreshLiveDb,
  deleteStoredProfile,
  importStagingPath,
  listStoredProfiles,
  liveDbPath,
  readProfileName,
  readProfileStats,
  stashLiveDb,
  storeImportedProfile,
  storedProfilePath,
  writeProfileName,
} from "@server/db/user-profiles";
import { getPipelineStatus } from "@server/pipeline/index";
import * as settingsRepo from "@server/repositories/settings";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { receiveUpload } from "../uploads";

export const userProfilesRouter = Router();

const idSchema = z.string().uuid();
const renameSchema = z.object({ name: z.string().trim().min(1).max(200) });
const newProfileSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

const PIPELINE_RUNNING_MESSAGE =
  "Cannot switch user profiles while a pipeline run is in progress.";

async function activeProfileName(): Promise<string> {
  return (await settingsRepo.getSetting("userProfileName")) ?? "Default";
}

/** Auto-restart: exit once the response has flushed (or the client aborted —
 * the files are already swapped, so staying up would only serve a closed DB).
 * `close` fires exactly at flushed-or-aborted, so no flush timer is needed;
 * compose `restart: unless-stopped` brings the container back. */
function exitAfterResponse(res: Response): void {
  res.on("close", () => process.exit(0));
}

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile"
  );
}

function sendSnapshotDownload(
  res: Response,
  opts: { includeSecrets: boolean; sourcePath?: string; name: string },
): void {
  let snapshot: ReturnType<typeof exportSnapshot> | null = null;
  try {
    snapshot = exportSnapshot({
      includeSecrets: opts.includeSecrets,
      sourcePath: opts.sourcePath,
    });
  } catch (error) {
    fail(res, toAppError(error));
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `cvclanker-${slugifyName(opts.name)}-${stamp}.db`;
  logger.info("user profile exported", {
    includeSecrets: opts.includeSecrets,
    stored: Boolean(opts.sourcePath),
  });

  res.download(snapshot.path, filename, (err) => {
    snapshot?.cleanup();
    if (err && !res.headersSent) {
      fail(res, toAppError(err));
    }
  });
}

/**
 * GET /api/user-profiles - the active profile (live DB) + every stored file.
 */
userProfilesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const { stats, sizeBytes } = readProfileStats(liveDbPath());
    ok(res, {
      active: { name: await activeProfileName(), sizeBytes, stats },
      stored: listStoredProfiles(),
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/user-profiles/active - just the active profile's name (drawer).
 */
userProfilesRouter.get("/active", async (_req: Request, res: Response) => {
  try {
    ok(res, { name: await activeProfileName() });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/user-profiles/export?includeSecrets=0|1 - download the active
 * profile as a snapshot.
 */
userProfilesRouter.get("/export", async (req: Request, res: Response) => {
  try {
    sendSnapshotDownload(res, {
      includeSecrets: req.query.includeSecrets === "1",
      name: await activeProfileName(),
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/user-profiles/import - upload a DB file (multipart) and store it
 * as a new profile. Accepts both stamped snapshot exports and raw `jobs.db`
 * copies; never touches the live DB.
 */
userProfilesRouter.post("/import", async (req: Request, res: Response) => {
  const staging = importStagingPath();
  try {
    const received = await receiveUpload(req, staging);
    if (!received) {
      return fail(res, badRequest("No file uploaded."));
    }

    const validation = validateSnapshot(staging);
    if (!validation.ok) {
      rmSync(staging, { force: true });
      return fail(res, unprocessableEntity(validation.reason));
    }

    const { id, name } = storeImportedProfile(staging);
    const { stats, sizeBytes } = readProfileStats(storedProfilePath(id));
    logger.info("user profile imported", {
      id,
      formatVersion: validation.formatVersion,
    });
    ok(res, { id, name, sizeBytes, stats });
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { force: true });
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/user-profiles/new - stash the live DB as a stored profile and
 * restart into a fresh install (boot migrations + seeds create it).
 */
userProfilesRouter.post("/new", async (req: Request, res: Response) => {
  let swapStarted = false;
  try {
    const { name } = newProfileSchema.parse(req.body ?? {});
    if (getPipelineStatus().isRunning) {
      return fail(res, conflict(PIPELINE_RUNNING_MESSAGE));
    }

    swapStarted = true;
    closeDb();
    const { id: stashedId } = stashLiveDb();
    if (name) {
      createFreshLiveDb(name);
    }

    logger.warn("exiting to start a fresh user profile", {
      stashedId,
      ...(name ? { name } : {}),
    });
    exitAfterResponse(res);
    ok(res, {
      message:
        "Current profile stashed. The app is restarting into a fresh install.",
      restartRequired: true,
      stashedId,
    });
  } catch (error) {
    // Past closeDb() the live connection is gone — a restart is the only way
    // back to a serving state, whether or not the swap completed.
    if (swapStarted) {
      logger.error(
        "user profile stash failed after closing the DB — exiting",
        { error: error instanceof Error ? error.message : String(error) },
      );
      exitAfterResponse(res);
    }
    fail(res, toAppError(error));
  }
});

/**
 * PATCH /api/user-profiles/active - rename the active profile.
 */
userProfilesRouter.patch("/active", async (req: Request, res: Response) => {
  try {
    const { name } = renameSchema.parse(req.body ?? {});
    await settingsRepo.setSetting("userProfileName", name);
    ok(res, { name });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/user-profiles/:id/export?includeSecrets=0|1 - download a stored
 * profile as a snapshot.
 */
userProfilesRouter.get("/:id/export", (req: Request, res: Response) => {
  try {
    const id = idSchema.parse(req.params.id);
    const path = storedProfilePath(id);
    if (!existsSync(path)) {
      return fail(res, notFound(`User profile not found: ${id}`));
    }
    sendSnapshotDownload(res, {
      includeSecrets: req.query.includeSecrets === "1",
      sourcePath: path,
      name: readProfileName(path) ?? id,
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/user-profiles/:id/activate - swap a stored profile in as the live
 * DB and restart. The pipeline guard fires before any file is touched.
 */
userProfilesRouter.post(
  "/:id/activate",
  async (req: Request, res: Response) => {
    let swapStarted = false;
    try {
      const id = idSchema.parse(req.params.id);
      if (getPipelineStatus().isRunning) {
        return fail(res, conflict(PIPELINE_RUNNING_MESSAGE));
      }
      const path = storedProfilePath(id);
      if (!existsSync(path)) {
        return fail(res, notFound(`User profile not found: ${id}`));
      }
      const validation = validateSnapshot(path);
      if (!validation.ok) {
        return fail(
          res,
          unprocessableEntity(`Cannot activate: ${validation.reason}`),
        );
      }

      swapStarted = true;
      closeDb();
      const { stashedId } = activateStoredProfile(id);

      logger.warn("exiting to switch user profile", {
        activatedId: id,
        stashedId,
      });
      exitAfterResponse(res);
      ok(res, {
        message: "User profile activated. The app is restarting.",
        restartRequired: true,
        stashedId,
      });
    } catch (error) {
      // Past closeDb() the live connection is gone — a restart is the only
      // way back to a serving state, whether or not the swap completed.
      if (swapStarted) {
        logger.error(
          "user profile swap failed after closing the DB — exiting",
          { error: error instanceof Error ? error.message : String(error) },
        );
        exitAfterResponse(res);
      }
      fail(res, toAppError(error));
    }
  },
);

/**
 * PATCH /api/user-profiles/:id - rename a stored profile (written into the
 * closed file so it stays self-describing).
 */
userProfilesRouter.patch("/:id", (req: Request, res: Response) => {
  try {
    const id = idSchema.parse(req.params.id);
    const { name } = renameSchema.parse(req.body ?? {});
    const path = storedProfilePath(id);
    if (!existsSync(path)) {
      return fail(res, notFound(`User profile not found: ${id}`));
    }
    try {
      writeProfileName(path, name);
    } catch {
      return fail(
        res,
        unprocessableEntity("Profile file is not a valid CV Clanker database."),
      );
    }
    ok(res, { id, name });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * DELETE /api/user-profiles/:id - delete a stored profile. The active profile
 * has no store id, so it can never be deleted here.
 */
userProfilesRouter.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = idSchema.parse(req.params.id);
    if (!deleteStoredProfile(id)) {
      return fail(res, notFound(`User profile not found: ${id}`));
    }
    logger.info("user profile deleted", { id });
    ok(res, { id });
  } catch (error) {
    fail(res, toAppError(error));
  }
});
