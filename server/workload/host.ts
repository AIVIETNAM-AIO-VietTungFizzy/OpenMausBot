import { join } from "node:path";
import { injectedOllamaUrl } from "../drivers/local-inject.ts";
import type { RoutineRun } from "../routines.ts";
import { createWorkloadRoutes } from "../routes/workload.ts";
import { BackgroundJobs } from "./background-jobs.ts";
import { backgroundQueueMax, jobMaxAttempts, schedulerEnabled, schedulerLimits } from "./config.ts";
import { schedulerFor, schedulerForInstance, schedulerKey, schedulerSnapshots, shutdownSchedulers } from "./registry.ts";
import { createRoutineAdmission, routineRunId } from "./routine-admission.ts";

interface Selection { instanceId: string; model?: string }

export interface WorkloadHostDeps {
  dataDir: string;
  bot(botId: string): { modelSelection: Selection } | null | undefined;
  bots(): Iterable<{ id: string; modelSelection: Selection; tasks?: ReadonlyArray<{ threadId: string; modelSelection?: Selection }> }>;
}

export interface UngovernedSender {
  botId: string;
  taskThreadId?: string;
  instanceId: string;
  origin: string;
  /** A scheduler admits other requests to this origin, so this bot's requests compete with them unseen. */
  sharesGovernedOrigin: boolean;
}

/** Bots whose CLI engine sends an injected Ollama model's requests from its own process, past the scheduler. */
export function ungovernedSenders(bots: WorkloadHostDeps["bots"]): UngovernedSender[] {
  const found: UngovernedSender[] = [];
  const note = (botId: string, selection: Selection | undefined, taskThreadId?: string) => {
    const url = injectedOllamaUrl(selection?.model);
    const origin = url ? schedulerKey(url) : null;
    if (!selection || !origin) return;
    found.push({ botId, ...(taskThreadId ? { taskThreadId } : {}), instanceId: selection.instanceId, origin, sharesGovernedOrigin: Boolean(schedulerFor(origin)) });
  };
  for (const bot of bots()) {
    note(bot.id, bot.modelSelection);
    for (const task of bot.tasks ?? []) note(bot.id, task.modelSelection, task.threadId);
  }
  return found;
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
      ungoverned: () => ungovernedSenders(deps.bots),
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
