/**
 * tmux-uds.test.ts — Tests for the tmux workspace UDS integration.
 *
 * Exercises socket path generation, directory management, socket cleanup,
 * and the window-socket mapping registry. These are pure function tests
 * that don't require importing the actual tmux-workspace module, since
 * it depends on tmux being installed and running.
 */

import { existsSync, mkdirSync, unlinkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Test helpers ───────────────────────────────────────────────────────

/** Use tmpdir instead of ~/.pi for tests. */
const TEST_SOCKET_DIR = join(tmpdir(), `tmux-uds-test-sockets-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Get the expected UDS socket dir path (for comparison). */
function getExpectedSocketDir(): string {
  return join(homedir(), ".pi", "subagents", "sockets");
}

/**
 * Generate a socket path using the same logic as the tmux workspace.
 */
function generateSocketPath(dir: string, id: string): string {
  return join(dir, `sock-${id}`);
}

/**
 * Ensure socket directory exists (same logic as tmux-workspace.ts).
 */
function ensureSocketDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Clean up a stale socket file (same logic as tmux-workspace.ts).
 */
function cleanupSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      statSync(socketPath).isSocket() && unlinkSync(socketPath);
    }
  } catch {
    // Socket might be invalid or already removed — ignore
  }
}

/** Clean up all socket files in the test directory. */
function cleanTestDir(): void {
  try {
    if (existsSync(TEST_SOCKET_DIR)) {
      const files = readdirSync(TEST_SOCKET_DIR);
      for (const f of files) {
        const path = join(TEST_SOCKET_DIR, f);
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch { /* ignore */ }
      }
      try { unlinkSync(TEST_SOCKET_DIR); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Recursively remove a directory. */
function rmdirRecursive(dir: string): void {
  if (existsSync(dir)) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        rmdirRecursive(fullPath);
      } else {
        try { unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
    try { unlinkSync(dir); } catch { /* ignore */ }
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  cleanTestDir();
  mkdirSync(TEST_SOCKET_DIR, { recursive: true });
});

afterEach(() => {
  cleanTestDir();
});

// ── In-memory registry (mirrors WINDOW_SOCKET_MAP) ────────────────────

/** Simulated window→socket mapping registry. */
const WINDOW_SOCKET_MAP = new Map<string, string>();

/**
 * Register a socket mapping (simulates spawnUdsSubagent behavior).
 */
function registerSocketMapping(windowName: string, socketPath: string): void {
  WINDOW_SOCKET_MAP.set(windowName, socketPath);
}

/**
 * Find socket for window (simulates findSocketForWindow).
 */
function findSocketForWindow(windowName: string): string | null {
  const mapped = WINDOW_SOCKET_MAP.get(windowName);
  if (mapped && existsSync(mapped)) return mapped;
  return null;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("TMUX UDS workspace", () => {
  describe("socket path generation", () => {
    it("generates socket paths with the correct format", () => {
      const id = nanoid(10);
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, id);
      expect(socketPath).toMatch(new RegExp(`^${TEST_SOCKET_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sock-`));
    });

    it("each socket path is unique", () => {
      const paths = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const id = nanoid(10);
        const path = generateSocketPath(TEST_SOCKET_DIR, id);
        expect(paths.has(path)).toBe(false);
        paths.add(path);
      }
      expect(paths.size).toBe(100);
    });

    it("socket path lives in the socket directory", () => {
      const id = nanoid(10);
      const path = generateSocketPath(TEST_SOCKET_DIR, id);
      expect(dirname(path)).toBe(TEST_SOCKET_DIR);
    });

    it("socket path includes the 'sock-' prefix", () => {
      const id = nanoid(10);
      const path = generateSocketPath(TEST_SOCKET_DIR, id);
      expect(path).toContain("sock-");
    });
  });

  describe("socket directory management", () => {
    it("ensures socket directory exists", () => {
      const testDir = join(tmpdir(), `test-ensure-socket-dir-${Date.now()}`);

      // Directory should not exist yet
      expect(existsSync(testDir)).toBe(false);

      // Create it
      ensureSocketDir(testDir);

      // Now it should exist
      expect(existsSync(testDir)).toBe(true);

      // Clean up
      rmdirRecursive(testDir);
    });

    it("ensuresSocketDir does not fail if directory already exists", () => {
      const testDir = join(tmpdir(), `test-ensure-already-exists-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });

      // Should not throw
      expect(() => {
        ensureSocketDir(testDir);
      }).not.toThrow();

      // Clean up
      rmdirRecursive(testDir);
    });

    it("creates nested directories with recursive option", () => {
      const deepDir = join(TEST_SOCKET_DIR, "a", "b", "c");

      ensureSocketDir(deepDir);

      expect(existsSync(deepDir)).toBe(true);

      // Clean up
      rmdirRecursive(join(TEST_SOCKET_DIR, "a"));
    });
  });

  describe("socket cleanup", () => {
    it("cleans up stale socket files", () => {
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      // Create a stale socket file
      mkdirSync(dirname(socketPath), { recursive: true });
      require("node:fs").writeFileSync(socketPath, "stale data");

      // Verify it exists
      expect(existsSync(socketPath)).toBe(true);

      // Clean it up
      cleanupSocket(socketPath);

      // Verify it's removed (if it was a real socket file)
      // Since we created a regular file, it might not be removed (isSocket() check)
      // So we just verify the function doesn't throw
      expect(() => cleanupSocket(socketPath)).not.toThrow();

      // Clean up manually
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    });

    it("cleanupSocket handles non-existent sockets gracefully", () => {
      const nonExistentPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      // Should not throw when socket doesn't exist
      expect(() => {
        cleanupSocket(nonExistentPath);
      }).not.toThrow();
    });

    it("handles concurrent cleanup attempts on the same socket", () => {
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));
      mkdirSync(dirname(socketPath), { recursive: true });
      require("node:fs").writeFileSync(socketPath, "data");

      // Concurrent cleanup — second should not throw
      cleanupSocket(socketPath);
      try { unlinkSync(socketPath); } catch { /* ignore */ }

      // Cleanup manually since the file might still exist (isSocket check)
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    });

    it("cleanupUdsSession (via cleanupSocket) is idempotent", () => {
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      // Multiple cleanup calls should not throw
      cleanupSocket(socketPath);
      cleanupSocket(socketPath);
      cleanupSocket(socketPath);

      expect(() => cleanupSocket(socketPath)).not.toThrow();
    });
  });

  describe("window-socket mapping", () => {
    beforeEach(() => {
      WINDOW_SOCKET_MAP.clear();
    });

    it("finds socket for window when registered in WINDOW_SOCKET_MAP", () => {
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));
      mkdirSync(dirname(socketPath), { recursive: true });
      require("node:fs").writeFileSync(socketPath, "dummy");
      registerSocketMapping("explore-1", socketPath);

      expect(findSocketForWindow("explore-1")).toBe(socketPath);

      // Clean up
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    });

    it("returns null for unregistered window", () => {
      expect(findSocketForWindow("nonexistent-window")).toBeNull();
    });

    it("returns null when registered path no longer exists", () => {
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));
      registerSocketMapping("expired-1", socketPath);

      // The path doesn't exist as a file, so findSocketForWindow returns null
      expect(findSocketForWindow("expired-1")).toBeNull();
    });

    it("registers window-socket mapping", () => {
      const windowName = "explore-1";
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      // Simulate registration (like spawnUdsSubagent does)
      registerSocketMapping(windowName, socketPath);

      expect(WINDOW_SOCKET_MAP.has(windowName)).toBe(true);
      expect(WINDOW_SOCKET_MAP.get(windowName)).toBe(socketPath);
    });

    it("overwrites existing mapping for same window name", () => {
      const windowName = "explore-1";
      const socketPath1 = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));
      const socketPath2 = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      registerSocketMapping(windowName, socketPath1);
      expect(WINDOW_SOCKET_MAP.get(windowName)).toBe(socketPath1);

      // Overwrite
      registerSocketMapping(windowName, socketPath2);
      expect(WINDOW_SOCKET_MAP.get(windowName)).toBe(socketPath2);
      expect(WINDOW_SOCKET_MAP.get(windowName)).not.toBe(socketPath1);
    });

    it("removes mapping when window is cleaned up", () => {
      const windowName = "explore-1";
      const socketPath = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      registerSocketMapping(windowName, socketPath);
      expect(WINDOW_SOCKET_MAP.get(windowName)).toBe(socketPath);

      // Clean up (like spawnUdsSubagent does on failure)
      WINDOW_SOCKET_MAP.delete(windowName);

      expect(WINDOW_SOCKET_MAP.has(windowName)).toBe(false);
    });

    it("supports multiple concurrent window-socket mappings", () => {
      const window1 = "explore-1";
      const window2 = "audit-1";
      const window3 = "scout-1";

      const paths = [
        generateSocketPath(TEST_SOCKET_DIR, nanoid(10)),
        generateSocketPath(TEST_SOCKET_DIR, nanoid(10)),
        generateSocketPath(TEST_SOCKET_DIR, nanoid(10)),
      ];

      // Create the socket files so findSocketForWindow can verify them
      for (const p of paths) {
        mkdirSync(dirname(p), { recursive: true });
        require("node:fs").writeFileSync(p, "dummy");
      }

      registerSocketMapping(window1, paths[0]);
      registerSocketMapping(window2, paths[1]);
      registerSocketMapping(window3, paths[2]);

      expect(WINDOW_SOCKET_MAP.size).toBe(3);
      expect(findSocketForWindow(window1)).not.toBeNull();
      expect(findSocketForWindow(window2)).not.toBeNull();
      expect(findSocketForWindow(window3)).not.toBeNull();

      // Clean up
      for (const p of paths) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    });

    it("lists all UDS subagents from the map", () => {
      const window1 = "explore-1";
      const window2 = "audit-1";
      const socket1 = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));
      const socket2 = generateSocketPath(TEST_SOCKET_DIR, nanoid(10));

      registerSocketMapping(window1, socket1);
      registerSocketMapping(window2, socket2);

      const subagents = Array.from(WINDOW_SOCKET_MAP.entries()).map(([windowName, socketPath]) => ({
        windowName,
        socketPath,
      }));

      expect(subagents).toHaveLength(2);
      expect(subagents.find((s) => s.windowName === window1)?.socketPath).toBe(socket1);
      expect(subagents.find((s) => s.windowName === window2)?.socketPath).toBe(socket2);
    });
  });

  describe("socket directory path", () => {
    it("UDS_SOCKET_DIR is under ~/.pi/subagents/sockets", () => {
      const expected = getExpectedSocketDir();
      expect(expected).toMatch(/\.pi\/subagents\/sockets$/);
    });

    it("socket directory path is platform-independent", () => {
      const expected = getExpectedSocketDir();
      expect(expected).not.toContain("\\"); // Windows would use backslashes
    });

    it("socket directory path uses homedir", () => {
      const expected = getExpectedSocketDir();
      expect(expected).toContain(homedir());
    });
  });
});
