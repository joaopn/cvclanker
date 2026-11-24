export interface ChatThread {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatMessageRole = "user" | "assistant";

export type ChatMessageStatus = "complete" | "failed" | "cancelled";

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
}

export type ChatStreamEvent =
  | { type: "ready"; threadId: string; requestId: string }
  | {
      type: "tool";
      name: string;
      arguments: unknown;
      write: boolean;
      ok: boolean;
      job?: { title: string; employer: string } | null;
    }
  | { type: "completed"; message: ChatMessage }
  | { type: "cancelled"; message: ChatMessage }
  | { type: "error"; code: string; message: string; requestId: string };
