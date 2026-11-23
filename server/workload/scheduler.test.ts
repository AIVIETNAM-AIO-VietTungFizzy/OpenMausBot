import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaBusyError, WorkloadScheduler, withInferenceSlot, type InferencePermit, type SchedulerEvent, type SchedulerLimits, type WorkloadMetadata } from "./scheduler.ts";
import { agingMs, schedulerEnabled, schedulerLimits } from "./config.ts";

const LIMITS: SchedulerLimits = {
  maxActive: 1,
  maxInteractiveWaiting: 2,
  maxWaitingPerBot: 1,
  maxBackgroundWaiting: 3,
  interactiveMaxWaitMs: 60_000,
  backgroundAgingMs: 10_000,
};

let seq = 0;
const ask = (botId: string, extra: Partial<WorkloadMetadata> = {}): WorkloadMetadata => ({
  workloadClass: "interactive", source: "person-turn", requestId: `r${++seq}`, botId, threadId: `t-${botId}`, ...extra,
});
const background = (botId: string, extra: Partial<WorkloadMetadata> = {}) => ask(botId, { workloadClass: "background", source: "background-job", ...extra });

function fixture(limits: Partial<SchedulerLimits> = {}) {
  let clock = 0;
  const events: SchedulerEvent[] = [];
  const scheduler = new WorkloadScheduler("http://ollama.test", { ...LIMITS, ...limits }, (event) => events.push(event), () => clock);
  return { scheduler, events, advance: (ms: number) => { clock += ms; } };
}

/** Records the order permits are granted in; a pending promise never resolves on its own. */
function track(promise: Promise<InferencePermit>, order: string[]) {
  const state: { permit?: InferencePermit; error?: unknown } = {};
  promise.then((permit) => { state.permit = permit; order.push(permit.meta.requestId); }, (error) => { state.error = error; });
  return state;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => vi.useRealTimers());

describe("admission limits", () => {
  it("runs one request, queues two interactive requests and refuses the fourth with OLLAMA_BUSY", async () => {
    const { scheduler } = fixture();
    const order: string[] = [];
    const first = track(scheduler.acquire(ask("a")), order);
    const second = track(scheduler.acquire(ask("b")), order);
    const third = track(scheduler.acquire(ask("c")), order);
    const fourth = track(scheduler.acquire(ask("d")), order);
    await flush();
    expect(first.permit).toBeDefined();
    expect(second.permit).toBeUndefined();
    expect(third.permit).toBeUndefined();
    expect(fourth.error).toBeInstanceOf(OllamaBusyError);
    expect(fourth.error).toMatchObject({ code: "OLLAMA_BUSY", status: 503, reason: "queue-full", text: { key: "chat.notice.modelBusy" } });
    expect((fourth.error as OllamaBusyError).retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.interactiveDepth).toBe(2);

    first.permit!.release("completed");
    await flush();
    expect(second.permit).toBeDefined();
    expect(scheduler.activeCount).toBe(1);
    second.permit!.release("completed");
    await flush();
    third.permit!.release("completed");
    expect(order).toEqual([first.permit!.meta.requestId, second.permit!.meta.requestId, third.permit!.meta.requestId]);
    expect(scheduler.snapshot().maxObserved).toEqual({ active: 1, interactiveWaiting: 2, backgroundWaiting: 0 });
  });

  it("keeps one bot from holding both waiting places", async () => {
    const { scheduler } = fixture();
    const running = track(scheduler.acquire(ask("a")), []);
    const waiting = track(scheduler.acquire(ask("b")), []);
    const again = track(scheduler.acquire(ask("b", { threadId: "another-thread" })), []);
    const other = track(scheduler.acquire(ask("c")), []);
    await flush();
    expect(running.permit).toBeDefined();
    expect(waiting.error).toBeUndefined();
    expect(again.error).toMatchObject({ reason: "bot-share" });
    expect(other.error).toBeUndefined();
    expect(scheduler.interactiveDepth).toBe(2);
  });

  it("releases a permit exactly once and never lets two requests run", async () => {
    const { scheduler } = fixture();
    const first = track(scheduler.acquire(ask("a")), []);
    const second = track(scheduler.acquire(ask("b")), []);
    await flush();
    expect(first.permit!.release("completed")).toBe(true);
    expect(first.permit!.release("failed")).toBe(false);
    expect(first.permit!.release("cancelled")).toBe(false);
    await flush();
    expect(second.permit).toBeDefined();
    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.snapshot().counters).toMatchObject({ completed: 1, failed: 0, cancelledActive: 0 });
  });

  it("refuses a request that waited longer than the interactive limit", async () => {
    vi.useFakeTimers();
    const scheduler = new WorkloadScheduler("http://ollama.test", { ...LIMITS, interactiveMaxWaitMs: 5_000 });
    const running = await scheduler.acquire(ask("a"));
    const waiting = scheduler.acquire(ask("b"));
    const outcome = waiting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toMatchObject({ reason: "wait-timeout", code: "OLLAMA_BUSY" });
    expect(scheduler.interactiveDepth).toBe(0);
    running.release("completed");
    expect(scheduler.activeCount).toBe(0);
  });
});

describe("cancellation", () => {
  it("drops a queued request whose caller went away and never grants it", async () => {
    const { scheduler, events } = fixture();
    const running = track(scheduler.acquire(ask("a")), []);
    const abort = new AbortController();
    const queued = track(scheduler.acquire(ask("b"), abort.signal), []);
    await flush();
    abort.abort();
    await flush();
    expect(queued.error).toMatchObject({ name: "AbortError" });
    expect(scheduler.interactiveDepth).toBe(0);
    running.permit!.release("completed");
    await flush();
    expect(queued.permit).toBeUndefined();
    expect(scheduler.activeCount).toBe(0);
    expect(events.filter((event) => event.event === "request_cancelled")).toHaveLength(1);
  });

  it("refuses a request whose signal was already aborted", async () => {
    const { scheduler } = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(scheduler.acquire(ask("a"), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.activeCount).toBe(0);
  });

  it("releases on success, failure and cancellation through withInferenceSlot", async () => {
    const { scheduler } = fixture();
    await withInferenceSlot(scheduler, ask("a"), undefined, async () => "ok");
    await expect(withInferenceSlot(scheduler, ask("b"), undefined, async () => { throw new Error("upstream HTTP 500: boom"); })).rejects.toThrow("HTTP 500");
    const abort = new AbortController();
    await expect(withInferenceSlot(scheduler, ask("c"), abort.signal, async () => { abort.abort(); throw new DOMException("stopped", "AbortError"); })).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.snapshot().counters).toMatchObject({ completed: 1, failed: 1, cancelledActive: 1 });
  });

  it("refuses every waiting request on shutdown and lets the running one finish", async () => {
    const { scheduler } = fixture();
    const running = track(scheduler.acquire(ask("a")), []);
    const queued = track(scheduler.acquire(ask("b")), []);
    const waitingBackground = track(scheduler.acquire(background("c")), []);
    await flush();
    scheduler.shutdown();
    await flush();
    expect(queued.error).toMatchObject({ reason: "shutdown" });
    expect(waitingBackground.error).toMatchObject({ reason: "shutdown" });
    expect(running.permit!.release("completed")).toBe(true);
    await expect(scheduler.acquire(ask("d"))).rejects.toMatchObject({ reason: "shutdown" });
  });
});

describe("priority, continuation and aging", () => {
  it("serves waiting interactive work before waiting background work", async () => {
    const { scheduler } = fixture({ backgroundAgingMs: null });
    const order: string[] = [];
    const running = track(scheduler.acquire(ask("a")), order);
    const job = track(scheduler.acquire(background("job")), order);
    const person = track(scheduler.acquire(ask("b")), order);
    await flush();
    running.permit!.release("completed");
    await flush();
    expect(person.permit).toBeDefined();
    expect(job.permit).toBeUndefined();
    person.permit!.release("completed");
    await flush();
    expect(job.permit).toBeDefined();
    expect(order).toEqual([running.permit!.meta.requestId, person.permit!.meta.requestId, job.permit!.meta.requestId]);
  });

  it("lets an aged background request go once, then alternates with waiting interactive work", async () => {
    const { scheduler, advance } = fixture({ backgroundAgingMs: 10_000, maxInteractiveWaiting: 3, maxWaitingPerBot: 3 });
    const order: string[] = [];
    const states = new Map<string, ReturnType<typeof track>>();
    const add = (meta: WorkloadMetadata) => states.set(meta.requestId, track(scheduler.acquire(meta), order));
    add(ask("a", { requestId: "first" }));
    add(background("job", { requestId: "job-1" }));
    add(background("job", { requestId: "job-2" }));
    advance(10_000);
    add(ask("b", { requestId: "person-1" }));
    add(ask("c", { requestId: "person-2" }));
    await flush();
    for (let step = 0; step < 4; step++) {
      states.get(order.at(-1)!)!.permit!.release("completed");
      await flush();
    }
    expect(order).toEqual(["first", "job-1", "person-1", "job-2", "person-2"]);
    expect(scheduler.snapshot().counters.agedBackgroundGrants).toBe(2);
  });

  it("puts a later round of an admitted turn ahead of new turns and displaces the newest new turn when full", async () => {
    const { scheduler } = fixture();
    const order: string[] = [];
    const running = track(scheduler.acquire(ask("a")), order);
    const older = track(scheduler.acquire(ask("b", { requestId: "new-old" })), order);
    const newer = track(scheduler.acquire(ask("c", { requestId: "new-young" })), order);
    const round = track(scheduler.acquire(ask("d", { requestId: "round-2", continuation: true })), order);
    await flush();
    expect(newer.error).toMatchObject({ reason: "displaced" });
    expect(older.error).toBeUndefined();
    expect(round.error).toBeUndefined();
    expect(scheduler.interactiveDepth).toBe(2);
    running.permit!.release("completed");
    await flush();
    expect(order.at(-1)).toBe("round-2");
  });

  it("refuses a later round only when every waiting place already holds another later round", async () => {
    const { scheduler } = fixture();
    track(scheduler.acquire(ask("a")), []);
    track(scheduler.acquire(ask("b", { continuation: true })), []);
    track(scheduler.acquire(ask("c", { continuation: true })), []);
    const third = track(scheduler.acquire(ask("d", { continuation: true })), []);
    await flush();
    expect(third.error).toMatchObject({ reason: "queue-full" });
  });

  it("bounds the background waiting list instead of growing it", async () => {
    const { scheduler } = fixture({ maxBackgroundWaiting: 2 });
    track(scheduler.acquire(ask("a")), []);
    track(scheduler.acquire(background("x")), []);
    track(scheduler.acquire(background("y")), []);
    const overflow = track(scheduler.acquire(background("z")), []);
    await flush();
    expect(overflow.error).toMatchObject({ reason: "background-full" });
    expect(scheduler.backgroundDepth).toBe(2);
  });

  it("observes model switches without choosing a model", async () => {
    const { scheduler, events } = fixture();
    (await scheduler.acquire(ask("a", { model: "qwen3.8:27b" }))).release("completed");
    (await scheduler.acquire(ask("b", { model: "qwen3.5:9b" }))).release("completed");
    expect(scheduler.snapshot().counters.modelSwitches).toBe(1);
    expect(events.filter((event) => event.event === "model_switch_observed")).toHaveLength(1);
  });

  it("logs lifecycle timestamps without prompt content and separates queue wait from service time", async () => {
    const { scheduler, events, advance } = fixture();
    const first = await scheduler.acquire(ask("a"));
    const queued = scheduler.acquire(ask("b"));
    advance(4_000);
    first.release("completed");
    const second = await queued;
    second.sent();
    advance(1_000);
    second.firstToken();
    advance(2_000);
    second.release("completed");
    const names = events.filter((event) => event.requestId === second.meta.requestId).map((event) => event.event);
    expect(names).toEqual(["request_received", "request_classified", "request_queued", "inference_slot_acquired", "ollama_request_sent", "first_token_received", "stream_completed"]);
    const done = events.find((event) => event.requestId === second.meta.requestId && event.event === "stream_completed")!;
    expect(done).toMatchObject({ waitMs: 4_000, serviceMs: 3_000, ttftMs: 1_000, totalMs: 7_000 });
    for (const event of events) expect(Object.keys(event)).not.toContain("prompt");
  });
});

describe("configuration", () => {
  it("is off unless enabled and defaults to the fixed limits", () => {
    expect(schedulerEnabled({})).toBe(false);
    expect(schedulerEnabled({ OPENMAUS_OLLAMA_SCHEDULER_ENABLED: "1" })).toBe(true);
    expect(schedulerLimits({})).toEqual({ maxActive: 1, maxInteractiveWaiting: 2, maxWaitingPerBot: 1, maxBackgroundWaiting: 8, interactiveMaxWaitMs: 180_000, backgroundAgingMs: 120_000 });
    expect(schedulerLimits({ OPENMAUS_OLLAMA_MAX_ACTIVE_INFERENCE: "nonsense" }).maxActive).toBe(1);
  });

  it("parses the aging policy", () => {
    expect(agingMs("off")).toBeNull();
    expect(agingMs("age:30")).toBe(30_000);
    expect(agingMs("age:0")).toBe(120_000);
    expect(agingMs("whenever")).toBe(120_000);
  });
});

describe("fairness under bursts", () => {
  function driven(limits: Partial<SchedulerLimits> = {}) {
    const { scheduler, advance } = fixture(limits);
    const order: string[] = [];
    const states = new Map<string, ReturnType<typeof track>>();
    const add = (meta: WorkloadMetadata) => {
      const state = track(scheduler.acquire(meta), order);
      states.set(meta.requestId, state);
      return state;
    };
    const finishRunning = async () => {
      states.get(order.at(-1)!)!.permit!.release("completed");
      await flush();
    };
    return { scheduler, advance, order, add, finishRunning };
  }

  it("serves a waiting new turn after two later rounds of other turns went ahead of it", async () => {
    const { order, add, finishRunning } = driven();
    add(ask("a", { requestId: "a-1" }));
    add(ask("c", { requestId: "c-2", continuation: true }));
    add(ask("b", { requestId: "b-1" }));
    await flush();
    await finishRunning();
    add(ask("a", { requestId: "a-2", continuation: true }));
    await finishRunning();
    add(ask("c", { requestId: "c-3", continuation: true }));
    await finishRunning();
    expect(order).toEqual(["a-1", "c-2", "a-2", "b-1"]);
    await finishRunning();
    expect(order.at(-1)).toBe("c-3");
  });

  it("counts a bot's waiting later round toward its one waiting place", async () => {
    const { scheduler, add } = driven();
    add(ask("a"));
    const round = add(ask("b", { continuation: true }));
    const fresh = add(ask("b", { threadId: "another-thread" }));
    const other = add(ask("c"));
    await flush();
    expect(round.error).toBeUndefined();
    expect(fresh.error).toMatchObject({ reason: "bot-share" });
    expect(other.error).toBeUndefined();
    expect(scheduler.interactiveDepth).toBe(2);
  });

  it("keeps a background turn's later round when the background lane is full, in place of the newest new job", async () => {
    const { scheduler, order, add, finishRunning } = driven({ maxBackgroundWaiting: 2, backgroundAgingMs: null });
    add(ask("a", { requestId: "person" }));
    const older = add(background("x", { requestId: "job-x" }));
    const newer = add(background("y", { requestId: "job-y" }));
    const round = add(background("z", { requestId: "round-z", continuation: true }));
    await flush();
    expect(newer.error).toMatchObject({ reason: "displaced" });
    expect(older.error).toBeUndefined();
    expect(round.error).toBeUndefined();
    expect(scheduler.backgroundDepth).toBe(2);
    await finishRunning();
    await finishRunning();
    expect(order).toEqual(["person", "round-z", "job-x"]);
  });

  it("refuses a background later round only when every background place holds another later round", async () => {
    const { add } = driven({ maxBackgroundWaiting: 2 });
    add(ask("a"));
    add(background("x", { continuation: true }));
    add(background("y", { continuation: true }));
    const third = add(background("z", { continuation: true }));
    await flush();
    expect(third.error).toMatchObject({ reason: "background-full" });
  });

  it("ages the background lane by its oldest request, whichever goes first inside it", async () => {
    const { scheduler, advance, order, add, finishRunning } = driven({ backgroundAgingMs: 10_000 });
    add(ask("a", { requestId: "first" }));
    add(background("x", { requestId: "old-job" }));
    advance(10_000);
    add(background("z", { requestId: "round-z", continuation: true }));
    add(ask("b", { requestId: "person" }));
    await flush();
    expect(scheduler.snapshot().oldestBackgroundAgeMs).toBe(10_000);
    await finishRunning();
    expect(order).toEqual(["first", "round-z"]);
  });

  it("never lets a stale permit's late release free the slot of the request that followed it", async () => {
    const { scheduler } = fixture();
    const first = track(scheduler.acquire(ask("a")), []);
    const second = track(scheduler.acquire(ask("b")), []);
    const third = track(scheduler.acquire(ask("c")), []);
    await flush();
    first.permit!.release("completed");
    await flush();
    expect(second.permit).toBeDefined();
    expect(first.permit!.release("completed")).toBe(false);
    expect(first.permit!.release("cancelled")).toBe(false);
    await flush();
    expect(scheduler.activeCount).toBe(1);
    expect(third.permit).toBeUndefined();
    expect(scheduler.snapshot().counters).toMatchObject({ completed: 1, cancelledActive: 0 });
  });
});
