import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { APP_VERSION } from "@server/services/prompts/fragments";
import { getMcpTool, listMcpTools, type McpTool } from "./tools";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2024-11-05",
] as const;

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number;

export interface McpMessageContext {
  requestId?: string;
  /** Returns a reason to refuse the call, or null to allow it. */
  authorizeTool?: (tool: McpTool) => string | null;
}

export type McpResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
} & (
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsableId(value: unknown): value is JsonRpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultResponse(
  id: JsonRpcId,
  result: Record<string, unknown>,
): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function callTool(
  params: Record<string, unknown>,
  ctx: McpMessageContext,
): Promise<
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
> {
  const name = params.name;
  if (typeof name !== "string") {
    return { error: { code: INVALID_PARAMS, message: "Missing tool name" } };
  }
  const tool = getMcpTool(name);
  if (!tool) {
    return {
      error: { code: INVALID_PARAMS, message: `Unknown tool: ${name}` },
    };
  }

  const refusal = ctx.authorizeTool?.(tool) ?? null;
  if (refusal !== null) return { result: toolError(refusal) };

  const parsed = tool.input.validate(params.arguments ?? {});
  if (!parsed.ok) return { result: toolError(parsed.error) };

  const jobId = typeof parsed.value.id === "string" ? parsed.value.id : null;
  const logContext = {
    tool: tool.name,
    ...(jobId !== null ? { jobId } : {}),
    ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
  };
  logger.info("MCP tool call", logContext);

  let result: unknown;
  try {
    result = await tool.handler(parsed.value);
  } catch (error) {
    logger.warn("MCP tool call failed", {
      ...logContext,
      error: sanitizeUnknown(error),
    });
    return {
      result: toolError(
        error instanceof Error ? error.message : "Tool call failed",
      ),
    };
  }
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      ...(isPlainObject(result) ? { structuredContent: result } : {}),
    },
  };
}

/**
 * Handles one parsed JSON-RPC 2.0 message. Returns the response to send, or
 * null for a notification, which gets none.
 */
export async function handleMcpMessage(
  message: unknown,
  ctx: McpMessageContext = {},
): Promise<McpResponse | null> {
  if (Array.isArray(message)) {
    return errorResponse(
      null,
      INVALID_REQUEST,
      "Batch requests are not supported",
    );
  }
  if (!isPlainObject(message)) {
    return errorResponse(null, INVALID_REQUEST, "Invalid Request");
  }

  const hasId = Object.hasOwn(message, "id");
  const id = isUsableId(message.id) ? message.id : null;
  const method = message.method;
  if (
    message.jsonrpc !== "2.0" ||
    typeof method !== "string" ||
    method === "" ||
    (hasId && id === null)
  ) {
    return errorResponse(id, INVALID_REQUEST, "Invalid Request");
  }
  if (id === null) return null;

  const params = isPlainObject(message.params) ? message.params : {};

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find(
        (version) => version === requested,
      );
      return resultResponse(id, {
        protocolVersion: protocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "cvclanker", version: APP_VERSION },
      });
    }
    case "ping":
      return resultResponse(id, {});
    case "tools/list":
      return resultResponse(id, {
        tools: listMcpTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input.jsonSchema,
        })),
      });
    case "tools/call": {
      const outcome = await callTool(params, ctx);
      if ("error" in outcome) {
        return errorResponse(id, outcome.error.code, outcome.error.message);
      }
      return resultResponse(id, outcome.result);
    }
    default:
      return errorResponse(id, METHOD_NOT_FOUND, "Method not found");
  }
}
