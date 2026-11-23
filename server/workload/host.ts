import { join } from "node:path";
import type { RoutineRun } from "../routines.ts";
import { createWorkloadRoutes } from "../routes/workload.ts";
import { BackgroundJobs } from "./background-jobs.ts";
import { backgroundQueueMax, jobMaxAttempts, schedulerEnabled, schedulerLimits } from "./config.ts";
import { schedulerForInstance, schedulerSnapshots, shutdownSchedulers } from "./registry.ts";
import { createRoutineAdmission, routineRunId } from "./routine-admission.ts";

export interface WorkloadHostDeps {
  dataDir: string;
  bot(botId: string): { modelSelection: { instanceId: string; model?: string } } | null | undefined;
}

interface RoutineRuns {
  listRuns(): RoutineRun[];
  cancelRun(id: string, reason?: string): Promise<RoutineRun | null>;
}

const LIVE_RUN = new Set(["queued", "running", "waiting"]);

/** The server's side of the workload scheduler: the background job ledger and routine gate exist only while it is on. */
export function createWorkloadHost(deps: WorkloadHostDeps) {
  const jobs = schedulerEnabled() ? new BackgroundJobs(join(deps.dataDir, "workload-jobs.db"), { capacity: backgroundQueueMax(), maxAttempts: jobMaxAttempts() }) : null;
  const admission = jobs ? createRoutineAdmission({
    jobs,
    scheduler: (botId) => schedulerForInstance(deps.bot(botId)?.modelSelection.instanceId),
    model: (botId) => deps.bot(botId)?.modelSelection.model ?? null,
    agingMs: schedulerLimits().backgroundAgingMs,
  }) : null;
  let routines: RoutineRuns | null = null;
  return {
    routineOptions: admission ? { admitBackground: (run: RoutineRun) => admission.admit(run) } : {},
    runChanged(run: RoutineRun) { admission?.mirror(run); },
    adopt(manager: RoutineRuns) {
      routines = manager;
      admission?.reconcile(new Set(manager.listRuns().filter((run) => LIVE_RUN.has(run.status)).map((run) => run.id)));
    },
    routes: () => createWorkloadRoutes({
      snapshots: schedulerSnapshots,
      jobs,
      cancelJob: async (job) => {
        const runId = routineRunId(job.dedupeKey);
        return Boolean(runId && routines && await routines.cancelRun(runId, "Cancelled from the background job queue"));
      },
    }),
    close() {
      shutdownSchedulers();
      jobs?.close();
    },
  };
}
