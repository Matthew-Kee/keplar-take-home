import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub used to push research completion to open SSE connections.
 *
 * Single-process only: the background job handler and the SSE route live in the
 * same Mastra server, so a module-singleton EventEmitter is enough. A
 * multi-replica deploy would swap this for Redis pub/sub (out of scope).
 *
 * SSE is only an accelerator — the `research_jobs` row remains the source of
 * truth, so a dropped event is recovered on the next `/thread/:id` snapshot.
 */

/** Event payloads fanned out to subscribers for a thread. */
export type ResearchEvent =
  | { type: 'done'; jobId: string; email: { subject: string; body: string; researchSummary: string } }
  | { type: 'error'; jobId: string; error: string };

// Allow many concurrent threads/tabs without Node's default 10-listener warning.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Prefix avoids collisions with any reserved EventEmitter event names. */
function channel(threadId: string): string {
  return `thread:${threadId}`;
}

/** Publish an event to all current subscribers of a thread. */
export function publish(threadId: string, payload: ResearchEvent): void {
  emitter.emit(channel(threadId), payload);
}

/** Subscribe to a thread's events. Returns an unsubscribe function. */
export function subscribe(threadId: string, cb: (payload: ResearchEvent) => void): () => void {
  const ch = channel(threadId);
  emitter.on(ch, cb);
  return () => emitter.off(ch, cb);
}
