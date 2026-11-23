import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ungovernedSenders } from "./host.ts";
import { registerInstanceOrigin, resetSchedulersForTests, schedulerKey, schedulerForInstance, sharedScheduler } from "./registry.ts";

afterEach(() => {
  resetSchedulersForTests();
  vi.unstubAllEnvs();
});

describe("one scheduler per Ollama server", () => {
  it("gives every name for this machine the same key", () => {
    const own = hostname().toLowerCase().replace(/\.local$/, "");
    const spellings = ["http://127.0.0.1:11434/v1", "http://localhost:11434", "http://LOCALHOST:11434/v1/", "http://[::1]:11434/v1",
      "http://127.0.0.2:11434", "http://0.0.0.0:11434", `http://${own}:11434/v1`, `http://${own}.local:11434/v1`];
    expect(new Set(spellings.map(schedulerKey))).toEqual(new Set(["http://127.0.0.1:11434"]));
  });

  it("keeps different ports, schemes and other machines apart", () => {
    expect(schedulerKey("http://127.0.0.1:11435/v1")).toBe("http://127.0.0.1:11435");
    expect(schedulerKey("https://localhost:11434")).toBe("https://127.0.0.1:11434");
    expect(schedulerKey("http://gpu-box.example:11434/v1")).toBe("http://gpu-box.example:11434");
    expect(schedulerKey("not a url")).toBeNull();
  });

  it("shares one scheduler between engines that spell the same server differently", () => {
    vi.stubEnv("OPENMAUS_OLLAMA_SCHEDULER_ENABLED", "1");
    registerInstanceOrigin("by-name", "http://localhost:11434/v1");
    registerInstanceOrigin("by-address", "http://127.0.0.1:11434/v1");
    expect(schedulerForInstance("by-name")).toBe(schedulerForInstance("by-address"));
    expect(sharedScheduler("http://[::1]:11434/v1")).toBe(schedulerForInstance("by-name"));
  });
});

describe("requests the scheduler cannot see", () => {
  const bots = () => [
    { id: "compat-bot", modelSelection: { instanceId: "mac-studio-ollama", model: "qwen3.8:27b" } },
    { id: "cli-bot", modelSelection: { instanceId: "claude", model: "ollama::qwen3.8:27b" },
      tasks: [{ threadId: "task-1", modelSelection: { instanceId: "codex", model: "local_ollama::qwen3.8:27b" } }, { threadId: "task-2" }] },
    { id: "studio-bot", modelSelection: { instanceId: "opencode", model: "lmstudio::some-model" } },
  ];

  it("lists bots whose CLI engine sends an injected Ollama model itself, and whether that origin is governed", () => {
    expect(ungovernedSenders(bots)).toEqual([
      { botId: "cli-bot", instanceId: "claude", origin: "http://127.0.0.1:11434", sharesGovernedOrigin: false },
      { botId: "cli-bot", taskThreadId: "task-1", instanceId: "codex", origin: "http://127.0.0.1:11434", sharesGovernedOrigin: false },
    ]);
    vi.stubEnv("OPENMAUS_OLLAMA_SCHEDULER_ENABLED", "1");
    sharedScheduler("http://localhost:11434/v1");
    expect(ungovernedSenders(bots).map((sender) => sender.sharesGovernedOrigin)).toEqual([true, true]);
  });
});
