import { describe, expect, it } from "vitest";
import { classifyRoutineFailure, retriesTeammateThread } from "../routine-recovery.ts";
import { TurnStops } from "../turn-outcome.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createWorkloadRoutes } from "../routes/workload.ts";
import { PASS } from "../routes/table.ts";
import type { TextGenerationOptions } from "../contracts.ts";
import { BackgroundJobs } from "./background-jobs.ts";
import { classifiedCall, sideJobWorkload, turnWorkload } from "./classify.ts";
import { MODEL_BUSY_NOTICE } from "./busy-notice.ts";
import { OllamaBusyError } from "./scheduler.ts";

describe("a busy refusal never starts a retry storm", () => {
  const busy = new OllamaBusyError("queue-full", 30);

  it("is busy for routines and not retried for teammate threads, by its notice key and not its words", () => {
    expect(classifyRoutineFailure(busy.message, { text: busy.text })).toEqual({ kind: "busy" });
    expect(classifyRoutineFailure(busy.message, { modelBusy: true })).toEqual({ kind: "busy" });
    expect(retriesTeammateThread(busy.message, { text: busy.text })).toBe(false);
    expect(retriesTeammateThread(busy.message, { modelBusy: true })).toBe(false);
  });

  it("is recorded on the thread's stop so the harness can leave the Chief out of it", () => {
    const stops = new TurnStops();
    stops.note({ type: "turn.started", threadId: "t", turnId: "turn", eventId: "e1", provider: "openai-compat", createdAt: "" } as never);
    stops.note({ type: "runtime.error", threadId: "t", turnId: "turn", eventId: "e2", provider: "openai-compat", createdAt: "", message: busy.message, text: busy.text, terminal: true } as never);
    expect(stops.read("t", "turn")?.flags).toMatchObject({ modelBusy: true });
    expect(busy.text.key).toBe(MODEL_BUSY_NOTICE);
  });
});

describe("classification at trusted boundaries", () => {
  it("maps a person's own work to interactive and bot work to background", () => {
    expect(turnWorkload(true, "bot", "thread")).toEqual({ workloadClass: "interactive", source: "person-turn", botId: "bot", threadId: "thread" });
    expect(turnWorkload(false, "bot", "thread")).toEqual({ workloadClass: "background", source: "automatic-turn", botId: "bot", threadId: "thread" });
  });

  it("classifies helper jobs by whether someone waits on them", () => {
    expect(sideJobWorkload("setup-suggestions", "b").workloadClass).toBe("interactive");
    expect(sideJobWorkload("compaction", "b").workloadClass).toBe("interactive");
    for (const job of ["memory", "skill-review", "representative", "status-reply"] as const) expect(sideJobWorkload(job, "b").workloadClass).toBe("background");
  });

  it("keeps its own classification whatever a caller passes", async () => {
    let seen: TextGenerationOptions | undefined;
    const call = classifiedCall(async (_prompt, options) => { seen = options; return "ok"; }, sideJobWorkload("memory", "b"));
    await call("prompt", { workload: { workloadClass: "interactive", source: "person-turn" } });
    expect(seen?.workload).toEqual({ workloadClass: "background", source: "helper", botId: "b", taskId: "memory" });
  });
});

describe("workload diagnostics route", () => {
  const jobs = new BackgroundJobs(":memory:", { capacity: 5, maxAttempts: 2 });
  const bypass = [{ botId: "cli-bot", instanceId: "claude", origin: "http://127.0.0.1:11434", sharesGovernedOrigin: true }];
  const routes = createWorkloadRoutes({ snapshots: () => ({ enabled: true, schedulers: [] }), ungoverned: () => bypass, jobs, cancelJob: async () => false });
  const call = async (auth: RequestAuth, method: string, path: string) => {
    const response: { status?: number; body?: unknown } = {};
    const res = { setHeader() {} } as never;
    const url = new URL(`http://localhost${path}`);
    const out = await routes({ req: {} as never, res, url, path: url.pathname, method, auth, readBody: (async () => "") as never,
      json: ((_res: unknown, status: number, body: unknown) => { response.status = status; response.body = body; }) as never });
    return { out, ...response };
  };
  const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const service: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], trust: "service" };
  const client: RequestAuth = { kind: "session", session: {} as never, via: "bearer", scopes: ["client"] };

  it("answers the owner and refuses everyone else", async () => {
    expect(await call(owner, "GET", "/api/workload")).toMatchObject({ status: 200, body: { enabled: true, ungoverned: bypass, backgroundJobs: { counts: { queued: 0 } } } });
    expect(await call(service, "GET", "/api/workload")).toMatchObject({ status: 403 });
    expect(await call(client, "GET", "/api/workload")).toMatchObject({ status: 403 });
    expect((await call(owner, "GET", "/api/other")).out).toBe(PASS);
  });

  it("cancels a live job and refuses a settled one", async () => {
    const asked = jobs.request({ dedupeKey: "routine-run:x", taskType: "routine:schedule", botId: "b" });
    if ("refused" in asked) throw new Error("refused");
    expect(await call(owner, "POST", `/api/workload/jobs/${asked.job.id}/cancel`)).toMatchObject({ status: 200, body: { job: { status: "cancelled" } } });
    expect(await call(owner, "POST", `/api/workload/jobs/${asked.job.id}/cancel`)).toMatchObject({ status: 409 });
    expect(await call(owner, "GET", "/api/workload/jobs?status=bogus")).toMatchObject({ status: 400 });
  });
});
