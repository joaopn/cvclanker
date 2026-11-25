import { conflict, notFound, toAppError, upstreamError } from "@infra/errors";
import { logger } from "@infra/logger";
import { getRequestId } from "@infra/request-context";
import { handleMcpMessage } from "@server/mcp/protocol";
import {
  compileInputDeclaration,
  getMcpTool,
  listMcpTools,
  type McpTool,
} from "@server/mcp/tools";
import type {
  ChatMessage,
  ChatMessageKind,
  ChatStreamEvent,
  ChatThread,
} from "@shared/types";
import * as chatRepo from "../repositories/assistant-chat";
import * as jobsRepo from "../repositories/jobs";
import { resolveChatModels } from "./assistant-chat-models";
import { resolveProviderCall } from "./llm/provider-credentials";
import { LlmService } from "./llm/service";
import type { JsonSchemaDefinition } from "./llm/types";
import { resolveLlmRuntimeSettings } from "./modelSelection";
import { loadPrompt } from "./prompts";
import { getEffectiveSettings } from "./settings";

// One search plus a handful of job reads fits in this many steps. Each step is
// a paid LLM call, so an unbounded lookup loop is a cost risk.
export const CHAT_MAX_LOOKUP_STEPS = 8;

// Opening a job puts its whole text in the conversation, and every later step
// sends it again. A description averaged about 1,500 tokens on a measured
// database, so ten jobs is about 15,000 tokens.
export const CHAT_OPEN_JOBS_WITHOUT_ASKING = 10;

const ASK_TO_CONTINUE = "ask_to_continue";

const askToContinueInput = compileInputDeclaration({
  message: {
    type: "string",
    required: true,
    minLength: 1,
    description:
      "The sentence shown to the user: how many jobs you would open and why.",
  },
});

const askToContinueTool = {
  name: ASK_TO_CONTINUE,
  description:
    'Stop and ask the user whether to go on, before opening more jobs than you may open without asking. Your turn ends here: no other call in the same reply runs, and the user sees message. When they reply "Continue.", go ahead.',
  inputSchema: askToContinueInput.jsonSchema,
};

const MAX_VALIDATION_ATTEMPTS = 2;

const runningTurns = new Map<string, AbortController>();

type ConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ToolCall = { name: string; argumentsJson: string };

type ReplyValidation =
  | {
      ok: true;
      message: string;
      toolCalls: ToolCall[];
      confirmation: string | null;
    }
  | { ok: false; error: string };

function responseSchema(toolNames: string[]): JsonSchemaDefinition {
  return {
    name: "chat_assistant_response",
    schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Your answer to the user in Markdown. Must not be empty when toolCalls is empty.",
        },
        toolCalls: {
          type: "array",
          description:
            "Tools to call now. Use an empty array when you are answering.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                enum: toolNames,
                description: "The tool to call.",
              },
              argumentsJson: {
                type: "string",
                description:
                  "The tool's arguments as a JSON-encoded object, following its input schema.",
              },
            },
            required: ["name", "argumentsJson"],
            additionalProperties: false,
          },
        },
      },
      required: ["message", "toolCalls"],
      additionalProperties: false,
    },
  };
}

function validateReply(raw: unknown): ReplyValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "response was not a JSON object" };
  }
  const { message, toolCalls } = raw as {
    message?: unknown;
    toolCalls?: unknown;
  };
  if (typeof message !== "string") {
    return { ok: false, error: "'message' must be a string" };
  }
  if (!Array.isArray(toolCalls)) {
    return {
      ok: false,
      error: "'toolCalls' must be an array (use [] for none)",
    };
  }
  const calls: ToolCall[] = [];
  for (const [index, call] of toolCalls.entries()) {
    const { name, argumentsJson } = (call ?? {}) as {
      name?: unknown;
      argumentsJson?: unknown;
    };
    if (typeof name !== "string" || typeof argumentsJson !== "string") {
      return {
        ok: false,
        error: `toolCalls[${index}] needs a string 'name' and a string 'argumentsJson'`,
      };
    }
    calls.push({ name, argumentsJson });
  }
  const ask = calls.find((call) => call.name === ASK_TO_CONTINUE);
  if (ask) {
    let args: unknown;
    try {
      args = JSON.parse(ask.argumentsJson);
    } catch {}
    const checked = askToContinueInput.validate(args);
    const confirmation = checked.ok ? String(checked.value.message).trim() : "";
    if (!confirmation) {
      const detail = checked.ok ? "" : ` (${checked.error})`;
      return {
        ok: false,
        error: `${ASK_TO_CONTINUE} needs an argumentsJson object with a non-empty "message" string${detail}`,
      };
    }
    return {
      ok: true,
      message: message.trim(),
      toolCalls: calls,
      confirmation,
    };
  }
  let nested: unknown;
  try {
    nested = JSON.parse(message.trim());
  } catch {}
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    Array.isArray((nested as { toolCalls?: unknown }).toolCalls)
  ) {
    return {
      ok: false,
      error:
        'you put your reply JSON inside the "message" field. Tool calls go in the top-level "toolCalls" array, and "message" holds only the plain-text answer',
    };
  }
  if (calls.length === 0 && !message.trim()) {
    return {
      ok: false,
      error: "'message' must not be empty when 'toolCalls' is empty",
    };
  }
  return {
    ok: true,
    message: message.trim(),
    toolCalls: calls,
    confirmation: null,
  };
}

function toolListMessage(tools: readonly McpTool[]): string {
  const listed = [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input.jsonSchema,
    })),
    askToContinueTool,
  ];
  return `Tools you can call:\n${JSON.stringify(listed, null, 2)}`;
}

export async function createChatThread(): Promise<ChatThread> {
  return chatRepo.createThread();
}

export async function listChatThreads(): Promise<ChatThread[]> {
  return chatRepo.listThreads();
}

export async function listChatMessages(
  threadId: string,
): Promise<ChatMessage[]> {
  const thread = await chatRepo.getThread(threadId);
  if (!thread) throw notFound("Chat not found");
  return chatRepo.listMessages(threadId);
}

export function cancelChatTurn(threadId: string): { cancelled: boolean } {
  const controller = runningTurns.get(threadId);
  if (!controller) return { cancelled: false };
  controller.abort();
  return { cancelled: true };
}

export async function sendChatMessage(input: {
  threadId: string;
  content: string;
  stream: (event: ChatStreamEvent) => void;
}): Promise<ChatMessage> {
  const thread = await chatRepo.getThread(input.threadId);
  if (!thread) throw notFound("Chat not found");
  if (runningTurns.has(thread.id)) {
    throw conflict("An answer is already running in this chat");
  }
  const controller = new AbortController();
  runningTurns.set(thread.id, controller);
  try {
    return await runTurn(
      thread,
      input.content.trim(),
      controller,
      input.stream,
    );
  } finally {
    runningTurns.delete(thread.id);
  }
}

async function runTurn(
  thread: ChatThread,
  content: string,
  controller: AbortController,
  stream: (event: ChatStreamEvent) => void,
): Promise<ChatMessage> {
  const requestId = getRequestId() ?? "unknown";
  const history: ConversationMessage[] = (
    await chatRepo.listMessages(thread.id)
  )
    .filter((message) => message.status === "complete")
    .map((message) => ({ role: message.role, content: message.content }));

  await chatRepo.addMessage({
    threadId: thread.id,
    role: "user",
    content,
    status: "complete",
  });
  const title = thread.title ?? content.split("\n")[0].trim();
  if (thread.title === null) {
    await chatRepo.setThreadTitle(thread.id, title);
  }
  await chatRepo.touchThread(thread.id);
  stream({ type: "ready", threadId: thread.id, requestId });

  let answer: { content: string; kind: ChatMessageKind } = {
    content: "",
    kind: "answer",
  };
  let failure: { code: string; message: string } | null = null;
  try {
    answer = await answerQuestion({
      title,
      history,
      content,
      requestId,
      signal: controller.signal,
      onToolEvent: stream,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      const appError = toAppError(error);
      failure = { code: appError.code, message: appError.message };
    }
  }

  const cancelled = controller.signal.aborted;
  const message = await chatRepo.addMessage({
    threadId: thread.id,
    role: "assistant",
    content: cancelled ? "" : (failure?.message ?? answer.content),
    status: cancelled ? "cancelled" : failure ? "failed" : "complete",
    kind: cancelled || failure ? "answer" : answer.kind,
  });
  await chatRepo.touchThread(thread.id);
  logger.info("Chat turn finished", {
    threadId: thread.id,
    requestId,
    status: message.status,
  });

  if (cancelled) {
    stream({ type: "cancelled", message });
  } else if (failure) {
    stream({ type: "error", ...failure, requestId });
  } else {
    stream({ type: "completed", message });
  }
  return message;
}

async function answerQuestion(input: {
  title: string;
  history: ConversationMessage[];
  content: string;
  requestId: string;
  signal: AbortSignal;
  onToolEvent: (event: ChatStreamEvent) => void;
}): Promise<{ content: string; kind: ChatMessageKind }> {
  const canChangeJobs = (await getEffectiveSettings()).chatCanChangeJobs.value;
  const tools = listMcpTools().filter(
    (tool) => tool.access === "read" || canChangeJobs,
  );
  const authorizeTool = (tool: McpTool): string | null =>
    tool.access === "write" && !canChangeJobs
      ? 'Changing jobs is switched off with the "Can change jobs" switch, the first entry in the menu under the arrow beside the Chat button.'
      : null;

  const [choice, prompt] = await Promise.all([
    resolveChatModels(),
    loadPrompt("chat-assistant", {
      changeJobs: canChangeJobs ? "on" : "off",
      maxJobsWithoutAsking: CHAT_OPEN_JOBS_WITHOUT_ASKING,
    }),
  ]);
  let llm: LlmService;
  let model: string;
  const effort = choice.response.current.effort;
  if (choice.stored) {
    const { current } = choice.response;
    llm = new LlmService((await resolveProviderCall(current.provider)).options);
    model = current.model;
  } else {
    const llmConfig = await resolveLlmRuntimeSettings("tailoring");
    llm = new LlmService({
      provider: llmConfig.provider,
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
    });
    model = llmConfig.model;
  }
  const jsonSchema = responseSchema([
    ...tools.map((tool) => tool.name),
    ASK_TO_CONTINUE,
  ]);

  const conversation: ConversationMessage[] = [
    { role: "system", content: prompt.system },
    { role: "system", content: toolListMessage(tools) },
    ...input.history,
    { role: "user", content: input.content },
  ];

  let steps = 0;
  let invalidAttempts = 0;
  let rpcId = 0;
  for (;;) {
    input.signal.throwIfAborted();
    if (steps >= CHAT_MAX_LOOKUP_STEPS) {
      throw upstreamError(
        `This question needed more lookups than the chat allows (${CHAT_MAX_LOOKUP_STEPS} steps).`,
      );
    }
    steps += 1;

    const result = await llm.callJson<unknown>({
      model,
      messages: conversation,
      jsonSchema,
      maxRetries: 1,
      retryDelayMs: 300,
      signal: input.signal,
      label: "chat",
      subject: input.title,
      ...(effort ? { effort } : {}),
    });
    input.signal.throwIfAborted();
    if (!result.success) {
      throw upstreamError(`LLM generation failed: ${result.error}`);
    }

    const reply = validateReply(result.data);
    if (!reply.ok) {
      invalidAttempts += 1;
      if (invalidAttempts >= MAX_VALIDATION_ATTEMPTS) {
        throw upstreamError(
          `Chat reply failed schema validation after ${MAX_VALIDATION_ATTEMPTS} attempts: ${reply.error}`,
        );
      }
      conversation.push(
        { role: "assistant", content: JSON.stringify(result.data) },
        {
          role: "user",
          content:
            `Your previous reply was invalid: ${reply.error}. ` +
            'Reply with ONLY a JSON object with a "message" string and a ' +
            '"toolCalls" array (use [] when answering). Do not include any ' +
            "text outside the JSON.",
        },
      );
      continue;
    }
    invalidAttempts = 0;

    if (reply.confirmation !== null) {
      return { content: reply.confirmation, kind: "confirm" };
    }
    if (reply.toolCalls.length === 0) {
      return { content: reply.message, kind: "answer" };
    }

    const results: string[] = [];
    for (const [index, call] of reply.toolCalls.entries()) {
      input.signal.throwIfAborted();
      const write = getMcpTool(call.name)?.access === "write";
      let args: unknown = call.argumentsJson;
      let parsed = false;
      let ok = false;
      let text: string;
      try {
        args = JSON.parse(call.argumentsJson);
        parsed = true;
      } catch {}
      if (!parsed) {
        text = "argumentsJson was not valid JSON";
      } else {
        rpcId += 1;
        const response = await handleMcpMessage(
          {
            jsonrpc: "2.0",
            id: rpcId,
            method: "tools/call",
            params: { name: call.name, arguments: args },
          },
          { requestId: input.requestId, authorizeTool },
        );
        if (!response) {
          text = "The tool returned no response";
        } else if ("error" in response) {
          text = response.error.message;
        } else {
          const toolResult = response.result as {
            content?: Array<{ text?: unknown }>;
            isError?: unknown;
          };
          const first = toolResult.content?.[0]?.text;
          text = typeof first === "string" ? first : "";
          ok = toolResult.isError !== true;
        }
      }
      const jobId =
        parsed && args && typeof args === "object"
          ? (args as { id?: unknown }).id
          : undefined;
      let job: { title: string; employer: string } | null | undefined;
      if (typeof jobId === "string") {
        try {
          const found = await jobsRepo.getJobById(jobId);
          job = found ? { title: found.title, employer: found.employer } : null;
        } catch {
          job = null;
        }
      }
      input.onToolEvent({
        type: "tool",
        name: call.name,
        arguments: args,
        write,
        ok,
        ...(job !== undefined && { job }),
      });
      results.push(
        `${index + 1}. ${call.name} ${call.argumentsJson}\n${ok ? "Result" : "Error"}: ${text}`,
      );
    }

    conversation.push(
      { role: "assistant", content: JSON.stringify(result.data) },
      {
        role: "user",
        content: `Results of your tool calls, in order:\n\n${results.join("\n\n")}`,
      },
    );
  }
}
