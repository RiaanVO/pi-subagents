/**
 * uds-agent-runner.ts — Parent-side logic for spawning and managing UDS child processes.
 *
 * Forks a child process running `uds-child.mjs`, connects to the child's UDS socket,
 * subscribes to events, waits for completion, and returns a `RunResult`.
 */

import { execSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type RunOptions,
  type RunResult,
  resolveDefaultModel,
  resolveEffectiveMaxTurns,
  type ToolActivity,
} from "./agent-runner.js";
import { getAgentConfig, getToolNamesForType } from "./agent-types.js";
import { detectEnv } from "./env.js";
import type { SubagentType, ThinkingLevel } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

/**
 * Callback fired once the client socket is connected and ready to receive
 * commands. Used by the agent manager to register the client for steering.
 */
type OnClientConnected = (client: net.Socket, socketPath: string) => void;

/**
 * UDS transport options — extends `RunOptions` with `transport: 'uds'`.
 *
 * The UDS runner does not use `nestedRuntime` or `structuredOutput` directly;
 * those are passed through to the child process via environment where applicable,
 * and the child handles them internally.
 */
export interface UdsRunOptions extends RunOptions {
  transport: "uds";
  /** Called when the client socket connects (for steering/abort registration). */
  onClientConnected?: OnClientConnected;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBAGENT_SOCKET_DIR = join(homedir(), ".pi", "subagents", "sockets");
const SOCKET_POLL_INTERVAL_MS = 50;
const SOCKET_POLL_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the session directory for a child process. */
function resolveSessionDir(
  agentConfig: ReturnType<typeof getAgentConfig>,
  _cwd: string,
): string | undefined {
  if (agentConfig?.sessionDir) {
    const dir = agentConfig.sessionDir;
    if (dir === "~" || dir.startsWith("~/")) return join(homedir(), dir.slice(2));
    return dirname(dir);
  }
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? undefined;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Spawn a child process via UDS, connect to its socket, and wait for completion.
 *
 * Returns a `RunResult` with the same shape as the in-process runner, except
 * `session` is always `null` because there is no in-process `AgentSession`.
 */
/** Extended result from runViaUds — includes the client socket for steering/abort. */
export interface UdsRunResult extends RunResult {
  /** The connected socket to the child process. Keep this to steer/abort. */
  client: net.Socket;
  /** The socket path on the filesystem. Used for cleanup after completion. */
  socketPath: string;
}

export async function runViaUds(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: UdsRunOptions,
): Promise<UdsRunResult> {
  // ─── 1. Resolve configuration (same as agent-runner.ts) ───────────────
  // TODO: In a future refactoring, runViaUds() should delegate the
  // socket-connection logic (polling, connection, message parsing, steer,
  // abort, completion polling) to connectToUdsSocket() once the child
  // process details are factored into the config passed to that function.

  const agentConfig = getAgentConfig(type);
  const effectiveCwd = options.cwd ?? ctx.cwd ?? process.cwd();
  const resolvedModel = options.model ?? resolveDefaultModel(
    ctx.model,
    ctx.modelRegistry,
    agentConfig?.model,
  );
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;
  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns);
  const toolNames = getToolNamesForType(type);

  // Detect env (same pattern as agent-runner.ts)
  // We only need it for the child env; the pi instance isn't available here
  // but detectEnv is needed for the child process env setup.
  // In UDS mode, the child handles its own env detection from its cwd.
  const _env = options.pi ? await detectEnv(options.pi, effectiveCwd) : undefined;

  const agentDir = getAgentDir();
  const sessionDir = resolveSessionDir(agentConfig, effectiveCwd);

  // ─── 1.5 Ensure UDS server is compiled (auto-build if needed) ───────────

  // The child process imports `../dist/uds-server.js`. In production (after `npm
  // run build`) this file exists. In development (running via `-e ./src/index.ts`
  // or from a pre-bundled extension) it may not — so we compile on demand.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..");
  const UDS_SERVER_PATH = join(projectRoot, "dist", "uds-server.js");
  const UDS_CHILD_PATH  = join(projectRoot, "src", "uds-child.mjs");

  function ensureUDSServerCompiled(): void {
    try { accessSync(UDS_SERVER_PATH); return; } catch { /* missing — compile below */ }

    // Resolve the tsc command — try local node_modules first, fall back to npx.
    // This handles hoisted dependencies (e.g. in workspaces) where tsc is only
    // available via npx rather than a local symlink at node_modules/.bin/tsc.
    const localTscPath = join(projectRoot, "node_modules", ".bin", "tsc");
    const tscCmd = existsSync(localTscPath) ? `"${localTscPath}"` : "npx tsc";

    // Compile only the UDS server using dedicated config (fast ~400 lines vs full project ~35 files)
    const TSCONFIG_UDS = join(projectRoot, "tsconfig.uds.json");
    try {
      execSync(`${tscCmd} --project "${TSCONFIG_UDS}" --outDir dist --skipLibCheck`, {
        cwd: projectRoot,
        stdio: "inherit",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `UDS server compilation failed: ${msg}\n` +
        `Check TypeScript errors by running: cd "${projectRoot}" && ${tscCmd} --project tsconfig.uds.json`,
      );
    }

    // Create dist/package.json so Node.js knows dist/uds-server.js is ESM
    writeFileSync(join(projectRoot, "dist", "package.json"), '{"type":"module"}');
  }

  ensureUDSServerCompiled();

  // ─── 2. Generate unique socket path ──────────────────────────────────

  const socketPath = join(SUBAGENT_SOCKET_DIR, `sock-${randomUUID()}`);
  mkdirSync(SUBAGENT_SOCKET_DIR, { recursive: true });

  // ─── 3. Build environment for child process ──────────────────────────

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PI_SUBAGENTS_UDS_SOCKET: socketPath,
    PI_SUBAGENTS_SESSION_FILE: options.resumeSessionFile ?? "",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir ?? "",
    PI_SUBAGENTS_AGENT_TYPE: type,
    PI_SUBAGENTS_PROMPT: prompt,
    PI_SUBAGENTS_MODEL: resolvedModel ? (resolvedModel as any).provider ? `${(resolvedModel as any).provider}/${(resolvedModel as any).id}` : "" : "",
    PI_SUBAGENTS_THINKING: thinkingLevel ?? "",
    PI_SUBAGENTS_MAX_TURNS: maxTurns != null ? String(maxTurns) : "",
    PI_SUBAGENTS_CWD: effectiveCwd,
    PI_SUBAGENTS_ISOLATED: options.isolated ? "true" : "",
    PI_SUBAGENTS_TOOLS: toolNames.join(","),
    PI_SUBAGENTS_TOOL_NAMES: toolNames.join(","),
  };

  // ─── 4. Spawn child process ──────────────────────────────────────────

  const child = fork(UDS_CHILD_PATH, {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: childEnv,
    cwd: effectiveCwd,
    detached: false,
  });

  // ─── 4.5 IPC error handler — captures child crash reasons ────────────
  // The child sends process.send({ type: 'child_error', message }) before exiting.
  // This prevents silent child crashes where the parent only sees 'exit' with no cause.
  child.on("message", (msg: any) => {
    if (msg?.type === "child_error") {
      error = msg.message ?? "child error (no message)";
      // Store in the result; no dedicated callback in RunOptions, but the
      // parent can inspect `result.failure` to see why the child failed.
    }
  });

  // ─── 5. Wait briefly for child to bind the socket ────────────────────

  const childExited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code: number | null, signal: string | null) => resolve({ code, signal }));
    child.once("error", (_err: unknown) => resolve({ code: null, signal: null }));
  });

  let _socketReady = false;
  const pollPromise = new Promise<void>((resolve, reject) => {
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += SOCKET_POLL_INTERVAL_MS;
      try {
        // Check if socket file exists
        accessSync(socketPath);
        _socketReady = true;
        clearInterval(timer);
        resolve();
      } catch {
        if (elapsed >= SOCKET_POLL_TIMEOUT_MS) {
          clearInterval(timer);
          reject(new Error(`Child did not create socket at ${socketPath} within ${SOCKET_POLL_TIMEOUT_MS}ms`));
        }
      }
    }, SOCKET_POLL_INTERVAL_MS);
    timer.unref();
  });

  try {
    await Promise.race([pollPromise, childExited]);
  } catch (err) {
    child.kill("SIGTERM");
    const { code, signal } = await childExited;
    throw new Error(
      `Child process failed while creating socket: ${err instanceof Error ? err.message : String(err)} ` +
      `(exit code: ${code}, signal: ${signal})`,
    );
  }

  // ─── 6. Connect to child's socket ────────────────────────────────────

  const client = net.createConnection({ path: socketPath });

  const connectPromise = new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", (err) => reject(err));

    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`Failed to connect to child socket at ${socketPath} within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    timer.unref();
  });

  try {
    await connectPromise;
  } catch (err) {
    child.kill("SIGTERM");
    const { code, signal } = await childExited;
    throw new Error(
      `Failed to connect to UDS child: ${err instanceof Error ? err.message : String(err)} ` +
      `(child exit code: ${code}, signal: ${signal})`,
    );
  }

  // Notify caller (agent manager) that the client socket is connected,
  // so steering/abort can target it immediately while the child is running.
  options.onClientConnected?.(client, socketPath);

  // ─── 7. Set up message parsing ───────────────────────────────────────

  let buffer = "";
  let readyReceived = false;

  // State tracking for the result
  let responseText = "";
  let _turnCount = 0;
  let _toolUses = 0;
  let completed = false;
  let aborted = false;
  let error: string | undefined;

  client.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line) as ChildMessage;
          // Wait for ready before sending commands
          if (msg.type === "ready" && !readyReceived) {
            readyReceived = true;
          }
          handleChildEvent(msg);
        } catch (_parseErr) {
          // Silently skip malformed messages
        }
      }
    }
  });

  /** Send a command to the child. */
  function sendCommand(command: Record<string, unknown>): void {
    if (!client.destroyed && !client.writableEnded) {
      client.write(JSON.stringify(command) + "\n");
    }
  }

  /** Handle events from child, mapping to RunOptions callbacks. */
  function handleChildEvent(msg: ChildMessage): void {
    switch (msg.type) {
      case "turn_start": {
        _turnCount++;
        break;
      }

      case "turn_end": {
        // turn_end may carry a final turnCount
        if (msg.turnCount != null) _turnCount = msg.turnCount;
        break;
      }

      case "text_delta": {
        responseText += msg.delta;
        options.onTextDelta?.(msg.delta as string, responseText);
        break;
      }

      case "tool_execution_start": {
        _toolUses++;
        options.onToolActivity?.({ type: "start", toolName: msg.toolName as string });
        break;
      }

      case "tool_execution_end": {
        options.onToolActivity?.({ type: "end", toolName: msg.toolName as string });
        break;
      }

      case "message_end": {
        const usage = msg.usage as LifetimeUsage | undefined;
        if (usage) {
          options.onAssistantUsage?.({
            input: usage.input,
            output: usage.output,
            cacheWrite: usage.cacheWrite ?? 0,
            cost: usage.cost,
          });
        }
        break;
      }

      case "compaction": {
        options.onCompaction?.({
          reason: (msg.reason as "manual" | "threshold" | "overflow") ?? "threshold",
          tokensBefore: msg.tokensBefore ?? 0,
        });
        break;
      }

      case "completed": {
        completed = true;
        if (msg.result != null && msg.result !== "") {
          responseText = msg.result as string;
        }
        break;
      }

      case "aborted": {
        aborted = true;
        completed = true;
        break;
      }

      case "error": {
        error = msg.message;
        completed = true;
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  // ─── Send initial steer command (wait for ready handshake first) ───────────
  // The child emits { type: "ready" } when fully initialized.
  // Sending steer before ready was a common cause of missed commands.
  if (readyReceived) {
    // Ready was already received — send immediately
    sendCommand({ type: "steer", message: prompt });
  } else {
    // Wait up to 2s for ready before sending (shouldn't happen, but be safe)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Steer sent without ready handshake — should not happen with the new protocol,
        // but fall back gracefully rather than hanging indefinitely.
        console.error(`[uds-runner] Warning: steer sent without ready handshake (took >2s)`);
        sendCommand({ type: "steer", message: prompt });
        resolve();
      }, 2000);
      timer.unref();

      // Override the data handler to send when ready arrives
      const originalHandler = client.listeners("data");
      const waitForReady = (data: Buffer) => {
        const text = data.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            try {
              const msg = JSON.parse(line) as ChildMessage;
              if (msg.type === "ready") {
                clearTimeout(timer);
                client.removeListener("data", waitForReady);
                // Re-register original handler
                for (const h of originalHandler) {
                  client.on("data", h);
                }
                sendCommand({ type: "steer", message: prompt });
                resolve();
                return;
              }
            } catch { /* skip */ }
          }
        }
      };
      client.on("data", waitForReady);
    });
  }

  // ─── 8. Wait for completion (race between child completion and abort) ─

  const childCompletionPromise = new Promise<UdsRunResult>((resolve) => {
    // Listen for child process exit (in case it exits without sending a message)
    const onExit = async () => {
      if (!completed) {
        completed = true;
        await cleanupSocket(socketPath);
      }
      resolve(buildResult());
    };
    child.once("exit", onExit);
    // If child already exited (race condition), trigger immediately
    if (completed) { onExit(); }
  });

  // Race: child completion vs. parent abort signal
  const abortPromise = new Promise<UdsRunResult>((resolve) => {
    if (!options.signal) {
      // No abort signal — resolve through childCompletionPromise
      return;
    }
    if (options.signal.aborted) {
      // Already aborted — abort the child immediately
      sendCommand({ type: "abort" });
      resolve(buildResult());
      return;
    }
    options.signal.addEventListener("abort", () => {
      aborted = true;
      sendCommand({ type: "abort" });
    }, { once: true });
  });

  // Determine which resolved first
  const firstCompletion = await Promise.race([childCompletionPromise, abortPromise]);

  // ─── 9. Cleanup ──────────────────────────────────────────────────────

  try { client.destroy(); } catch { /* ignore */ }
  await cleanupSocket(socketPath);

  // If childCompletionPromise didn't already resolve, ensure it does
  if (!completed) {
    await cleanupSocket(socketPath);
    await childExited; // destructuring { code, signal } unused here
    return buildResult();
  }

  return firstCompletion;

  // ─── Helper: build final RunResult ───────────────────────────────────

  function buildResult(): UdsRunResult {
    return {
      responseText: responseText.trim(),
      session: null as unknown as AgentSession,
      aborted,
      steered: false,
      failure: error,
      client,
      socketPath,
    };
  }
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

/**
 * Remove a UDS socket file. No-op if it doesn't exist.
 */
async function cleanupSocket(socketPath: string): Promise<void> {
  try {
    unlinkSync(socketPath);
  } catch { /* socket may have already been cleaned up by child */ }
}

// ---------------------------------------------------------------------------
// connectToUdsSocket — Connect to a pre-existing UDS socket and stream events
// ---------------------------------------------------------------------------

/**
 * Connect to an existing UDS socket, send a steer command, and wait for completion.
 *
 * This function encapsulates the shared socket-connection logic used by both
 * `runViaUds()` (which spawns a child) and `streamFromUdsSocket()` (which
 * connects to an existing socket). It handles: socket polling, connection,
 * message parsing, steer with ready-handshake, abort signal, and completion
 * polling.
 *
 * @param socketPath - Filesystem path to the UDS socket.
 * @param prompt - The steer message to send once connected.
 * @param config - Agent configuration (used for future refactoring).
 * @param options - Streaming callbacks and abort signal.
 * @returns A `UdsRunResult` with the same shape as `runViaUds()`.
 */
export async function connectToUdsSocket(
  socketPath: string,
  prompt: string,
  _config: { agentType: SubagentType; model: any; thinkingLevel: ThinkingLevel | undefined; maxTurns: number | undefined; toolNames: string[] },
  options: {
    onTextDelta?: (delta: string, fullText: string) => void;
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number; cost?: number }) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
  },
): Promise<UdsRunResult> {
  // ── 1. Poll for socket existence ────────────────────────────────────
  let _socketReady = false;
  await new Promise<void>((resolve, reject) => {
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += SOCKET_POLL_INTERVAL_MS;
      try {
        accessSync(socketPath);
        _socketReady = true;
        clearInterval(timer);
        resolve();
      } catch {
        if (elapsed >= SOCKET_POLL_TIMEOUT_MS) {
          clearInterval(timer);
          reject(new Error(`Socket ${socketPath} not ready within ${SOCKET_POLL_TIMEOUT_MS}ms`));
        }
      }
    }, SOCKET_POLL_INTERVAL_MS);
    timer.unref();
  });

  // ── 2. Connect to the socket ────────────────────────────────────────
  const client = net.createConnection({ path: socketPath });

  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", (err) => reject(err));
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`Failed to connect to UDS socket at ${socketPath} within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    timer.unref();
  });

  // ── 3. State variables ──────────────────────────────────────────────
  let buffer = "";
  let readyReceived = false;
  let responseText = "";
  let _turnCount = 0;
  let _toolUses = 0;
  let completed = false;
  let aborted = false;
  let error: string | undefined;

  // ── 4. Data handler ─────────────────────────────────────────────────
  client.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line) as ChildMessage;
          if (msg.type === "ready" && !readyReceived) {
            readyReceived = true;
          }
          handleChildEvent(msg);
        } catch { /* skip malformed */ }
      }
    }
  });

  // ── 5. sendCommand helper ───────────────────────────────────────────
  function sendCommand(command: Record<string, unknown>): void {
    if (!client.destroyed && !client.writableEnded) {
      client.write(JSON.stringify(command) + "\n");
    }
  }

  // ── 6. handleChildEvent ─────────────────────────────────────────────
  function handleChildEvent(msg: ChildMessage): void {
    switch (msg.type) {
      case "turn_start": {
        _turnCount++;
        break;
      }

      case "turn_end": {
        if (msg.turnCount != null) _turnCount = msg.turnCount;
        break;
      }

      case "text_delta": {
        responseText += msg.delta as string;
        options.onTextDelta?.(msg.delta as string, responseText);
        break;
      }

      case "tool_execution_start": {
        _toolUses++;
        options.onToolActivity?.({ type: "start", toolName: msg.toolName as string });
        break;
      }

      case "tool_execution_end": {
        options.onToolActivity?.({ type: "end", toolName: msg.toolName as string });
        break;
      }

      case "message_end": {
        const usage = msg.usage;
        if (usage) {
          options.onAssistantUsage?.({
            input: usage.input,
            output: usage.output,
            cacheWrite: usage.cacheWrite ?? 0,
            cost: usage.cost,
          });
        }
        break;
      }

      case "compaction": {
        options.onCompaction?.({
          reason: (msg.reason as "manual" | "threshold" | "overflow") ?? "threshold",
          tokensBefore: msg.tokensBefore ?? 0,
        });
        break;
      }

      case "completed": {
        completed = true;
        if (msg.result != null && msg.result !== "") {
          responseText = msg.result as string;
        }
        break;
      }

      case "aborted": {
        aborted = true;
        completed = true;
        break;
      }

      case "error": {
        error = msg.message;
        completed = true;
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  // ── 7. Steer command with ready handshake (simpler version) ─────────
  // Does NOT re-register the original data handler after ready arrives.
  if (readyReceived) {
    sendCommand({ type: "steer", message: prompt });
  } else {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.error(`[uds-runner] Warning: steer sent without ready handshake (took >2s)`);
        sendCommand({ type: "steer", message: prompt });
        resolve();
      }, 2000);
      timer.unref();

      const waitForReady = (data: Buffer) => {
        const text = data.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            try {
              const msg = JSON.parse(line) as ChildMessage;
              if (msg.type === "ready") {
                clearTimeout(timer);
                client.removeListener("data", waitForReady);
                sendCommand({ type: "steer", message: prompt });
                resolve();
                return;
              }
            } catch { /* skip */ }
          }
        }
      };
      client.on("data", waitForReady);
    });
  }

  // ── 8. Abort signal handling ────────────────────────────────────────
  const abortPromise = new Promise<void>((resolve) => {
    if (!options.signal) {
      // No signal — don't resolve here; completionPromise handles normal completion.
      // The race will pick completionPromise since abortPromise stays pending.
      return;
    }
    if (options.signal.aborted) {
      sendCommand({ type: "abort" });
      resolve();
      return;
    }
    options.signal.addEventListener("abort", () => {
      aborted = true;
      sendCommand({ type: "abort" });
      resolve();
    }, { once: true });
  });

  // ── 9. Completion polling (100ms interval on `completed` flag) ──────
  const completionPromise = new Promise<void>((resolve) => {
    const checkCompletion = setInterval(() => {
      if (completed) {
        clearInterval(checkCompletion);
        resolve();
      }
    }, 100);
    checkCompletion.unref();
  });

  await Promise.race([completionPromise, abortPromise]);

  // ── 10. Cleanup & return ────────────────────────────────────────────
  try { client.destroy(); } catch { /* ignore */ }
  await cleanupSocket(socketPath);

  return {
    responseText: responseText.trim(),
    session: null as unknown as AgentSession,
    aborted,
    steered: false,
    failure: error,
    client,
    socketPath,
  };
}

// ---------------------------------------------------------------------------
// Child message types
// ---------------------------------------------------------------------------

interface ChildMessage {
  type:
    | "ready"
    | "turn_start"
    | "turn_end"
    | "text_delta"
    | "tool_execution_start"
    | "tool_execution_end"
    | "message_start"
    | "message_end"
    | "compaction"
    | "completed"
    | "aborted"
    | "error";
  turnCount?: number;
  delta?: string;
  toolName?: string;
  usage?: { input: number; output: number; cacheWrite?: number; cacheRead?: number; cost?: number };
  reason?: "manual" | "threshold" | "overflow";
  tokensBefore?: number;
  result?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Exported helper functions
// ---------------------------------------------------------------------------

/**
 * Send a steer command to a running UDS child.
 *
 * @param client - The connected socket to the child process.
 * @param message - The steering message to send.
 */
export function steerUdsAgent(client: net.Socket, message: string): void {
  if (!client.destroyed && client.writable) {
    client.write(JSON.stringify({ type: "steer", message }) + "\n");
  }
}

/**
 * Send an abort command to a running UDS child.
 *
 * @param client - The connected socket to the child process.
 */
export function abortUdsAgent(client: net.Socket): void {
  if (!client.destroyed && client.writable) {
    client.write(JSON.stringify({ type: "abort" }) + "\n");
  }
}

/**
 * Send a tool set command to a running UDS child.
 *
 * @param client - The connected socket to the child process.
 * @param tools - The tool names to activate.
 */
export function setToolsUdsAgent(client: net.Socket, tools: string[]): void {
  if (!client.destroyed && client.writable) {
    client.write(JSON.stringify({ type: "setTools", tools }) + "\n");
  }
}

/**
 * Cleanup a UDS agent connection and socket.
 *
 * @param client - The connected socket to the child process (will be destroyed).
 * @param socketPath - The path to the UDS socket file to remove.
 */
export async function cleanupUdsAgent(client: net.Socket, socketPath: string): Promise<void> {
  try { client.destroy(); } catch { /* ignore destroy on already-closed socket */ }
  await cleanupSocket(socketPath);
}
