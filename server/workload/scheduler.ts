import { newId } from "../contracts.ts";
import { RuntimeNoticeError } from "../drivers/runtime-notice-error.ts";
import { MODEL_BUSY_NOTICE } from "./busy-notice.ts";
import type { WorkloadClass, WorkloadSource } from "./types.ts";

export type { WorkloadClass, WorkloadSource };

export interface WorkloadMetadata {
  workloadClass: WorkloadClass;
  source: WorkloadSource;
  requestId: string;
  botId?: string;
  threadId?: string;
  taskId?: string;
  model?: string;
  /** A later round of a turn that was already admitted. It may have run tools, so refusing it would strand half-done
   * work; it goes ahead of new turns and is refused only when every waiting place already holds another such round. */
  continuation?: boolean;
}

export interface SchedulerLimits {
  maxActive: number;
  maxInteractiveWaiting: number;
  maxWaitingPerBot: number;
  maxBackgroundWaiting: number;
  interactiveMaxWaitMs: number;
  /** A background request waiting at least this long goes before waiting interactive work, at most every other
   * dispatch; null turns aging off. */
  backgroundAgingMs: number | null;
}

export const DEFAULT_LIMITS: SchedulerLimits = {
  maxActive: 1,
  maxInteractiveWaiting: 2,
  maxWaitingPerBot: 1,
  maxBackgroundWaiting: 8,
  interactiveMaxWaitMs: 180_000,
  backgroundAgingMs: 120_000,
};

export type BusyReason = "queue-full" | "bot-share" | "wait-timeout" | "displaced" | "background-full" | "shutdown";
export type ReleaseOutcome = "completed" | "failed" | "cancelled";

export const OLLAMA_BUSY = "OLLAMA_BUSY";

export class OllamaBusyError extends RuntimeNoticeError {
  readonly code = OLLAMA_BUSY;
  readonly status = 503;
  readonly reason: BusyReason;
  readonly retryAfterSeconds: number;
  constructor(reason: BusyReason, retryAfterSeconds: number) {
    super(
      `The local model is busy with other bots' requests, so this message was not sent to it. Try again in about ${retryAfterSeconds} seconds.`,
      MODEL_BUSY_NOTICE,
      { seconds: String(retryAfterSeconds) },
    );
    this.name = "OllamaBusyError";
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const isBusy = (error: unknown): error is OllamaBusyError => error instanceof OllamaBusyError;

export type SchedulerEventName =
  | "request_received"
  | "request_classified"
  | "request_queued"
  | "request_rejected"
  | "inference_slot_acquired"
  | "ollama_request_sent"
  | "first_token_received"
  | "stream_completed"
  | "request_cancelled"
  | "request_failed"
  | "model_switch_observed";

export interface SchedulerEvent {
  event: SchedulerEventName;
  at: string;
  key: string;
  requestId: string;
  workloadClass: WorkloadClass;
  source: WorkloadSource;
  botId?: string;
  threadId?: string;
  taskId?: string;
  model?: string;
  continuation?: boolean;
  waitMs?: number;
  serviceMs?: number;
  ttftMs?: number;
  totalMs?: number;
  reason?: string;
  queueDepth?: { interactive: number; background: number };
}

export interface InferencePermit {
  readonly meta: WorkloadMetadata;
  readonly waitedMs: number;
  sent(): void;
  firstToken(): void;
  /** True only for the call that actually released the slot. */
  release(outcome: ReleaseOutcome, reason?: string): boolean;
}

interface Waiter {
  meta: WorkloadMetadata;
  receivedAt: number;
  seq: number;
  grant(permit: InferencePermit): void;
  refuse(error: Error): void;
}

const SAMPLE_WINDOW = 200;

class Samples {
  private values: number[] = [];
  private total = 0;
  private count = 0;
  private largest = 0;
  add(value: number) {
    this.values.push(value);
    if (this.values.length > SAMPLE_WINDOW) this.values.shift();
    this.total += value;
    this.count += 1;
    this.largest = Math.max(this.largest, value);
  }
  summary() {
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null;
    return { n: this.count, meanMs: this.count ? Math.round(this.total / this.count) : null, p50Ms: at(0.5), p90Ms: at(0.9), maxMs: this.count ? this.largest : null };
  }
}

const MIN_RETRY_SECONDS = 10;
const MAX_RETRY_SECONDS = 300;
const INITIAL_SERVICE_MS = 20_000;
const MAX_BOTS_REPORTED = 64;

export class WorkloadScheduler {
  private readonly interactive: Waiter[] = [];
  private readonly background: Waiter[] = [];
  private readonly running = new Map<string, { meta: WorkloadMetadata; acquiredAt: number; firstTokenAt?: number }>();
  private seq = 0;
  private lastGrantAged = false;
  private lastModel: string | undefined;
  private serviceEstimateMs = INITIAL_SERVICE_MS;
  private closed = false;
  private readonly counters = {
    received: 0, admittedImmediately: 0, queued: 0, completed: 0, failed: 0,
    cancelledWaiting: 0, cancelledActive: 0, unclassified: 0, modelSwitches: 0, agedBackgroundGrants: 0,
    rejected: { "queue-full": 0, "bot-share": 0, "wait-timeout": 0, displaced: 0, "background-full": 0, shutdown: 0 } as Record<BusyReason, number>,
    byClass: { interactive: 0, background: 0 } as Record<WorkloadClass, number>,
    bySource: {} as Partial<Record<WorkloadSource, number>>,
    byBot: new Map<string, number>(),
  };
  private readonly maxObserved = { active: 0, interactiveWaiting: 0, backgroundWaiting: 0 };
  private readonly timings = { interactiveWait: new Samples(), backgroundWait: new Samples(), service: new Samples(), ttft: new Samples(), total: new Samples() };

  readonly key: string;
  readonly limits: SchedulerLimits;
  private readonly log: (event: SchedulerEvent) => void;
  private readonly now: () => number;

  constructor(key: string, limits: SchedulerLimits = DEFAULT_LIMITS, log: (event: SchedulerEvent) => void = () => {}, now: () => number = Date.now) {
    this.key = key;
    this.limits = limits;
    this.log = log;
    this.now = now;
  }

  acquire(meta: WorkloadMetadata, signal?: AbortSignal): Promise<InferencePermit> {
    const receivedAt = this.now();
    this.counters.received += 1;
    this.counters.byClass[meta.workloadClass] += 1;
    this.counters.bySource[meta.source] = (this.counters.bySource[meta.source] ?? 0) + 1;
    if (meta.source === "unclassified") this.counters.unclassified += 1;
    if (meta.botId) this.countBot(meta.botId);
    this.emit("request_received", meta);
    this.emit("request_classified", meta);
    if (signal?.aborted) {
      this.counters.cancelledWaiting += 1;
      this.emit("request_cancelled", meta, { reason: "aborted-before-queue" });
      return Promise.reject(signal.reason);
    }
    if (this.closed) return Promise.reject(this.refusal("shutdown", meta, receivedAt));
    if (this.running.size < this.limits.maxActive && !this.interactive.length && !this.background.length) {
      this.counters.admittedImmediately += 1;
      return Promise.resolve(this.grantNow(meta, receivedAt));
    }

    return new Promise<InferencePermit>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        meta, receivedAt, seq: this.seq++,
        grant: (permit) => { settle(); resolve(permit); },
        refuse: (error) => { settle(); reject(error); },
      };
      const onAbort = () => {
        if (!this.remove(waiter)) return;
        this.counters.cancelledWaiting += 1;
        this.emit("request_cancelled", meta, { reason: "aborted-while-queued", waitMs: this.now() - receivedAt });
        waiter.refuse(signal!.reason instanceof Error ? signal!.reason : new DOMException("The request was cancelled while queued", "AbortError"));
      };
      const refused = this.enqueue(waiter);
      if (refused) { reject(refused); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (meta.workloadClass === "interactive") {
        timer = setTimeout(() => {
          if (!this.remove(waiter)) return;
          waiter.refuse(this.refusal("wait-timeout", meta, receivedAt));
        }, this.limits.interactiveMaxWaitMs);
        timer.unref?.();
      }
    });
  }

  /** Refuses every waiting request; running requests keep their slots until their own streams end. */
  shutdown() {
    this.closed = true;
    for (const waiter of [...this.interactive, ...this.background]) {
      this.remove(waiter);
      waiter.refuse(this.refusal("shutdown", waiter.meta, waiter.receivedAt));
    }
  }

  snapshot() {
    const now = this.now();
    const waiting = (rows: Waiter[]) => rows.map((waiter) => ({
      requestId: waiter.meta.requestId, botId: waiter.meta.botId ?? null, source: waiter.meta.source,
      continuation: Boolean(waiter.meta.continuation), waitingMs: now - waiter.receivedAt,
    }));
    return {
      key: this.key,
      limits: this.limits,
      active: [...this.running.entries()].map(([requestId, run]) => ({
        requestId, botId: run.meta.botId ?? null, workloadClass: run.meta.workloadClass, source: run.meta.source,
        model: run.meta.model ?? null, runningMs: now - run.acquiredAt, firstTokenMs: run.firstTokenAt ? run.firstTokenAt - run.acquiredAt : null,
      })),
      interactiveWaiting: waiting(this.interactive),
      backgroundWaiting: waiting(this.background),
      oldestBackgroundAgeMs: this.background[0] ? now - this.background[0].receivedAt : null,
      maxObserved: { ...this.maxObserved },
      counters: {
        ...this.counters,
        rejected: { ...this.counters.rejected },
        byClass: { ...this.counters.byClass },
        bySource: { ...this.counters.bySource },
        byBot: Object.fromEntries([...this.counters.byBot.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_BOTS_REPORTED)),
      },
      timings: {
        interactiveWait: this.timings.interactiveWait.summary(),
        backgroundWait: this.timings.backgroundWait.summary(),
        service: this.timings.service.summary(),
        timeToFirstToken: this.timings.ttft.summary(),
        total: this.timings.total.summary(),
      },
      retryAfterSeconds: this.retryAfterSeconds(),
    };
  }

  get activeCount() { return this.running.size; }
  get interactiveDepth() { return this.interactive.length; }
  get backgroundDepth() { return this.background.length; }
  /** Room to start one more background job without making a waiting person wait longer. */
  get idleForBackground() { return this.running.size < this.limits.maxActive && !this.interactive.length; }

  private enqueue(waiter: Waiter): OllamaBusyError | null {
    const { meta } = waiter;
    if (meta.workloadClass === "background") {
      if (this.background.length >= this.limits.maxBackgroundWaiting) return this.refusal("background-full", meta, waiter.receivedAt);
      this.background.push(waiter);
    } else if (meta.continuation) {
      if (this.interactive.length >= this.limits.maxInteractiveWaiting) {
        const newest = [...this.interactive].reverse().find((entry) => !entry.meta.continuation);
        if (!newest) return this.refusal("queue-full", meta, waiter.receivedAt);
        this.remove(newest);
        newest.refuse(this.refusal("displaced", newest.meta, newest.receivedAt));
      }
      const firstNew = this.interactive.findIndex((entry) => !entry.meta.continuation);
      this.interactive.splice(firstNew === -1 ? this.interactive.length : firstNew, 0, waiter);
    } else {
      if (this.interactive.length >= this.limits.maxInteractiveWaiting) return this.refusal("queue-full", meta, waiter.receivedAt);
      const sameBot = this.interactive.filter((entry) => !entry.meta.continuation && this.fairnessKey(entry.meta) === this.fairnessKey(meta)).length;
      if (sameBot >= this.limits.maxWaitingPerBot) return this.refusal("bot-share", meta, waiter.receivedAt);
      this.interactive.push(waiter);
    }
    this.counters.queued += 1;
    this.maxObserved.interactiveWaiting = Math.max(this.maxObserved.interactiveWaiting, this.interactive.length);
    this.maxObserved.backgroundWaiting = Math.max(this.maxObserved.backgroundWaiting, this.background.length);
    this.emit("request_queued", meta, { queueDepth: { interactive: this.interactive.length, background: this.background.length } });
    return null;
  }

  private fairnessKey(meta: WorkloadMetadata) {
    return meta.botId ?? meta.threadId ?? "unattributed";
  }

  private remove(waiter: Waiter): boolean {
    for (const queue of [this.interactive, this.background]) {
      const index = queue.indexOf(waiter);
      if (index !== -1) { queue.splice(index, 1); return true; }
    }
    return false;
  }

  private nextWaiter(): { waiter: Waiter; aged: boolean } | null {
    const oldestBackground = this.background[0];
    const aged = Boolean(oldestBackground && this.interactive.length && this.limits.backgroundAgingMs !== null && !this.lastGrantAged
      && this.now() - oldestBackground.receivedAt >= this.limits.backgroundAgingMs);
    if (aged) return { waiter: this.background.shift()!, aged: true };
    if (this.interactive.length) return { waiter: this.interactive.shift()!, aged: false };
    if (this.background.length) return { waiter: this.background.shift()!, aged: false };
    return null;
  }

  private dispatch() {
    while (this.running.size < this.limits.maxActive) {
      const next = this.nextWaiter();
      if (!next) return;
      this.lastGrantAged = next.aged;
      if (next.aged) this.counters.agedBackgroundGrants += 1;
      next.waiter.grant(this.grantNow(next.waiter.meta, next.waiter.receivedAt));
    }
  }

  private grantNow(meta: WorkloadMetadata, receivedAt: number): InferencePermit {
    const acquiredAt = this.now();
    const waitedMs = acquiredAt - receivedAt;
    const run: { meta: WorkloadMetadata; acquiredAt: number; firstTokenAt?: number } = { meta, acquiredAt };
    const slotId = newId();
    this.running.set(slotId, run);
    this.maxObserved.active = Math.max(this.maxObserved.active, this.running.size);
    (meta.workloadClass === "interactive" ? this.timings.interactiveWait : this.timings.backgroundWait).add(waitedMs);
    if (meta.model) {
      if (this.lastModel !== undefined && this.lastModel !== meta.model) {
        this.counters.modelSwitches += 1;
        this.emit("model_switch_observed", meta, { reason: `${this.lastModel} -> ${meta.model}` });
      }
      this.lastModel = meta.model;
    }
    this.emit("inference_slot_acquired", meta, { waitMs: waitedMs });
    let released = false;
    let sentLogged = false;
    return {
      meta,
      waitedMs,
      sent: () => {
        if (released || sentLogged) return;
        sentLogged = true;
        this.emit("ollama_request_sent", meta);
      },
      firstToken: () => {
        if (released || run.firstTokenAt !== undefined) return;
        run.firstTokenAt = this.now();
        this.timings.ttft.add(run.firstTokenAt - acquiredAt);
        this.emit("first_token_received", meta, { ttftMs: run.firstTokenAt - acquiredAt, waitMs: waitedMs });
      },
      release: (outcome, reason) => {
        if (released) return false;
        released = true;
        this.running.delete(slotId);
        const end = this.now();
        const serviceMs = end - acquiredAt;
        this.timings.service.add(serviceMs);
        this.timings.total.add(end - receivedAt);
        if (outcome === "completed") {
          this.counters.completed += 1;
          this.serviceEstimateMs = Math.round(this.serviceEstimateMs * 0.8 + serviceMs * 0.2);
        } else if (outcome === "failed") this.counters.failed += 1;
        else this.counters.cancelledActive += 1;
        const timing = { waitMs: waitedMs, serviceMs, totalMs: end - receivedAt, ...(run.firstTokenAt ? { ttftMs: run.firstTokenAt - acquiredAt } : {}), ...(reason ? { reason } : {}) };
        this.emit(outcome === "completed" ? "stream_completed" : outcome === "failed" ? "request_failed" : "request_cancelled", meta, timing);
        this.dispatch();
        return true;
      },
    };
  }

  private refusal(reason: BusyReason, meta: WorkloadMetadata, receivedAt: number) {
    this.counters.rejected[reason] += 1;
    const error = new OllamaBusyError(reason, this.retryAfterSeconds());
    this.emit("request_rejected", meta, { reason, waitMs: this.now() - receivedAt });
    return error;
  }

  private retryAfterSeconds() {
    const ahead = this.running.size + this.interactive.length;
    const seconds = Math.ceil((Math.max(1, ahead) * this.serviceEstimateMs) / 1000);
    return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, seconds));
  }

  private countBot(botId: string) {
    this.counters.byBot.set(botId, (this.counters.byBot.get(botId) ?? 0) + 1);
  }

  private emit(event: SchedulerEventName, meta: WorkloadMetadata, extra: Partial<SchedulerEvent> = {}) {
    this.log({
      event, at: new Date(this.now()).toISOString(), key: this.key, requestId: meta.requestId,
      workloadClass: meta.workloadClass, source: meta.source,
      ...(meta.botId ? { botId: meta.botId } : {}),
      ...(meta.threadId ? { threadId: meta.threadId } : {}),
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.continuation ? { continuation: true } : {}),
      ...extra,
    });
  }
}

/** Runs `work` while holding one inference slot, and releases it exactly once however `work` ends. */
export async function withInferenceSlot<T>(
  scheduler: WorkloadScheduler,
  meta: WorkloadMetadata,
  signal: AbortSignal | undefined,
  work: (permit: InferencePermit) => Promise<T>,
): Promise<T> {
  const permit = await scheduler.acquire(meta, signal);
  try {
    const result = await work(permit);
    permit.release("completed");
    return result;
  } catch (error) {
    permit.release(signal?.aborted ? "cancelled" : "failed", errorCategory(error));
    throw error;
  }
}

export function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AbortError" || error.name === "TimeoutError") return error.message.includes("idle timeout") ? "idle-timeout" : "aborted";
  const status = /HTTP (\d{3})/.exec(error.message)?.[1];
  if (status) return `http-${status}`;
  if (error.name === "ChatProtocolError") return "protocol";
  return error.name || "error";
}
