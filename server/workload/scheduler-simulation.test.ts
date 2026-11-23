import { describe, expect, it, vi } from "vitest";
import { OllamaBusyError, WorkloadScheduler, withInferenceSlot, type WorkloadMetadata } from "./scheduler.ts";
import { DEFAULT_LIMITS } from "./scheduler.ts";

/** Deterministic: the same seed gives the same arrivals, durations and results. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Outcome { admitted: number; rejected: number; maxActive: number; maxInteractiveWaiting: number; maxWaitMs: number; byReason: Record<string, number>; perBotServed: number[]; maxWaitingPlacesPerBot: number }

/** 29 bots each send `rounds` requests at random times; Ollama takes 8–24 s of simulated time per request. */
async function simulate(seed: number, rounds: number, meanGapMs: number, backgroundShare = 0): Promise<Outcome> {
  vi.useFakeTimers();
  try {
    const next = random(seed);
    const scheduler = new WorkloadScheduler("http://ollama.test", DEFAULT_LIMITS);
    let active = 0;
    const outcome: Outcome = { admitted: 0, rejected: 0, maxActive: 0, maxInteractiveWaiting: 0, maxWaitMs: 0, byReason: {}, perBotServed: Array(29).fill(0), maxWaitingPlacesPerBot: 0 };
    const all: Promise<void>[] = [];
    for (let bot = 0; bot < 29; bot++) {
      let at = Math.floor(next() * meanGapMs);
      for (let round = 0; round < rounds; round++) {
        const start = at;
        const serviceMs = 8_000 + Math.floor(next() * 16_000);
        const background = next() < backgroundShare;
        const meta: WorkloadMetadata = {
          workloadClass: background ? "background" : "interactive", source: background ? "background-job" : "person-turn",
          requestId: `bot${bot}-r${round}`, botId: `bot-${bot}`,
        };
        all.push(new Promise<void>((resolve) => setTimeout(resolve, start)).then(() => withInferenceSlot(scheduler, meta, undefined, async (permit) => {
          active += 1;
          outcome.maxActive = Math.max(outcome.maxActive, active);
          outcome.maxInteractiveWaiting = Math.max(outcome.maxInteractiveWaiting, scheduler.interactiveDepth);
          const waiting = scheduler.snapshot().interactiveWaiting.map((entry) => entry.botId);
          for (const id of waiting) outcome.maxWaitingPlacesPerBot = Math.max(outcome.maxWaitingPlacesPerBot, waiting.filter((other) => other === id).length);
          outcome.maxWaitMs = Math.max(outcome.maxWaitMs, permit.waitedMs);
          await new Promise((resolve) => setTimeout(resolve, serviceMs));
          active -= 1;
          outcome.admitted += 1;
          outcome.perBotServed[bot]! += 1;
        })).catch((error: unknown) => {
          if (!(error instanceof OllamaBusyError)) throw error;
          outcome.rejected += 1;
          outcome.byReason[error.reason] = (outcome.byReason[error.reason] ?? 0) + 1;
        }));
        at += Math.floor(next() * 2 * meanGapMs);
      }
    }
    await vi.runAllTimersAsync();
    await Promise.all(all);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.interactiveDepth).toBe(0);
    return outcome;
  } finally {
    vi.useRealTimers();
  }
}

describe("29-bot simulation against one inference slot", () => {
  it("never runs two requests and never queues more than two interactive ones under overload", async () => {
    const result = await simulate(23, 6, 60_000);
    expect(result.maxActive).toBe(1);
    expect(result.maxInteractiveWaiting).toBeLessThanOrEqual(2);
    expect(result.admitted + result.rejected).toBe(29 * 6);
    expect(result.rejected).toBeGreaterThan(0);
    expect(result.maxWaitMs).toBeLessThanOrEqual(DEFAULT_LIMITS.interactiveMaxWaitMs);
    expect(result.maxWaitingPlacesPerBot).toBeLessThanOrEqual(1);
    expect(result.perBotServed.filter((served) => served > 0).length).toBeGreaterThanOrEqual(15);
  }, 30_000);

  it("keeps the limits at the arrival rate measured on 2026-11-23 (about 3.7 calls a minute across 29 bots)", async () => {
    const result = await simulate(2026, 8, 470_000);
    expect(result.maxActive).toBe(1);
    expect(result.maxInteractiveWaiting).toBeLessThanOrEqual(2);
    expect(result.maxWaitMs).toBeLessThanOrEqual(DEFAULT_LIMITS.interactiveMaxWaitMs);
    expect(result.admitted + result.rejected).toBe(29 * 8);
  }, 30_000);

  it("admits everything when arrivals stay under capacity", async () => {
    const result = await simulate(7, 2, 30 * 60_000);
    expect(result.maxActive).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.admitted).toBe(58);
  }, 30_000);

  it("keeps the limits with a mix of background work", async () => {
    const result = await simulate(91, 6, 45_000, 0.4);
    expect(result.maxActive).toBe(1);
    expect(result.maxInteractiveWaiting).toBeLessThanOrEqual(2);
    expect(result.admitted + result.rejected).toBe(29 * 6);
  }, 30_000);

  it("is deterministic for a seed", async () => {
    expect(await simulate(5, 3, 40_000)).toEqual(await simulate(5, 3, 40_000));
  }, 30_000);
});
