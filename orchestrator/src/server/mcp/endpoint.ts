import { logger } from "@infra/logger";
import { getRequestId } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import type { McpAccessState } from "@shared/types";
import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from "express";
import { getMcpAccessState, verifyMcpToken } from "./access";
import { handleMcpMessage } from "./protocol";
import type { McpTool } from "./tools";

const READ_ONLY_REFUSAL =
  "This token is read-only. Switch it to read and change in Settings → Agent access.";
const BRIEF_REFUSAL =
  "Sharing the personal brief is switched off in Settings → Agent access.";

const PARSE_ERROR = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32700, message: "Parse error" },
} as const;

function presentedToken(req: Request): string | null {
  const match = /^bearer +(.*)$/i.exec(req.headers.authorization ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/** Answers the request itself and returns null unless the caller may go on. */
function admit(req: Request, res: Response): McpAccessState | null {
  if (!getMcpAccessState().enabled) {
    res.status(404).end();
    return null;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).end();
    return null;
  }
  const token = presentedToken(req);
  const access = token === null ? null : verifyMcpToken(token);
  if (access === null) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({
      error: token === null ? "Missing bearer token" : "Invalid token",
    });
    return null;
  }
  return access;
}

function authorizerFor(access: McpAccessState) {
  return (tool: McpTool): string | null => {
    if (tool.access === "write" && access.accessLevel !== "read_write") {
      return READ_ONLY_REFUSAL;
    }
    if (tool.needsBrief && !access.shareBrief) return BRIEF_REFUSAL;
    return null;
  };
}

function internalError(res: Response, error: unknown): void {
  logger.error("MCP request failed", {
    requestId: getRequestId(),
    error: sanitizeUnknown(error),
  });
  if (res.headersSent) return;
  res.status(500).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32603, message: "Internal error" },
  });
}

export const mcpEndpoint: RequestHandler = (req, res) => {
  void (async () => {
    const access = admit(req, res);
    if (access === null) return;
    if (!req.is("application/json")) {
      res.status(400).json(PARSE_ERROR);
      return;
    }
    const response = await handleMcpMessage(req.body, {
      requestId: getRequestId(),
      authorizeTool: authorizerFor(access),
    });
    if (response === null) {
      res.status(202).end();
      return;
    }
    res.status(200).json(response);
  })().catch((error) => internalError(res, error));
};

/** `express.json` rejects an unreadable body before any route runs. */
export const mcpBodyErrorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  next,
) => {
  if (req.path !== "/") {
    next(error);
    return;
  }
  try {
    if (admit(req, res) === null) return;
    const { status, type } = error as { status?: unknown; type?: unknown };
    if (typeof status !== "number" || status < 400 || status >= 500) {
      internalError(res, error);
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(status).json(PARSE_ERROR);
      return;
    }
    const message =
      status === 413 ? "Request body too large" : "Invalid Request";
    res.status(status).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message },
    });
  } catch (caught) {
    internalError(res, caught);
  }
};
