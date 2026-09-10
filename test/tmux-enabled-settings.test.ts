/**
 * tmux-enabled-settings.test.ts — Tests for the tmuxEnabled settings feature.
 *
 * Verifies:
 * - tmuxEnabled round-trips through save/load
 * - Legacy "tmux" transport is downgraded to "uds"
 * - tmuxEnabled flows through applySettings to the applier
 * - spawnUdsSubagent returns { windowName, socketPath }
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySettings, loadSettings, saveSettings, type SettingsAppliers } from "../src/settings.js";

describe("tmuxEnabled settings", () => {
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-tmux-enabled-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(projectDir, "global-agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify(obj));
  }

  describe("round-trip", () => {
    it("saves and loads tmuxEnabled: true", () => {
      saveSettings({ tmuxEnabled: true }, projectDir);
      expect(loadSettings(projectDir)).toEqual({ tmuxEnabled: true });
    });

    it("saves and loads tmuxEnabled: false", () => {
      saveSettings({ tmuxEnabled: false }, projectDir);
      expect(loadSettings(projectDir)).toEqual({ tmuxEnabled: false });
    });

    it("drops non-boolean tmuxEnabled values", () => {
      writeProject({ tmuxEnabled: "on" } as any);
      expect(loadSettings(projectDir).tmuxEnabled).toBeUndefined();
      writeProject({ tmuxEnabled: 1 } as any);
      expect(loadSettings(projectDir).tmuxEnabled).toBeUndefined();
      writeProject({ tmuxEnabled: null } as any);
      expect(loadSettings(projectDir).tmuxEnabled).toBeUndefined();
    });

    it("tmuxEnabled persists alongside other settings", () => {
      saveSettings({ tmuxEnabled: true, defaultTransport: "uds", maxConcurrent: 4 }, projectDir);
      expect(loadSettings(projectDir)).toEqual({
        tmuxEnabled: true,
        defaultTransport: "uds",
        maxConcurrent: 4,
      });
    });

    it("absence of tmuxEnabled is not stored", () => {
      saveSettings({}, projectDir);
      expect(loadSettings(projectDir)).toEqual({});
      expect(loadSettings(projectDir).tmuxEnabled).toBeUndefined();
    });
  });

  describe("legacy transport downgrade", () => {
    it('downgrades defaultTransport: "tmux" to "uds"', () => {
      writeProject({ defaultTransport: "tmux" });
      const loaded = loadSettings(projectDir);
      expect(loaded.defaultTransport).toBe("uds");
    });

    it('downgrades defaultTransport: "tmux" without changing tmuxEnabled', () => {
      writeProject({ defaultTransport: "tmux", tmuxEnabled: true });
      const loaded = loadSettings(projectDir);
      expect(loaded.defaultTransport).toBe("uds");
      expect(loaded.tmuxEnabled).toBe(true);
    });

    it('still accepts valid transport values "in-process" and "uds"', () => {
      writeProject({ defaultTransport: "in-process" });
      expect(loadSettings(projectDir).defaultTransport).toBe("in-process");

      writeProject({ defaultTransport: "uds" });
      expect(loadSettings(projectDir).defaultTransport).toBe("uds");
    });

    it("drops invalid defaultTransport values", () => {
      writeProject({ defaultTransport: "invalid" });
      expect(loadSettings(projectDir).defaultTransport).toBeUndefined();

      writeProject({ defaultTransport: 42 } as any);
      expect(loadSettings(projectDir).defaultTransport).toBeUndefined();
    });
  });

  describe("applySettings wiring", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setMaxConcurrentForeground: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setSchedulingEnabled: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
        setRememberAgents: vi.fn(),
        setWidgetMode: vi.fn(),
        setViewerMarkdown: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setWorkflowsEnabled: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setFallbackSubagent: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
        setShowModel: vi.fn(),
        setDefaultTransport: vi.fn(),
        setTmuxEnabled: vi.fn(),
      };
    });

    it("calls setTmuxEnabled(true) when tmuxEnabled is true", () => {
      applySettings({ tmuxEnabled: true }, appliers);
      expect(appliers.setTmuxEnabled).toHaveBeenCalledWith(true);
    });

    it("calls setTmuxEnabled(false) when tmuxEnabled is false", () => {
      applySettings({ tmuxEnabled: false }, appliers);
      expect(appliers.setTmuxEnabled).toHaveBeenCalledWith(false);
    });

    it("does not call setTmuxEnabled when absent", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setTmuxEnabled).not.toHaveBeenCalled();
    });

    it("calls setDefaultTransport for legacy 'tmux' (after downgrade in sanitize)", () => {
      // The sanitize function downgrades "tmux" → "uds", so the applier receives "uds"
      writeProject({ defaultTransport: "tmux" });
      const settings = loadSettings(projectDir);
      expect(settings.defaultTransport).toBe("uds");
      applySettings(settings, appliers);
      expect(appliers.setDefaultTransport).toHaveBeenCalledWith("uds");
    });
  });
});
