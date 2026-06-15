import { createClient, type Client } from '@libsql/client';

/**
 * Single shared `@libsql/client` connection to the same file Mastra uses
 * (`file:./mastra.db`). The research-job and chat-message tables are plain
 * libsql tables created here — deliberately NOT `@mastra/*` packages — so the
 * version-pin rules in CLAUDE.md stay untouched.
 */
let client: Client | null = null;

export function db(): Client {
  if (!client) {
    client = createClient({ url: 'file:./mastra.db' });
  }
  return client;
}
