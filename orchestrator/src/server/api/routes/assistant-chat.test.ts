// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("/api/chat", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}/api/chat${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  }

  it("lists chats by their last update, newest first", async () => {
    const first = await call("POST", "/threads");
    const second = await call("POST", "/threads");
    expect(first.status).toBe(200);
    expect(first.body.data.thread).toMatchObject({ title: null });

    const { touchThread } = await import("@server/repositories/assistant-chat");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await touchThread(first.body.data.thread.id);

    const listed = await call("GET", "/threads");
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.threads.map((thread: { id: string }) => thread.id),
    ).toEqual([first.body.data.thread.id, second.body.data.thread.id]);
  });

  it("answers 404 for the messages of an unknown chat", async () => {
    const { status, body } = await call("GET", "/threads/missing/messages");

    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("refuses an empty message", async () => {
    const created = await call("POST", "/threads");

    const { status, body } = await call(
      "POST",
      `/threads/${created.body.data.thread.id}/messages`,
      { content: "   " },
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});
