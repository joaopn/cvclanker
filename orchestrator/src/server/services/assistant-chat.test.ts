// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatStreamEvent } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.hoisted(() => vi.fn());
const loadPromptMock = vi.hoisted(() => vi.fn());

vi.mock("./llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));

vi.mock("./prompts", () => ({
  loadPrompt: loadPromptMock,
}));

type Message = { role: string; content: string };
type CallOptions = {
  messages: Message[];
  jsonSchema: {
    schema: {
      properties: {
        toolCalls: { items: { properties: { name: { enum: string[] } } } };
      };
    };
  };
  signal?: AbortSignal;
};

const WRITE_TOOLS = ["mark_applied", "add_job_note"];

function reply(message: string, toolCalls: unknown[] = []) {
  return { success: true as const, data: { message, toolCalls } };
}

function toolCall(name: string, args: unknown) {
  return { name, argumentsJson: JSON.stringify(args) };
}

describe.sequential("assistant chat turn", () => {
  let tempDir: string;
  let chat: Awaited<typeof import("./assistant-chat")>;
  let jobsRepo: Awaited<typeof import("../repositories/jobs")>;
  let settingsRepo: Awaited<typeof import("../repositories/settings")>;
  let dbModule: Awaited<typeof import("../db/index")>;
  let seen: CallOptions[];

  function script(...replies: unknown[]) {
    let index = 0;
    callJsonMock.mockImplementation(async (options: CallOptions) => {
      seen.push(structuredClone({ ...options, signal: undefined }));
      const next = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return next;
    });
  }

  function enumOf(call: CallOptions): string[] {
    return call.jsonSchema.schema.properties.toolCalls.items.properties.name
      .enum;
  }

  async function send(threadId: string, content: string) {
    const events: ChatStreamEvent[] = [];
    const message = await chat.sendChatMessage({
      threadId,
      content,
      stream: (event) => events.push(event),
    });
    return { message, events };
  }

  async function seedReadyJob(title = "Data Engineer") {
    const job = await jobsRepo.createJob({
      source: "manual",
      title,
      employer: "Acme",
      jobUrl: `https://example.com/jobs/${title.replaceAll(" ", "-")}`,
    });
    await jobsRepo.updateJob(job.id, { status: "ready" });
    return job.id;
  }

  beforeEach(async () => {
    vi.resetModules();
    callJsonMock.mockReset();
    loadPromptMock.mockReset();
    loadPromptMock.mockResolvedValue({
      name: "chat-assistant",
      description: "",
      system: "stub-system",
      user: "",
      modelHints: {},
    });
    seen = [];
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-assistant-chat-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    dbModule = await import("../db/index");
    jobsRepo = await import("../repositories/jobs");
    settingsRepo = await import("../repositories/settings");
    chat = await import("./assistant-chat");
  });

  afterEach(async () => {
    dbModule.closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("feeds a search result to the next step and saves the tool-less reply as the answer", async () => {
    const jobId = await seedReadyJob();
    const thread = await chat.createChatThread();
    script(
      reply("", [toolCall("search_jobs", { query: "Acme" })]),
      reply("You have one job at Acme."),
    );

    const { message, events } = await send(thread.id, "Which jobs at Acme?");

    expect(seen).toHaveLength(2);
    const last = seen[1].messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("search_jobs");
    expect(last?.content).toContain(jobId);
    expect(events).toContainEqual({
      type: "tool",
      name: "search_jobs",
      arguments: { query: "Acme" },
      write: false,
      ok: true,
    });
    expect(message).toMatchObject({
      role: "assistant",
      status: "complete",
      content: "You have one job at Acme.",
    });
    expect(events.at(-1)).toEqual({ type: "completed", message });
    const saved = await chat.listChatMessages(thread.id);
    expect(saved.map((m) => [m.role, m.status, m.content])).toEqual([
      ["user", "complete", "Which jobs at Acme?"],
      ["assistant", "complete", "You have one job at Acme."],
    ]);
  });

  it("with the switch off, offers no write tool and refuses a forced one", async () => {
    await settingsRepo.setSetting("chatCanChangeJobs", "0");
    const jobId = await seedReadyJob();
    const thread = await chat.createChatThread();
    script(
      reply("", [toolCall("mark_applied", { id: jobId })]),
      reply("Changes are switched off."),
    );

    const { events } = await send(thread.id, "Mark it applied");

    for (const name of WRITE_TOOLS) expect(enumOf(seen[0])).not.toContain(name);
    expect(events).toContainEqual({
      type: "tool",
      name: "mark_applied",
      arguments: { id: jobId },
      write: true,
      ok: false,
    });
    expect(seen[1].messages.at(-1)?.content).toContain("switched off");
    expect((await jobsRepo.getJobById(jobId))?.status).toBe("ready");
  });

  it("with the switch on, marks a Ready job applied and adds a note", async () => {
    await settingsRepo.setSetting("chatCanChangeJobs", "1");
    const jobId = await seedReadyJob();
    const thread = await chat.createChatThread();
    script(
      reply("", [
        toolCall("mark_applied", { id: jobId }),
        toolCall("add_job_note", {
          id: jobId,
          title: "Call",
          content: "Recruiter called",
        }),
      ]),
      reply("Done."),
    );

    const { events } = await send(thread.id, "Mark it applied and note it");

    for (const name of WRITE_TOOLS) expect(enumOf(seen[0])).toContain(name);
    expect(
      events.filter((event) => event.type === "tool").map((e) => e.ok),
    ).toEqual([true, true]);
    expect((await jobsRepo.getJobById(jobId))?.status).toBe("applied");
    const notes = await jobsRepo.listJobNotes(jobId);
    expect(notes.map((note) => [note.title, note.content])).toEqual([
      ["Call", "Recruiter called"],
    ]);
  });

  it("is read-only when the switch was never saved", async () => {
    const thread = await chat.createChatThread();
    script(reply("Hello."));

    await send(thread.id, "Hi");

    expect(enumOf(seen[0])).toEqual([
      "search_jobs",
      "get_job",
      "get_job_documents",
      "get_tailored_cv",
      "get_personal_brief",
    ]);
    expect(loadPromptMock).toHaveBeenCalledWith("chat-assistant", {
      changeJobs: "off",
    });
  });

  it("tells the model about an unknown tool instead of failing the turn", async () => {
    const thread = await chat.createChatThread();
    script(
      reply("", [toolCall("delete_job", { id: "x" })]),
      reply("I cannot delete jobs."),
    );

    const { message, events } = await send(thread.id, "Delete it");

    expect(seen[1].messages.at(-1)?.content).toContain(
      "Unknown tool: delete_job",
    );
    expect(events).toContainEqual({
      type: "tool",
      name: "delete_job",
      arguments: { id: "x" },
      write: false,
      ok: false,
    });
    expect(message).toMatchObject({
      status: "complete",
      content: "I cannot delete jobs.",
    });
  });

  it("fails the turn when the lookup steps run out", async () => {
    const thread = await chat.createChatThread();
    const lookup = reply("", [toolCall("search_jobs", { query: "Acme" })]);
    script(...Array(20).fill(lookup), reply("Unbounded answer."));

    const { message, events } = await send(thread.id, "Count everything");

    expect(seen).toHaveLength(chat.CHAT_MAX_LOOKUP_STEPS);
    expect(message.status).toBe("failed");
    expect(message.content).toContain(
      "needed more lookups than the chat allows",
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: message.content,
    });
  });

  it("retries an invalid reply once with the error, then fails", async () => {
    const thread = await chat.createChatThread();
    script(reply(""), reply(""), reply("Too late."));

    const { message } = await send(thread.id, "Hi");

    expect(seen).toHaveLength(2);
    expect(seen[1].messages.at(-1)?.content).toContain(
      "Your previous reply was invalid",
    );
    expect(message.status).toBe("failed");
    expect(message.content).toContain("schema validation after 2 attempts");
  });

  it("saves a cancelled answer when the turn is cancelled mid-call", async () => {
    const thread = await chat.createChatThread();
    callJsonMock.mockImplementation(
      (options: CallOptions) =>
        new Promise((resolve) => {
          options.signal?.addEventListener("abort", () =>
            resolve({ success: false, error: "aborted", code: "unknown" }),
          );
        }),
    );

    const pending = send(thread.id, "Hi");
    await vi.waitFor(() => expect(callJsonMock).toHaveBeenCalled());
    expect(chat.cancelChatTurn(thread.id)).toEqual({ cancelled: true });
    const { message, events } = await pending;

    expect(message).toMatchObject({ status: "cancelled", content: "" });
    expect(events.at(-1)).toEqual({ type: "cancelled", message });
    expect(chat.cancelChatTurn(thread.id)).toEqual({ cancelled: false });
  });

  it("refuses a second message while an answer is running", async () => {
    const thread = await chat.createChatThread();
    let release: (value: unknown) => void = () => {};
    callJsonMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    callJsonMock.mockResolvedValue(reply("Second answer."));

    const first = send(thread.id, "First");
    await vi.waitFor(() => expect(callJsonMock).toHaveBeenCalled());

    await expect(send(thread.id, "Second")).rejects.toMatchObject({
      status: 409,
    });

    release(reply("First answer."));
    expect((await first).message.content).toBe("First answer.");
  });

  it("names the chat after the first line of its first message only", async () => {
    const thread = await chat.createChatThread();
    script(reply("Answer."));

    await send(thread.id, "  Which jobs at Acme?  \nWith details");
    await send(thread.id, "And at Globex?");

    const [listed] = await chat.listChatThreads();
    expect(listed.title).toBe("Which jobs at Acme?");
  });
});
