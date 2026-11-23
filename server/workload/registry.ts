import { schedulerEnabled, schedulerLimits } from "./config.ts";
import { WorkloadScheduler, type SchedulerEvent } from "./scheduler.ts";

const schedulers = new Map<string, WorkloadScheduler>();
const instanceOrigins = new Map<string, string>();

const logEvent = (event: SchedulerEvent) => console.info(`[omb-scheduler] ${JSON.stringify(event)}`);

/** One scheduler per Ollama origin for the whole server process: every bot and every engine instance that sends to the
 * same origin shares its slot. The server lease keeps one process per data directory. */
export function schedulerKey(apiUrl: string): string | null {
  try {
    const url = new URL(apiUrl);
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function sharedScheduler(apiUrl: string): WorkloadScheduler | null {
  if (!schedulerEnabled()) return null;
  const key = schedulerKey(apiUrl);
  if (!key) return null;
  let scheduler = schedulerFor(key);
  if (!scheduler) {
    scheduler = new WorkloadScheduler(key, schedulerLimits(), logEvent);
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

export function schedulerFor(key: string): WorkloadScheduler | undefined {
  return schedulers.get(key);
}

/** An engine instance whose requests a scheduler admits, so work started outside the driver can ask that scheduler. */
export function registerInstanceOrigin(instanceId: string, apiUrl: string) {
  instanceOrigins.set(instanceId, apiUrl);
}

export function schedulerForInstance(instanceId: string | undefined): WorkloadScheduler | null {
  const apiUrl = instanceId ? instanceOrigins.get(instanceId) : undefined;
  return apiUrl ? sharedScheduler(apiUrl) : null;
}

export function schedulerSnapshots() {
  return { enabled: schedulerEnabled(), schedulers: [...schedulers.values()].map((scheduler) => scheduler.snapshot()) };
}

export function shutdownSchedulers() {
  for (const scheduler of schedulers.values()) scheduler.shutdown();
}

export function resetSchedulersForTests() {
  for (const scheduler of schedulers.values()) scheduler.shutdown();
  schedulers.clear();
  instanceOrigins.clear();
}
