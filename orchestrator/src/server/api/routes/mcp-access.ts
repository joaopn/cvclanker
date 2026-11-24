import { toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { getWebLoginConfig } from "@server/auth/web-login";
import {
  generateMcpToken,
  getMcpAccessState,
  revokeMcpToken,
  updateMcpAccess,
} from "@server/mcp/access";
import type {
  McpAccessState,
  McpAccessSummary,
  McpTokenIssued,
  UpdateMcpAccessInput,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const mcpAccessRouter = Router();

const updateSchema = z
  .object({
    accessLevel: z.enum(["read", "read_write"]).optional(),
    shareBrief: z.boolean().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "Provide accessLevel or shareBrief",
  }) satisfies z.ZodType<UpdateMcpAccessInput>;

function summary(state: McpAccessState): McpAccessSummary {
  return { ...state, webLoginEnabled: getWebLoginConfig().enabled };
}

mcpAccessRouter.get("/", (_req: Request, res: Response) => {
  try {
    ok(res, summary(getMcpAccessState()));
  } catch (error) {
    fail(res, toAppError(error));
  }
});

mcpAccessRouter.post("/", (_req: Request, res: Response) => {
  try {
    const token = generateMcpToken();
    const issued: McpTokenIssued = {
      token,
      ...summary(getMcpAccessState()),
    };
    res.setHeader("Cache-Control", "no-store");
    ok(res, issued);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

mcpAccessRouter.patch("/", (req: Request, res: Response) => {
  try {
    const input = updateSchema.parse(req.body ?? {});
    ok(res, summary(updateMcpAccess(input)));
  } catch (error) {
    fail(res, toAppError(error));
  }
});

mcpAccessRouter.delete("/", (_req: Request, res: Response) => {
  try {
    revokeMcpToken();
    ok(res, summary(getMcpAccessState()));
  } catch (error) {
    fail(res, toAppError(error));
  }
});
