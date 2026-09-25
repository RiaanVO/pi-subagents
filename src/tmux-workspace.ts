/**
 * tmux-workspace.ts — Launch subagents in separate tmux windows for direct interaction.
 *
 * Philosophy: pi says "No background bash. Use tmux." and "Spawn pi instances via tmux."
 * This module puts that into practice: each subagent gets its own tmux window with a
 * live `pi` process, so you can switch to it, interact directly, send steering messages,
 * and read output without leaving your terminal multiplexer.
 *
 * Two modes:
 *
 *   1. **Interactive** (default) — spawns `pi -c` (continue) or a fresh `pi` in the
 *      window, giving you a full TUI session. You can interact, run commands, etc.
 *      Steering from the parent agent works via `session.steer()` if the session file
 *      is shared.
 *
 *   2. **Print** — runs `pi -p "<prompt>"` in the background. The window opens, pi
 *      runs to completion, outputs its result to stdout which is captured, then pi
 *      exits. The pane title shows completion status.
 *
 * Session layout:
 *   - Window 0: "pi-subagents" — the control dashboard
 *   - Window 1+: each subagent gets its own window named after the agent type + handle
 *
 * Commands:
 *   `pi-tmux spawn <type> <prompt>` — spawn a subagent in a new tmux window
 *   `pi-tmux list` — list all active subagent windows
 *   `pi-tmux attach <window>` — switch to a subagent's window
 *   `pi-tmux stop <window>` — send Ctrl+C to stop a subagent
 *   `pi-tmux results` — show completed subagent results
 */

import { execSync, } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

// ---- Constants ----

/** Name of the master tmux session that holds all subagent windows. */
export const TMUX_SESSION_NAME = "pi-subagents";

/** How long to wait for a print-mode agent to complete before timing out (ms). */
const PRINT_TIMEOUT_MS = 300_000; // 5 minutes

/** Base directory for UDS socket files. */
export const UDS_SOCKET_DIR = join(homedir(), ".pi", "subagents", "sockets");

/** Timeout for UDS socket connection (ms). */
const UDS_CONNECT_TIMEOUT = 5000;

/** Path to the compiled uds-child.mjs (resolved at runtime from this module's location). */
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const UDS_CHILD_PATH = join(dirname(__dirname), "src", "uds-child.mjs");

// ---- Types ----

/** In-memory registry tracking which tmux window uses which UDS socket. */
const WINDOW_SOCKET_MAP = new Map<string, string>();

/** Information about a subagent window in the tmux session. */
export interface TmuxSubagentInfo {
  /** Window index (numeric). */
  windowIndex: number;
  /** Window name (e.g., "explore-1", "audit-2"). */
  windowName: string;
  /** Subagent type (e.g., "Explore", "Audit"). */
  type: string;
  /** Description of what the agent is doing. */
  description: string;
  /** Whether the window is still running (active pi process). */
  isActive: boolean;
  /** Whether it was spawned in print mode (auto-complete, no interaction). */
  isPrintMode: boolean;
  /** Path to the output file (print mode) or session file (interactive). */
  outputPath?: string;
  /** Result text (read from output file if completed in print mode). */
  result?: string;
  /** Started timestamp. */
  startedAt: number;
  /** Completed timestamp (if completed). */
  completedAt?: number;
  /** UDS socket path for this subagent (UDS mode only). */
  socketPath?: string;
  /** Child process PID (UDS mode). */
  pid?: number;
}

// ---- Helpers ----

/** Check if tmux is available and a session manager exists. */
export function isTmuxAvailable(): boolean {
  try {
    execSync("tmux list-sessions 2>/dev/null", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Get or create the master tmux session. */
function getOrCreateSession(): string {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION_NAME} 2>/dev/null`, { stdio: "pipe" });
    return TMUX_SESSION_NAME;
  } catch {
    // Session doesn't exist — create it
    execSync(`tmux new-session -d -s ${TMUX_SESSION_NAME} -x 200 -y 50`, { stdio: "pipe" });
    return TMUX_SESSION_NAME;
  }
}

/** Check if a window exists in the tmux session. */
function windowExists(windowName: string): boolean {
  try {
    execSync(
      `tmux has-session -t ${TMUX_SESSION_NAME}:${windowName} 2>/dev/null`,
      { stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

/** Get the process ID of a window's main pane. */
function getPanePid(windowName: string): number | null {
  try {
    const output = execSync(
      `tmux display-message -t ${TMUX_SESSION_NAME}:${windowName} -p "#{pane_pid}"`,
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();
    return parseInt(output, 10);
  } catch {
    return null;
  }
}

/** Send a key sequence to a tmux pane. */
function sendKeys(windowName: string, keys: string): void {
  try {
    execSync(
      `tmux send-keys -t ${TMUX_SESSION_NAME}:${windowName} ${JSON.stringify(keys)} C-m`,
      { stdio: "pipe" },
    );
  } catch {
    // Pane might be gone — that's fine
  }
}

/** Send Ctrl+C to stop a process in a tmux pane. */
export function stopWindow(windowName: string): void {
  sendKeys(windowName, "C-c");
}

// ---- Core: Spawn Subagents ----

/**
 * Generate a unique window name for a subagent.
 * Format: `<type>-<short-id>` where type is slugified.
 */
function generateWindowName(type: string, description: string): string {
  const slug = type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  // Short description prefix if available
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join("-");
  const prefix = descWords ? `${slug}-${descWords}` : slug;
  return prefix;
}

/**
 * Find an available window name (handles collisions by appending a number).
 */
function findAvailableWindowName(baseName: string): string {
  let candidate = baseName;
  let suffix = 2;
  while (windowExists(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix++;
  }
  return candidate;
}

/**
 * Spawn a subagent in a new tmux window.
 *
 * @param type - The subagent type (e.g., "Explore", "Audit")
 * @param prompt - The prompt to give the agent
 * @param options - Configuration options
 * @returns Window name if successful, null otherwise
 */
export function spawnSubagent(
  type: string,
  prompt: string,
  options?: {
    /** Working directory for the pi instance. Defaults to process.cwd(). */
    cwd?: string;
    /** Model to use (e.g., "sonnet", "gpt-4o"). */
    model?: string;
    /** Thinking level. */
    thinking?: string;
    /** Whether to run in print mode (background, non-interactive). */
    printMode?: boolean;
    /** Session file to resume (for interactive mode). */
    resumeSession?: string;
    /** Additional pi arguments. */
    extraArgs?: string[];
  },
): string | null {
  const cwd = options?.cwd ?? process.cwd();
  const printMode = options?.printMode ?? false;
  const sessionFile = options?.resumeSession;

  // Get or create the master session
  getOrCreateSession();

  // Generate window name
  let windowName = generateWindowName(type, prompt);
  windowName = findAvailableWindowName(windowName);

  // Build the pi command
  let cmd = "pi";
  const args: string[] = [];

  // Escape quotes so the prompt survives shell/tmux quoting
  const _escapedPrompt = prompt.replace(/"/g, '\\"');

  if (printMode) {
    // Print mode: run once and exit
    cmd = "pi";
    args.push("-p");
    if (options?.model) args.push("--model", options.model);
    if (options?.thinking) args.push("--thinking", options.thinking);
    if (options?.extraArgs) args.push(...options.extraArgs);
    args.push(`"${_escapedPrompt}"`);
  } else {
    // Interactive mode: start a fresh pi session or resume
    if (sessionFile && existsSync(sessionFile)) {
      cmd = "pi";
      args.push("--session", sessionFile);
    } else {
      cmd = "pi";
      // Start fresh with the prompt
      args.push(`"${_escapedPrompt}"`);
      if (options?.model) args.push("--model", options.model);
      if (options?.thinking) args.push("--thinking", options.thinking);
      if (options?.extraArgs) args.push(...options.extraArgs);
    }
  }

  try {
    // Create new window, detached
    // We need to cd to the working directory first, then run pi
    const cdCmd = `cd ${JSON.stringify(cwd)} && ${cmd} ${args.join(" ")}`;

    execSync(
      `tmux new-window -t ${TMUX_SESSION_NAME} -n "${windowName}" "${cdCmd}"`,
      {
        stdio: "pipe",
        encoding: "utf-8",
      },
    );

    // Set the window title to show the agent type and description
    try {
      execSync(
        `tmux set-window-option -t ${TMUX_SESSION_NAME}:${windowName} window-status-format "${type}"`,
        { stdio: "pipe" },
      );
      execSync(
        `tmux set-window-option -t ${TMUX_SESSION_NAME}:${windowName} window-active-status-format "${type} [running]"`,
        { stdio: "pipe" },
      );
    } catch {
      // Title settings are nice-to-have
    }

    return windowName;
  } catch (err) {
    console.error(`Failed to spawn subagent "${windowName}":`, err);
    return null;
  }
}

// ---- UDS-based Subagent Helpers ----

/** Ensure the UDS socket directory exists. */
function ensureSocketDir(): void {
  if (!existsSync(UDS_SOCKET_DIR)) {
    mkdirSync(UDS_SOCKET_DIR, { recursive: true });
  }
}

/** Clean up a stale socket file (remove if it exists). */
export function cleanupUdsSession(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      statSync(socketPath).isSocket() && unlinkSync(socketPath);
    }
  } catch {
    // Socket might be invalid or already removed — ignore
  }
}

/**
 * Generate a unique UDS socket path for a subagent.
 * Format: ~/.pi/subagents/sockets/sock-<uuid>
 */
function generateSocketPath(): string {
  const id = nanoid(10);
  return join(UDS_SOCKET_DIR, `sock-${id}`);
}

/**
 * Spawn a UDS-based subagent in a new tmux window.
 *
 * @param type - The subagent type (e.g., "Explore", "Audit")
 * @param prompt - The prompt to give the agent
 * @param options - Configuration options
 * @returns Window name if successful, null otherwise
 */
export function spawnUdsSubagent(
  type: string,
  prompt: string,
  options?: {
    /** Working directory for the node process. Defaults to process.cwd(). */
    cwd?: string;
    /** Model to use (e.g., "sonnet", "gpt-4o"). */
    model?: string;
    /** Thinking level. */
    thinking?: string;
    /** Maximum turns for the agent. */
    maxTurns?: number;
    /** Whether to run in isolated mode. */
    isolated?: boolean;
    /** Session file to resume. */
    resumeSession?: string;
    /** Additional agent ID. */
    agentId?: string;
  },
): { windowName: string; socketPath: string } | null {
  const cwd = options?.cwd ?? process.cwd();

  // Ensure the socket directory exists
  ensureSocketDir();

  // Generate unique socket path
  const socketPath = generateSocketPath();

  // Clean up any stale socket from a previous run
  cleanupUdsSession(socketPath);

  // Register socket→window mapping
  const windowNameBase = generateWindowName(type, prompt);
  let windowName = findAvailableWindowName(windowNameBase);
  WINDOW_SOCKET_MAP.set(windowName, socketPath);

  // Build environment variables for the node command
  const envVars: string[] = [
    `PI_SUBAGENTS_UDS_SOCKET="${socketPath}"`,
    `PI_SUBAGENTS_SESSION_FILE="${options?.resumeSession ?? ""}"`,
    `PI_CODING_AGENT_DIR="${process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi")}"`,
    `PI_CODING_AGENT_SESSION_DIR="${options?.resumeSession ?? ""}"`,
    `PI_SUBAGENTS_AGENT_TYPE="${type}"`,
    `PI_SUBAGENTS_PROMPT="${JSON.stringify(prompt).slice(1, -1)}"`,
  ];

  // Optional env vars
  if (options?.model) envVars.push(`PI_SUBAGENTS_MODEL="${options.model}"`);
  if (options?.thinking) envVars.push(`PI_SUBAGENTS_THINKING="${options.thinking}"`);
  if (options?.maxTurns) envVars.push(`PI_SUBAGENTS_MAX_TURNS="${options.maxTurns}"`);
  envVars.push(`PI_SUBAGENTS_CWD="${cwd}"`);
  if (options?.isolated) envVars.push('PI_SUBAGENTS_ISOLATED="true"');
  envVars.push(`PI_SUBAGENTS_SOCKET_DIR="${UDS_SOCKET_DIR}"`);

  // Build the tmux command:
  //   cd "<cwd>" && env VAR1="val1" VAR2="val2" node "uds-child-path"
  const envStr = envVars.join(" ");
  const cdCmd = `cd ${JSON.stringify(cwd)}`;
  const nodeCmd = `node "${UDS_CHILD_PATH}"`;
  const fullCmd = `${cdCmd} && env ${envStr} ${nodeCmd}`;

  // Get or create the master session
  getOrCreateSession();

  try {
    // Create new window, detached
    execSync(
      `tmux new-window -t ${TMUX_SESSION_NAME} -n "${windowName}" "${fullCmd}"`,
      {
        stdio: "pipe",
        encoding: "utf-8",
      },
    );

    // Set the window title to show the agent type and description
    try {
      execSync(
        `tmux set-window-option -t ${TMUX_SESSION_NAME}:${windowName} window-status-format "${type}"`,
        { stdio: "pipe" },
      );
      execSync(
        `tmux set-window-option -t ${TMUX_SESSION_NAME}:${windowName} window-active-status-format "${type} [running]"`,
        { stdio: "pipe" },
      );
    } catch {
      // Title settings are nice-to-have
    }

    return { windowName, socketPath };
  } catch (err) {
    console.error(`Failed to spawn UDS subagent "${windowName}":`, err);
    // Clean up the socket path registration
    WINDOW_SOCKET_MAP.delete(windowName);
    return null;
  }
}

/**
 * Send a steering message through the UDS socket for a given tmux window.
 */
export async function steerTmuxWindow(
  windowName: string,
  message: string,
): Promise<boolean> {
  const socketPath = WINDOW_SOCKET_MAP.get(windowName);
  if (!socketPath) {
    console.error(`No socket found for window "${windowName}"`);
    return false;
  }

  // Also check if the socket file exists (may have been cleaned up)
  if (!existsSync(socketPath)) {
    // Try to find it from tmux pane title or metadata
    const foundSocket = getSocketPathForWindow(windowName);
    if (!foundSocket) {
      console.error(`Socket file not found for window "${windowName}"`);
      return false;
    }
    WINDOW_SOCKET_MAP.set(windowName, foundSocket);
    return steerTmuxWindow(windowName, message); // retry
  }

  try {
    return await connectAndSend(socketPath, message);
  } catch (err) {
    console.error(`Failed to steer "${windowName}":`, err);
    return false;
  }
}

/**
 * Look up the socket path for a window by inspecting tmux metadata or the window name.
 */
/**
 * Discover the UDS socket path for a tmux window. Exported for agent-manager.
 */
export function getSocketPathForWindow(windowName: string): string | null {
  // Strategy 1: Check the registered map
  const mapped = WINDOW_SOCKET_MAP.get(windowName);
  if (mapped && existsSync(mapped)) return mapped;

  // Strategy 2: Search socket files for one whose name matches the window
  // UDS children name their socket files after the socket path
  try {
    const socketFiles = existsSync(UDS_SOCKET_DIR)
      ? readdirSync(UDS_SOCKET_DIR).filter((f) => f.startsWith("sock-"))
      : [];
    for (const sf of socketFiles) {
      const fullPath = join(UDS_SOCKET_DIR, sf);
      if (existsSync(fullPath)) {
        // Check if any tmux window references this socket
        WINDOW_SOCKET_MAP.set(windowName, fullPath);
        return fullPath;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Connect to a UDS socket and send a steering message.
 */
async function connectAndSend(socketPath: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      // Connected — send the steer command
      const steerPayload = JSON.stringify({
        type: "steer",
        message,
      });
      client.write(steerPayload + "\n");
      client.end();
      resolve(true);
    });

    client.setTimeout(UDS_CONNECT_TIMEOUT);
    client.on("timeout", () => {
      client.destroy();
      resolve(false);
    });
    client.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Spawn multiple subagents in parallel, each in its own tmux window.
 * Returns a map of type → windowName.
 */
export function spawnSubagentsParallel(
  agents: Array<{ type: string; prompt: string; options?: Record<string, unknown> }>,
): Record<string, string | null> {
  const results: Record<string, string | null> = {};
  for (const agent of agents) {
    results[agent.type] = spawnSubagent(
      agent.type,
      agent.prompt,
      agent.options as typeof agents[0]["options"],
    );
  }
  return results;
}

// ---- Core: List and Query Subagents ----

/**
 * List all subagent windows in the tmux session.
 */
export function listSubagents(): TmuxSubagentInfo[] {
  const session = getOrCreateSession();

  try {
    // Get all window names in the session
    const output = execSync(
      `tmux list-windows -t ${session} -F "#{window_index}:#{window_name}:#{window_active}"`,
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();

    if (!output) return [];

    const lines = output.split("\n");
    const subagents: TmuxSubagentInfo[] = [];

    for (const line of lines) {
      const [indexStr, windowName, activeStr] = line.split(":");
      const isActive = activeStr === "1";
      const windowIndex = parseInt(indexStr, 10);

      // Skip the dashboard window (index 0)
      if (windowIndex === 0) continue;

      // Try to parse type and description from window name
      const typeMatch = windowName.match(/^([^-\s]+)-?/);
      const type = typeMatch ? typeMatch[1].charAt(0).toUpperCase() + typeMatch[1].slice(1) : "agent";

      subagents.push({
        windowIndex,
        windowName,
        type,
        description: windowName,
        isActive,
        isPrintMode: false, // Not tracked per-window yet
        startedAt: Date.now(),
      });
    }

    return subagents;
  } catch {
    return [];
  }
}

/**
 * List all UDS-based subagent windows in the tmux session.
 * Only returns subagents that are registered in the UDS socket map.
 */
export function listUdsSubagents(): TmuxSubagentInfo[] {
  const allSubagents = listSubagents();
  const udsSubagents: TmuxSubagentInfo[] = [];

  for (const agent of allSubagents) {
    const socketPath = WINDOW_SOCKET_MAP.get(agent.windowName);
    if (socketPath) {
      udsSubagents.push({
        ...agent,
        socketPath,
        pid: undefined, // Can be fetched dynamically if needed
      });
    }
  }

  return udsSubagents;
}

/**
 * Get detailed info about a specific subagent window (including UDS info).
 */
export function getSubagentInfo(windowName: string): TmuxSubagentInfo | null {
  const session = getOrCreateSession();

  try {
    const output = execSync(
      `tmux list-windows -t ${session} -F "#{window_index}:#{window_name}:#{window_active}:#{pane_pid}:#{pane_current_path}"`,
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();

    for (const line of output.split("\n")) {
      const [indexStr, name, activeStr, pidStr, cwd] = line.split(":");
      if (name === windowName) {
        const typeMatch = name.match(/^([^-\s]+)-?/);
        return {
          windowIndex: parseInt(indexStr, 10),
          windowName: name,
          type: typeMatch ? typeMatch[1].charAt(0).toUpperCase() + typeMatch[1].slice(1) : "agent",
          description: name,
          isActive: activeStr === "1" || parseInt(pidStr, 10) > 0,
          isPrintMode: false,
          outputPath: join(cwd, `.pi/subagents/${name}.output`),
          startedAt: Date.now(),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Core: Subagent Status ----

/**
 * Returns the current status of a tmux subagent window.
 *
 * @param windowName - The tmux window name
 * @returns 'running', 'completed', 'error', or 'unknown'
 */
export function getTmuxSubagentStatus(windowName: string): "running" | "completed" | "error" | "unknown" {
  // Check if the window exists
  if (!windowExists(windowName)) {
    return "unknown";
  }

  // Check the pane PID
  const pid = getPanePid(windowName);
  if (!pid) {
    return "completed";
  }

  // Check if the process is still alive
  try {
    // Send signal 0 to check existence without actually killing it
    execSync(`kill -0 ${pid} 2>/dev/null`, { stdio: "pipe" });
    return "running";
  } catch {
    // Process is gone
    return "completed";
  }
}

// ---- Cleanup on Parent Exit ----

/**
 * Get all subagent window names currently in the tmux session.
 * Excludes window 0 (dashboard).
 */
export function getAllSubagentWindowNames(): string[] {
  try {
    const output = execSync(
      `tmux list-windows -t ${TMUX_SESSION_NAME} -F "#{window_name}"`,
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();
    if (!output) return [];
    const allNames = output.split("\n").filter(Boolean);
    // Skip the dashboard (window 0)
    return allNames.filter(n => n !== "dashboard");
  } catch {
    return [];
  }
}

/**
 * Send Ctrl+C to all subagent windows to attempt graceful stop.
 */
export function stopAllSubagentWindows(): void {
  const windows = getAllSubagentWindowNames();
  for (const window of windows) {
    stopWindow(window);
  }
}

/**
 * Kill the entire tmux session (after graceful attempts).
 */
export function killTmuxSession(): void {
  try {
    execSync(`tmux kill-session -t ${TMUX_SESSION_NAME}`, { stdio: "pipe" });
  } catch {
    // Session may already be gone — that's fine
  }
}

/**
 * Orchestrates the full tmux cleanup on parent exit.
 * Strategy: Ctrl+C all windows → wait 1s → kill the entire session.
 * Wrapped in try/catch so tmux unavailability doesn't break parent shutdown.
 */
export function cleanupTmuxOnExit(): void {
  try {
    // Only attempt if tmux is available
    if (!isTmuxAvailable()) return;

    // Phase 1: Send Ctrl+C to all windows for graceful stop
    stopAllSubagentWindows();

    // Phase 2: Wait a brief period for graceful shutdown
    const start = Date.now();
    while (Date.now() - start < 1000) {
      // Check if any windows are still alive
      const windows = getAllSubagentWindowNames();
      if (windows.length === 0) break;

      // Check if pane PIDs are still alive
      let allGone = true;
      for (const window of windows) {
        try {
          const pid = getPanePid(window);
          if (pid) {
            execSync(`kill -0 ${pid} 2>/dev/null`, { stdio: "pipe" });
            allGone = false;
          }
        } catch {
          // Process gone, continue checking
        }
      }
      if (allGone && windows.length === 0) break;

      // Brief sleep (50ms polling)
      const startSleep = Date.now();
      while (Date.now() - startSleep < 50) { /* busy wait */ }
    }

    // Phase 3: Aggressively kill the entire session
    killTmuxSession();
  } catch {
    // tmux may be unavailable, session already gone, etc.
    // This must never break parent shutdown
  }
}

// ---- Core: View Results ----

/**
 * Read the output from a completed subagent.
 * For print mode, reads from the output file.
 * For interactive mode, tries to grab the pane's history.
 */
export function getSubagentResult(windowName: string): string | null {
  const session = getOrCreateSession();

  try {
    // Try to read from an output file first (print mode)
    const outputDir = join(homedir(), ".pi", "subagents");
    const outputPath = join(outputDir, `${windowName}.output`);
    if (existsSync(outputPath)) {
      return readFileSync(outputPath, "utf-8");
    }

    // Try to get the last output from tmux pane history
    const output = execSync(
      `tmux capture-pane -t ${session}:${windowName} -p`,
      { stdio: "pipe", encoding: "utf-8" },
    );

    // Extract the last meaningful text block (after the prompt)
    const lines = output.split("\n");
    // Find lines that look like assistant output (not pi prompts, not bash commands)
    const outputLines = lines.filter(
      (l) =>
        !l.startsWith("$ ") &&
        !l.startsWith("pi ") &&
        !l.includes("┌─") &&
        !l.includes("└─") &&
        !l.includes("╭─") &&
        !l.includes("╰─"),
    );

    return outputLines.join("\n").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Show results for all completed subagents.
 */
export function showResults(): string {
  const subagents = listSubagents();

  if (subagents.length === 0) {
    return "No subagents running.";
  }

  const lines: string[] = [];
  for (const agent of subagents) {
    const status = agent.isActive ? "running" : "completed";
    const result = getSubagentResult(agent.windowName);
    const preview = result
      ? result.split("\n").slice(0, 3).join("\n").slice(0, 200)
      : "no output";

    lines.push(
      `[${agent.windowIndex}] ${agent.type} (${agent.windowName}) — ${status}`,
      `  ${preview}`,
      "",
    );
  }

  return lines.join("\n");
}

// ---- Core: Dashboard ----

/**
 * Create or update the dashboard window (window 0).
 * Shows the status of all subagents.
 */
export function updateDashboard(): void {
  const session = getOrCreateSession();
  const subagents = listSubagents();

  const total = subagents.length;
  const active = subagents.filter((a) => a.isActive).length;
  const completed = total - active;

  const dashboard = [
    `╔══════════════════════════════════════════════════╗`,
    `║          PI SUBAGENTS DASHBOARD                  ║`,
    `╠══════════════════════════════════════════════════╣`,
    `║                                                  ║`,
    `║  Total agents: ${String(total).padEnd(34)}║`,
    `║  Active:      ${String(active).padEnd(34)}║`,
    `║  Completed:   ${String(completed).padEnd(34)}║`,
    `║                                                  ║`,
    `╠══════════════════════════════════════════════════╣`,
    `║  WINDOWS                                         ║`,
    `╠══════════════════════════════════════════════════╣`,
  ];

  for (const agent of subagents) {
    const status = agent.isActive ? "▶ RUN" : "✓ DONE";
    const padding = " ".repeat(Math.max(1, 8 - agent.type.length));
    dashboard.push(
      `║  [${String(agent.windowIndex).padEnd(2)}] ${agent.type}${padding} ${status}  ${agent.windowName.slice(0, 20)}`,
    );
  }

  if (subagents.length === 0) {
    dashboard.push(`║                                                  ║`);
    dashboard.push(`║  No subagents spawned yet.                       ║`);
  }

  dashboard.push(`╚══════════════════════════════════════════════════╝`);
  dashboard.push(``);
  dashboard.push(`Shortcuts:`);
  dashboard.push(`  tmux attach -t ${session}        — Attach to session`);
  dashboard.push(`  Ctrl+B then N                    — Next window`);
  dashboard.push(`  Ctrl+B then P                    — Previous window`);
  dashboard.push(`  Ctrl+B then <number>             — Jump to window`);

  // Update the dashboard pane content
  try {
    execSync(
      `tmux send-keys -t ${session}:0 "${dashboard.join("\\n")}" C-m`,
      { stdio: "pipe" },
    );
  } catch {
    // Dashboard pane might not exist yet
  }
}

/**
 * Initialize the tmux workspace session with a dashboard.
 */
export function initWorkspace(): string {
  const session = getOrCreateSession();

  // Check if dashboard (window 0) exists
  try {
    execSync(
      `tmux has-session -t ${session}:0 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    // Dashboard doesn't exist — create it
    execSync(`tmux new-window -t ${session}:0 -n "dashboard" "echo 'Loading...'"`, {
      stdio: "pipe",
    });
  }

  updateDashboard();
  return session;
}

// ---- Integration with Agent Manager ----

/**
 * A tmux-based agent runner that replaces the in-process agent runner.
 * Returns a window name instead of a session object.
 */
export interface TmuxAgentResult {
  /** The tmux window name where the agent is running. */
  windowName: string;
  /** Whether the agent is running in print mode. */
  isPrintMode: boolean;
}

/**
 * Run an agent in a tmux window.
 * This is the main entry point for tmux-based subagents.
 *
 * @param type - The subagent type (e.g., "Explore", "Audit")
 * @param prompt - The prompt to give the agent
 * @param options - Configuration options
 * @returns Window name if successful, null otherwise
 */
export function runAgentInTmux(
  type: string,
  prompt: string,
  options?: {
    /** Working directory for the agent. */
    cwd?: string;
    /** Model to use (e.g., "sonnet", "gpt-4o"). */
    model?: string;
    /** Thinking level. */
    thinking?: string;
    /** Whether to run in print mode (background, non-interactive). */
    printMode?: boolean;
    /** Session file to resume (in-process mode). */
    resumeSession?: string;
    /** Maximum turns for the agent (UDS mode). */
    maxTurns?: number;
    /** Whether to run in isolated mode (UDS mode). */
    isolated?: boolean;
    /** Additional agent ID (UDS mode). */
    agentId?: string;
  },
): TmuxAgentResult | null {
  // Tmux always uses UDS underneath — tmux is the display layer, UDS is the transport.
  const result = spawnUdsSubagent(type, prompt, {
    cwd: options?.cwd,
    model: options?.model,
    thinking: options?.thinking,
    maxTurns: options?.maxTurns,
    isolated: options?.isolated,
    resumeSession: options?.resumeSession,
    agentId: options?.agentId,
  });
  if (!result) return null;
  return {
    windowName: result.windowName,
    isPrintMode: false, // UDS agents are always interactive
  };
}

/**
 * Wait for a print-mode agent to complete and return its result.
 * Polls the tmux pane for output changes.
 */
export async function waitForPrintResult(
  windowName: string,
  timeoutMs: number = PRINT_TIMEOUT_MS,
): Promise<string | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const info = getSubagentInfo(windowName);
    if (!info) break; // Window gone — agent completed

    const result = getSubagentResult(windowName);
    if (result && result.length > 50) {
      // Has meaningful output — might be done
      // Check if the process is still alive
      const pid = getPanePid(windowName);
      if (!pid) {
        // Process is gone — completed
        return result;
      }
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

// ---- CLI Entry Point ----

/**
 * Handle command-line arguments for standalone usage.
 * Usage: pi-tmux <command> [args...]
 */
export function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "init":
      {
        const session = initWorkspace();
        console.log(`Workspace session "${session}" created.`);
        console.log(`Attach with: tmux attach -t ${session}`);
      }
      break;

    case "spawn":
      {
        if (args.length < 2) {
          console.error("Usage: pi-tmux spawn <type> <prompt> [options...]");
          process.exit(1);
        }
        const type = args[1];
        const prompt = args.slice(2).join(" ");
        const windowName = spawnSubagent(type, prompt);
        if (windowName) {
          console.log(`Spawned "${type}" in window "${windowName}".`);
          console.log(`Attach with: tmux attach -t ${TMUX_SESSION_NAME}:${windowName}`);
        } else {
          console.error("Failed to spawn subagent.");
          process.exit(1);
        }
      }
      break;

    case "list":
      {
        const subagents = listSubagents();
        if (subagents.length === 0) {
          console.log("No subagents running.");
        } else {
          console.log(`Active subagents (${subagents.length}):`);
          for (const agent of subagents) {
            const status = agent.isActive ? "running" : "completed";
            console.log(`  [${agent.windowIndex}] ${agent.windowName} — ${status}`);
          }
        }
      }
      break;

    case "attach":
      {
        if (args.length < 2) {
          console.error("Usage: pi-tmux attach <window-name>");
          process.exit(1);
        }
        const windowName = args[1];
        console.log(`Attaching to ${TMUX_SESSION_NAME}:${windowName}...`);
        console.log(`Run: tmux attach -t ${TMUX_SESSION_NAME}:${windowName}`);
      }
      break;

    case "stop":
      {
        if (args.length < 2) {
          console.error("Usage: pi-tmux stop <window-name>");
          process.exit(1);
        }
        stopWindow(args[1]);
        console.log(`Sent Ctrl+C to ${args[1]}.`);
      }
      break;

    case "results":
      {
        console.log(showResults());
      }
      break;

    case "dashboard":
      {
        const session = initWorkspace();
        console.log(`Dashboard updated in ${session}:0`);
      }
      break;

    default:
      console.log("pi-tmux — Manage subagents in tmux windows");
      console.log("");
      console.log("Usage:");
      console.log("  pi-tmux init              — Initialize workspace session");
      console.log("  pi-tmux spawn <type> <prompt> — Spawn a subagent");
      console.log("  pi-tmux list              — List active subagents");
      console.log("  pi-tmux attach <window>   — Show how to attach to a window");
      console.log("  pi-tmux stop <window>     — Stop a subagent");
      console.log("  pi-tmux results           — Show subagent results");
      console.log("  pi-tmux dashboard         — Update the dashboard");
      break;
  }
}

// Auto-run if called directly
if (import.meta.url && process.argv[1] && resolve(process.argv[1]).endsWith("tmux-workspace.ts")) {
  main();
}
