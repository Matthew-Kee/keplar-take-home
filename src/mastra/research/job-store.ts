import { randomUUID } from 'node:crypto';
import { db } from './db';

/**
 * Per-thread research job tracking, stored in its own `research_jobs` table in
 * the same LibSQL file Mastra uses (`file:./mastra.db`). This is a plain
 * `@libsql/client` table — deliberately NOT a `@mastra/*` package — so the
 * version-pin rules in CLAUDE.md are untouched.
 *
 * The DB row is the source of truth for "is research underway / done" so the UI
 * can reconstruct state after a reload even if it missed the live SSE event.
 */

export type JobStatus = 'running' | 'done' | 'error';

/** Drafted-email result persisted when a job completes. */
export interface EmailResult {
  subject: string;
  body: string;
  researchSummary: string;
}

export interface ResearchJob {
  id: string;
  threadId: string;
  runId: string | null;
  status: JobStatus;
  prospect: string | null;
  result: EmailResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

// Lazy, run-once table creation. Every operation awaits this first, so the
// table always exists regardless of startup ordering. `initJobStore()` is kept
// as an explicit boot-time trigger but is not required.
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await db().execute(`
        CREATE TABLE IF NOT EXISTS research_jobs (
          id          TEXT PRIMARY KEY,
          thread_id   TEXT NOT NULL,
          run_id      TEXT,
          status      TEXT NOT NULL,
          prospect    TEXT,
          result_json TEXT,
          error       TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        )
      `);
      // Speeds up "latest running job for this thread" lookups.
      await db().execute(
        `CREATE INDEX IF NOT EXISTS idx_research_jobs_thread ON research_jobs (thread_id, created_at)`,
      );
    })();
  }
  return initPromise;
}

/** Create the `research_jobs` table if it doesn't exist. Optional on boot. */
export async function initJobStore(): Promise<void> {
  await ensureInit();
}

type Row = Record<string, unknown>;

function rowToJob(row: Row): ResearchJob {
  const resultJson = row.result_json as string | null;
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId: (row.run_id as string | null) ?? null,
    status: row.status as JobStatus,
    prospect: (row.prospect as string | null) ?? null,
    result: resultJson ? (JSON.parse(resultJson) as EmailResult) : null,
    error: (row.error as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Insert a new job in the `running` state and return the persisted row. */
export async function createJob(params: {
  threadId: string;
  prospect?: string | null;
}): Promise<ResearchJob> {
  await ensureInit();
  const now = Date.now();
  const job: ResearchJob = {
    id: randomUUID(),
    threadId: params.threadId,
    runId: null,
    status: 'running',
    prospect: params.prospect ?? null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await db().execute({
    sql: `INSERT INTO research_jobs
            (id, thread_id, run_id, status, prospect, result_json, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [job.id, job.threadId, null, job.status, job.prospect, null, null, now, now],
  });
  return job;
}

/** Attach the Mastra workflow runId once the run has been created. */
export async function setRunId(jobId: string, runId: string): Promise<void> {
  await ensureInit();
  await db().execute({
    sql: `UPDATE research_jobs SET run_id = ?, updated_at = ? WHERE id = ?`,
    args: [runId, Date.now(), jobId],
  });
}

/** The latest still-running job for a thread, or null. Powers the indicator. */
export async function getActiveJobByThread(threadId: string): Promise<ResearchJob | null> {
  await ensureInit();
  const res = await db().execute({
    sql: `SELECT * FROM research_jobs
          WHERE thread_id = ? AND status = 'running'
          ORDER BY created_at DESC
          LIMIT 1`,
    args: [threadId],
  });
  return res.rows.length ? rowToJob(res.rows[0] as Row) : null;
}

export async function getJob(jobId: string): Promise<ResearchJob | null> {
  await ensureInit();
  const res = await db().execute({
    sql: `SELECT * FROM research_jobs WHERE id = ? LIMIT 1`,
    args: [jobId],
  });
  return res.rows.length ? rowToJob(res.rows[0] as Row) : null;
}

/** Mark a job done and persist the drafted email result. */
export async function completeJob(jobId: string, result: EmailResult): Promise<void> {
  await ensureInit();
  await db().execute({
    sql: `UPDATE research_jobs
          SET status = 'done', result_json = ?, error = NULL, updated_at = ?
          WHERE id = ?`,
    args: [JSON.stringify(result), Date.now(), jobId],
  });
}

/** Mark a job failed with an error message. */
export async function failJob(jobId: string, error: string): Promise<void> {
  await ensureInit();
  await db().execute({
    sql: `UPDATE research_jobs
          SET status = 'error', error = ?, updated_at = ?
          WHERE id = ?`,
    args: [error, Date.now(), jobId],
  });
}
