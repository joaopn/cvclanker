// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("handleMcpMessage", () => {
  let tempDir: string;
  let protocol: Awaited<typeof import("./protocol")>;
  let tools: Awaited<typeof import("./tools")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-mcp-protocol-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    protocol = await import("./protocol");
    tools = await import("./tools");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  const request = (method: string, params?: unknown, id: unknown = 1) => ({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });

  it("echoes a supported protocol version and advertises tools", async () => {
    const response = await protocol.handleMcpMessage(
      request("initialize", { protocolVersion: "2024-11-05" }),
    );

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cvclanker" },
      },
    });
  });

  it("answers the newest version for one it does not support", async () => {
    const response = await protocol.handleMcpMessage(
      request("initialize", { protocolVersion: "2025-03-26" }),
    );

    expect(response).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
  });

  it("answers ping with an empty result", async () => {
    const response = await protocol.handleMcpMessage(request("ping", {}, "p"));

    expect(response).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  it("lists the seven tools", async () => {
    const response = await protocol.handleMcpMessage(request("tools/list"));

    const listed = (
      response as unknown as {
        result: { tools: { name: string; inputSchema: unknown }[] };
      }
    ).result.tools;
    expect(listed.map((tool) => tool.name).sort()).toEqual([
      "add_job_note",
      "get_job",
      "get_job_documents",
      "get_personal_brief",
      "get_tailored_cv",
      "mark_applied",
      "search_jobs",
    ]);
    expect(listed.find((tool) => tool.name === "get_job")?.inputSchema).toEqual(
      {
        type: "object",
        properties: {
          id: { type: "string", description: "The job's id." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    );
  });

  it("answers an unknown method with -32601", async () => {
    const response = await protocol.handleMcpMessage(request("resources/list"));

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("answers an unknown tool with -32602", async () => {
    const response = await protocol.handleMcpMessage(
      request("tools/call", { name: "delete_everything" }),
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Unknown tool: delete_everything" },
    });
  });

  it("returns null for a notification", async () => {
    const response = await protocol.handleMcpMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response).toBeNull();
  });

  it("answers -32600 to a message that is not JSON-RPC 2.0", async () => {
    expect(
      await protocol.handleMcpMessage({
        jsonrpc: "1.0",
        id: 4,
        method: "ping",
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(
      await protocol.handleMcpMessage({ jsonrpc: "2.0", id: 5 }),
    ).toMatchObject({ id: 5, error: { code: -32600 } });
    expect(await protocol.handleMcpMessage("ping")).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(await protocol.handleMcpMessage([request("ping")])).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch requests are not supported" },
    });
  });

  it("turns invalid arguments into a tool error", async () => {
    const response = await protocol.handleMcpMessage(
      request("tools/call", { name: "get_job", arguments: {} }),
    );

    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [{ type: "text", text: 'Missing required property "id"' }],
      },
    });
  });

  it("turns a handler throw into a tool error carrying the message only", async () => {
    const response = await protocol.handleMcpMessage(
      request("tools/call", {
        name: "get_job",
        arguments: { id: "no-such-job" },
      }),
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "Job not found" }],
        isError: true,
      },
    });
  });

  it("returns a successful call as text and structured content", async () => {
    const response = await protocol.handleMcpMessage(
      request("tools/call", { name: "search_jobs" }),
    );

    const expected = { total: 0, jobs: [] };
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(expected, null, 2) }],
        structuredContent: expected,
      },
    });
  });

  it("refuses a tool the authorizer refuses, without calling it", async () => {
    const tool = tools.getMcpTool("mark_applied");
    if (!tool) throw new Error("mark_applied is not registered");
    const handler = vi.spyOn(tool, "handler");
    const authorizeTool = vi.fn(() => "Write tools are switched off");

    const response = await protocol.handleMcpMessage(
      request("tools/call", { name: "mark_applied", arguments: { id: "x" } }),
      { authorizeTool },
    );

    expect(authorizeTool).toHaveBeenCalledWith(tool);
    expect(handler).not.toHaveBeenCalled();
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "Write tools are switched off" }],
        isError: true,
      },
    });
  });

  it("refuses before it validates the arguments", async () => {
    const response = await protocol.handleMcpMessage(
      request("tools/call", { name: "mark_applied", arguments: {} }),
      { authorizeTool: () => "Write tools are switched off" },
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "Write tools are switched off" }],
        isError: true,
      },
    });
  });
});
