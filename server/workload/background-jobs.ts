import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { newId } from "../contracts.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** One background job. Never holds a prompt or a reply: `resultRef` points at where the result lives (a thread). */
export interface BackgroundJob {
  id: string;
  dedupeKey: string;
  taskType: string;
  botId: string;
  threadId: string | null;
  model: string | null;
  status: JobStatus;
  createdAt: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  resultRef: string | null;
  errorClass: string | null;
  attempts: number;
}

export interface JobRequest {
  dedupeKey: string;
  taskType: string;
  botId: string;
  threadId?: string | null;
  model?: string | null;
}

export type JobRequestResult = { job: BackgroundJob; created: boolean } | { refused: "full"; live: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  task_type TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  thread_id TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  created_at INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result_ref TEXT,
  error_class TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS background_jobs_live ON background_jobs(status, queued_at) WHERE status IN ('queued','running');
`;

interface Row {
  id: string; dedupe_key: string; task_type: string; bot_id: string; thread_id: string | null; model: string | null;
  status: JobStatus; created_at: number; queued_at: number; started_at: number | null; finished_at: number | null;
  result_ref: string | null; error_class: string | null; attempts: number;
}

const fromRow = (row: Row): BackgroundJob => ({
  id: row.id, dedupeKey: row.dedupe_key, taskType: row.task_type, botId: row.bot_id, threadId: row.thread_id, model: row.model,
  status: row.status, createdAt: row.created_at, queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at,
  resultRef: row.result_ref, errorClass: row.error_class, attempts: row.attempts,
});

const TERMINAL_KEEP_MS = 7 * 24 * 60 * 60_000;

export interface BackgroundJobsOptions {
  capacity: number;
  maxAttempts: number;
  now?: () => number;
}

/** The durable record of background inference work: what is queued, running and settled, and why one failed. */
export class BackgroundJobs {
  private readonly db: DatabaseSync;
  private readonly capacity: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  refusedFull = 0;

  constructor(path: string, options: BackgroundJobsOptions) {
    this.capacity = options.capacity;
    this.maxAttempts = options.maxAttempts;
    this.now = options.now ?? Date.now;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    this.db.exec(SCHEMA);
    this.recover();
  }

  close() {
    this.db.close();
  }

  /** Records the job once per dedupe key; asking again returns the same job. Refuses a new key while the queue is full. */
  request(input: JobRequest): JobRequestResult {
    const existing = this.byKey(input.dedupeKey);
    if (existing) return { job: existing, created: false };
    const live = this.liveCount();
    if (live >= this.capacity) {
      this.refusedFull += 1;
      return { refused: "full", live };
    }
    const at = this.now();
    const job: BackgroundJob = {
      id: newId(), dedupeKey: input.dedupeKey, taskType: input.taskType, botId: input.botId, threadId: input.threadId ?? null,
      model: input.model ?? null, status: "queued", createdAt: at, queuedAt: at, startedAt: null, finishedAt: null,
      resultRef: null, errorClass: null, attempts: 0,
    };
    this.db.prepare(`INSERT INTO background_jobs (id, dedupe_key, task_type, bot_id, thread_id, model, status, created_at, queued_at, attempts)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)`).run(job.id, job.dedupeKey, job.taskType, job.botId, job.threadId, job.model, at, at);
    return { job, created: true };
  }

  /** Moves a queued job to running and counts the attempt; false when it is not queued. */
  start(dedupeKey: string, threadId?: string | null): boolean {
    const changed = this.db.prepare(`UPDATE background_jobs SET status = 'running', started_at = ?, attempts = attempts + 1,
      thread_id = COALESCE(?, thread_id) WHERE dedupe_key = ? AND status = 'queued'`).run(this.now(), threadId ?? null, dedupeKey);
    return Number(changed.changes) === 1;
  }

  /** Back to the queue: its owner scheduled a retry, whatever the ledger last recorded. The owner's own retry policy
   * bounds how often; the ledger counts the attempts. */
  requeue(dedupeKey: string, errorClass: string): BackgroundJob | null {
    this.db.prepare(`UPDATE background_jobs SET status = 'queued', queued_at = ?, finished_at = NULL, error_class = ? WHERE dedupe_key = ?`)
      .run(this.now(), errorClass, dedupeKey);
    return this.byKey(dedupeKey);
  }

  /** Settles a live job once; a settled job keeps its first outcome. */
  settle(dedupeKey: string, status: "completed" | "failed" | "cancelled", detail: { resultRef?: string | null; errorClass?: string | null } = {}): BackgroundJob | null {
    this.db.prepare(`UPDATE background_jobs SET status = ?, finished_at = ?, result_ref = COALESCE(?, result_ref), error_class = COALESCE(?, error_class)
      WHERE dedupe_key = ? AND status IN ('queued','running')`).run(status, this.now(), detail.resultRef ?? null, detail.errorClass ?? null, dedupeKey);
    return this.byKey(dedupeKey);
  }

  cancel(id: string): BackgroundJob | null {
    const job = this.get(id);
    if (!job) return null;
    return this.settle(job.dedupeKey, "cancelled", { errorClass: "cancelled" });
  }

  get(id: string): BackgroundJob | null {
    const row = this.db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  byKey(dedupeKey: string): BackgroundJob | null {
    const row = this.db.prepare("SELECT * FROM background_jobs WHERE dedupe_key = ?").get(dedupeKey) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(filter: { status?: JobStatus; limit?: number } = {}): BackgroundJob[] {
    const params: SQLInputValue[] = [];
    let sql = "SELECT * FROM background_jobs";
    if (filter.status) { sql += " WHERE status = ?"; params.push(filter.status); }
    sql += " ORDER BY queued_at DESC LIMIT ?";
    params.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    return (this.db.prepare(sql).all(...params) as unknown as Row[]).map(fromRow);
  }

  counts(): Record<JobStatus, number> {
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS n FROM background_jobs GROUP BY status").all() as Array<{ status: JobStatus; n: number }>) counts[row.status] = Number(row.n);
    return counts;
  }

  oldestQueuedAgeMs(): number | null {
    const row = this.db.prepare("SELECT MIN(queued_at) AS at FROM background_jobs WHERE status = 'queued'").get() as { at: number | null };
    return row.at == null ? null : this.now() - Number(row.at);
  }

  /** Live jobs whose owner no longer knows them are cancelled, so they neither count against capacity nor linger. */
  reconcile(stillLive: (job: BackgroundJob) => boolean): number {
    let closed = 0;
    for (const job of this.live()) {
      if (stillLive(job)) continue;
      this.settle(job.dedupeKey, "cancelled", { errorClass: "orphaned" });
      closed += 1;
    }
    return closed;
  }

  private live(): BackgroundJob[] {
    return (this.db.prepare("SELECT * FROM background_jobs WHERE status IN ('queued','running') ORDER BY queued_at").all() as unknown as Row[]).map(fromRow);
  }

  private liveCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM background_jobs WHERE status IN ('queued','running')").get() as { n: number };
    return Number(row.n);
  }

  /** A job running when the process stopped goes back to the queue, unless it already used its attempts. */
  private recover() {
    const at = this.now();
    this.db.prepare(`UPDATE background_jobs SET status = 'failed', finished_at = ?, error_class = 'interrupted:attempts-exhausted'
      WHERE status = 'running' AND attempts >= ?`).run(at, this.maxAttempts);
    this.db.prepare(`UPDATE background_jobs SET status = 'queued', queued_at = ?, error_class = 'interrupted' WHERE status = 'running'`).run(at);
    this.db.prepare(`DELETE FROM background_jobs WHERE status IN ('completed','failed','cancelled') AND finished_at < ?`).run(at - TERMINAL_KEEP_MS);
  }
}
