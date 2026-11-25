import * as api from "@client/api";
import { ApiClientError } from "@client/api";
import { useResizablePanel } from "@client/hooks/useResizableListPanel";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type { ChatMessage, ChatStreamEvent } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Composer } from "../ghostwriter/Composer";
import { TailorColumnSplitter } from "../ghostwriter/TailorColumnSplitter";
import { useChat } from "./ChatContext";
import { ChatModelMenus } from "./ChatModelMenus";

export const CHAT_PANEL_WIDTH_KEY = "cvclanker:chat:width";
const JOBS_CHANGED_EVENT = "cvclanker:jobs-changed";
const CHAT_PANEL_MIN_WIDTH = 320;
const CHAT_PANEL_DEFAULT_WIDTH = 420;
const CHAT_PANEL_MAX_WIDTH_SHARE = 0.7;

const TOOL_STATUS: Record<string, string> = {
  search_jobs: "Searching jobs…",
  get_job: "Reading a job…",
  get_job_documents: "Reading job documents…",
  get_tailored_cv: "Reading the tailored CV…",
  get_personal_brief: "Reading your personal brief…",
  mark_applied: "Marking a job applied…",
  add_job_note: "Adding a note…",
};

const JOB_TOOL_STATUS: Record<string, [string, string]> = {
  get_job: ["Reading job", "…"],
  get_job_documents: ["Reading documents", "…"],
  get_tailored_cv: ["Reading tailored CV", "…"],
  mark_applied: ["Marking applied", ""],
  add_job_note: ["Adding a note", ""],
};

function toolStatus(event: Extract<ChatStreamEvent, { type: "tool" }>) {
  if (event.name === "search_jobs") {
    const query = (event.arguments as { query?: unknown } | null)?.query;
    return typeof query === "string" && query.trim()
      ? `Searching jobs: ${query.trim()}…`
      : "Searching jobs…";
  }
  const withJob = JOB_TOOL_STATUS[event.name];
  if (withJob && event.job) {
    return `${withJob[0]}: ${event.job.title} @ ${event.job.employer}${withJob[1]}`;
  }
  return TOOL_STATUS[event.name] ?? `Running ${event.name}…`;
}

interface LiveLine {
  label: string;
  ok: boolean;
}

let localMessageCount = 0;

function localMessage(
  threadId: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"],
): ChatMessage {
  return {
    id: `local-${++localMessageCount}`,
    threadId,
    role,
    content,
    status,
    kind: "answer",
    createdAt: new Date().toISOString(),
  };
}

const MARKDOWN_CLASS =
  "text-sm leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted/40 [&_pre]:p-3 [&_table]:my-2 [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_th]:border [&_th]:border-border/60 [&_th]:px-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5";

interface ConfirmActions {
  enabled: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

const ChatMessageView: React.FC<{
  message: ChatMessage;
  confirm: ConfirmActions;
}> = ({ message, confirm }) => {
  if (message.role === "user") {
    return (
      <div className="ml-8 self-end whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-sm">
        {message.content}
      </div>
    );
  }
  if (message.status === "failed") {
    return (
      <div className="whitespace-pre-wrap text-sm text-destructive">
        {message.content || "The answer failed."}
      </div>
    );
  }
  if (message.status === "cancelled") {
    return (
      <div className="text-sm italic text-muted-foreground">
        Stopped before answering.
      </div>
    );
  }
  const markdown = (
    <div className={MARKDOWN_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {message.content}
      </ReactMarkdown>
    </div>
  );
  if (message.kind !== "confirm") return markdown;
  return (
    <div className="flex flex-col gap-2">
      {markdown}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!confirm.enabled}
          onClick={confirm.onContinue}
        >
          Continue
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!confirm.enabled}
          onClick={confirm.onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
};

export const ChatPanel: React.FC = () => {
  const { isOpen, threadId, setThreadId, setAnswering } = useChat();
  const queryClient = useQueryClient();
  const { width, maxWidth, isDragging, startDrag } = useResizablePanel({
    storageKey: CHAT_PANEL_WIDTH_KEY,
    defaultWidth: CHAT_PANEL_DEFAULT_WIDTH,
    minWidth: CHAT_PANEL_MIN_WIDTH,
    maxWidth: Number.POSITIVE_INFINITY,
    maxWidthShare: CHAT_PANEL_MAX_WIDTH_SHARE,
    invertDelta: true,
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [runThreadId, setRunThreadId] = useState<string | null>(null);
  const [liveLines, setLiveLines] = useState<LiveLine[]>([]);
  const [cancelledConfirmId, setCancelledConfirmId] = useState<string | null>(
    null,
  );
  const viewedThreadRef = useRef(threadId);
  const skipLoadRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRunning = runThreadId !== null;

  useEffect(() => {
    if (!isRunning) return;
    setAnswering(true);
    return () => setAnswering(false);
  }, [isRunning, setAnswering]);

  useEffect(() => {
    viewedThreadRef.current = threadId;
  }, [threadId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!isOpen) return;
    const root = document.documentElement;
    root.style.setProperty("--chat-panel-width", `${width}px`);
    return () => {
      root.style.removeProperty("--chat-panel-width");
    };
  }, [isOpen, width]);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setIsLoadingMessages(false);
      return;
    }
    if (!isOpen) return;
    if (skipLoadRef.current === threadId) {
      skipLoadRef.current = null;
      return;
    }
    let cancelled = false;
    setIsLoadingMessages(true);
    api
      .getChatMessages(threadId)
      .then((result) => {
        if (!cancelled) setMessages(result.messages);
      })
      .catch((error) => {
        if (cancelled) return;
        setMessages([]);
        if (error instanceof ApiClientError && error.status === 404) {
          setThreadId(null);
          return;
        }
        toast.error(
          error instanceof Error ? error.message : "Failed to load the chat",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, threadId, setThreadId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  });

  const appendIfViewing = useCallback((runId: string, message: ChatMessage) => {
    if (viewedThreadRef.current !== runId) return;
    setMessages((previous) => [...previous, message]);
  }, []);

  const handleEvent = useCallback(
    (runId: string, event: ChatStreamEvent) => {
      switch (event.type) {
        case "tool":
          setLiveLines((previous) => [
            ...previous,
            {
              label: toolStatus(event),
              ok: event.ok,
            },
          ]);
          if (event.write && event.ok) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.jobs.all,
            });
            window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
          }
          return;
        case "completed":
        case "cancelled":
          setLiveLines([]);
          appendIfViewing(runId, event.message);
          return;
        case "error":
          setLiveLines([]);
          appendIfViewing(
            runId,
            localMessage(runId, "assistant", event.message, "failed"),
          );
          return;
        default:
          return;
      }
    },
    [appendIfViewing, queryClient],
  );

  const send = async (content: string) => {
    if (isRunning) return;
    let runId = threadId;
    if (!runId) {
      try {
        runId = (await api.createChatThread()).thread.id;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to start a chat",
        );
        return;
      }
      skipLoadRef.current = runId;
      viewedThreadRef.current = runId;
      setThreadId(runId);
    }
    const id = runId;
    setMessages((previous) => [
      ...previous,
      localMessage(id, "user", content, "complete"),
    ]);
    setLiveLines([]);
    setRunThreadId(id);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.streamChatMessage(
        id,
        content,
        (event) => handleEvent(id, event),
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        appendIfViewing(
          id,
          localMessage(
            id,
            "assistant",
            error instanceof Error ? error.message : "The answer failed.",
            "failed",
          ),
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLiveLines([]);
      setRunThreadId(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.threads(),
      });
    }
  };

  const stop = async () => {
    if (!runThreadId) return;
    try {
      await api.cancelChatTurn(runThreadId);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to stop the answer",
      );
    }
  };

  if (!isOpen) return null;

  const title =
    messages
      .find((message) => message.role === "user")
      ?.content.split("\n")[0] || "New chat";
  const showLive = isRunning && runThreadId === threadId;

  return (
    <aside
      aria-label="Chat"
      onKeyDown={(event) => event.stopPropagation()}
      style={{ "--chat-width": `${width}px` } as React.CSSProperties}
      className="flex bg-background max-md:fixed max-md:inset-0 max-md:z-[60] md:sticky md:top-0 md:h-[100dvh] md:w-[var(--chat-width)] md:shrink-0"
    >
      <div className="hidden md:flex">
        <TailorColumnSplitter
          onDrag={startDrag}
          isDragging={isDragging}
          width={width}
          minWidth={CHAT_PANEL_MIN_WIDTH}
          maxWidth={maxWidth}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border/60 py-4 pl-4 pr-36">
          <div className="min-w-0 flex-1 truncate text-sm font-semibold leading-9">
            {title}
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        >
          {isLoadingMessages && messages.length === 0 ? (
            <div className="text-sm text-muted-foreground">Loading chat…</div>
          ) : messages.length === 0 && !showLive ? (
            <div className="text-sm text-muted-foreground">
              Ask about your jobs: which Ready jobs are at a company, what a
              posting says about remote work, or how many jobs you have applied
              to.
            </div>
          ) : (
            messages.map((message, index) => (
              <ChatMessageView
                key={message.id}
                message={message}
                confirm={{
                  enabled:
                    index === messages.length - 1 &&
                    !isRunning &&
                    !isLoadingMessages &&
                    message.id !== cancelledConfirmId,
                  onContinue: () => void send("Continue."),
                  onCancel: () => setCancelledConfirmId(message.id),
                }}
              />
            ))
          )}
          {showLive && (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              {liveLines.length === 0 && <div>Thinking…</div>}
              {liveLines.map((line, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are only ever appended
                  key={index}
                  className={cn(!line.ok && "text-destructive")}
                >
                  {line.ok ? line.label : `${line.label} (failed)`}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-border/60 px-4 py-3">
          <Composer
            disabled={isRunning}
            isStreaming={showLive}
            onStop={stop}
            onSend={send}
            placeholder="Ask about your jobs..."
            leading={<ChatModelMenus disabled={isRunning} />}
          />
        </div>
      </div>
    </aside>
  );
};
