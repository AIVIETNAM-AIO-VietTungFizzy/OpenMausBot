import type { RoutineRun } from "../routines.ts";
import type { BackgroundJobs } from "./background-jobs.ts";
import type { WorkloadScheduler } from "./scheduler.ts";

export interface RoutineAdmissionDeps {
  jobs: BackgroundJobs;
  /** The shared scheduler the bot's engine sends to, or null for an engine no scheduler governs. */
  scheduler(botId: string): WorkloadScheduler | null;
  model(botId: string): string | null;
  agingMs: number | null;
  now?: () => number;
}

export const routineJobKey = (runId: string) => `routine-run:${runId}`;
export const routineRunId = (dedupeKey: string) => dedupeKey.startsWith("routine-run:") ? dedupeKey.slice("routine-run:".length) : null;

const trigger = (run: RoutineRun) => run.triggerSource ?? (run.manual ? "manual" : "schedule");

/** Routine runs are the background jobs: routines.json keeps their prompt, retries and restart recovery; the ledger keeps
 * their admission state, and the gate starts one only when the shared model has room for background work. */
export function createRoutineAdmission(deps: RoutineAdmissionDeps) {
  const now = deps.now ?? Date.now;
  return {
    /** False keeps the run queued; it is asked again on the routine manager's next pass and never dropped. */
    admit(run: RoutineRun): boolean {
      const scheduler = deps.scheduler(run.botId);
      if (!scheduler) return true;
      const key = routineJobKey(run.id);
      const asked = deps.jobs.request({ dedupeKey: key, taskType: `routine:${trigger(run)}`, botId: run.botId, threadId: run.threadId ?? null, model: deps.model(run.botId) });
      if ("refused" in asked) return false;
      let job = asked.job;
      if (job.status === "running") return true;
      if (job.status !== "queued") job = deps.jobs.requeue(key, "retry") ?? job;
      const aged = deps.agingMs !== null && now() - job.queuedAt >= deps.agingMs;
      if (!scheduler.idleForBackground && !aged) return false;
      deps.jobs.start(key, run.threadId ?? null);
      return true;
    },

    mirror(run: RoutineRun) {
      const key = routineJobKey(run.id);
      const job = deps.jobs.byKey(key);
      if (!job) return;
      switch (run.status) {
        case "queued":
          if (job.status !== "queued") deps.jobs.requeue(key, "retry");
          return;
        case "running":
        case "waiting":
          if (job.status === "queued") deps.jobs.start(key, run.threadId ?? null);
          return;
        case "completed":
          deps.jobs.settle(key, "completed", { resultRef: run.threadId ?? null });
          return;
        case "cancelled":
          deps.jobs.settle(key, "cancelled", { resultRef: run.threadId ?? null, errorClass: "cancelled" });
          return;
        case "failed":
        case "missed":
          deps.jobs.settle(key, "failed", { resultRef: run.threadId ?? null, errorClass: run.status === "missed" ? "missed" : "routine-failed" });
      }
    },

    /** Ledger rows for runs the routine manager no longer holds live are closed, so none blocks capacity. */
    reconcile(liveRunIds: ReadonlySet<string>): number {
      return deps.jobs.reconcile((job) => {
        const runId = routineRunId(job.dedupeKey);
        return runId === null || liveRunIds.has(runId);
      });
    },
  };
}
