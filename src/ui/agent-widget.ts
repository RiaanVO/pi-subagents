/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { isTopLevelAgent, type AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, AgentRecord, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short label for the model the run used, e.g. "haiku 4.5". */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/**
 * Format a cost as `~$0.0042`, or "" when there is nothing to show.
 *
 * The tilde is load-bearing: this is pi's own estimate from the model's listed
 * rates, not a billed figure, and the surfaces that print it sit next to token
 * counts that ARE exact.
 *
 * Nothing is printed for zero, which is also what a model with no pricing data
 * reports: `$0.00` beside a local model's tokens would claim its cost was
 * measured and found to be nothing, rather than never measured at all. For the
 * same reason a real cost too small for four decimals reads `<$0.0001` — it was
 * measured, and rounding it to `~$0.0000` would say the opposite.
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";                     // also catches NaN
  if (cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `~$${cost.toFixed(2)}`;
  // Under a dollar: cents at minimum, four decimals at most, nothing trailing.
  // Most single runs land between a tenth of a cent and a dime, where rounding
  // to cents would collapse a 4x difference in spend into the same figure.
  const rounded = Number(cost.toFixed(4));
  const decimals = (String(rounded).split(".")[1] ?? "").length;
  return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/**
 * Mode label is not included — callers add it where they want it.
 *
 * Both model forms come back so each surface can pick by width; the
 * "(asked X)" annotation is applied here rather than by callers, so a value the
 * spawn did not honor cannot be rendered as though it had been (#182).
 */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const asked = (value: string | undefined, requested: string | undefined): string | undefined =>
    value && requested && requested !== value ? `${value} (asked ${requested})` : value;
  const thinking = asked(invocation.thinking, invocation.requestedThinking);
  if (thinking) tags.push(`thinking: ${thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return {
    modelName: asked(invocation.modelName, invocation.requestedModel),
    modelId: asked(invocation.modelId, invocation.requestedModel),
    tags,
  };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension supplies one defaulting to `"background"`.
     */
    private mode: () => WidgetMode = () => "all",
    /**
     * Read live at render time, like `mode`. Whether running agents show an
     * estimated cost beside their token count. Defaults to off — the extension
     * supplies the user's `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * Read live at render time, like `mode`. Whether running agents name the
     * model driving them and the thinking level it is running at. Defaults to
     * off — the extension supplies the user's `showModel` setting — because the
     * row is already dense and the same pair is on the tool result and in the
     * conversation viewer unconditionally.
     */
    private showModel: () => boolean = () => false,
  ) {}

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgents() {
    const all = this.manager.listAgents();
    switch (this.mode()) {
      case "off": return [];
      case "background":
        return all.filter(
          a => isTopLevelAgent(a) && a.isBackground !== false,
        );
      default:
        return all.filter(isTopLevelAgent);
    }
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /**
   * Drop an agent's finished-age (call when a settled agent starts running
   * again, i.e. a background resume). markFinished only seeds an age it has not
   * seen before, so a resumed agent would otherwise keep the age from its
   * previous run — already past the linger limit, hiding the new run's
   * completion line entirely.
   */
  markRunning(agentId: string) {
    this.finishedTurnAge.delete(agentId);
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: { id: string; type: SubagentType; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number; error?: string; lifetimeUsage?: LifetimeUsage }, theme: Theme): string {
    const modeLabel = getPromptModeLabel(a.type);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const activity = this.agentActivity.get(a.id);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    // From the record, not the activity tracker: that entry is deleted the
    // moment an agent finishes, and "what did it cost" is a question asked
    // about finished agents.
    const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
    if (costText) parts.push(costText);
    parts.push(duration);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    return `${icon} ${renderAgentName(a.type, theme, { fallbackColor: "dim" })}${modeTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   * Builds a tree from agent records and renders it linearly with proper indentation.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.widgetAgents();

    if (allAgents.length === 0) return [];

    // Build tree: group children by parent
    const childrenByParent = new Map<string, AgentRecord[]>();
    const topLevels: AgentRecord[] = [];

    for (const a of allAgents) {
      if (a.parentAgentId == null) {
        topLevels.push(a);
      } else {
        if (!childrenByParent.has(a.parentAgentId)) {
          childrenByParent.set(a.parentAgentId, []);
        }
        childrenByParent.get(a.parentAgentId)!.push(a);
      }
    }

    // Sort each group by start time
    topLevels.sort((a, b) => a.startedAt - b.startedAt);
    for (const children of childrenByParent.values()) {
      children.sort((a, b) => a.startedAt - b.startedAt);
    }

    // Helper: count visible lines for an agent and all its descendants
    const lineCount = (a: AgentRecord): number => {
      const selfLines = a.status === "running" ? 2 : 1;
      const childLines = (childrenByParent.get(a.id) || []).reduce((sum, c) => sum + lineCount(c), 0);
      return selfLines + childLines;
    };

    // Helper: check if an agent should be visible
    const isVisible = (a: AgentRecord): boolean => {
      if (a.status === "running") return true;
      if (a.status === "queued") return true;
      if (a.completedAt && this.shouldShowFinished(a.id, a.status)) return true;
      if (a.status === "error" || a.status === "aborted" || a.status === "stopped") return true;
      return false;
    };

    // Check active
    const hasActive = allAgents.some(a => a.status === "running" || a.status === "queued");
    const hasVisible = allAgents.some(a => isVisible(a));
    if (!hasActive && !hasVisible) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    const lines: string[] = [];
    lines.push(truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents")));

    // Budget: heading (1 line) + overflow indicator (1 line) = 2 reserved
    const maxBody = MAX_WIDGET_LINES - 1;
    let budget = maxBody;
    let hiddenCount = 0;

    // Walk the tree recursively, collecting lines
    const walk = (parentId: string | null, isParentLast: boolean, indent: string): void => {
      if (budget <= 0) return;

      const children = parentId === null ? topLevels : (childrenByParent.get(parentId) || []);
      if (children.length === 0) return;

      for (let i = 0; i < children.length && budget > 0; i++) {
        const child = children[i];
        const isLast = (i === children.length - 1);
        const childTotal = lineCount(child);

        if (budget < childTotal) {
          hiddenCount += childTotal;
          break;
        }

        budget -= childTotal;
        hiddenCount = hiddenCount; // no change yet

        // Determine connector
        const connector = isLast ? "└─ " : "├─ ";
        const branchChar = isLast ? "   " : "│  ";
        const childIndent = indent + (isParentLast ? "    " : "│   ");

        if (child.status === "running") {
          // Running agent: 2 lines (header + activity)
          const modeLabel = getPromptModeLabel(child.type);
          const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
          const elapsed = formatMs(Date.now() - child.startedAt);

          const bg = this.agentActivity.get(child.id);
          const toolUses = bg?.toolUses ?? child.toolUses;
          const tokens = getLifetimeTotal(child.lifetimeUsage);
          const contextPercent = getSessionContextPercent(bg?.session);
          const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, child.compactionCount) : "";
          const costText = this.showCost() ? formatCost(getLifetimeCost(child.lifetimeUsage)) : "";

          const parts: string[] = [];
          if (this.showModel()) {
            const { modelName, tags } = buildInvocationTags(child.invocation);
            if (modelName) parts.push(modelName);
            const thinkingTag = tags.find(tag => tag.startsWith("thinking: "));
            if (thinkingTag) parts.push(thinkingTag);
          }
          if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
          if (toolUses > 0) parts.push(`${child.toolUses} tool use${child.toolUses === 1 ? "" : "s"}`);
          if (tokenText) parts.push(tokenText);
          if (costText) parts.push(costText);
          parts.push(elapsed);
          const statsText = parts.join(" · ");

          const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

          lines.push(truncate(
            theme.fg("dim", indent + connector) + ` ${theme.fg("accent", frame)} ${renderAgentName(child.type, theme, { bold: true })}${modeTag}  ${theme.fg("muted", child.description)} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`
          ));
          lines.push(truncate(
            theme.fg("dim", childIndent + branchChar) + `  ⎿  ${activity}`
          ));
        } else {
          // Finished/error/etc: 1 line
          lines.push(truncate(
            theme.fg("dim", indent + connector) + " " + this.renderFinishedLine(child, theme)
          ));
        }

        // Recurse into children
        walk(child.id, isLast, childIndent);
      }
    };

    walk(null, true, "");

    // Recalculate hiddenCount: total potential body lines minus rendered body lines.
    // The walk only counts the first overflowed child, so we fix it here.
    const totalPotentialLines = topLevels.reduce((sum, a) => sum + lineCount(a), 0);
    const renderedBodyLines = lines.length - 1; // subtract heading
    hiddenCount = totalPotentialLines - renderedBodyLines;

    // Add overflow indicator if agents were hidden
    if (hiddenCount > 0) {
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenCount} more`)}`));
    }

    // Fix last connector: swap ├─ → └─
    if (lines.length > 1) {
      const last = lines.length - 1;
      lines[last] = lines[last].replace("├─", "└─");
      // If last item is a running agent activity line, fix the pipe above it
      if (lines[last].includes("⎿")) {
        if (last >= 2) {
          lines[last - 1] = lines[last - 1].replace("│  ", "   ");
        }
      }
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.widgetAgents();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
