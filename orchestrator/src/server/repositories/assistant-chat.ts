import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatMessageRole,
  ChatMessageStatus,
  ChatThread,
} from "@shared/types";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";

const { chatMessages, chatThreads } = schema;

function mapThread(row: typeof chatThreads.$inferSelect): ChatThread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function createThread(
  title: string | null = null,
): Promise<ChatThread> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(chatThreads).values({
    id,
    title,
    createdAt: now,
    updatedAt: now,
  });
  const thread = await getThread(id);
  if (!thread) throw new Error(`Failed to load created chat thread ${id}.`);
  return thread;
}

export async function listThreads(): Promise<ChatThread[]> {
  const rows = await db
    .select()
    .from(chatThreads)
    .orderBy(desc(chatThreads.updatedAt), desc(sql`rowid`));
  return rows.map(mapThread);
}

export async function getThread(threadId: string): Promise<ChatThread | null> {
  const [row] = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  return row ? mapThread(row) : null;
}

export async function setThreadTitle(
  threadId: string,
  title: string,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId));
}

export async function touchThread(threadId: string): Promise<void> {
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(chatThreads.id, threadId));
}

export async function listMessages(threadId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(sql`rowid`));
  return rows.map(mapMessage);
}

export async function addMessage(input: {
  threadId: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
}): Promise<ChatMessage> {
  const id = randomUUID();
  await db.insert(chatMessages).values({
    id,
    threadId: input.threadId,
    role: input.role,
    content: input.content,
    status: input.status,
    createdAt: new Date().toISOString(),
  });
  const [row] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, id));
  if (!row) throw new Error(`Failed to load created chat message ${id}.`);
  return mapMessage(row);
}
