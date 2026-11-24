// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const READ_ONLY_REFUSAL =
  "This token is read-only. Switch it to read and change in Settings → Agent access.";
const BRIEF_REFUSAL =
  "Sharing the personal brief is switched off in Settings → Agent access.";

const WEB_LOGIN_ENV = {
  BASIC_AUTH_USER: "jane",
  BASIC_AUTH_PASSWORD: "example-password",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
};

describe.sequential("POST /mcp", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    const { getActivePersonalBrief } = await import("@server/services/brief");
    vi.mocked(getActivePersonalBrief).mockResolvedValue("");
    await stopServer({ server, closeDb, tempDir });
  });

  function webHeaders(jwt?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    };
  }

  async function issueToken(jwt?: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/mcp-access`, {
      method: "POST",
      headers: webHeaders(jwt),
    });
    expect(res.status).toBe(200);
    return (await res.json()).data.token;
  }

  async function patchAccess(body: unknown, jwt?: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/mcp-access`, {
      method: "PATCH",
      headers: webHeaders(jwt),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  }

  async function postMcp(
    body: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${baseUrl}/mcp`, { method: "POST", headers, body });
  }

  function rpc(token: string | null, message: unknown): Promise<Response> {
    return postMcp(JSON.stringify(message), {
      "Content-Type": "application/json",
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
    });
  }

  async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const res = await rpc(token, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(res.status).toBe(200);
    return (await res.json()).result;
  }

  const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  async function seedReadyJob(id: string): Promise<void> {
    const { db, schema } = await import("@server/db/index");
    await db.insert(schema.jobs).values({
      id,
      source: "linkedin",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/${id}`,
      status: "ready",
    });
  }

  async function jobStatus(id: string): Promise<string | undefined> {
    const { getJobById } = await import("@server/repositories/jobs");
    return (await getJobById(id))?.status;
  }

  describe("without the web login", () => {
    beforeEach(async () => {
      ({ server, baseUrl, closeDb, tempDir } = await startServer());
    });

    it("does not exist while no token is stored", async () => {
      const res = await rpc("cvc_anything", toolsList);

      expect(res.status).toBe(404);
    });

    it("answers a method other than POST with 405", async () => {
      const token = await issueToken();

      const res = await fetch(`${baseUrl}/mcp`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });

    it("refuses a request without a bearer token", async () => {
      await issueToken();

      const res = await rpc(null, toolsList);

      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({ error: expect.any(String) });
    });

    it("refuses a wrong token", async () => {
      const token = await issueToken();

      const res = await rpc(`${token}x`, toolsList);

      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    });

    it("lists the tools for the right token", async () => {
      const token = await issueToken();

      const res = await rpc(token, toolsList);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(
        body.result.tools.map((tool: { name: string }) => tool.name),
      ).toContain("search_jobs");
    });

    it("answers a notification with 202 and no body", async () => {
      const token = await issueToken();

      const res = await rpc(token, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    });

    it("answers a malformed JSON body with a parse error", async () => {
      const token = await issueToken();

      const res = await postMcp('{"jsonrpc": "2.0",', {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    });

    it("hides a malformed JSON body behind the missing endpoint", async () => {
      const res = await postMcp('{"jsonrpc": "2.0",', {
        "Content-Type": "application/json",
        Authorization: "Bearer cvc_anything",
      });

      expect(res.status).toBe(404);
    });

    it("checks the token before reading a malformed JSON body", async () => {
      const token = await issueToken();
      const malformed = (headers: Record<string, string>) =>
        postMcp('{"jsonrpc": "2.0",', {
          "Content-Type": "application/json",
          ...headers,
        });

      expect((await malformed({})).status).toBe(401);
      expect(
        (await malformed({ Authorization: `Bearer ${token}x` })).status,
      ).toBe(401);
    });

    it("checks the token before the content type", async () => {
      await issueToken();

      const res = await postMcp(JSON.stringify(toolsList), {
        "Content-Type": "text/plain",
      });

      expect(res.status).toBe(401);
    });

    it("answers a body it cannot decode with an invalid request", async () => {
      const token = await issueToken();

      const res = await postMcp(JSON.stringify(toolsList), {
        "Content-Type": "application/json; charset=latin-9",
        Authorization: `Bearer ${token}`,
      });

      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    });

    it("accepts the bearer scheme in any case", async () => {
      const token = await issueToken();

      for (const scheme of ["bearer", "BEARER"]) {
        const res = await postMcp(JSON.stringify(toolsList), {
          "Content-Type": "application/json",
          Authorization: `${scheme} ${token}`,
        });
        expect(res.status).toBe(200);
      }
    });

    it("answers a body that is not JSON with a parse error", async () => {
      const token = await issueToken();

      const res = await postMcp(JSON.stringify(toolsList), {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${token}`,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(-32700);
    });

    it("keeps a read-only token from marking a job applied until switched", async () => {
      await seedReadyJob("mcp-ready-1");
      const token = await issueToken();

      const refused = await callTool(token, "mark_applied", {
        id: "mcp-ready-1",
      });

      expect(refused).toEqual({
        content: [{ type: "text", text: READ_ONLY_REFUSAL }],
        isError: true,
      });
      expect(await jobStatus("mcp-ready-1")).toBe("ready");

      await patchAccess({ accessLevel: "read_write" });
      const allowed = await callTool(token, "mark_applied", {
        id: "mcp-ready-1",
      });

      expect(allowed.isError).toBeUndefined();
      expect(allowed.structuredContent.status).toBe("applied");
      expect(await jobStatus("mcp-ready-1")).toBe("applied");
    });

    it("shares the personal brief only while its switch is on", async () => {
      const { getActivePersonalBrief } = await import("@server/services/brief");
      vi.mocked(getActivePersonalBrief).mockResolvedValue(
        "Jane Q. Doe builds data pipelines at Example Corp.",
      );
      const token = await issueToken();

      const refused = await callTool(token, "get_personal_brief");

      expect(refused).toEqual({
        content: [{ type: "text", text: BRIEF_REFUSAL }],
        isError: true,
      });

      await patchAccess({ shareBrief: true });
      const shared = await callTool(token, "get_personal_brief");

      expect(shared.isError).toBeUndefined();
      expect(shared.structuredContent).toEqual({
        brief: "Jane Q. Doe builds data pipelines at Example Corp.",
      });
    });

    it("stops existing once the token is revoked", async () => {
      const token = await issueToken();
      expect((await rpc(token, toolsList)).status).toBe(200);

      const revoked = await fetch(`${baseUrl}/api/mcp-access`, {
        method: "DELETE",
      });
      expect(revoked.status).toBe(200);

      expect((await rpc(token, toolsList)).status).toBe(404);
    });

    it("starts a regenerated token read-only with the brief withheld", async () => {
      await seedReadyJob("mcp-ready-2");
      const first = await issueToken();
      await patchAccess({ accessLevel: "read_write", shareBrief: true });

      const second = await issueToken();

      expect(second).not.toBe(first);
      expect((await rpc(first, toolsList)).status).toBe(401);
      const markApplied = await callTool(second, "mark_applied", {
        id: "mcp-ready-2",
      });
      expect(markApplied.content[0].text).toBe(READ_ONLY_REFUSAL);
      expect(await jobStatus("mcp-ready-2")).toBe("ready");
      const brief = await callTool(second, "get_personal_brief");
      expect(brief.content[0].text).toBe(BRIEF_REFUSAL);
    });
  });

  describe("with the web login on", () => {
    beforeEach(async () => {
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        env: WEB_LOGIN_ENV,
      }));
    });

    async function logIn(): Promise<string> {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: WEB_LOGIN_ENV.BASIC_AUTH_USER,
          password: WEB_LOGIN_ENV.BASIC_AUTH_PASSWORD,
        }),
      });
      expect(res.status).toBe(200);
      return (await res.json()).data.token;
    }

    it("lets the agent token through without a web session", async () => {
      const token = await issueToken(await logIn());

      const res = await rpc(token, toolsList);

      expect(res.status).toBe(200);
      expect((await res.json()).result.tools.length).toBeGreaterThan(0);
    });

    it("does not accept the web login's token", async () => {
      const jwt = await logIn();
      await issueToken(jwt);

      const res = await rpc(jwt, toolsList);

      expect(res.status).toBe(401);
    });
  });
});
