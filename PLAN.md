# Plan: Agentic Outbound-Email Chat App ("Keplar outreach")

An agentic chat app. The user enters info about a prospective customer; the assistant
acknowledges instantly, runs a (potentially 15–30 min) research + drafting job in the
background, and appends a personalized outbound email — inviting the prospect to try the
**Keplar voice experience at keplar.io** — into the chat thread the moment it's ready.
Starting prospect: **Begoña Fafián** (`https://www.linkedin.com/in/begonia-fafian-31b07b9/`).

## Locked decisions

- **LLM provider:** OpenAI `gpt-5.2` (the starter's existing model string; needs `OPENAI_API_KEY`).
- **Research source:** **Exa** web-search API (real data, graceful fallback if no key).
- **Frontend:** static UI (vanilla HTML/JS, no build step) served by the Mastra server.

## Hard constraints (from CLAUDE.md)

- **Do NOT change any `@mastra/*` or `mastra` versions** in `package.json` or any lockfile.
  The pinned set is load-bearing (`@mastra/deployer` / `@mastra/server` stay at `1.24.0`).
- New deps must be **non-`@mastra`** only. We add `@libsql/client` (already present
  transitively via `@mastra/libsql`) as a direct dep; Exa is called via raw `fetch` (no SDK).

---

## 1. Architecture at a glance

One Mastra process. The Mastra server (Hono) hosts both the static chat UI and custom
JSON/SSE routes. The long research+draft job runs **detached** from the HTTP request and
writes its result back into the persistent thread; the browser learns about it via SSE
(with a polling/reload fallback).

```
Browser (static UI)
  │  POST /chat ───────────────► returns ACK instantly (does NOT wait for research)
  │                                  └─ kicks off detached workflow run (void run.start)
  │  GET  /thread/:id ─────────► messages + current research status (reload reconstruction)
  │  GET  /research/:id/stream ► SSE: pushes "done"/"error" the moment research finishes
  ▼
Mastra server (custom routes)
  ├─ outreachAgent             (instant ack + email drafting persona, openai/gpt-5.2)
  ├─ prospectWorkflow          (researchProspect → draftEmail)
  ├─ webSearchTool             (Exa via fetch, graceful fallback to model knowledge)
  ├─ Memory (LibSQLStore)      (thread + messages persistence → reload resilience)
  ├─ ResearchJobStore (libsql) (per-thread job status: running/done/error + result)
  └─ events (EventEmitter)     (in-process pub/sub → SSE fan-out)
```

**Source of truth is the database** (thread messages + `research_jobs` row). SSE is only an
accelerator for live updates; if it drops, the `/thread/:id` snapshot still tells the full
story. This is what makes all three requirements hold.

Verified against the installed packages:
- `registerApiRoute()` from `@mastra/core/server` for custom Hono routes.
- Mastra's documented **"continue generation after client disconnect"** pattern
  (`void run.start()` / not forwarding the request `AbortSignal`) — the exact primitive for
  a job that must outlive the HTTP request.
- `Memory` → `createThread` / `getThreadById` / `saveMessages` / `query`.
- Hono `streamSSE` helper is present for live push.
- Workflow `createRun` / `start` / `watch` / `getWorkflowRunById`.

## 2. Requirement traceability

| Requirement | How it's satisfied |
|---|---|
| **R1** — instant ack, doesn't block on the agentic work; visual research indicator | `POST /chat` saves the user msg, writes a **deterministic ack** assistant message, creates a `research_jobs` row (`status='running'`), starts the workflow with `void run.start()` **without forwarding `c.req.raw.signal`**, and returns `{threadId, jobId, status:'researching'}` immediately. UI renders a persistent "Researching {prospect}…" animated bubble while status is `running`. |
| **R2** — open chat auto-updates the moment research finishes; email appended; no reload | Background completion handler `saveMessages()` the drafted email as an assistant message, sets job `status='done'`, and `events.emit(threadId, ...)`. The open SSE connection pushes the event; UI removes the indicator and appends the email bubble. No reload, no spinner-forever. |
| **R3** — persists across reload; mid-research reload shows it's underway; email shows once done | On load the UI calls `GET /thread/:id` → returns persisted messages + `activeJob`. If a job is `running`, UI shows the indicator and (re)opens SSE; if it completed while away, the email is already in `messages`. Because the run is detached, a browser reload never interrupts it. |

## 3. Data model

**`research_jobs`** (LibSQL table, created on boot via `@libsql/client` against
`file:./mastra.db`; separate table, not a `@mastra/*` package → version-pin rule untouched):

```
id           TEXT PRIMARY KEY      -- jobId (uuid)
thread_id    TEXT NOT NULL
run_id       TEXT                  -- mastra workflow runId
status       TEXT NOT NULL         -- 'running' | 'done' | 'error'
prospect     TEXT                  -- display name for the indicator
result_json  TEXT                  -- { subject, body, researchSummary } when done
error        TEXT
created_at   INTEGER
updated_at   INTEGER
```

The "active" job for a thread is the latest `running` row by `created_at`. Thread messages
themselves live in Mastra Memory's tables (LibSQLStore), so we don't duplicate them.

## 4. Backend files

### `src/mastra/research/job-store.ts`
Thin wrapper over a `@libsql/client` connection to `file:./mastra.db`. Exports:
- `initJobStore()` — `CREATE TABLE IF NOT EXISTS research_jobs ...`
- `createJob({threadId, prospect})` → row (`status:'running'`)
- `setRunId(jobId, runId)`
- `getActiveJobByThread(threadId)` / `getJob(jobId)`
- `completeJob(jobId, result)` / `failJob(jobId, error)`

### `src/mastra/research/events.ts`
Module-singleton `EventEmitter`. `publish(threadId, payload)` / `subscribe(threadId, cb)→unsub`.
Used by the background handler → SSE route.
> Single-process only; a multi-replica deploy would swap this for Redis pub/sub (out of scope).

### `src/mastra/tools/web-search-tool.ts` (Exa)
`createTool({ id: 'web-search' })`, input `{ query: string, category?: string, numResults?: number }`,
output `{ results: { title, url, summary, highlights, publishedDate, author }[] }`.

**Endpoint:** `POST https://api.exa.ai/search` · **Auth:** header `x-api-key: $EXA_API_KEY` ·
**Body:** `Content-Type: application/json`.

```ts
const res = await fetch('https://api.exa.ai/search', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.EXA_API_KEY ?? '',
  },
  body: JSON.stringify({
    query,
    type: 'auto',                   // 'auto' default; 'fast' for low-latency; 'deep' for richer research
    category: category ?? 'people', // 'people' fits prospect research; 'company' for the org pass
    numResults: numResults ?? 5,
    contents: { highlights: true, summary: true }, // token-efficient extracts + AI summary
  }),
});
```

Map Exa's `results[]` (fields: `title`, `url`, `text`, `highlights`, `summary`,
`publishedDate`, `author`) into the tool output.

**Graceful fallback:** if `EXA_API_KEY` is missing or the call throws / returns non-200,
return `{ results: [] }` and let `draftEmail` proceed from input + model knowledge so the
demo never hard-fails on a missing key.

> Why Exa fits: its `category: 'people'` surface is purpose-built for researching a named
> prospect, and it accepts a LinkedIn URL directly in `query`. `researchProspect` can do two
> passes — `category:'people'` on the person, then `category:'company'` on their org.
> (Exa publishes an `exa-js` SDK; we use raw `fetch` to keep the dependency surface minimal.)

### `src/mastra/agents/outreach-agent.ts`
`new Agent({ id:'outreach-agent', model:'openai/gpt-5.2', tools:{ webSearchTool }, memory: new Memory() })`.
Instructions encode:
- The **Keplar context** — this is an outbound email inviting the prospect to try the
  **Keplar voice experience at keplar.io**; warm, concise, personalized, single clear CTA,
  no spammy filler. **Leave a clearly-marked block to paste Keplar's exact value prop** so we
  don't fabricate product specifics.
- How to use research findings to personalize (reference the prospect's role/company/recent work).

### `src/mastra/workflows/prospect-workflow.ts`
`createWorkflow({ id:'prospect-workflow', inputSchema, outputSchema })`:
- **inputSchema:** `{ prospect: { name, role?, company?, linkedinUrl?, notes? }, rawQuery: string }`
- **Step `researchProspect`:** build 1–3 targeted Exa queries from the prospect fields, call
  `webSearchTool` (people pass + optional company pass), condense into a `researchSummary`
  string. This is the step that is "allowed to be slow" in production (use Exa `type:'deep'`).
- **Step `draftEmail`:** `outreachAgent.generate(prompt, { structuredOutput: emailSchema })`
  where `emailSchema = z.object({ subject: z.string(), body: z.string() })`. Prompt = Keplar
  context + researchSummary + original prospect input.
- **outputSchema:** `{ subject, body, researchSummary }`.

> Using a workflow gives persisted run state via `getWorkflowRunById` as a secondary check
> alongside `research_jobs`.

### `src/mastra/server/routes.ts` — custom routes (`registerApiRoute`)
Paths must **not** start with `/api/` (reserved by Mastra).

- **`POST /chat`** — body `{ threadId?, message, prospect? }`
  1. `threadId ??= (await memory.createThread()).id`
  2. `memory.saveMessages([{ role:'user', content: message, threadId }])`
  3. Write **deterministic ack** assistant message and `saveMessages(...)`:
     *"Got it — I'm researching {prospect.name} now and drafting the outreach email. This can
     take a while; I'll drop the draft right here in the chat the moment it's ready."*
  4. `const job = createJob({ threadId, prospect: prospect.name })`
  5. `const run = await prospectWorkflow.createRun(); setRunId(job.id, run.runId)`
  6. **Detached** background work (do **not** pass `c.req.raw.signal`):
     ```ts
     void (async () => {
       try {
         const res = await run.start({ inputData: { prospect, rawQuery: message } });
         const email = res.result; // { subject, body, researchSummary }
         await memory.saveMessages([{ role:'assistant', threadId,
           content: formatEmailMessage(email) }]);
         completeJob(job.id, email);
         publish(threadId, { type:'done', jobId: job.id, email });
       } catch (e) {
         failJob(job.id, String(e));
         publish(threadId, { type:'error', jobId: job.id, error: String(e) });
       }
     })();
     ```
  7. `return c.json({ threadId, jobId: job.id, ack, status:'researching' })` — returns in ms.

- **`GET /thread/:threadId`** → `{ messages: memory.query(...), activeJob: getActiveJobByThread() }`.
  Powers first paint and reload reconstruction.

- **`GET /research/:threadId/stream`** (SSE via Hono `streamSSE`):
  - On connect, immediately emit the **current** job state from the DB (so a reload that
    reconnects gets caught up even if it missed the live event).
  - `subscribe(threadId, cb)` → forward `done`/`error` events as SSE messages.
  - Heartbeat comment every ~15s; clean up `unsub` on close.

- **`GET /`** and assets → serve `public/index.html`, `public/app.js`, `public/styles.css`.

### `src/mastra/index.ts` (edit)
- Keep existing `storage`, `logger`, weather agent/workflow (don't break the starter).
- Register `outreachAgent`, `prospectWorkflow`.
- Add `server: { apiRoutes: [...routes] }`.
- Call `initJobStore()` on startup.

## 5. Frontend (`public/`)

Single lightweight page, vanilla JS (no build step) — matches "static UI served by Mastra".

- **`index.html`** — chat thread container, composer, and a small "prospect" form prefilled
  with the example (**Begoña Fafián**, LinkedIn URL from the prompt) so the user can send in
  one click.
- **`app.js`**:
  - `threadId` persisted in `localStorage` → survives reloads (R3).
  - **On load:** `GET /thread/:id` → render messages; if `activeJob.status==='running'`, render
    the **research indicator** and open SSE; if a `done` job's email is already in messages, it
    just renders.
  - **Send:** `POST /chat` → append user bubble + ack bubble from the response → show research
    indicator → open/ensure SSE.
  - **SSE handler:** `done` → remove indicator, append email bubble (subject + body, copy
    button); `error` → show retryable error bubble.
  - **Resilience:** auto-reconnect SSE on drop; lightweight `GET /thread/:id` poll every ~10s
    while a job is `running` as a belt-and-suspenders fallback.
- **`styles.css`** — minimal chat styling + an animated "researching…" pulse/typing indicator.

## 6. Config / env

- **`.env`** (new): `OPENAI_API_KEY=...`, `EXA_API_KEY=...`. Mastra dev loads `.env` automatically.
- **`package.json`:** add **`@libsql/client`** as a direct dependency (non-`@mastra` — pin rule
  unaffected). Exa via `fetch` (no SDK). **No `@mastra/*` / `mastra` version changes.**
- **Scripts unchanged:** `npm run dev` (`mastra dev`) serves the UI at `localhost:4111/`.

## 7. Implementation order (each bullet = one promptable chunk)

1. **Deps/env:** add `@libsql/client`, create `.env`, confirm `npm run dev` still boots.
2. **Data layer:** `research/job-store.ts` + `research/events.ts`.
3. **Tool:** `tools/web-search-tool.ts` (Exa, with fallback).
4. **Agent + workflow:** `agents/outreach-agent.ts`, `workflows/prospect-workflow.ts` (structured email output).
5. **Routes:** `server/routes.ts` (`/chat`, `/thread/:id`, `/research/:id/stream`, static) + wire into `index.ts` + `initJobStore()`.
6. **Frontend:** `public/index.html`, `app.js`, `styles.css`.
7. **Verify end-to-end** (acceptance below).

## 8. Acceptance tests (manual)

1. Send a query → ack appears in **< 1s**; research indicator shows. ✅R1
2. Leave the tab open → email bubble appears automatically when research finishes, no reload. ✅R2
3. **Reload while researching** → thread comes back showing the indicator still running; email
   later appears in the same thread. ✅R3
4. Kill/restart the browser tab mid-run (server stays up) → run still completes and email lands
   in the thread.
5. Remove `EXA_API_KEY` → still drafts an email (fallback path), no crash.

## 9. Open items to fill at implementation time

- **Keplar value prop / CTA wording** — leave a marked block in the agent instructions rather
  than invent product claims; paste the real positioning when building.
- **Multi-replica deploy** — the in-process event bus would need Redis; out of scope for the test.
- **Production "slow" path** — switch Exa `type` to `'deep'` and add more research passes when
  you want the job to behave like the real 15–30 min workload.
