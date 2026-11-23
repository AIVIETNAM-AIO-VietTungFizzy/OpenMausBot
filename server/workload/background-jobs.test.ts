import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundJobs } from "./background-jobs.ts";
import { createRoutineAdmission, routineJobKey } from "./routine-admission.ts";
import { WorkloadScheduler } from "./scheduler.ts";
import type { RoutineRun } from "../routines.ts";

const dirs: string[] = [];
const opened: BackgroundJobs[] = [];
afterEach(() => {
  for (const jobs of opened.splice(0)) { try { jobs.close(); } catch { /* closed by the test */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(path = ":memory:", options: { capacity?: number; maxAttempts?: number; now?: () => number } = {}) {
  const jobs = new BackgroundJobs(path, { capacity: options.capacity ?? 10, maxAttempts: options.maxAttempts ?? 2, ...(options.now ? { now: options.now } : {}) });
  opened.push(jobs);
  return jobs;
}
const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), "omb-jobs-")); dirs.push(dir); return join(dir, "workload-jobs.db"); };
const request = { dedupeKey: "routine-run:1", taskType: "routine:schedule", botId: "bot-1", threadId: null, model: "qwen3.8:27b" };

describe("background job ledger", () => {
  it("accepts a job with its own id and every lifecycle field, without prompt content", () => {
    let clock = 1_000;
    const jobs = open(":memory:", { now: () => clock });
    const asked = jobs.request(request);
    if ("refused" in asked) throw new Error("refused");
    expect(asked.created).toBe(true);
    expect(asked.job).toMatchObject({ status: "queued", botId: "bot-1", taskType: "routine:schedule", model: "qwen3.8:27b", createdAt: 1_000, queuedAt: 1_000, attempts: 0 });
    expect(asked.job.id).toMatch(/^[0-9a-f-]{36}$/);
    clock = 2_000;
    expect(jobs.start(request.dedupeKey, "thread-9")).toBe(true);
    clock = 5_000;
    const done = jobs.settle(request.dedupeKey, "completed", { resultRef: "thread-9" });
    expect(done).toMatchObject({ status: "completed", startedAt: 2_000, finishedAt: 5_000, resultRef: "thread-9", threadId: "thread-9", attempts: 1 });
    expect(jobs.get(asked.job.id)).toEqual(done);
    expect(Object.keys(done!)).not.toContain("prompt");
  });

  it("returns the same job for the same dedupe key and never runs it twice", () => {
    const jobs = open();
    const first = jobs.request(request);
    const again = jobs.request(request);
    if ("refused" in first || "refused" in again) throw new Error("refused");
    expect(again).toEqual({ job: first.job, created: false });
    expect(jobs.start(request.dedupeKey)).toBe(true);
    expect(jobs.start(request.dedupeKey)).toBe(false);
    expect(jobs.counts()).toMatchObject({ queued: 0, running: 1 });
  });

  it("refuses new jobs at capacity instead of growing, and keeps counting what it refused", () => {
    const jobs = open(":memory:", { capacity: 2 });
    jobs.request({ ...request, dedupeKey: "a" });
    jobs.request({ ...request, dedupeKey: "b" });
    expect(jobs.request({ ...request, dedupeKey: "c" })).toEqual({ refused: "full", live: 2 });
    expect(jobs.refusedFull).toBe(1);
    jobs.settle("a", "completed");
    expect("job" in jobs.request({ ...request, dedupeKey: "c" })).toBe(true);
  });

  it("records failures and cancellation once", () => {
    const jobs = open();
    jobs.request({ ...request, dedupeKey: "fails" });
    jobs.start("fails");
    expect(jobs.settle("fails", "failed", { errorClass: "routine-failed" })).toMatchObject({ status: "failed", errorClass: "routine-failed" });
    expect(jobs.settle("fails", "completed")).toMatchObject({ status: "failed" });
    const asked = jobs.request({ ...request, dedupeKey: "cancel-me" });
    if ("refused" in asked) throw new Error("refused");
    expect(jobs.cancel(asked.job.id)).toMatchObject({ status: "cancelled", errorClass: "cancelled" });
    expect(jobs.cancel(asked.job.id)).toMatchObject({ status: "cancelled" });
  });

  it("survives a restart: queued jobs stay queued, a running job goes back to the queue, one out of attempts fails", () => {
    const path = tempDb();
    const before = open(path, { maxAttempts: 2 });
    before.request({ ...request, dedupeKey: "waiting" });
    before.request({ ...request, dedupeKey: "cut-off" });
    before.start("cut-off");
    before.request({ ...request, dedupeKey: "spent" });
    before.start("spent");
    before.requeue("spent", "retry");
    before.start("spent");
    before.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const after = open(path, { maxAttempts: 2 });
    expect(after.byKey("waiting")).toMatchObject({ status: "queued", attempts: 0 });
    expect(after.byKey("cut-off")).toMatchObject({ status: "queued", attempts: 1, errorClass: "interrupted" });
    expect(after.byKey("spent")).toMatchObject({ status: "failed", attempts: 2, errorClass: "interrupted:attempts-exhausted" });
  });

  it("closes live jobs their owner no longer knows", () => {
    const jobs = open();
    jobs.request({ ...request, dedupeKey: "routine-run:kept" });
    jobs.request({ ...request, dedupeKey: "routine-run:gone" });
    expect(jobs.reconcile((job) => job.dedupeKey.endsWith("kept"))).toBe(1);
    expect(jobs.byKey("routine-run:gone")).toMatchObject({ status: "cancelled", errorClass: "orphaned" });
    expect(jobs.byKey("routine-run:kept")).toMatchObject({ status: "queued" });
  });
});

const run = (id: string, status: RoutineRun["status"] = "queued", extra: Partial<RoutineRun> = {}) =>
  ({ id, routineId: "routine", routineName: "Daily digest", botId: "bot-1", status, manual: false, scheduledFor: 0, ...extra }) as unknown as RoutineRun;

describe("routine admission", () => {
  function gate(options: { agingMs?: number | null; capacity?: number } = {}) {
    let clock = 0;
    const jobs = open(":memory:", { capacity: options.capacity ?? 10, now: () => clock });
    const scheduler = new WorkloadScheduler("http://ollama.test", undefined, undefined, () => clock);
    const admission = createRoutineAdmission({ jobs, scheduler: (botId) => botId === "bot-1" ? scheduler : null, model: () => "qwen3.8:27b", agingMs: options.agingMs === undefined ? 60_000 : options.agingMs, now: () => clock });
    return { jobs, scheduler, admission, advance: (ms: number) => { clock += ms; } };
  }
  const meta = (botId: string) => ({ workloadClass: "interactive" as const, source: "person-turn" as const, requestId: `${botId}-${Math.random()}`, botId });

  it("starts a run at once when the shared model is idle and records it as running", () => {
    const { jobs, admission } = gate();
    expect(admission.admit(run("r1"))).toBe(true);
    expect(jobs.byKey(routineJobKey("r1"))).toMatchObject({ status: "running", attempts: 1, taskType: "routine:schedule", model: "qwen3.8:27b" });
  });

  it("keeps a run queued while a person's request runs or waits, then lets it go once aged", async () => {
    const { jobs, scheduler, admission, advance } = gate({ agingMs: 60_000 });
    const permit = await scheduler.acquire(meta("person"));
    expect(admission.admit(run("r1"))).toBe(false);
    expect(jobs.byKey(routineJobKey("r1"))).toMatchObject({ status: "queued" });
    advance(59_999);
    expect(admission.admit(run("r1"))).toBe(false);
    advance(1);
    expect(admission.admit(run("r1"))).toBe(true);
    permit.release("completed");
  });

  it("never ages a run past waiting people when aging is off", async () => {
    const { scheduler, admission, advance } = gate({ agingMs: null });
    const permit = await scheduler.acquire(meta("person"));
    advance(24 * 60 * 60_000);
    expect(admission.admit(run("r1"))).toBe(false);
    permit.release("completed");
    expect(admission.admit(run("r1"))).toBe(true);
  });

  it("leaves a bot whose engine no scheduler governs untouched", () => {
    const { jobs, admission } = gate();
    expect(admission.admit(run("r2", "queued", { botId: "cloud-bot" } as Partial<RoutineRun>))).toBe(true);
    expect(jobs.byKey(routineJobKey("r2"))).toBeNull();
  });

  it("holds a run queued (never dropped) while the ledger is full", () => {
    const { jobs, admission } = gate({ capacity: 1 });
    jobs.request({ ...request, dedupeKey: "other" });
    expect(admission.admit(run("r3"))).toBe(false);
    expect(jobs.byKey(routineJobKey("r3"))).toBeNull();
    jobs.settle("other", "completed");
    expect(admission.admit(run("r3"))).toBe(true);
  });

  it("mirrors the routine's lifecycle, including its own retry", () => {
    const { jobs, admission } = gate();
    admission.admit(run("r4"));
    admission.mirror(run("r4", "running", { threadId: "thread-4" } as Partial<RoutineRun>));
    admission.mirror(run("r4", "failed", { threadId: "thread-4" } as Partial<RoutineRun>));
    expect(jobs.byKey(routineJobKey("r4"))).toMatchObject({ status: "failed", errorClass: "routine-failed", resultRef: "thread-4" });
    admission.mirror(run("r4", "queued"));
    expect(jobs.byKey(routineJobKey("r4"))).toMatchObject({ status: "queued", errorClass: "retry" });
    expect(admission.admit(run("r4"))).toBe(true);
    admission.mirror(run("r4", "completed", { threadId: "thread-4" } as Partial<RoutineRun>));
    expect(jobs.byKey(routineJobKey("r4"))).toMatchObject({ status: "completed", attempts: 2, resultRef: "thread-4" });
  });

  it("closes ledger rows for runs the routine manager no longer holds", () => {
    const { jobs, admission } = gate();
    admission.admit(run("live"));
    admission.admit(run("gone"));
    expect(admission.reconcile(new Set(["live"]))).toBe(1);
    expect(jobs.byKey(routineJobKey("gone"))).toMatchObject({ status: "cancelled", errorClass: "orphaned" });
  });
});
