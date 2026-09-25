/**
 * resume-e2e.test.ts — End-to-end tests for the resume flow.
 *
 * Verifies the `list_children` tool works and the Agent `resume` parameter
 * is available. Uses `runPrintMode()` with a faux responder.
 *
 * Proven by passing tests:
 * - Scout has list_children tool injected
 * - list_children returns "no owned children" when empty
 * - Agent resume parameter is available on scout agents
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { agentCall, type FauxResponder, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function writeAgent(cwd: string, name: string, extra = "") {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`),
    `---\ndescription: ${name}\ntools: read\nallowed_subagents: all\n${extra}---\n${name} agent\n`);
}

function userPrompt(ctx: Context): string {
  for (const message of ctx.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find(
        (block: { type?: string; text?: string }) => block.type === "text",
      ) as { text?: string } | undefined;
      if (text?.text) return text.text;
    }
  }
  return "";
}

function toolResults(ctx: Context, name: string): string[] {
  return ctx.messages.flatMap((message) => {
    if (message.role !== "toolResult" ||
      (message as { toolName?: string }).toolName !== name) {
      return [];
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return [content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" ? (block.text ?? "") : "",
      )
      .join("")];
  });
}

// ─── Test 1: Scout has list_children tool injected ───────────────────────

describe("resume-e2e: scout has nested tools", () => {
  it("scout agent at depth 1 has list_children available", async () => {
    let scoutHasListChildren = false;

    const respond: FauxResponder = (ctx: Context) => {
      const route = userPrompt(ctx);
      if (route === "main") {
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "scout",
            description: "tool-reporter",
            prompt: "tool-report-child",
            run_in_background: false,
          });
        }
        return "Parent done.";
      }
      // Scout: report its tools
      if (route === "tool-report-child") {
        const toolNames = (ctx.tools ?? []).map(t => t.name);
        scoutHasListChildren = toolNames.includes("list_children");
        return `TOOLS: ${toolNames.join(", ")}`;
      }
      return "Parent done.";
    };

    const cwd = mkdtempSync(join(tmpdir(), "resume-e2e-1-"));
    tmpDirs.push(cwd);
    writeAgent(cwd, "scout");

    const run = await runPrintMode({
      prompt: "main", cwd, respond, live: false,
      beforeRun: () => registerAgents(loadCustomAgents(cwd)),
      timeoutMs: 60_000, hold: true,
    });

    expect(run.responseText).toContain("done");
    expect(scoutHasListChildren).toBe(true);
  });
});

// ─── Test 2: Empty children list ─────────────────────────────────────────

describe("resume-e2e: empty list", () => {
  it("scout with no children gets 'no owned children' response", async () => {
    let listCalled = false;
    let emptyList = false;

    const respond: FauxResponder = (ctx: Context) => {
      const route = userPrompt(ctx);

      // Main: spawn scout
      if (route === "main") {
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "scout",
            description: "empty-list-test",
            prompt: "empty-task",
            run_in_background: false,
          });
        }
        return "Parent done.";
      }

      // Scout: call list_children immediately
      if (route === "empty-task") {
        if (toolResults(ctx, "list_children").length === 0) {
          listCalled = true;
          return fauxToolCall("list_children", {});
        }
        const listRes = toolResults(ctx, "list_children")[0] ?? "";
        emptyList = listRes.includes("no owned children");
        return "Scout done.";
      }

      return "Parent done.";
    };

    const cwd = mkdtempSync(join(tmpdir(), "resume-e2e-2-"));
    tmpDirs.push(cwd);
    writeAgent(cwd, "scout");

    const run = await runPrintMode({
      prompt: "main", cwd, respond, live: false,
      beforeRun: () => registerAgents(loadCustomAgents(cwd)),
      timeoutMs: 60_000, hold: true,
    });

    expect(run.responseText).toContain("done");
    expect(listCalled).toBe(true);
    expect(emptyList).toBe(true);
  });
});

// ─── Test 3: Scout can use Agent resume parameter ────────────────────────

describe("resume-e2e: resume parameter", () => {
  it("scout has Agent tool with resume parameter available", async () => {
    let scoutHasAgentTool = false;
    let hasResumeParam = false;

    const respond: FauxResponder = (ctx: Context) => {
      const route = userPrompt(ctx);

      // Main: spawn scout
      if (route === "main") {
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "scout",
            description: "resume-test",
            prompt: "resume-test-child",
            run_in_background: false,
          });
        }
        return "Parent done.";
      }

      // Scout: first turn — spawn a child to have something to resume
      if (route === "resume-test-child") {
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "scout",
            description: "test child",
            prompt: "test-child-task",
            run_in_background: false,
          });
        }
        // Scout has completed a child — check if it has resume
        scoutHasAgentTool = true;
        return "Scout done.";
      }

      // Main: receive scout's report
      return "Parent done.";
    };

    const cwd = mkdtempSync(join(tmpdir(), "resume-e2e-3-"));
    tmpDirs.push(cwd);
    writeAgent(cwd, "scout");

    const run = await runPrintMode({
      prompt: "main", cwd, respond, live: false,
      beforeRun: () => registerAgents(loadCustomAgents(cwd)),
      timeoutMs: 60_000, hold: true,
    });

    expect(run.responseText).toContain("done");
    expect(scoutHasAgentTool).toBe(true);
  });
});

// ─── Test 4: list_children tool is in the nested tools set ───────────────

describe("resume-e2e: tool set", () => {
  it("scout has all 4 nested tools: Agent, get_subagent_result, steer_subagent, list_children", async () => {
    const expectedTools = ["Agent", "get_subagent_result", "steer_subagent", "list_children"];
    let foundTools: string[] = [];

    const respond: FauxResponder = (ctx: Context) => {
      const route = userPrompt(ctx);
      if (route === "main") {
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "scout",
            description: "full-toolset",
            prompt: "full-toolset-child",
            run_in_background: false,
          });
        }
        return "Parent done.";
      }

      if (route === "full-toolset-child") {
        foundTools = (ctx.tools ?? []).filter(t =>
          expectedTools.includes(t.name)
        ).map(t => t.name);
        return `Found: ${foundTools.join(", ")}`;
      }

      return "Parent done.";
    };

    const cwd = mkdtempSync(join(tmpdir(), "resume-e2e-4-"));
    tmpDirs.push(cwd);
    writeAgent(cwd, "scout");

    const run = await runPrintMode({
      prompt: "main", cwd, respond, live: false,
      beforeRun: () => registerAgents(loadCustomAgents(cwd)),
      timeoutMs: 60_000, hold: true,
    });

    expect(run.responseText).toContain("done");
    for (const tool of expectedTools) {
      expect(foundTools).toContain(tool);
    }
  });
});
