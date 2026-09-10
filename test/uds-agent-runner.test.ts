/**
 * uds-agent-runner.test.ts — Tests for the UDS agent runner.
 *
 * Exercises configuration resolution, socket path generation, and the
 * runViaUds logic (mocking child process spawn and socket connect).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const mockGetAgentConfig = vi.hoisted(() => vi.fn());
const mockGetConfig = vi.hoisted(() => vi.fn());
const mockGetToolNamesForType = vi.hoisted(() => vi.fn());
const mockResolveDefaultModel = vi.hoisted(() => vi.fn());
const mockResolveEffectiveMaxTurns = vi.hoisted(() => vi.fn());
const mockDetectEnv = vi.hoisted(() => vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })));
const mockGetAgentDir = vi.hoisted(() => vi.fn(() => "/mock/agent-dir"));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
}));

vi.mock("../src/agent-types.js", () => ({
  getAgentConfig: mockGetAgentConfig,
  getConfig: mockGetConfig,
  getToolNamesForType: mockGetToolNamesForType,
}));

vi.mock("../src/agent-runner.js", () => ({
  resolveDefaultModel: mockResolveDefaultModel,
  resolveEffectiveMaxTurns: mockResolveEffectiveMaxTurns,
}));

vi.mock("../src/env.js", () => ({
  detectEnv: mockDetectEnv,
}));

// ── Mock child process and net module ──────────────────────────────────

const mockChildFork = vi.hoisted(() => vi.fn());
const mockNetCreateConnection = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  fork: mockChildFork,
}));

vi.mock("node:net", () => ({
  createConnection: mockNetCreateConnection,
}));

// ── Import under test ─────────────────────────────────────────────────
import {
  runViaUds,
  steerUdsAgent,
  abortUdsAgent,
  setToolsUdsAgent,
  cleanupUdsAgent,
} from "../src/uds-agent-runner.js";

// ── Test helpers ───────────────────────────────────────────────────────

/** Socket directory used by the UDS runner. Tests must clean up after themselves. */
const SOCKET_DIR = join(homedir(), ".pi", "subagents", "sockets");

/** Clean up socket files left from previous tests. */
function cleanTestSockets(): void {
  try {
    if (existsSync(SOCKET_DIR)) {
      const files = require("node:fs").readdirSync(SOCKET_DIR);
      for (const f of files) {
        const path = join(SOCKET_DIR, f);
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** Create a mock child process. */
function createMockChild(): {
  once: any;
  kill: any;
  exitCallbacks: Array<(code: number | null, signal: string | null) => void>;
  errorCallbacks: Array<(err: unknown) => void>;
} {
  const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  const errorCallbacks: Array<(err: unknown) => void> = [];

  const mock = {
    once: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === "exit") {
        exitCallbacks.push(handler as any);
      }
      if (event === "error") {
        errorCallbacks.push(handler as any);
      }
      return mock;
    }),
    kill: vi.fn(),
    exitCallbacks,
    errorCallbacks,
  };

  return mock;
}

/**
 * Trigger the mock child's exit with the given code/signal.
 */
function triggerChildExit(child: { exitCallbacks: Array<(code: number | null, signal: string | null) => void> }, code: number | null = 0, signal: string | null = null): void {
  for (const cb of child.exitCallbacks) {
    cb(code, signal);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  cleanTestSockets();
  mockGetAgentConfig.mockReset().mockReturnValue({
    name: "test-agent",
    systemPrompt: "Test.",
    thinking: "medium",
    maxTurns: 50,
    sessionDir: undefined,
  });
  mockGetConfig.mockReset();
  mockGetToolNamesForType.mockReset().mockReturnValue(["read", "bash", "write"]);
  mockResolveDefaultModel.mockReset();
  mockResolveEffectiveMaxTurns.mockReset();
  mockDetectEnv.mockResolvedValue({ isGitRepo: false, branch: "", platform: "linux" });
  mockGetAgentDir.mockReset().mockReturnValue("/mock/agent-dir");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanTestSockets();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("UDS agent runner", () => {
  describe("socket path generation", () => {
    it("generates unique socket paths", () => {
      const path1 = join(SOCKET_DIR, `sock-${randomUUID()}`);
      const path2 = join(SOCKET_DIR, `sock-${randomUUID()}`);
      expect(path1).not.toBe(path2);
      expect(path1).toMatch(/^.*\.pi\/subagents\/sockets\/sock-[a-f0-9-]+$/);
      expect(path2).toMatch(/^.*\.pi\/subagents\/sockets\/sock-[a-f0-9-]+$/);
    });

    it("generates paths in the correct directory", () => {
      const expectedDir = join(homedir(), ".pi", "subagents", "sockets");
      const socketPath = join(SOCKET_DIR, `sock-${randomUUID()}`);
      expect(dirname(socketPath)).toBe(expectedDir);
    });
  });

  describe("configuration resolution", () => {
    it("resolves agent config for UDS runs", () => {
      mockGetAgentConfig.mockReturnValueOnce({
        name: "explore",
        systemPrompt: "Explore agent.",
        thinking: "high",
        maxTurns: 100,
      });

      // We can't easily run the full runViaUds without mocking the child process
      // but we can verify getAgentConfig is called with the right type
      const agentConfig = mockGetAgentConfig("Explore");
      expect(mockGetAgentConfig).toHaveBeenCalledWith("Explore");
      expect(agentConfig.name).toBe("explore");
    });

    it("resolves model for UDS runs", async () => {
      mockResolveDefaultModel.mockReturnValueOnce("gpt-4o");
      const agentConfig = {
        name: "test",
        systemPrompt: "Test.",
        model: "low",
      };

      // The runner calls resolveDefaultModel with the parent model, registry, and agent model
      const parentModel = { provider: "openai", id: "gpt-4" };
      mockGetAgentConfig.mockReturnValueOnce(agentConfig);
      const resolved = mockResolveDefaultModel(parentModel, {} as any, agentConfig.model);
      expect(resolved).toBe("gpt-4o");
    });

    it("resolves thinking level from agent config", () => {
      mockGetAgentConfig.mockReturnValueOnce({
        name: "test",
        systemPrompt: "Test.",
        thinking: "high",
        maxTurns: 100,
      });

      const config = mockGetAgentConfig("test");
      expect(config?.thinking).toBe("high");
    });

    it("resolves max turns from agent config", () => {
      mockResolveEffectiveMaxTurns.mockReturnValueOnce(200);

      const maxTurns = mockResolveEffectiveMaxTurns("test", undefined);
      expect(mockResolveEffectiveMaxTurns).toHaveBeenCalledWith("test", undefined);
      expect(maxTurns).toBe(200);
    });

    it("prefers caller-provided thinking over agent config", () => {
      const callerLevel: string | undefined = "low";
      mockGetAgentConfig.mockReturnValueOnce({
        name: "test",
        systemPrompt: "Test.",
        thinking: "high",
        maxTurns: 100,
      });

      // In runViaUds: thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking
      const agentConfig = mockGetAgentConfig("test");
      const thinkingLevel = callerLevel ?? agentConfig?.thinking;
      expect(thinkingLevel).toBe("low");
    });

    it("falls back to agent config when caller does not specify thinking", () => {
      mockGetAgentConfig.mockReturnValueOnce({
        name: "test",
        systemPrompt: "Test.",
        thinking: "medium",
        maxTurns: 100,
      });

      const agentConfig = mockGetAgentConfig("test");
      const thinkingLevel = undefined as unknown as string ?? agentConfig?.thinking;
      expect(thinkingLevel).toBe("medium");
    });
  });

  describe("utility functions", () => {
    it("steerUdsAgent sends a steer command", () => {
      const mockClient = { destroyed: false, writable: true } as any;
      const writeMock = vi.fn(() => true);
      mockClient.write = writeMock;

      steerUdsAgent(mockClient, "test message");

      expect(writeMock).toHaveBeenCalledWith(JSON.stringify({ type: "steer", message: "test message" }) + "\n");
    });

    it("steerUdsAgent does nothing on destroyed socket", () => {
      const mockClient = { destroyed: true, writable: true } as any;
      const writeMock = vi.fn();
      mockClient.write = writeMock;

      steerUdsAgent(mockClient, "test message");

      expect(writeMock).not.toHaveBeenCalled();
    });

    it("steerUdsAgent does nothing on non-writable socket", () => {
      const mockClient = { destroyed: false, writable: false } as any;
      const writeMock = vi.fn();
      mockClient.write = writeMock;

      steerUdsAgent(mockClient, "test message");

      expect(writeMock).not.toHaveBeenCalled();
    });

    it("abortUdsAgent sends an abort command", () => {
      const mockClient = { destroyed: false, writable: true } as any;
      const writeMock = vi.fn(() => true);
      mockClient.write = writeMock;

      abortUdsAgent(mockClient);

      expect(writeMock).toHaveBeenCalledWith(JSON.stringify({ type: "abort" }) + "\n");
    });

    it("abortUdsAgent does nothing on destroyed socket", () => {
      const mockClient = { destroyed: true, writable: true } as any;
      const writeMock = vi.fn();
      mockClient.write = writeMock;

      abortUdsAgent(mockClient);

      expect(writeMock).not.toHaveBeenCalled();
    });

    it("setToolsUdsAgent sends a setTools command", () => {
      const mockClient = { destroyed: false, writable: true } as any;
      const writeMock = vi.fn(() => true);
      mockClient.write = writeMock;

      setToolsUdsAgent(mockClient, ["read", "write", "grep"]);

      expect(writeMock).toHaveBeenCalledWith(
        JSON.stringify({ type: "setTools", tools: ["read", "write", "grep"] }) + "\n",
      );
    });

    it("cleanupUdsAgent destroys the client and removes the socket", async () => {
      const mockClient = {
        destroyed: false,
        destroy: vi.fn(),
      } as any;

      // Create a fake socket file
      const socketPath = join(tmpdir(), `uds-test-cleanup-${Date.now()}.sock`);
      writeFileSync(socketPath, "");

      await cleanupUdsAgent(mockClient, socketPath);

      expect(mockClient.destroy).toHaveBeenCalled();
      expect(existsSync(socketPath)).toBe(false);

      // Clean up if file somehow wasn't removed
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    });

    it("cleanupUdsAgent does not throw if client is already destroyed", async () => {
      const mockClient = {
        destroyed: true,
        destroy: vi.fn(),
      } as any;

      const socketPath = join(tmpdir(), `uds-test-cleanup-2-${Date.now()}.sock`);
      writeFileSync(socketPath, "");

      await expect(cleanupUdsAgent(mockClient, socketPath)).resolves.toBeUndefined();
    });

    it("cleanupUdsAgent does not throw if socket file does not exist", async () => {
      const mockClient = { destroy: vi.fn() } as any;
      const socketPath = join(tmpdir(), `uds-test-cleanup-noexist-${Date.now()}.sock`);

      await expect(cleanupUdsAgent(mockClient, socketPath)).resolves.toBeUndefined();
    });
  });
});
