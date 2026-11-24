// @vitest-environment node
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("/api/mcp-access", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function start(env?: Record<string, string>): Promise<void> {
    ({ server, baseUrl, closeDb, tempDir } = await startServer({ env }));
  }

  async function call(
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; text: string; body: any }> {
    const res = await fetch(`${baseUrl}/api/mcp-access`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: JSON.parse(text),
    };
  }

  async function mcpRows(): Promise<Record<string, string>> {
    const { db, schema } = await import("@server/db/index");
    const rows = await db.select().from(schema.runtimeSecrets);
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  it("reports no token before one is generated", async () => {
    await start();

    const { status, body } = await call("GET");

    expect(status).toBe(200);
    expect(body.data).toEqual({
      enabled: false,
      accessLevel: "read",
      shareBrief: false,
      createdAt: null,
      webLoginEnabled: false,
    });
  });

  it("returns the token once and stores only its digest", async () => {
    await start();

    const created = await call("POST");

    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const token: string = created.body.data.token;
    expect(token).toMatch(/^cvc_[A-Za-z0-9_-]{43}$/);
    expect(created.body.data).toMatchObject({
      enabled: true,
      accessLevel: "read",
      shareBrief: false,
      createdAt: expect.any(String),
      webLoginEnabled: false,
    });

    const digest = createHash("sha256").update(token).digest("hex");
    const rows = await mcpRows();
    expect(rows.mcp_token_sha256).toBe(digest);
    expect(Object.values(rows)).not.toContain(token);

    const read = await call("GET");
    expect(read.body.data.enabled).toBe(true);
    expect(read.text).not.toContain(token);
    expect(read.text).not.toContain(digest);
    expect(read.body.data).not.toHaveProperty("token");
  });

  it("switches the access level and the brief", async () => {
    await start();
    await call("POST");

    const updated = await call("PATCH", {
      accessLevel: "read_write",
      shareBrief: true,
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      enabled: true,
      accessLevel: "read_write",
      shareBrief: true,
    });
    expect((await call("GET")).body.data).toMatchObject({
      accessLevel: "read_write",
      shareBrief: true,
    });
  });

  it.each([
    ["an unknown key", { accessLevel: "read", scope: "all" }],
    ["an unknown access level", { accessLevel: "admin" }],
    ["a brief switch that is not a boolean", { shareBrief: "true" }],
    ["an empty body", {}],
  ])("rejects %s with 400 and writes nothing", async (_label, body) => {
    await start();
    await call("POST");
    await call("PATCH", { accessLevel: "read_write" });

    const { status, body: response } = await call("PATCH", body);

    expect(status).toBe(400);
    expect(response.error.code).toBe("INVALID_REQUEST");
    expect((await call("GET")).body.data).toMatchObject({
      accessLevel: "read_write",
      shareBrief: false,
    });
  });

  it("answers a switch with 404 while no token exists", async () => {
    await start();

    const { status } = await call("PATCH", { shareBrief: true });

    expect(status).toBe(404);
    expect(await mcpRows()).toEqual({});
  });

  it("revokes the token and keeps the web login's signing secret", async () => {
    await start();
    const { insertRuntimeSecretIfAbsent } = await import(
      "@server/repositories/runtime-secrets"
    );
    await insertRuntimeSecretIfAbsent(
      "jwt_secret",
      "an-example-signing-secret-of-enough-length",
    );
    await call("POST");
    await call("PATCH", { accessLevel: "read_write", shareBrief: true });

    const revoked = await call("DELETE");

    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toEqual({
      enabled: false,
      accessLevel: "read",
      shareBrief: false,
      createdAt: null,
      webLoginEnabled: false,
    });
    expect(await mcpRows()).toEqual({
      jwt_secret: "an-example-signing-secret-of-enough-length",
    });
  });

  it("reports the web login as on when both credentials are set", async () => {
    await start({
      BASIC_AUTH_USER: "jane",
      BASIC_AUTH_PASSWORD: "example-password",
      JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
    });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "jane", password: "example-password" }),
    });
    const jwt = (await login.json()).data.token;

    expect((await call("GET")).status).toBe(401);
    const { body } = await call("GET", undefined, {
      Authorization: `Bearer ${jwt}`,
    });
    expect(body.data.webLoginEnabled).toBe(true);
  });

  it("reports the web login as off when only the user is set", async () => {
    await start({ BASIC_AUTH_USER: "jane" });

    const { body } = await call("GET");

    expect(body.data.webLoginEnabled).toBe(false);
  });
});
