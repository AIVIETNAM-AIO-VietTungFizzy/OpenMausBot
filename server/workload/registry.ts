import { hostname, networkInterfaces } from "node:os";
import { isLoopback } from "../provider-key-check.ts";
import { schedulerEnabled, schedulerLimits } from "./config.ts";
import { WorkloadScheduler, type SchedulerEvent } from "./scheduler.ts";

const schedulers = new Map<string, WorkloadScheduler>();
const instanceOrigins = new Map<string, string>();

const logEvent = (event: SchedulerEvent) => console.info(`[omb-scheduler] ${JSON.stringify(event)}`);

const SAME_MACHINE_KEY_HOST = "127.0.0.1";
const UNSPECIFIED = new Set(["0.0.0.0", "::"]);

function onThisMachine(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopback(bare) || UNSPECIFIED.has(bare)) return true;
  const own = hostname().toLowerCase();
  if (bare === own || bare === `${own.replace(/\.local$/, "")}.local`) return true;
  return Object.values(networkInterfaces()).some((addresses) => addresses?.some((address) => address.address.toLowerCase() === bare));
}

/** One scheduler per Ollama server for the whole server process: every bot and every engine instance that sends to the
 * same server shares its slot, whichever name for this machine its URL uses. The server lease keeps one process per data
 * directory. */
export function schedulerKey(apiUrl: string): string | null {
  try {
    const url = new URL(apiUrl);
    const host = onThisMachine(url.hostname) ? SAME_MACHINE_KEY_HOST : url.hostname.toLowerCase();
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
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
