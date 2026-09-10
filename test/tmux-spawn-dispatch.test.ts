/**
 * tmux-spawn-dispatch.test.ts — Tests for agent-manager.ts startViaTmuxUds dispatch.
 *
 * Verifies that spawn() routes to the correct path based on transport + tmuxEnabled:
 *   - transport="uds" + tmuxEnabled=true  → calls spawnUdsSubagent from tmux-workspace
 *   - transport="uds" + tmuxEnabled=false → calls startViaUds (spawnUdsSubagent NOT called)
 *
 * The tmux-workspace module is MOCKED (to prevent real tmux execution and OOM)
 * and the mock function is directly spied on to verify calls.
 *
 * Mocks (using vi.hoisted to ensure they execute before imports):
 *   - tmux-workspace — mocked to prevent real tmux, spied on to verify calls
 *   - node:child_process fork — prevents REAL child processes
 *   - node:net createConnection — prevents REAL socket connections
 *   - @earendil-works/pi-coding-agent — mocks pi-coding-agent dependencies
 *   - agent-types, agent-runner, env — mocks configuration functions
 *   - uds-agent-runner — mocks UDS runner functions
 *   - worktree, usage, mention — mocks supporting modules
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks for dependency injection (runs BEFORE any imports) ──

const mockGetAgentConfig = vi.hoisted(() => vi.fn());
const mockGetConfig = vi.hoisted(() => vi.fn());
const mockGetToolNamesForType = vi.hoisted(() => vi.fn());
const mockResolveDefaultModel = vi.hoisted(() => vi.fn());
const mockResolveEffectiveMaxTurns = vi.hoisted(() => vi.fn());
const mockDetectEnv = vi.hoisted(() => vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })));
const mockGetAgentDir = vi.hoisted(() => vi.fn(() => "/mock/agent-dir"));

// ── Hoisted child_process and net mocks ───────────────────────────────

const mockExecSync = vi.hoisted(() => vi.fn());
const mockFork = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: mockFork,
    execSync: mockExecSync,
  };
});

const mockCreateConnection = vi.hoisted(() => vi.fn());

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: mockCreateConnection,
  };
});

// ── Hoisted tmux-workspace mock ──────────────────────────────────────

const mockSpawnUdsSubagent = vi.hoisted(() => vi.fn());
const mockGetSocketPathForWindow = vi.hoisted(() => vi.fn());

vi.mock("../src/tmux-workspace.js", () => ({
  spawnUdsSubagent: mockSpawnUdsSubagent,
  getSocketPathForWindow: mockGetSocketPathForWindow,
}));

// ── Hoisted module mocks ─────────────────────────────────────────────

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
  DEFAULT_TRANSPORT: "uds",
}));

vi.mock("../src/env.js", () => ({
  detectEnv: mockDetectEnv,
}));

vi.mock("../src/uds-agent-runner.js", () => ({
  runViaUds: vi.fn().mockResolvedValue({
    responseText: "mocked response",
    session: null,
    aborted: false,
    steered: false,
    failure: undefined,
    structuredJson: undefined,
    structuredRetried: false,
    client: { destroyed: false, write: vi.fn().mockReturnValue(true), end: vi.fn(), destroy: vi.fn() },
    socketPath: "/mock/socket",
  }),
  cleanupUdsAgent: vi.fn().mockResolvedValue(undefined),
  steerUdsAgent: vi.fn(),
  abortUdsAgent: vi.fn(),
  setToolsUdsAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn().mockResolvedValue(null),
  cleanupWorktree: vi.fn().mockResolvedValue({ hasChanges: false, branch: undefined }),
  isWorktreeIsolationEnabled: vi.fn().mockReturnValue(false),
  pruneWorktrees: vi.fn(),
}));

vi.mock("../src/usage.js", () => ({
  addUsage: vi.fn(),
}));

vi.mock("../src/mention.js", () => ({
  assignHandle: vi.fn((prefix: string) => `${prefix}-1`),
  handleBase: vi.fn((type: string) => type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")),
}));

// ── Import under test ────────────────────────────────────────────────

import { execSync, fork } from "node:child_process";
import net from "node:net";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AgentManager } from "../src/agent-manager.js";

// ── Test helpers ───────────────────────────────────────────────────────

function getMockSpawnUdsSubagent() {
  return vi.mocked(mockSpawnUdsSubagent);
}

/** Clean up any UDS sockets left behind. */
function cleanTestSockets(): void {
  try {
    const socketDir = join(homedir(), ".pi", "subagents", "sockets");
    if (existsSync(socketDir)) {
      const entries = readdirSync(socketDir);
      for (const entry of entries) {
        try { unlinkSync(join(socketDir, entry)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ── Before/After Each ────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  cleanTestSockets();

  // Reset mock return values
  mockGetAgentConfig.mockReset();
  mockGetAgentConfig.mockReturnValue({
    name: "test-agent",
    systemPrompt: "Test agent.",
    thinking: "medium",
    maxTurns: 50,
  });
  mockGetConfig.mockReset();
  mockGetToolNamesForType.mockReset().mockReturnValue(["read", "write", "bash", "grep", "glob"]);
  mockResolveDefaultModel.mockReset();
  mockResolveDefaultModel.mockReturnValue({ provider: "openai", id: "gpt-4o" });
  mockResolveEffectiveMaxTurns.mockReset();
  mockResolveEffectiveMaxTurns.mockReturnValue(50);
  mockDetectEnv.mockReset().mockResolvedValue({ isGitRepo: false, branch: "", platform: "linux" });
  mockGetAgentDir.mockReset().mockReturnValue("/mock/agent-dir");

  // Reset mock execSync and fork
  mockExecSync.mockReset();
  mockExecSync.mockImplementation(() => Buffer.from(""));
  mockFork.mockReset();
  mockFork.mockReturnValue({
    once: vi.fn().mockReturnValue({ once: vi.fn() }),
    kill: vi.fn().mockReturnValue(true),
  } as any);
  mockCreateConnection.mockReset();
  mockCreateConnection.mockReturnValue({
    destroyed: false,
    writable: true,
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    destroy: vi.fn(),
    setTimeout: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  } as any);

  // Default spawnUdsSubagent returns success
  mockSpawnUdsSubagent.mockReturnValue({
    windowName: "explore-1",
    socketPath: "/tmp/subagents/sockets/sock-abc123",
  });
  mockGetSocketPathForWindow.mockReturnValue("/tmp/subagents/sockets/sock-abc123");
});

afterEach(() => {
  cleanTestSockets();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("agent-manager tmux spawn dispatch", () => {
  describe("tmuxEnabled=true + transport=uds", () => {
    it("calls spawnUdsSubagent from tmux-workspace (not normal UDS path)", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      const agentId = manager.spawn(
        mockPi,
        mockCtx,
        "Explore",
        "Explore this codebase",
        {
          description: "Explore codebase",
          transport: "uds" as const,
          tmuxEnabled: true,
        },
      );

      // spawn() returns synchronously with an ID
      expect(agentId).toBeDefined();
      expect(typeof agentId).toBe("string");

      // startViaTmuxUds is async — wait for the spawnUdsSubagent call
      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      // Check if the record exists and has tmuxWindow set (from startViaTmuxUds)
      const record = manager.getRecord(agentId);
      expect(record).toBeDefined();
      expect(record!.tmuxWindow).toBeDefined();

      // Verify the arguments passed to spawnUdsSubagent
      const [type, prompt, spawnOptions] = mockSpawn.mock.calls[0];
      expect(type).toBe("Explore");
      expect(prompt).toBe("Explore this codebase");
      expect(spawnOptions).toHaveProperty("cwd");
      expect(spawnOptions).toHaveProperty("agentId");
    });

    it("passes agent type to spawnUdsSubagent", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Audit", "Audit security", {
        description: "Audit security",
        transport: "uds" as const,
        tmuxEnabled: true,
      });

      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      const [type] = mockSpawn.mock.calls[0];
      expect(type).toBe("Audit");
    });

    it("passes prompt to spawnUdsSubagent", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();
      const targetPrompt = "Find all security vulnerabilities";

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Audit", targetPrompt, {
        description: "Security audit",
        transport: "uds" as const,
        tmuxEnabled: true,
      });

      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      const [, prompt] = mockSpawn.mock.calls[0];
      expect(prompt).toBe(targetPrompt);
    });

    it("passes model through spawnUdsSubagent", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Audit", "Audit code", {
        description: "Audit code",
        transport: "uds" as const,
        tmuxEnabled: true,
        model: { provider: "anthropic", id: "sonnet" },
      });

      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      const [, , options] = mockSpawn.mock.calls[0];
      expect(options.model).toBe("anthropic/sonnet");
    });

    it("passes thinking level through spawnUdsSubagent", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Audit", "Audit deeply", {
        description: "Audit deeply",
        transport: "uds" as const,
        tmuxEnabled: true,
        thinkingLevel: "high",
      });

      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      const [, , options] = mockSpawn.mock.calls[0];
      expect(options.thinking).toBe("high");
    });

    it("passes maxTurns through spawnUdsSubagent", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Audit", "Audit deeply", {
        description: "Audit deeply",
        transport: "uds" as const,
        tmuxEnabled: true,
        maxTurns: 100,
      });

      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      const [, , options] = mockSpawn.mock.calls[0];
      expect(options.maxTurns).toBe(100);
    });

    it("passes isolated flag through spawnUdsSubagent", async () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Audit", "Isolated audit", {
        description: "Isolated audit",
        transport: "uds" as const,
        tmuxEnabled: true,
        isolated: true,
      });

      await vi.waitFor(
        () => {
          expect(mockSpawn).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      const [, , options] = mockSpawn.mock.calls[0];
      expect(options.isolated).toBe(true);
    });
  });

  describe("tmuxEnabled=false + transport=uds (normal UDS, no tmux)", () => {
    it("does NOT call spawnUdsSubagent from tmux-workspace", () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager.spawn(mockPi, mockCtx, "Explore", "Normal UDS spawn", {
        description: "Normal UDS",
        transport: "uds" as const,
        tmuxEnabled: false,
      });

      // spawnUdsSubagent was NOT called
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("uses the normal UDS path (startViaUds → runViaUds)", () => {
      const mockSpawn = getMockSpawnUdsSubagent();

      const manager = new AgentManager();
      const mockPi = {} as any;
      const mockCtx = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      const agentId = manager.spawn(mockPi, mockCtx, "Explore", "Normal UDS", {
        description: "Normal UDS",
        transport: "uds" as const,
        tmuxEnabled: false,
      });

      expect(agentId).toBeDefined();
      expect(typeof agentId).toBe("string");
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("tmuxEnabled=true vs false dispatch to different paths", async () => {
      // Test 1: tmuxEnabled=true → spawnUdsSubagent IS called
      // We verify by checking that the mock was called with tmux params.
      const callCountBefore = getMockSpawnUdsSubagent().mock.calls.length;

      const manager1 = new AgentManager();
      const mockPi1 = {} as any;
      const mockCtx1 = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager1.spawn(mockPi1, mockCtx1, "Audit", "With tmux", {
        description: "With tmux",
        transport: "uds" as const,
        tmuxEnabled: true,
      });

      // Verify the call count increased (spawnUdsSubagent was called)
      await vi.waitFor(
        () => {
          expect(getMockSpawnUdsSubagent().mock.calls.length).toBeGreaterThan(callCountBefore);
        },
        { timeout: 2000 },
      );

      // Record calls after manager1
      const callsAfterManager1 = getMockSpawnUdsSubagent().mock.calls.length;

      // Test 2: tmuxEnabled=false → spawnUdsSubagent should NOT be called
      const manager2 = new AgentManager();
      const mockPi2 = {} as any;
      const mockCtx2 = {
        cwd: "/tmp/test",
        model: { provider: "openai", id: "gpt-4o" },
        modelRegistry: {},
      } as any;

      manager2.spawn(mockPi2, mockCtx2, "Audit", "Without tmux", {
        description: "Without tmux",
        transport: "uds" as const,
        tmuxEnabled: false,
      });

      // Wait a moment for any async operations
      await new Promise((r) => setTimeout(r, 100));

      // Verify no additional calls — spawnUdsSubagent was NOT called for manager2
      expect(getMockSpawnUdsSubagent().mock.calls.length).toBe(callsAfterManager1);
    });
  });
});
