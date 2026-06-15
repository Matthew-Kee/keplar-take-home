import { registerApiRoute } from '@mastra/core/server';
import { streamSSE } from 'hono/streaming';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createJob,
  setRunId,
  completeJob,
  failJob,
  getActiveJobByThread,
} from '../research/job-store';
import { addMessage, getMessages, newThreadId } from '../research/chat-store';
import { publish, subscribe } from '../research/events';

/**
 * Custom JSON/SSE + static routes for the Keplar outreach chat app.
 *
 * Paths must NOT start with `/api/` (reserved by Mastra). The DB (chat_messages +
 * research_jobs) is the source of truth; SSE only accelerates live updates, so a
 * dropped connection is always recoverable via `GET /thread/:id`.
 */

interface ProspectInput {
  linkedinUrl?: string;
  role?: string;
  company?: string;
  notes?: string;
}

/** Render a drafted email as a single assistant message string. */
function formatEmailMessage(email: { subject: string; body: string }): string {
  return `Subject: ${email.subject}\n\n${email.body}`;
}

// ── POST /chat ──────────────────────────────────────────────────────────────
// Saves the user message + a deterministic ack, opens a research job, kicks off
// the workflow DETACHED (does not await, does not forward the request signal),
// and returns immediately so the UI can ack in < 1s.
const chatRoute = registerApiRoute('/chat', {
  method: 'POST',
  handler: async c => {
    const body = await c.req.json().catch(() => ({}));
    const message: string = body?.message ?? '';
    const prospect: ProspectInput | undefined = body?.prospect;
    const threadId: string = body?.threadId ?? newThreadId();

    if (!message.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }

    await addMessage({ threadId, role: 'user', content: message });

    // The prospect's name isn't known until research matches their profile, so
    // the ack is name-agnostic.
    const ack =
      `Got it — I'm researching this prospect now and drafting the outreach email. ` +
      `This can take a while; I'll drop the result right here in the chat the moment it's ready.`;
    await addMessage({ threadId, role: 'assistant', content: ack });

    const job = await createJob({ threadId, prospect: null });

    const mastra = c.get('mastra');
    const workflow = mastra.getWorkflow('prospectWorkflow');
    const run = await workflow.createRun();
    await setRunId(job.id, run.runId);

    // Detached: outlives the HTTP request. No `c.req.raw.signal` forwarded, so a
    // browser disconnect / reload never cancels the research.
    void (async () => {
      try {
        const res = await run.start({
          inputData: { prospect: prospect ?? {}, rawQuery: message },
        });
        if (res.status !== 'success') {
          const reason = res.status === 'failed' ? res.error?.message : `workflow ${res.status}`;
          throw new Error(reason ?? 'workflow did not complete');
        }
        const out = res.result as {
          status: 'drafted' | 'unverified';
          subject: string;
          body: string;
          researchSummary: string;
          reason: string;
        };

        if (out.status === 'drafted') {
          const content = formatEmailMessage(out);
          await addMessage({ threadId, role: 'assistant', content });
          await completeJob(job.id, {
            subject: out.subject,
            body: out.body,
            researchSummary: out.researchSummary,
          });
          publish(threadId, { type: 'done', jobId: job.id, email: out });
        } else {
          // Identity unverified — append the notice; still a successful outcome.
          await addMessage({ threadId, role: 'assistant', content: out.reason });
          await completeJob(job.id, { subject: '', body: out.reason, researchSummary: '' });
          publish(threadId, {
            type: 'done',
            jobId: job.id,
            email: { subject: '', body: out.reason, researchSummary: '' },
          });
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await addMessage({
          threadId,
          role: 'assistant',
          content: `Sorry — something went wrong while researching this prospect. Please try again. (${error})`,
        });
        await failJob(job.id, error);
        publish(threadId, { type: 'error', jobId: job.id, error });
      }
    })();

    return c.json({ threadId, jobId: job.id, ack, status: 'researching' });
  },
});

// ── GET /thread/:threadId ───────────────────────────────────────────────────
// Full snapshot for first paint and reload reconstruction.
const threadRoute = registerApiRoute('/thread/:threadId', {
  method: 'GET',
  handler: async c => {
    const threadId = c.req.param('threadId');
    const [messages, activeJob] = await Promise.all([
      getMessages(threadId),
      getActiveJobByThread(threadId),
    ]);
    return c.json({ threadId, messages, activeJob });
  },
});

// ── GET /research/:threadId/stream ──────────────────────────────────────────
// SSE: emits current job state on connect (catch-up), then live done/error.
const streamRoute = registerApiRoute('/research/:threadId/stream', {
  method: 'GET',
  handler: c => {
    const threadId = c.req.param('threadId');
    return streamSSE(c, async stream => {
      // Catch-up: tell a (re)connecting client the current state from the DB.
      const active = await getActiveJobByThread(threadId);
      await stream.writeSSE({
        event: 'status',
        data: JSON.stringify({
          type: active ? 'running' : 'idle',
          jobId: active?.id ?? null,
          prospect: active?.prospect ?? null,
        }),
      });

      // Live updates from the background job handler.
      const unsub = subscribe(threadId, payload => {
        stream
          .writeSSE({ event: payload.type, data: JSON.stringify(payload) })
          .catch(() => {});
      });

      // Heartbeat keeps proxies from closing an idle connection.
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {});
      }, 15000);

      // Hold the stream open until the client disconnects, then clean up.
      await new Promise<void>(resolve => stream.onAbort(() => resolve()));
      clearInterval(heartbeat);
      unsub();
    });
  },
});

// ── Static UI ───────────────────────────────────────────────────────────────
// The frontend lives in `src/mastra/public/`. Mastra only auto-serves that dir
// at *build* time, so in `mastra dev` we serve it ourselves. We resolve against
// a few candidate base dirs so it works whether cwd is the mastra dir, its
// `public/` subdir (dev), or the bundled output root (after `mastra build`).
const PUBLIC_CANDIDATES = [
  join(process.cwd(), 'public'),
  process.cwd(),
  join(process.cwd(), 'src', 'mastra', 'public'),
];

async function readPublic(relPath: string): Promise<string | null> {
  for (const base of PUBLIC_CANDIDATES) {
    try {
      return await readFile(join(base, relPath), 'utf8');
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function serveFile(relPath: string, contentType: string) {
  return async (c: {
    body: (b: string, s?: number, h?: Record<string, string>) => Response;
    text: (t: string, s?: number) => Response;
  }) => {
    const content = await readPublic(relPath);
    if (content == null) return c.text('Not found', 404);
    return c.body(content, 200, { 'Content-Type': contentType });
  };
}

const htmlHandler = serveFile('index.html', 'text/html; charset=utf-8');
// Serve the chat UI at `/` (overrides Studio's root in dev) and `/app` (alias).
const indexRoute = registerApiRoute('/', { method: 'GET', handler: htmlHandler });
const appRoute = registerApiRoute('/app', { method: 'GET', handler: htmlHandler });
const jsRoute = registerApiRoute('/app.js', {
  method: 'GET',
  handler: serveFile('app.js', 'application/javascript; charset=utf-8'),
});
const cssRoute = registerApiRoute('/styles.css', {
  method: 'GET',
  handler: serveFile('styles.css', 'text/css; charset=utf-8'),
});

export const apiRoutes = [chatRoute, threadRoute, streamRoute, indexRoute, appRoute, jsRoute, cssRoute];
