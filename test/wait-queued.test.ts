/**
 * wait-queued.test.ts — get_subagent_result(wait: true) lifecycle behavior.
 *
 * Queued records have no promise yet (it's created when the queue starts
 * them), so the old `status === "running" && record.promise` condition
 * skipped the wait entirely and returned "still running" — forcing the
 * caller into a poll loop against the concurrency queue.
 *
 * Wiring test through the REAL extension: spawn background agents until one
 * queues, call the real tool with wait:true, drain the queue, and assert the
 * call returns the final result.
 */
// Force in-process transport (tests don't support UDS; override global settings).
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/settings.js", () => ({
  loadSettings: () => ({}),
  applySettings: () => {},
  applyAndEmitLoaded: () => ({}),
  saveSettings: () => true,
}));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

// ── Hoisted mocks for UDS agent runner ─────────────────────────────────

const mockRunViaUds = vi.hoisted(() => vi.fn());
const mockCleanupUdsAgent = vi.hoisted(() => vi.fn());
const mockSteerUdsAgent = vi.hoisted(() => vi.fn());
const mockAbortUdsAgent = vi.hoisted(() => vi.fn());

vi.mock("../src/uds-agent-runner.js", () => ({
  runViaUds: mockRunViaUds,
  cleanupUdsAgent: mockCleanupUdsAgent,
  steerUdsAgent: mockSteerUdsAgent,
  abortUdsAgent: mockAbortUdsAgent,
}));

/** Hoisted mocks for child_process and net — prevent real processes. */
const mockChildFork = vi.hoisted(() => vi.fn());
const mockNetCreateConnection = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  fork: mockChildFork,
}));

vi.mock("node:net", () => ({
  createConnection: mockNetCreateConnection,
}));

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** runAgent mock where each call blocks until we resolve it manually. */
function deferredRuns() {
  const resolvers: Array<(v: any) => void> = [];
  vi.mocked(runAgent).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          }),
        );
      }) as any,
  );
  return resolvers;
}

async function spawnBackground(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "queued-wait test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

describe("get_subagent_result wait:true on a queued agent", () => {
  it("waits through queue start and returns the result (no 'still running')", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();

    // Spawn until one lands in the queue (concurrency limit is config-dependent).
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    // wait:true on the QUEUED agent — must not return "still running".
    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait", { agent_id: queuedId, wait: true }, undefined, undefined, ctx());

    // Drain: resolve running agents until the queued one starts and finishes.
    let settled = false;
    void waitPromise.then(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      await new Promise((r) => setTimeout(r, 100)); // outlive one 250ms poll tick
    }

    const result = await waitPromise;
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");
    expect(textOf(result)).not.toContain("still running");

    await new Promise((r) => setTimeout(r, 350));
    expect(JSON.stringify(pi.sendMessage.mock.calls)).not.toContain(queuedId);

    await lifecycle.get("session_shutdown")?.();
  }, 20_000);

  it("aborts a running result wait without aborting or consuming the child", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    let resolveRun: (() => void) | undefined;
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, _prompt, options) =>
        new Promise((resolve) => {
          childSignal = options.signal;
          resolveRun = () => resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          });
        }),
    );

    const { id } = await spawnBackground(tools);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-wait-abort", { agent_id: id, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    const childWasAborted = childSignal?.aborted;

    resolveRun?.();
    await flush();
    await waitOutcome;
    await new Promise((r) => setTimeout(r, 350));

    const completedResult = await tools
      .get("get_subagent_result")
      .execute("tc-result", { agent_id: id }, undefined, undefined, ctx());

    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(childWasAborted).toBe(false);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });

  it("aborts a queued result wait before the agent starts", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    const controller = new AbortController();
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-queued-abort", { agent_id: queuedId, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    let completedResult: any;
    for (let i = 0; i < 40 && !completedResult; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      const result = await tools
        .get("get_subagent_result")
        .execute("tc-queued-result", { agent_id: queuedId }, undefined, undefined, ctx());
      if (textOf(result).includes("THE-RESULT-PAYLOAD")) completedResult = result;
      await new Promise((r) => setTimeout(r, 25));
    }

    await waitOutcome;
    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });
});

// ── UDS-path variants ───────────────────────────────────────────────────

/** runViaUds mock where each call blocks until we resolve it manually. */
function deferredUdsRuns() {
  const resolvers: Array<(v: any) => void> = [];
  const mockClient = { destroy: vi.fn(), writable: true } as any;
  mockClient.write = vi.fn();
  const socketPath = "/tmp/test-uds.sock";
  mockRunViaUds.mockImplementation(
    (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onClientConnected?.(mockClient, socketPath);
      return new Promise((resolve) => {
        resolvers.push(() =>
          resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: null as any,
            aborted: false,
            steered: false,
            failure: undefined,
            client: mockClient,
            socketPath,
          } as any),
        );
      }) as any;
    },
  );
  return resolvers;
}

/** A runViaUds that never settles, and only completes when we resolve it. */
function heldUdsRun() {
  const mockClient = { destroy: vi.fn(), writable: true } as any;
  mockClient.write = vi.fn();
  const socketPath = "/tmp/test-uds.sock";
  let resolveRun: ((v: any) => void) | undefined;
  mockRunViaUds.mockImplementation(
    (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onClientConnected?.(mockClient, socketPath);
      return new Promise((resolve) => {
        resolveRun = () => resolve({
          responseText: "THE-RESULT-PAYLOAD",
          session: null as any,
          aborted: false,
          steered: false,
          failure: undefined,
          client: mockClient,
          socketPath,
        } as any);
      });
    },
  );
  return { resolve: () => resolveRun?.() };
}

async function spawnBackgroundUds(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("Agent").execute(
    "tc-spawn-uds",
    { prompt: "go", description: "uds wait test agent", subagent_type: "general-purpose", run_in_background: true, transport: "uds" },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

describe("get_subagent_result wait:true on a UDS agent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  });

  it("waits through and returns the UDS result (no 'still running')", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredUdsRuns();

    // Spawn until one lands in the queue.
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackgroundUds(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    // wait:true on the QUEUED agent.
    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait-uds", { agent_id: queuedId!, wait: true }, undefined, undefined, ctx());

    // Drain: resolve running agents until the queued one starts and finishes.
    let settled = false;
    void waitPromise.then(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      await new Promise((r) => setTimeout(r, 100));
    }

    const result = await waitPromise;
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");
    expect(textOf(result)).not.toContain("still running");

    await new Promise((r) => setTimeout(r, 350));
    expect(JSON.stringify(pi.sendMessage.mock.calls)).not.toContain(queuedId);

    await lifecycle.get("session_shutdown")?.();
  }, 20_000);

  it("aborts a running UDS result wait without aborting the child", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    let childSignal: AbortSignal | undefined;
    mockRunViaUds.mockImplementation(
      (_ctx, _type, _prompt, options) =>
        new Promise((resolve) => {
          childSignal = options.signal;
          // Never settle on its own — we want the child to keep running
          return new Promise(() => {}) as any;
        }),
    );

    const { id } = await spawnBackgroundUds(tools);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-wait-abort-uds", { agent_id: id, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    const childWasAborted = childSignal?.aborted;

    // The abort only stopped the WAIT, not the child. Get the status
    // directly — the child is still running so no nudge yet.
    await flush();
    await waitOutcome;

    const completedResult = await tools
      .get("get_subagent_result")
      .execute("tc-result-uds", { agent_id: id }, undefined, undefined, ctx());

    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(childWasAborted).toBe(false); // the controller.abort() only stopped the WAIT, not the child
    expect(removeListener).toHaveBeenCalledTimes(1);
    // The child is still running, so no completion nudge has fired yet.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // No result either since the child never completed
    expect(textOf(completedResult)).not.toContain("THE-RESULT-PAYLOAD");
  });

  it("aborts a queued result wait before the agent starts (transport=uds)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredUdsRuns();
    let queuedId: string | undefined;
    for (let i = 0; i < 20 && !queuedId; i++) {
      const { id, queued } = await spawnBackgroundUds(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 20 spawns").toBeDefined();

    const controller = new AbortController();
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-queued-abort-uds", { agent_id: queuedId!, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    let completedResult: any;
    for (let i = 0; i < 40 && !completedResult; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      const result = await tools
        .get("get_subagent_result")
        .execute("tc-queued-result-uds", { agent_id: queuedId! }, undefined, undefined, ctx());
      if (textOf(result).includes("THE-RESULT-PAYLOAD")) completedResult = result;
      await new Promise((r) => setTimeout(r, 25));
    }

    await waitOutcome;
    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });
});

