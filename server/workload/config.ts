import { DEFAULT_LIMITS, type SchedulerLimits } from "./scheduler.ts";

type Env = Record<string, string | undefined>;

export const SCHEDULER_ENV = {
  enabled: "OPENMAUS_OLLAMA_SCHEDULER_ENABLED",
  maxActive: "OPENMAUS_OLLAMA_MAX_ACTIVE_INFERENCE",
  maxInteractiveWaiting: "OPENMAUS_OLLAMA_MAX_INTERACTIVE_WAITING",
  maxWaitingPerBot: "OPENMAUS_OLLAMA_MAX_WAITING_PER_BOT",
  interactiveMaxWaitMs: "OPENMAUS_OLLAMA_INTERACTIVE_MAX_WAIT_MS",
  maxBackgroundWaiting: "OPENMAUS_OLLAMA_BACKGROUND_WAITING_MAX",
  backgroundQueueMax: "OPENMAUS_OLLAMA_BACKGROUND_QUEUE_MAX",
  agingPolicy: "OPENMAUS_OLLAMA_BACKGROUND_AGING_POLICY",
  jobMaxAttempts: "OPENMAUS_OLLAMA_BACKGROUND_JOB_MAX_ATTEMPTS",
} as const;

export const DEFAULT_BACKGROUND_QUEUE_MAX = 200;
export const DEFAULT_JOB_MAX_ATTEMPTS = 2;

const ON = new Set(["1", "true", "on", "yes"]);

export function schedulerEnabled(env: Env = process.env): boolean {
  return ON.has((env[SCHEDULER_ENV.enabled] ?? "").trim().toLowerCase());
}

function wholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

/** "off", or "age:<seconds>" for how long a background request waits before it may go ahead of waiting interactive work. */
export function agingMs(raw: string | undefined): number | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return DEFAULT_LIMITS.backgroundAgingMs;
  if (value === "off") return null;
  const seconds = /^age:(\d+)$/.exec(value)?.[1];
  const parsed = seconds === undefined ? NaN : Number(seconds);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 86_400 ? parsed * 1000 : DEFAULT_LIMITS.backgroundAgingMs;
}

export function schedulerLimits(env: Env = process.env): SchedulerLimits {
  return {
    maxActive: wholeNumber(env, SCHEDULER_ENV.maxActive, DEFAULT_LIMITS.maxActive, 1, 8),
    maxInteractiveWaiting: wholeNumber(env, SCHEDULER_ENV.maxInteractiveWaiting, DEFAULT_LIMITS.maxInteractiveWaiting, 0, 32),
    maxWaitingPerBot: wholeNumber(env, SCHEDULER_ENV.maxWaitingPerBot, DEFAULT_LIMITS.maxWaitingPerBot, 1, 32),
    maxBackgroundWaiting: wholeNumber(env, SCHEDULER_ENV.maxBackgroundWaiting, DEFAULT_LIMITS.maxBackgroundWaiting, 1, 256),
    interactiveMaxWaitMs: wholeNumber(env, SCHEDULER_ENV.interactiveMaxWaitMs, DEFAULT_LIMITS.interactiveMaxWaitMs, 1_000, 3_600_000),
    backgroundAgingMs: agingMs(env[SCHEDULER_ENV.agingPolicy]),
  };
}

export function backgroundQueueMax(env: Env = process.env): number {
  return wholeNumber(env, SCHEDULER_ENV.backgroundQueueMax, DEFAULT_BACKGROUND_QUEUE_MAX, 1, 10_000);
}

export function jobMaxAttempts(env: Env = process.env): number {
  return wholeNumber(env, SCHEDULER_ENV.jobMaxAttempts, DEFAULT_JOB_MAX_ATTEMPTS, 1, 5);
}
