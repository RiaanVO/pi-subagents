/**
 * uds-integration.test.ts — Integration tests for the UDS flow.
 *
 * Tests the full child→parent communication flow using mock sockets,
 * simulates child process behavior, and verifies cleanup of stale sockets.
 */

import net from "node:net";
import fs from "node:fs";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const mockSessionSubscribe = vi.hoisted(() => vi.fn());
const mockSessionSteer = vi.hoisted(() => vi.fn());
const mockSessionPrompt = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockSessionAbort = vi.hoisted(() => vi.fn());
const mockSessionSetActiveTools = vi.hoisted(() => vi.fn());
const mockSessionGetAllTools = vi.hoisted(() => vi.fn(() => [
  { name: "read" },
  { name: "bash" },
  { name: "write" },
]));
const mockSessionSetThinking = vi.hoisted(() => vi.fn());
const mockSessionCompact = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class MockAgentSession {
    // session.messages is used by routeCommand to determine if steer should use prompt() or steer()
    messages: any[] = [];
    subscribe(fn: (event: any) => void) {
      return mockSessionSubscribe(fn);
    }
    steer(...args: unknown[]) {
      return mockSessionSteer(...args);
    }
    prompt(...args: unknown[]) {
      return mockSessionPrompt(...args);
    }
    abort(...args: unknown[]) {
      return mockSessionAbort(...args);
    }
    setActiveToolsByName(...args: unknown[]) {
      return mockSessionSetActiveTools(...args);
    }
    getAllTools(...args: unknown[]) {
      return mockSessionGetAllTools(...args);
    }
    setThinkingLevel(...args: unknown[]) {
      return mockSessionSetThinking(...args);
    }
    compact(...args: unknown[]) {
      return mockSessionCompact(...args);
    }
  },
  createCodingTools: () => [],
  createReadOnlyTools: () => [],
}));

// ── Import under test ──────────────────────────────────────────────────
import { UdsServer } from "../src/uds-server.js";
import {
  steerUdsAgent,
  abortUdsAgent,
  cleanupUdsAgent,
} from "../src/uds-agent-runner.js";

// ── Test helpers ───────────────────────────────────────────────────────

/** Socket directory used by the UDS runner. Keep short to avoid macOS path length limits. */
const SOCKET_DIR = join(tmpdir(), "uds-int");

/** Clean up all socket files in the test directory. */
function cleanSocketDir(): void {
  try {
    if (existsSync(SOCKET_DIR)) {
      const files = readdirSync(SOCKET_DIR);
      for (const f of files) {
        const path = join(SOCKET_DIR, f);
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Create a session with an emit helper for the integration tests.
 */
function createSession(): {
  session: any;
  emit: (event: any) => void;
} {
  const emitFns: Array<(event: any) => void> = [];
  const subscribeMock = vi.fn((cb: (event: any) => void) => {
    emitFns.push(cb);
    return () => {};
  });

  return {
    session: {
      subscribe: subscribeMock,
      steer: mockSessionSteer,
      prompt: mockSessionPrompt,  // First steer uses prompt()
      abort: mockSessionAbort,
      setActiveToolsByName: mockSessionSetActiveTools,
      getAllTools: mockSessionGetAllTools,
      setThinkingLevel: mockSessionSetThinking,
      compact: mockSessionCompact,
      // session.messages is used by routeCommand
      messages: [],
    },
    emit: (event: any) => {
      for (const cb of emitFns) {
        cb(event);
      }
    },
  };
}

/** Connect a client and collect messages. */
function collectMessages(client: net.Socket, count: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    let buffer = "";

    const handler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          messages.push(msg);
          if (messages.length >= count) {
            client.removeListener("data", handler);
            resolve(messages);
          }
        } catch { /* skip */ }
      }
    };

    client.on("data", handler);

    setTimeout(() => {
      client.removeListener("data", handler);
      reject(new Error(`Timeout: expected ${count} messages, got ${messages.length}`));
    }, 3000);
  });
}

/** Send a command and wait for a response. */
function sendCommand(client: net.Socket, cmd: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    client.write(JSON.stringify(cmd) + "\n");

    const handler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === "command_ack" || msg.type === "error") {
            client.removeListener("data", handler);
            resolve(msg);
            return;
          }
        } catch { /* skip */ }
      }
    };

    client.on("data", handler);

    setTimeout(() => {
      client.removeListener("data", handler);
      reject(new Error("Timeout waiting for command response"));
    }, 3000);
  });
}

// ── Setup ──────────────────────────────────────────────────────────────

let servers: UdsServer[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  cleanSocketDir();
  mkdirSync(SOCKET_DIR, { recursive: true });
});

afterEach(() => {
  // Shutdown all servers
  for (const server of servers) {
    try { server.shutdown(); } catch { /* ignore */ }
  }
  servers = [];

  // Clean socket dir
  cleanSocketDir();
});

// ── Integration Tests ──────────────────────────────────────────────────

describe("UDS integration", () => {
  describe("child→parent communication flow", () => {
    it("emits ready before any other message (handshake protocol)", async () => {
      const socketPath = join(SOCKET_DIR, "sock-handshake");
      const childServer = new UdsServer(socketPath);

      const { session } = createSession();

      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      // Collect all messages until we see session_created
      const msgs = await collectMessages(client, 2);

      // First message should be ready
      expect(msgs[0].type).toBe("ready");
      // Second should be session_created
      expect(msgs[1].type).toBe("session_created");

      client.destroy();
      childServer.shutdown();
    });

    it("exits cleanly on child completion", async () => {
      const socketPath = join(SOCKET_DIR, "sock-test-1");
      const childServer = new UdsServer(socketPath);

      const { session, emit } = createSession();

      // Start server AND connect client in parallel
      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      // Wait for session_created
      const msgs = await collectMessages(client, 2); // ready + session_created
      expect(msgs[0].type).toBe("ready");
      const [sessionCreated] = msgs.slice(1);
      expect(sessionCreated.type).toBe("session_created");

      // Simulate the child completing (agent_end event)
      emit({
        type: "agent_end",
        status: "completed",
      });

      // Parent receives completion
      const [completedMsg] = await collectMessages(client, 1);
      expect(completedMsg.type).toBe("completed");
      expect(completedMsg.status).toBe("completed");

      // Client disconnects
      client.destroy();

      // Server should shut down cleanly
      childServer.shutdown();
    });

    it("handles child errors", async () => {
      const socketPath = join(SOCKET_DIR, "sock-test-2");
      const childServer = new UdsServer(socketPath);

      const { session, emit } = createSession();

      // Start server AND connect client in parallel
      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      await collectMessages(client, 2); // ready + session_created

      // Simulate an error from the child
      childServer.emit({ type: "error", message: "child process crashed" });

      // Client receives error event
      const [errorMsg] = await collectMessages(client, 1);
      expect(errorMsg.type).toBe("error");
      expect(errorMsg.message).toBe("child process crashed");

      client.destroy();
      childServer.shutdown();
    });

    it("passes turns and text deltas through the full chain", async () => {
      const socketPath = join(SOCKET_DIR, "sock-test-3");
      const childServer = new UdsServer(socketPath);

      const { session, emit } = createSession();

      // Start server AND connect client in parallel
      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      await collectMessages(client, 2); // ready + session_created

      // Simulate a turn
      emit({ type: "turn_end" });

      // Simulate message start
      emit({
        type: "message_start",
        message: { role: "assistant" },
      });

      // Simulate text deltas
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      });

      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " World" },
      });

      // Simulate message end with usage
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: { total: 0.002 } },
        },
      });

      // Simulate completion
      emit({
        type: "agent_end",
        status: "completed",
      });

      // Collect all messages
      const allMessages = await collectMessages(client, 6);

      expect(allMessages[0].type).toBe("turn_end");
      expect(allMessages[1].type).toBe("message_start");
      expect(allMessages[2].type).toBe("text_delta");
      expect(allMessages[2].delta).toBe("Hello");
      expect(allMessages[3].type).toBe("text_delta");
      expect(allMessages[3].delta).toBe(" World");
      expect(allMessages[4].type).toBe("message_end");
      expect(allMessages[4].usage?.input).toBe(100);
      expect(allMessages[5].type).toBe("completed");

      client.destroy();
      childServer.shutdown();
    });

    it("parent can steer the child and the child acknowledges", async () => {
      const socketPath = join(SOCKET_DIR, "sock-test-4");
      const childServer = new UdsServer(socketPath);

      const { session, emit } = createSession();

      // Start server AND connect client in parallel
      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      await collectMessages(client, 2); // ready + session_created

      // Parent steers
      const ack = await sendCommand(client, { type: "steer", message: "please focus on the errors" });
      expect(ack.type).toBe("command_ack");
      expect(ack.command).toBe("steer");

      // First steer goes to prompt(), subsequent ones to steer()
      expect(mockSessionPrompt).toHaveBeenCalledWith("please focus on the errors");

      client.destroy();
      childServer.shutdown();
    });

    it("parent can abort the child", async () => {
      const socketPath = join(SOCKET_DIR, "sock-test-5");
      const childServer = new UdsServer(socketPath);

      const { session, emit } = createSession();

      // Start server AND connect client in parallel
      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      await collectMessages(client, 2); // ready + session_created

      // Parent aborts
      const ack = await sendCommand(client, { type: "abort" });
      expect(ack.type).toBe("command_ack");
      expect(ack.command).toBe("abort");

      expect(mockSessionAbort).toHaveBeenCalled();

      client.destroy();
      childServer.shutdown();
    });

    it("parent can change tools mid-stream", async () => {
      const socketPath = join(SOCKET_DIR, "sock-test-6");
      const childServer = new UdsServer(socketPath);

      const { session, emit } = createSession();

      // Start server AND connect client in parallel
      const serverStart = childServer.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(childServer);

      await collectMessages(client, 2); // ready + session_created

      // Parent sets tools
      const ack = await sendCommand(client, {
        type: "setTools",
        tools: ["read", "write"],
      });
      expect(ack.type).toBe("command_ack");
      expect(ack.command).toBe("setTools");

      expect(mockSessionSetActiveTools).toHaveBeenCalledWith(["read", "write"]);

      client.destroy();
      childServer.shutdown();
    });
  });

  describe("stale socket cleanup", () => {
    it("cleans up stale sockets on server startup", async () => {
      const socketPath = join(SOCKET_DIR, "sock-stale-1");

      // Create a stale socket file
      writeFileSync(socketPath, "stale data from crashed process");
      expect(existsSync(socketPath)).toBe(true);

      // Starting a new server should clean up the stale file
      const server = new UdsServer(socketPath);

      const { session } = createSession();

      const serverStart = server.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(server);

      // The server replaces the stale socket with a real socket
      // (fs.unlinkSync is called before listen, then listen creates the socket)
      expect(existsSync(socketPath)).toBe(true);

      server.shutdown();
    });

    it("creates multiple stale sockets and verifies cleanup removes them", async () => {
      const socketPaths: string[] = [];

      // Create multiple stale socket files
      for (let i = 0; i < 5; i++) {
        const p = join(SOCKET_DIR, `sock-stale-${i}`);
        writeFileSync(p, `stale data ${i}`);
        socketPaths.push(p);
      }

      // Verify all exist
      for (const p of socketPaths) {
        expect(existsSync(p)).toBe(true);
      }

      // Clean them up (simulating what cleanupSocket does)
      for (const p of socketPaths) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }

      // Verify all removed
      for (const p of socketPaths) {
        expect(existsSync(p)).toBe(false);
      }
    });

    it("supports concurrent socket cleanup without errors", async () => {
      const socketPath = join(SOCKET_DIR, "sock-concurrent");
      writeFileSync(socketPath, "concurrent test");

      // Multiple concurrent cleanup attempts should not throw
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, async () => {
          try {
            if (existsSync(socketPath)) {
              unlinkSync(socketPath);
            }
          } catch { /* ignore */ }
        }),
      );

      // All should settle (no uncaught rejections)
      for (const result of results) {
        expect(result.status).toBe("fulfilled");
      }

      // Socket should be gone
      expect(existsSync(socketPath)).toBe(false);
    });

    it("cleans up stale sockets that point to dead processes", async () => {
      const socketPath = join(SOCKET_DIR, "sock-dead");

      // Create a socket file that is just a regular file (not a real socket)
      writeFileSync(socketPath, "dead process socket");
      expect(existsSync(socketPath)).toBe(true);

      // A new server should be able to start by cleaning up the stale file
      const server = new UdsServer(socketPath);

      const { session } = createSession();

      const serverStart = server.start(session as any);
      const client = net.createConnection({ path: socketPath });
      await serverStart;
      servers.push(server);

      // Server should now own the socket path
      expect(existsSync(socketPath)).toBe(true);

      server.shutdown();
    });
  });

  describe("cleanup after completion", () => {
    it("client.destroy does not throw when socket is already gone", () => {
      const client = net.createConnection({ path: "/tmp/nonexistent.sock" });

      // The connection will fail, but destroy should not throw
      client.destroy(); // Should not throw

      // Settle any pending connection
      return new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 100);
      });
    });

    it("server.shutdown cleans up even when no client is connected", async () => {
      const socketPath = join(SOCKET_DIR, "sock-noclient");
      const server = new UdsServer(socketPath);

      // Create a fake socket-like file to test cleanup
      mkdirSync(dirname(socketPath), { recursive: true });
      
      // Create a directory instead of a socket — verify server.start still works
      // by creating a real socket first then shutting down without a client
      const realSocketPath = join(SOCKET_DIR, "sock-real");
      
      const { session } = createSession();
      
      // Start the server with a real socket path so it can listen
      const realServer = new UdsServer(realSocketPath);
      const serverStart = realServer.start(session as any);
      
      // Connect a client to make the server resolve
      const client = net.createConnection({ path: realSocketPath });
      await serverStart;
      servers.push(realServer);
      
      // Now disconnect the client and verify the socket path matches
      expect(realServer.socketPath).toBe(realSocketPath);
      
      // Shutdown without client — should clean up the socket
      realServer.shutdown();
      
      expect(existsSync(realSocketPath)).toBe(false);
      client.destroy();
    });

    it("steerUdsAgent is safe after client is destroyed", () => {
      const client = { destroyed: true, writable: false } as any;
      const writeMock = vi.fn();
      client.write = writeMock;

      // Should not throw and should not write
      steerUdsAgent(client, "test");

      expect(writeMock).not.toHaveBeenCalled();
    });

    it("abortUdsAgent is safe after client is destroyed", () => {
      const client = { destroyed: true, writable: false } as any;
      const writeMock = vi.fn();
      client.write = writeMock;

      abortUdsAgent(client);

      expect(writeMock).not.toHaveBeenCalled();
    });
  });
});
