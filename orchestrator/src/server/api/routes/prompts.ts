import {
  badRequest,
  notFound,
  toAppError,
  unprocessableEntity,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import {
  getPromptRow,
  resetPromptContent,
  updatePromptContent,
} from "@server/repositories/prompts";
import {
  clearPromptCache,
  listPrompts,
  validatePromptContent,
} from "@server/services/prompts";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const promptsRouter = Router();

// Pure DoS guard, not a UX limit: the largest shipped prompt is ~8KB, so this
// is ~25x headroom; magnitude matches the maxBriefChars default (200k).
const MAX_PROMPT_CONTENT_CHARS = 200_000;

const updatePromptSchema = z.object({
  content: z.string().min(1).max(MAX_PROMPT_CONTENT_CHARS),
});

// Prompt names are single path segments (fragments ride the dedicated
// /fragments/:name routes and get prefixed server-side), matching the
// loader's identifier charset.
const NAME_PATTERN = /^[\w.-]+$/;

function resolvePromptName(req: Request): string | null {
  const segment = req.params.name;
  if (!segment || !NAME_PATTERN.test(segment)) return null;
  return req.path.startsWith("/fragments/") ? `fragments/${segment}` : segment;
}

function promptResponse(row: {
  name: string;
  content: string;
  defaultContent: string;
  updatedAt: string;
}) {
  return {
    name: row.name,
    content: row.content,
    defaultContent: row.defaultContent,
    edited: row.content !== row.defaultContent,
    updatedAt: row.updatedAt,
  };
}

/**
 * GET /api/prompts — list every prompt row with its description, last-update
 * time, and whether it has been edited away from the baked default.
 */
promptsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const prompts = await listPrompts();
    ok(res, { prompts });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/prompts/reload — drop the in-memory parse memo. Edits made
 * through the PUT route (or directly on the DB) already propagate on the
 * next load via updated_at, so this is a belt-and-braces revalidation: with
 * a name it STRUCTURALLY re-validates the row (parse + schema + partials, NO
 * variable interpolation — the same check as PUT) so a broken edit surfaces as
 * a 422 here instead of at the next consumer. It must NOT render: a render
 * would 500 on every prompt that has required {{vars}}. Body: { name?: string }
 */
promptsRouter.post("/reload", async (req: Request, res: Response) => {
  try {
    const rawName = req.body?.name;
    const name =
      typeof rawName === "string" && rawName.trim().length > 0
        ? rawName.trim()
        : null;

    if (rawName != null && name == null) {
      return fail(res, badRequest("name must be a non-empty string"));
    }

    if (name == null) {
      clearPromptCache();
      ok(res, { reloaded: "all" });
      return;
    }

    clearPromptCache(name);
    const row = await getPromptRow(name);
    if (!row) return fail(res, notFound("Prompt not found."));
    try {
      await validatePromptContent(name, row.content);
    } catch (validationError) {
      return fail(
        res,
        unprocessableEntity(
          validationError instanceof Error
            ? validationError.message
            : String(validationError),
        ),
      );
    }
    ok(res, { reloaded: name });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

async function handleGetPrompt(req: Request, res: Response): Promise<void> {
  try {
    const name = resolvePromptName(req);
    if (!name) return fail(res, badRequest("Invalid prompt name"));
    const row = await getPromptRow(name);
    if (!row) return fail(res, notFound("Prompt not found."));
    ok(res, promptResponse(row));
  } catch (error) {
    fail(res, toAppError(error));
  }
}

async function handlePutPrompt(req: Request, res: Response): Promise<void> {
  try {
    const name = resolvePromptName(req);
    if (!name) return fail(res, badRequest("Invalid prompt name"));

    const parsed = updatePromptSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(
        res,
        badRequest("Invalid request body", parsed.error.flatten()),
      );
    }

    const existing = await getPromptRow(name);
    if (!existing) return fail(res, notFound("Prompt not found."));

    try {
      await validatePromptContent(name, parsed.data.content);
    } catch (validationError) {
      return fail(
        res,
        unprocessableEntity(
          validationError instanceof Error
            ? validationError.message
            : String(validationError),
        ),
      );
    }

    await updatePromptContent(name, parsed.data.content);
    clearPromptCache(name);
    const updated = await getPromptRow(name);
    if (!updated) return fail(res, notFound("Prompt not found."));
    ok(res, promptResponse(updated));
  } catch (error) {
    fail(res, toAppError(error));
  }
}

async function handleResetPrompt(req: Request, res: Response): Promise<void> {
  try {
    const name = resolvePromptName(req);
    if (!name) return fail(res, badRequest("Invalid prompt name"));
    const changes = await resetPromptContent(name);
    if (changes === 0) return fail(res, notFound("Prompt not found."));
    clearPromptCache(name);
    const row = await getPromptRow(name);
    if (!row) return fail(res, notFound("Prompt not found."));
    ok(res, promptResponse(row));
  } catch (error) {
    fail(res, toAppError(error));
  }
}

// Fragment routes first (two segments — the bare /:name routes are
// single-segment and can never match these; explicit registration order is
// belt-and-braces, not the mechanism).
promptsRouter.get("/fragments/:name", handleGetPrompt);
promptsRouter.put("/fragments/:name", handlePutPrompt);
promptsRouter.post("/fragments/:name/reset", handleResetPrompt);

promptsRouter.get("/:name", handleGetPrompt);
promptsRouter.put("/:name", handlePutPrompt);
promptsRouter.post("/:name/reset", handleResetPrompt);
