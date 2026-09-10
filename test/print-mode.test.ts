import { afterEach, describe, expect, it, vi } from "vitest";

// Force in-process transport (tests don't support UDS; override global settings).
vi.mock("../src/settings.js", () => ({
  loadSettings: () => ({}),
  applySettings: () => {},
  applyAndEmitLoaded: () => ({}),
  saveSettings: () => true,
}));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});

// ── UDS-path variants ───────────────────────────────────────────────────

/** Hoisted mocks for UDS agent runner. */
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

describe("print mode background notifications (UDS path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  });

  it("sends completion notification when background agent finishes (transport=uds)", async () => {
    const mockClient = { destroy: vi.fn(), writable: true } as any;
    const writeMock = vi.fn();
    mockClient.write = writeMock;
    mockRunViaUds.mockResolvedValue({
      responseText: "done",
      session: null as any,
      aborted: false,
      steered: false,
      failure: undefined,
      client: mockClient,
      socketPath: "/tmp/test.sock",
    } as any);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-uds",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
        transport: "uds",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});

