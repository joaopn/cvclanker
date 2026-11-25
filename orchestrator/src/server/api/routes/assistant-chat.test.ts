// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const callJsonMock = vi.hoisted(() => vi.fn());

vi.mock("@server/services/llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

vi.mock("@server/services/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@server/services/prompts")>()),
  loadPrompt: vi.fn().mockResolvedValue({
    name: "chat-assistant",
    description: "",
    system: "stub-system",
    user: "",
    modelHints: {},
  }),
}));

describe.sequential("/api/chat", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    callJsonMock.mockReset();
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

  it("lists the models the chat can use", async () => {
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("llmProvider", "openrouter");
    await setSetting("model", "acme/base");
    await setSetting("modelTailoring", "acme/tailor");

    const { status, body } = await call("GET", "/models");

    expect(status).toBe(200);
    expect(body.data).toEqual({
      providers: [
        {
          provider: "openrouter",
          models: [
            { model: "acme/base", tasks: ["default", "scoring"] },
            { model: "acme/tailor", tasks: ["tailoring"] },
          ],
        },
      ],
      current: { provider: "openrouter", model: "acme/tailor", effort: null },
      supportsEffort: ["claude_code"],
    });
  });

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

  async function lastAssistantStatus(threadId: string) {
    const { body } = await call("GET", `/threads/${threadId}/messages`);
    const messages = body.data.messages as { role: string; status: string }[];
    return messages.filter((message) => message.role === "assistant").at(-1)
      ?.status;
  }

  it("cancels the turn when the client drops the stream", async () => {
    callJsonMock.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          options.signal.addEventListener("abort", () =>
            resolve({ success: false, error: "aborted" }),
          );
        }),
    );
    const created = await call("POST", "/threads");
    const threadId = created.body.data.thread.id;
    const controller = new AbortController();

    const res = await fetch(
      `${baseUrl}/api/chat/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hi" }),
        signal: controller.signal,
      },
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(callJsonMock).toHaveBeenCalled());
    controller.abort();

    await vi.waitFor(async () =>
      expect(await lastAssistantStatus(threadId)).toBe("cancelled"),
    );
  });

  it("saves a turn that streams to its end as complete", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { message: "Hello.", toolCalls: [] },
    });
    const created = await call("POST", "/threads");
    const threadId = created.body.data.thread.id;

    const res = await fetch(
      `${baseUrl}/api/chat/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hi" }),
      },
    );
    expect(await res.text()).toContain('"type":"completed"');

    expect(await lastAssistantStatus(threadId)).toBe("complete");
  });
});
