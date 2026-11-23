import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatDriver } from "../drivers/openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { resetSchedulersForTests, schedulerSnapshots } from "./registry.ts";

type ChatMode = "stream" | "http-500" | "malformed";

interface FakeOllama {
  url: string;
  chats: Array<{ model: string; marker: string }>;
  inFlight: number;
  maxInFlight: number;
  /** Lets the oldest held chat request answer. */
  release(): void;
  held(): number;
  waitForHeld(count: number): Promise<void>;
  nextMode: ChatMode[];
  closed: number;
  answersAsOllama: boolean;
  close(): Promise<void>;
}

const sse = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function fakeOllama(options: { answersAsOllama?: boolean; holdChats?: boolean } = {}): Promise<FakeOllama> {
  const waiting: Array<() => void> = [];
  const heldWatchers: Array<() => void> = [];
  const fake = {
    chats: [] as FakeOllama["chats"], inFlight: 0, maxInFlight: 0, nextMode: [] as ChatMode[], closed: 0,
    answersAsOllama: options.answersAsOllama ?? true,
  };
  const send = (res: ServerResponse, stream: boolean) => {
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { content: "hello" }, finish_reason: "stop" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ content: "hel" }));
    setTimeout(() => {
      res.write(sse({ content: "lo" }, "stop"));
      res.end("data: [DONE]\n\n");
    }, 5);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body: Buffer[] = [];
    req.on("data", (part: Buffer) => body.push(part));
    req.on("end", () => {
      const path = req.url ?? "";
      if (path === "/api/version") {
        if (!fake.answersAsOllama) { res.writeHead(404).end(); return; }
        res.end(JSON.stringify({ version: "0.40.15" }));
        return;
      }
      if (path === "/api/show") { res.end(JSON.stringify({ parameters: "", model_info: {} })); return; }
      if (path === "/api/ps" || path === "/api/tags") { res.end(JSON.stringify({ models: [] })); return; }
      if (path === "/api/create") { res.end(JSON.stringify({ status: "success" })); return; }
      if (path === "/v1/models") { res.end(JSON.stringify({ data: [] })); return; }
      if (path !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const parsed = JSON.parse(Buffer.concat(body).toString("utf8")) as { model: string; stream?: boolean; messages: Array<{ content: unknown }> };
      const last = parsed.messages.at(-1)?.content;
      fake.chats.push({ model: parsed.model, marker: typeof last === "string" ? last : JSON.stringify(last) });
      fake.inFlight += 1;
      fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
      res.on("close", () => { fake.inFlight -= 1; fake.closed += 1; });
      const mode = fake.nextMode.shift() ?? "stream";
      const answer = () => {
        if (res.destroyed) return;
        if (mode === "http-500") { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "boom" })); return; }
        if (mode === "malformed") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: {not json\n\n"); return; }
        send(res, parsed.stream !== false);
      };
      if (options.holdChats === false) { answer(); return; }
      waiting.push(answer);
      for (const watcher of heldWatchers.splice(0)) watcher();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return Object.assign(fake, {
    url: `http://127.0.0.1:${address.port}/v1`,
    release: () => waiting.shift()?.(),
    held: () => waiting.length,
    async waitForHeld(count: number) {
      while (waiting.length < count) await new Promise<void>((resolve) => heldWatchers.push(resolve));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

async function engine(fake: FakeOllama, instanceId = "mac-studio-ollama") {
  const inst = await OpenAICompatDriver.create({
    instanceId, displayName: "Mac Studio Ollama", enabled: true,
    config: { url: fake.url, apiKeyEnv: "FIXTURE_KEY", model: "qwen3.8:27b", managedModels: ["qwen3.8:27b"] },
    environment: { FIXTURE_KEY: "synthetic-not-a-secret" },
  });
  const recorder = recordEvents(inst.adapter);
  const outcome = async (threadId: string, timeoutMs = 10_000) => {
    const done = await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId, timeoutMs);
    const error = recorder.events.find((event) => event.type === "runtime.error" && event.threadId === threadId);
    const text = recorder.events.filter((event) => event.type === "content.delta" && event.threadId === threadId)
      .map((event) => (event as { delta: string }).delta).join("");
    return { ok: (done as { ok: boolean }).ok, error: error as { text?: { key: string }; message: string } | undefined, text };
  };
  return { inst, recorder, outcome };
}

const turn = (botIndex: number, extra: Record<string, unknown> = {}) => ({
  threadId: `thread-${botIndex}`, botId: `bot-${botIndex}`, text: `marker-${botIndex}`,
  workload: { workloadClass: "interactive" as const, source: "person-turn" as const }, ...extra,
});

const until = async (check: () => boolean, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetSchedulersForTests();
  vi.unstubAllEnvs();
});

async function setup(options: { enabled?: boolean; answersAsOllama?: boolean; holdChats?: boolean } = {}) {
  if (options.enabled !== false) vi.stubEnv("OPENMAUS_OLLAMA_SCHEDULER_ENABLED", "1");
  const fake = await fakeOllama(options);
  const { inst, recorder, outcome } = await engine(fake);
  cleanups.push(async () => { recorder.stop(); await inst.dispose(); await fake.close(); });
  return { fake, inst, recorder, outcome };
}

describe("shared Ollama admission through the openai-compat driver", () => {
  it("gives 29 bots one active request and two waiting places, and refuses the rest before they reach Ollama", async () => {
    const { fake, inst, outcome } = await setup();
    for (let bot = 0; bot < 29; bot++) await inst.adapter.sendTurn(turn(bot));
    const refused = await Promise.all(Array.from({ length: 26 }, (_, index) => outcome(`thread-${index + 3}`)));
    for (const result of refused) {
      expect(result.ok).toBe(false);
      expect(result.error?.text?.key).toBe("chat.notice.modelBusy");
      expect(result.error?.message).toMatch(/busy.*Try again in about \d+ seconds/);
    }
    await fake.waitForHeld(1);
    expect(fake.chats.map((chat) => chat.marker)).toEqual(["marker-0"]);
    for (let served = 0; served < 3; served++) {
      await fake.waitForHeld(1);
      expect(fake.inFlight).toBe(1);
      fake.release();
      expect(await outcome(`thread-${served}`)).toMatchObject({ ok: true, text: "hello" });
    }
    expect(fake.maxInFlight).toBe(1);
    expect(fake.chats.map((chat) => chat.marker)).toEqual(["marker-0", "marker-1", "marker-2"]);
    const [snapshot] = schedulerSnapshots().schedulers;
    expect(snapshot!.maxObserved).toMatchObject({ active: 1, interactiveWaiting: 2 });
    expect(snapshot!.counters.rejected["queue-full"]).toBe(26);
    expect(snapshot!.counters.completed).toBe(3);
  }, 30_000);

  it("holds the slot for the whole stream and forwards every chunk", async () => {
    const { fake, inst, outcome } = await setup();
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(1);
    fake.release();
    const first = await outcome("thread-0");
    expect(first).toMatchObject({ ok: true, text: "hello" });
    await fake.waitForHeld(1);
    expect(fake.chats.map((chat) => chat.marker)).toEqual(["marker-0", "marker-1"]);
    expect(fake.maxInFlight).toBe(1);
    fake.release();
    expect(await outcome("thread-1")).toMatchObject({ ok: true, text: "hello" });
  });

  it("keeps the served model name the driver already chose", async () => {
    const { fake, inst, outcome } = await setup({ holdChats: false });
    await inst.adapter.sendTurn(turn(0));
    await outcome("thread-0");
    expect(fake.chats[0]!.model).toBe("qwen3.8:27b-omb-16k");
  });

  it("never sends a queued request whose turn was stopped, and frees the slot when the running turn is stopped", async () => {
    const { fake, inst, outcome } = await setup();
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await inst.adapter.sendTurn(turn(2));
    await fake.waitForHeld(1);
    await inst.adapter.interruptTurn("thread-1");
    await inst.adapter.interruptTurn("thread-1");
    expect((await outcome("thread-1")).ok).toBe(false);
    await inst.adapter.interruptTurn("thread-0");
    await inst.adapter.interruptTurn("thread-0");
    expect((await outcome("thread-0")).ok).toBe(false);
    await until(() => fake.closed >= 1);
    await fake.waitForHeld(2);
    fake.release();
    fake.release();
    expect(await outcome("thread-2")).toMatchObject({ ok: true, text: "hello" });
    expect(fake.chats.map((chat) => chat.marker)).toEqual(["marker-0", "marker-2"]);
    const [snapshot] = schedulerSnapshots().schedulers;
    expect(snapshot!.active).toEqual([]);
    expect(snapshot!.counters).toMatchObject({ cancelledWaiting: 1, cancelledActive: 1, completed: 1 });
  });

  it.each(["http-500", "malformed"] as const)("releases the slot after a %s answer and serves the next request", async (mode) => {
    const { fake, inst, outcome } = await setup();
    fake.nextMode.push(mode);
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(1);
    fake.release();
    expect((await outcome("thread-0")).ok).toBe(false);
    await fake.waitForHeld(1);
    fake.release();
    expect(await outcome("thread-1")).toMatchObject({ ok: true, text: "hello" });
    const [snapshot] = schedulerSnapshots().schedulers;
    expect(snapshot!.counters).toMatchObject({ failed: 1, completed: 1 });
    expect(snapshot!.active).toEqual([]);
  });

  it("runs waiting interactive work before a waiting background helper call", async () => {
    const { fake, inst, outcome } = await setup();
    await inst.adapter.sendTurn(turn(0));
    await fake.waitForHeld(1);
    const helper = inst.generateText!("marker-helper", { workload: { workloadClass: "background", source: "helper", botId: "bot-9", taskId: "memory" } });
    await until(() => schedulerSnapshots().schedulers[0]!.backgroundWaiting.length === 1);
    await inst.adapter.sendTurn(turn(1));
    await until(() => schedulerSnapshots().schedulers[0]!.interactiveWaiting.length === 1);
    fake.release();
    await outcome("thread-0");
    await fake.waitForHeld(1);
    expect(fake.chats.at(-1)!.marker).toBe("marker-1");
    fake.release();
    await outcome("thread-1");
    await fake.waitForHeld(1);
    expect(fake.chats.at(-1)!.marker).toBe("marker-helper");
    fake.release();
    await expect(helper).resolves.toBe("hello");
    expect(schedulerSnapshots().schedulers[0]!.counters.byClass).toEqual({ interactive: 2, background: 1 });
  });

  it("counts a turn without a classification as interactive and unclassified", async () => {
    const { inst, outcome } = await setup({ holdChats: false });
    await inst.adapter.sendTurn({ threadId: "thread-x", botId: "bot-x", text: "marker-x" });
    await outcome("thread-x");
    expect(schedulerSnapshots().schedulers[0]!.counters).toMatchObject({ unclassified: 1, byClass: { interactive: 1, background: 0 } });
  });
});

describe("timeouts", () => {
  it("starts the reply-wait timer only once the slot is held, so queue time never counts as a silent model", async () => {
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "1000");
    const { fake, inst, outcome } = await setup();
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    fake.release();
    expect(await outcome("thread-0")).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await fake.waitForHeld(1);
    fake.release();
    expect(await outcome("thread-1")).toMatchObject({ ok: true, text: "hello" });
    expect(schedulerSnapshots().schedulers[0]!.timings.interactiveWait.maxMs).toBeGreaterThanOrEqual(650);
  }, 15_000);

  it("still stops a model that goes silent once admitted, releases its slot as failed and serves the next request", async () => {
    vi.stubEnv("OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS", "1000");
    const { fake, inst, outcome } = await setup();
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(1);
    const silent = await outcome("thread-0");
    expect(silent.ok).toBe(false);
    await until(() => fake.closed >= 1);
    await fake.waitForHeld(2);
    fake.release();
    fake.release();
    expect(await outcome("thread-1")).toMatchObject({ ok: true, text: "hello" });
    expect(fake.maxInFlight).toBe(1);
    const [snapshot] = schedulerSnapshots().schedulers;
    expect(snapshot!.counters).toMatchObject({ failed: 1, completed: 1, cancelledActive: 0 });
    expect(snapshot!.timings.interactiveWait.maxMs).toBeGreaterThanOrEqual(950);
    expect(snapshot!.active).toEqual([]);
  }, 15_000);
});

describe("isolation", () => {
  it("leaves requests unscheduled while the feature flag is off", async () => {
    const { fake, inst, outcome } = await setup({ enabled: false });
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(2);
    expect(fake.maxInFlight).toBe(2);
    fake.release();
    fake.release();
    await outcome("thread-0");
    await outcome("thread-1");
    expect(schedulerSnapshots()).toEqual({ enabled: false, schedulers: [] });
  });

  it("leaves a local server that is not Ollama unscheduled", async () => {
    const { fake, inst, outcome } = await setup({ answersAsOllama: false });
    await inst.adapter.sendTurn(turn(0));
    await inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(2);
    expect(fake.maxInFlight).toBe(2);
    fake.release();
    fake.release();
    await outcome("thread-0");
    await outcome("thread-1");
  });

  it("shares one slot between two engine instances that send to the same Ollama", async () => {
    vi.stubEnv("OPENMAUS_OLLAMA_SCHEDULER_ENABLED", "1");
    const fake = await fakeOllama();
    const first = await engine(fake, "instance-a");
    const second = await engine(fake, "instance-b");
    cleanups.push(async () => { first.recorder.stop(); second.recorder.stop(); await first.inst.dispose(); await second.inst.dispose(); await fake.close(); });
    await first.inst.adapter.sendTurn(turn(0));
    await second.inst.adapter.sendTurn(turn(1));
    await fake.waitForHeld(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.inFlight).toBe(1);
    fake.release();
    await first.outcome("thread-0");
    await fake.waitForHeld(1);
    fake.release();
    await second.outcome("thread-1");
    expect(fake.maxInFlight).toBe(1);
    expect(schedulerSnapshots().schedulers).toHaveLength(1);
  });
});
