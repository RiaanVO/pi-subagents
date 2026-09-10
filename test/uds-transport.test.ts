/**
 * uds-transport.test.ts — Unit tests for the UDS server component.
 *
 * Uses Node.js `net` module to connect to a real Unix socket, exercising the
 * full bidirectional message flow between client (parent) and server (child).
 * No real pi sessions — mock sessions drive the event stream.
 */

import net from "node:net";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const subscribeCallbacks: Array<(event: any) => void> = [];

const mockSession = vi.hoisted(() => ({
  subscribe: vi.fn((cb: (event: any) => void) => {
    subscribeCallbacks.push(cb);
    return () => {};
  }),
  steer: vi.fn(),
  prompt: vi.fn(() => Promise.resolve()),  // First steer uses prompt(), subsequent ones use steer()
  abort: vi.fn(),
  setActiveToolsByName: vi.fn(),
  getAllTools: vi.fn(() => [
    { name: "read" },
    { name: "bash" },
    { name: "edit" },
    { name: "write" },
    { name: "grep" },
    { name: "find" },
    { name: "ls" },
  ]),
  setThinkingLevel: vi.fn(),
  compact: vi.fn(),
  // session.messages is used by routeCommand to determine if steer should use prompt() or steer()
  messages: [],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class MockAgentSession {
    subscribe(fn: (event: any) => void) {
      return mockSession.subscribe(fn);
    }
    steer(...args: unknown[]) {
      return mockSession.steer(...args);
    }
    abort(...args: unknown[]) {
      return mockSession.abort(...args);
    }
    setActiveToolsByName(...args: unknown[]) {
      return mockSession.setActiveToolsByName(...args);
    }
    getAllTools(...args: unknown[]) {
      return mockSession.getAllTools(...args);
    }
    setThinkingLevel(...args: unknown[]) {
      return mockSession.setThinkingLevel(...args);
    }
    compact(...args: unknown[]) {
      return mockSession.compact(...args);
    }
  },
}));

// ── Import under test ──────────────────────────────────────────────────
import { UdsServer } from "../src/uds-server.js";

// ── Test helpers ───────────────────────────────────────────────────────

/** Create a socket path in tmpdir for the test. */
function makeSocketPath(): string {
  return join(tmpdir(), `uds-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

// ── Message queue for handling bulk arrival ────────────────────────────
// Messages arriving before waitForMessage is called are queued here.

const msgQueue: Record<string, unknown>[] = [];
let dataHandler: ((data: Buffer) => void) | null = null;
let waitingResolvers: Array<{
  resolve: (msg: Record<string, unknown>) => void;
  timeout: ReturnType<typeof setTimeout>;
}> = [];

/**
 * Attach a data handler that queues incoming messages.
 * MUST be called before messages can arrive (before net.createConnection
 * in most cases).
 */
function attachDataHandler(client: net.Socket): void {
  if (dataHandler) return;

  dataHandler = (data: Buffer) => {
    const text = data.toString();
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        msgQueue.push(msg);
      } catch { /* skip */ }
    }

    // Resolve any waiting callers
    const toResolve: typeof waitingResolvers = [];
    while (msgQueue.length > 0 && waitingResolvers.length > 0) {
      toResolve.push(waitingResolvers.shift()!);
    }
    for (const w of toResolve) {
      w.resolve(msgQueue.shift()!);
    }
  };

  client.on("data", dataHandler);
}

/**
 * Wait for the next message from the client socket.
 * Messages arriving before this is called are queued.
 */
function waitForMessage(client: net.Socket): Promise<Record<string, unknown>> {
  attachDataHandler(client);

  return new Promise((resolve, reject) => {
    // Check queue first
    if (msgQueue.length > 0) {
      resolve(msgQueue.shift()!);
      return;
    }

    const timeout = setTimeout(() => {
      waitingResolvers = waitingResolvers.filter(w => w.resolve !== resolve);
      reject(new Error("Timeout waiting for message (3s)"));
    }, 3000);

    waitingResolvers.push({ resolve, timeout });
  });
}

/**
 * Wait specifically for the 'ready' event.
 */
function waitForReady(client: net.Socket): Promise<Record<string, unknown>> {
  attachDataHandler(client);

  return new Promise((resolve, reject) => {
    // Check queue for ready event
    const readyIdx = msgQueue.findIndex(m => (m as any).type === "ready");
    if (readyIdx >= 0) {
      resolve(msgQueue.splice(readyIdx, 1)[0]);
      return;
    }

    const timeout = setTimeout(() => {
      waitingResolvers = waitingResolvers.filter(w => w.resolve !== resolve);
      reject(new Error("Timeout waiting for ready (3s)"));
    }, 3000);

    waitingResolvers.push({ resolve, timeout });
  });
}

/**
 * Send a command string to the client and wait for a command_ack or error response.
 * Uses the shared dataHandler to collect responses.
 */
function sendCommand(client: net.Socket, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  attachDataHandler(client);

  return new Promise((resolve, reject) => {
    client.write(JSON.stringify(cmd) + "\n");

    const timeout = setTimeout(() => {
      waitingResolvers = waitingResolvers.filter(w => w.resolve !== resolve);
      reject(new Error("Timeout waiting for command response (3s)"));
    }, 3000);

    // Check queue first for a response
    const idx = msgQueue.findIndex(m => (m as any).type === "command_ack" || (m as any).type === "error");
    if (idx >= 0) {
      clearTimeout(timeout);
      waitingResolvers = waitingResolvers.filter(w => w.resolve !== resolve);
      resolve(msgQueue.splice(idx, 1)[0]);
      return;
    }

    waitingResolvers.push({ resolve, timeout });
  });
}

/**
 * Wait for a specific event type from the client.
 */
function waitForEventType(client: net.Socket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === type) {
            resolve(msg);
            return;
          }
        } catch { /* skip */ }
      }
      reject(new Error(`Expected event type "${type}" not found`));
    };

    client.on("data", onData);

    setTimeout(() => {
      client.removeListener("data", onData);
      reject(new Error(`Timeout waiting for event type "${type}" (3s)`));
    }, 3000);
  });
}

/**
 * Emit a session event through the mock subscription.
 */
function emitSessionEvent(event: any): void {
  for (const cb of subscribeCallbacks) {
    cb(event);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────

let activeServers: UdsServer[] = [];
let activeClients: net.Socket[] = [];

afterEach(() => {
  // Destroy all active clients
  for (const client of activeClients) {
    try { client.destroy(); } catch { /* ignore */ }
  }
  activeClients = [];
  msgQueue.length = 0;
  dataHandler = null;
  waitingResolvers = [];

  for (const server of activeServers) {
    try { server.shutdown(); } catch { /* ignore */ }
    try { fs.unlinkSync(server.socketPath); } catch { /* ignore */ }
  }
  activeServers = [];
  subscribeCallbacks.length = 0;
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("UDS transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects and exchanges messages", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    // Start server AND connect client in parallel
    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);

    await serverStart;
    activeServers.push(server);

    // Wait for ready + session_created (protocol handshake)
    const readyMsg = await waitForMessage(client);
    expect(readyMsg.type).toBe("ready");

    const createdMsg = await waitForMessage(client);
    expect(createdMsg.type).toBe("session_created");
    expect(createdMsg.status).toBe("active");

    // Simulate a turn_end event from the mock session
    emitSessionEvent({ type: "turn_end" });

    const turnMsg = await waitForMessage(client);
    expect(turnMsg.type).toBe("turn_end");
    expect(typeof turnMsg.turnCount).toBe("number");

    // Test steering command from client to server
    // Note: First steer uses prompt(), subsequent ones use steer()
    const ack = await sendCommand(client, { type: "steer", message: "test message" });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("steer");

    // First steer goes to prompt()
    expect(mockSession.prompt).toHaveBeenCalledWith("test message");

    client.destroy();
  });

  it("forwards tool_execution_start and tool_execution_end events", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    // Wait for ready + session_created
    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Emit tool_execution_start
    emitSessionEvent({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call-123",
    });

    const startMsg = await waitForEventType(client, "tool_execution_start");
    expect(startMsg.toolName).toBe("bash");
    expect(startMsg.toolCallId).toBe("call-123");
    expect(typeof startMsg.turnCount).toBe("number");

    // Emit tool_execution_end
    emitSessionEvent({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-123",
      isError: false,
      duration: 42,
    });

    const endMsg = await waitForEventType(client, "tool_execution_end");
    expect(endMsg.toolName).toBe("bash");
    expect(endMsg.toolCallId).toBe("call-123");
    expect(endMsg.success).toBe(true);
    expect(endMsg.duration).toBe(42);

    client.destroy();
  });

  it("forwards text delta events", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // First text_delta
    emitSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });

    const delta1 = await waitForEventType(client, "text_delta");
    expect(delta1.delta).toBe("Hello");
    expect(delta1.fullText).toBe("Hello");

    // Second text_delta
    emitSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " World" },
    });

    const delta2 = await waitForEventType(client, "text_delta");
    expect(delta2.delta).toBe(" World");
    expect(delta2.fullText).toBe("Hello World");

    client.destroy();
  });

  it("forwards usage events on message_end", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Emit message_end with usage data
    emitSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input: 100,
          output: 50,
          cacheWrite: 10,
          cacheRead: 900,
          cost: { total: 0.002 },
        },
      },
    });

    const msgEnd = await waitForEventType(client, "message_end");
    expect(msgEnd.usage).toBeDefined();
    expect(msgEnd.usage.input).toBe(100);
    expect(msgEnd.usage.output).toBe(50);
    expect(msgEnd.usage.cacheWrite).toBe(10);
    expect(msgEnd.usage.cacheRead).toBe(900);
    expect(msgEnd.usage.cost?.total).toBe(0.002);

    client.destroy();
  });

  it("normalizes partial usage objects", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Emit message_end with partial usage (only input)
    emitSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 50 },
      },
    });

    const msgEnd = await waitForEventType(client, "message_end");
    expect(msgEnd.usage.input).toBe(50);
    expect(msgEnd.usage.output).toBe(0);
    expect(msgEnd.usage.cacheWrite).toBe(0);
    expect(msgEnd.usage.cacheRead).toBe(0);
    expect(msgEnd.usage.cost?.total).toBe(0);

    client.destroy();
  });

  it("skips message_end for non-assistant messages", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Emit message_end for user role
    emitSessionEvent({
      type: "message_end",
      message: { role: "user", usage: { input: 10 } },
    });

    // Start a slow wait — user message_end should NOT be forwarded
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 200);
    });
    await timeoutPromise;

    // If we get here, the user message_end was correctly ignored
    client.destroy();
  });

  it("forwards compaction events", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Emit compaction_end (non-aborted)
    emitSessionEvent({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
      result: { tokensBefore: 12345, compactionCount: 1 },
    });

    const compaction = await waitForEventType(client, "compaction");
    expect(compaction.reason).toBe("threshold");
    expect(compaction.tokensBefore).toBe(12345);
    expect(compaction.compactionCount).toBe(1);

    // Emit aborted compaction — should be filtered out
    emitSessionEvent({
      type: "compaction_end",
      aborted: true,
      reason: "manual",
      result: { tokensBefore: 99999 },
    });

    // Start a slow wait — aborted compaction should NOT be forwarded
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 200);
    });
    await timeoutPromise;

    client.destroy();
  });

  it("handles multiple steer commands", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Send three steer commands in quick succession
    await sendCommand(client, { type: "steer", message: "first" });
    await sendCommand(client, { type: "steer", message: "second" });
    await sendCommand(client, { type: "steer", message: "third" });

    // All steer commands should have been routed to session (either prompt or steer)
    const totalCalls = mockSession.prompt.mock.calls.length + mockSession.steer.mock.calls.length;
    expect(totalCalls).toBe(3);

    client.destroy();
  });

  it("handles abort command", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    const ack = await sendCommand(client, { type: "abort" });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("abort");

    expect(mockSession.abort).toHaveBeenCalled();

    client.destroy();
  });

  it("handles setTools command", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    const ack = await sendCommand(client, {
      type: "setTools",
      tools: ["read", "write", "grep"],
    });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("setTools");

    expect(mockSession.setActiveToolsByName).toHaveBeenCalledWith(["read", "write", "grep"]);

    client.destroy();
  });

  it("handles excludeTools command", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    const ack = await sendCommand(client, {
      type: "excludeTools",
      tools: ["bash", "edit"],
    });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("excludeTools");

    // All tools except bash and edit
    expect(mockSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["read", "write", "grep", "find", "ls"]),
    );
    expect(mockSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.not.arrayContaining(["bash", "edit"]),
    );

    client.destroy();
  });

  it("handles setThinking command", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    const ack = await sendCommand(client, {
      type: "setThinking",
      level: "high",
    });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("setThinking");

    expect(mockSession.setThinkingLevel).toHaveBeenCalledWith("high");

    client.destroy();
  });

  it("handles compact command", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    const ack = await sendCommand(client, {
      type: "compact",
      instructions: "compress history",
    });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("compact");

    expect(mockSession.compact).toHaveBeenCalledWith("compress history");

    client.destroy();
  });

  it("cleans up socket file on shutdown", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Verify socket file exists
    expect(fs.existsSync(socketPath)).toBe(true);

    // Shutdown
    server.shutdown();

    // Verify socket file is removed
    expect(fs.existsSync(socketPath)).toBe(false);

    client.destroy();
  });

  it("handles client disconnect gracefully", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Client disconnects
    client.destroy();

    // Give the server a tick to handle the disconnect
    await new Promise((r) => setTimeout(r, 100));

    // Server should still be functional after a client disconnect
    // (shutdown should not throw)
    server.shutdown();
  });

  it("rejects second connection", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client1 = net.createConnection({ path: socketPath });
    attachDataHandler(client1);
    activeClients.push(client1);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client1); // ready
    await waitForMessage(client1); // session_created

    // Second client tries to connect
    const client2 = net.createConnection({ path: socketPath });

    // Second client should receive an error and be closed
    await new Promise<void>((resolve) => {
      client2.once("close", () => resolve());
      setTimeout(() => resolve(), 200);
    });

    client1.destroy();
  });

  it("ignores malformed JSON commands", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    await waitForMessage(client); // ready
    await waitForMessage(client); // session_created

    // Send garbage data
    client.write("not json at all\n");
    client.write("{broken json\n");
    client.write('{"type": "unknown_cmd"}\n');

    // Start a slow wait — unknown command should generate an error event
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 200);
    });
    await timeoutPromise;

    client.destroy();
  });

  // ─── Ready handshake tests ────────────────────────────────────────────────

  it("emits ready before session_created (protocol handshake)", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    // Collect messages until session_created
    const msgs: any[] = [];
    await new Promise<void>((resolve) => {
      const handler = (data: Buffer) => {
        const text = data.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            msgs.push(msg);
            if (msg.type === "session_created") {
              client.removeListener("data", handler);
              resolve();
              return;
            }
          } catch { /* skip */ }
        }
      };
      client.on("data", handler);
    });

    // Verify ready came before session_created
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe("ready");
    expect(msgs[1].type).toBe("session_created");

    client.destroy();
  });

  it("parent waits for ready before sending steer", async () => {
    const socketPath = makeSocketPath();
    const server = new UdsServer(socketPath);

    const serverStart = server.start(mockSession as any);
    const client = net.createConnection({ path: socketPath });
    attachDataHandler(client);
    activeClients.push(client);
    await serverStart;
    activeServers.push(server);

    // Wait for ready FIRST
    const ready = await waitForReady(client);
    expect(ready.type).toBe("ready");

    // Then wait for session_created
    const sessionCreated = await waitForMessage(client);
    expect(sessionCreated.type).toBe("session_created");

    // NOW send steer
    // Note: The FIRST steer uses session.prompt(), subsequent ones use session.steer()
    const ack = await sendCommand(client, { type: "steer", message: "hello after ready" });
    expect(ack.type).toBe("command_ack");
    expect(ack.command).toBe("steer");

    // First steer goes to prompt(), not steer()
    expect(mockSession.prompt).toHaveBeenCalledWith("hello after ready");
    expect(mockSession.steer).not.toHaveBeenCalled();

    client.destroy();
  });
});
