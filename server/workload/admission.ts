import type { TurnWorkload } from "../contracts.ts";
import { newId } from "../contracts.ts";
import type { InferencePermit, WorkloadMetadata, WorkloadScheduler } from "./scheduler.ts";

export { errorCategory, type InferencePermit, type WorkloadMetadata, type WorkloadScheduler } from "./scheduler.ts";

/** A held slot, or null when no scheduler governs the server. The caller releases it once the reply has ended. */
export async function admitted(admission: () => Promise<WorkloadScheduler | null>, meta: WorkloadMetadata, signal?: AbortSignal): Promise<InferencePermit | null> {
  const scheduler = await admission();
  return scheduler ? scheduler.acquire(meta, signal) : null;
}

export function requestWorkload(workload: TurnWorkload | undefined, botId: string | undefined, threadId: string | undefined): WorkloadMetadata {
  return {
    workloadClass: workload?.workloadClass ?? "interactive",
    source: workload?.source ?? "unclassified",
    requestId: newId(),
    ...(botId ? { botId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(workload?.taskId ? { taskId: workload.taskId } : {}),
  };
}
