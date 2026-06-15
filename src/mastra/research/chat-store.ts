import { randomUUID } from 'node:crypto';
import { db } from './db';

/**
 * Persistent store for the visible chat transcript (user messages, the
 * deterministic ack, and the drafted email / unverified notice).
 *
 * This is a dedicated `chat_messages` libsql table rather than Mastra Memory — a
 * deliberate, approved deviation from the plan. The custom UI consumes exactly
 * this shape, and the reload-critical path (R3) stays plain SQL we fully control.
 * The DB is the source of truth; SSE is only a live accelerator on top of it.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await db().execute(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id         TEXT PRIMARY KEY,
          thread_id  TEXT NOT NULL,
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      // Ordered transcript reads per thread.
      await db().execute(
        `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, created_at)`,
      );
    })();
  }
  return initPromise;
}

/** Create the `chat_messages` table if it doesn't exist. Optional on boot. */
export async function initChatStore(): Promise<void> {
  await ensureInit();
}

/** A thread is just a server-generated id; no row is needed to "create" one. */
export function newThreadId(): string {
  return randomUUID();
}

/** Append a message to a thread and return the persisted row. */
export async function addMessage(params: {
  threadId: string;
  role: ChatRole;
  content: string;
}): Promise<ChatMessage> {
  await ensureInit();
  const msg: ChatMessage = {
    id: randomUUID(),
    threadId: params.threadId,
    role: params.role,
    content: params.content,
    createdAt: Date.now(),
  };
  await db().execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [msg.id, msg.threadId, msg.role, msg.content, msg.createdAt],
  });
  return msg;
}

/** All messages for a thread in chronological order. Powers first paint + reload. */
export async function getMessages(threadId: string): Promise<ChatMessage[]> {
  await ensureInit();
  const res = await db().execute({
    sql: `SELECT id, thread_id, role, content, created_at
          FROM chat_messages
          WHERE thread_id = ?
          ORDER BY created_at ASC`,
    args: [threadId],
  });
  return res.rows.map(row => ({
    id: String(row.id),
    threadId: String(row.thread_id),
    role: row.role as ChatRole,
    content: String(row.content),
    createdAt: Number(row.created_at),
  }));
}
