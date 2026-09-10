#!/usr/bin/env node
/**
 * uds-child.mjs — Child process for UDS transport mode.
 *
 * This script runs as a forked child process spawned by `uds-agent-runner.ts`.
 * It reads configuration from environment variables, creates a pi-coding-agent
 * `AgentSession`, and exposes it via a Unix Domain Socket (UDS) so the parent
 * can observe events and send commands (steer, abort, setTools, etc.).
 *
 * Environment variables from parent:
 *   PI_SUBAGENTS_UDS_SOCKET        - Socket path for the child to bind
 *   PI_SUBAGENTS_SESSION_FILE      - Optional session file to resume
 *   PI_CODING_AGENT_DIR            - Agent directory (agentDir for pi)
 *   PI_CODING_AGENT_SESSION_DIR    - Session directory (may be empty)
 *   PI_SUBAGENTS_AGENT_TYPE        - Agent type name (e.g. "code")
 *   PI_SUBAGENTS_PROMPT            - The user prompt / initial message
 *   PI_SUBAGENTS_MODEL             - Model as "provider/id" (e.g. "anthropic/claude-sonnet-4-20250514")
 *   PI_SUBAGENTS_THINKING          - Thinking level ("off", "low", "medium", "high")
 *   PI_SUBAGENTS_MAX_TURNS         - Maximum turns for this session
 *   PI_SUBAGENTS_CWD               - Working directory
 *   PI_SUBAGENTS_TOOLS             - Comma-separated tool names to enable
 *   PI_SUBAGENTS_TOOL_NAMES        - Alias for PI_SUBAGENTS_TOOLS (duplicate)
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { UdsServer } from "../dist/uds-server.js";

// ---------------------------------------------------------------------------
// Environment variable helpers
// ---------------------------------------------------------------------------

/** Get an environment variable, trimming whitespace and returning "" if empty. */
function getEnv(name) {
  return (process.env[name] ?? "").trim();
}

/** Parse a model string of the form "provider/id" into a { provider, id } object. */
function parseModel(modelStr) {
  const trimmed = modelStr.trim();
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) {
    return { provider: trimmed, id: trimmed };
  }
  return {
    provider: trimmed.slice(0, slashIndex).trim(),
    id: trimmed.slice(slashIndex + 1).trim(),
  };
}

// ---------------------------------------------------------------------------
// Resolve configuration from environment
// ---------------------------------------------------------------------------

const socketPath = getEnv("PI_SUBAGENTS_UDS_SOCKET");
const sessionFile = getEnv("PI_SUBAGENTS_SESSION_FILE");
const agentDir = getEnv("PI_CODING_AGENT_DIR");
const sessionDir = getEnv("PI_CODING_AGENT_SESSION_DIR");
const agentType = getEnv("PI_SUBAGENTS_AGENT_TYPE");
const prompt = getEnv("PI_SUBAGENTS_PROMPT");
const modelStr = getEnv("PI_SUBAGENTS_MODEL");
const thinkingLevel = getEnv("PI_SUBAGENTS_THINKING") || undefined;
const maxTurnsStr = getEnv("PI_SUBAGENTS_MAX_TURNS");
// Read PI_SUBAGENTS_CWD with a robust fallback chain:
//   1. The env var if set and non-empty
//   2. process.cwd() (may be undefined in edge cases, e.g. deleted cwd)
//   3. "__no_cwd__" as absolute last resort so DefaultResourceLoader always gets a string
const rawCwd = getEnv("PI_SUBAGENTS_CWD") || process.cwd?.() || "__no_cwd__";
const cwd = rawCwd || undefined;
const toolsStr = getEnv("PI_SUBAGENTS_TOOLS") || getEnv("PI_SUBAGENTS_TOOL_NAMES");

// ---------------------------------------------------------------------------
// Logging helper with LOG_LEVEL control
// ---------------------------------------------------------------------------

/**
 * Log level from env (default: "error" in production, "debug" when PI_SUBAGENTS_LOG_LEVEL is set).
 * Levels: ERROR < WARN < INFO < DEBUG
 * Usage: PI_SUBAGENTS_LOG_LEVEL=debug node uds-child.mjs
 */
const CHILD_LOG_LEVEL = (process.env.PI_SUBAGENTS_LOG_LEVEL || "ERROR").toUpperCase();
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CHILD_LOG_PRIORITY = LOG_LEVELS[CHILD_LOG_LEVEL] !== undefined ? LOG_LEVELS[CHILD_LOG_LEVEL] : LOG_LEVELS.ERROR;

/**
 * Log a message if its priority is above the configured threshold.
 * @param {string} level - "error", "warn", "info", or "debug"
 * @param  {...any} args - Arguments to log
 */
function log(level, ...args) {
  const priority = LOG_LEVELS[level?.toUpperCase?.()] ?? 0;
  if (priority <= CHILD_LOG_PRIORITY) {
    console.error(`[uds-child] ${level?.toUpperCase?.() ?? "ERROR"}:`, ...args);
  }
}

/**
 * Convenience: always log regardless of level (for critical startup messages).
 */
function logAlways(...args) {
  console.error("[uds-child]", ...args);
}

// ---------------------------------------------------------------------------
// Construct session options
// ---------------------------------------------------------------------------

/** Determine whether extensions are desired (based on agent config from parent). */
function resolveExtensionsEnabled() {
  // The parent controls this via agent type configuration.
  // For the child, we enable extensions unless the prompt explicitly disables them.
  return true;
}

// Resolve model
const modelParsed = parseModel(modelStr);
const model = modelParsed ? {
  provider: modelParsed.provider,
  id: modelParsed.id,
} : undefined;

// Resolve max turns
const maxTurns = maxTurnsStr ? parseInt(maxTurnsStr, 10) : undefined;

// Parse tool names
const toolNames = toolsStr ? toolsStr.split(",").map((t) => t.trim()).filter(Boolean) : [];

// ---------------------------------------------------------------------------
// Create session manager
// ---------------------------------------------------------------------------

let sessionManager;

if (sessionFile) {
  // Resume an existing session file
  logAlways(`Resuming session from: ${sessionFile}`);
  try {
    sessionManager = SessionManager.open(sessionFile, sessionDir || undefined);
  } catch (err) {
    log("error", `Failed to open session file: ${err.message}`);
    process.exit(1);
  }
} else {
  // Create a new session — persist by default if a session dir is configured
  const persistSession = Boolean(sessionDir);
  if (persistSession) {
    try {
      sessionManager = SessionManager.create(rawCwd, sessionDir, {
        parentSession: undefined, // Top-level subagent has no parent session
      });
      log("info", "Created new persistent session");
    } catch (err) {
      log("error", `Failed to create session: ${err.message}`);
      process.exit(1);
    }
  } else {
    // In-memory session (non-persistent)
    sessionManager = SessionManager.inMemory(rawCwd);
    log("debug", "Created in-memory session");
  }
}

// ---------------------------------------------------------------------------
// Create settings manager
// ---------------------------------------------------------------------------

const settingsManager = SettingsManager.create(
  rawCwd,
  agentDir || getAgentDir(),
);

// ---------------------------------------------------------------------------
// Create resource loader
// ---------------------------------------------------------------------------

const resourceLoader = new DefaultResourceLoader({
  cwd: rawCwd,
  agentDir: agentDir || getAgentDir(),
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});

await resourceLoader.reload();

// ---------------------------------------------------------------------------
// Build session options
// ---------------------------------------------------------------------------

const isChild = true;

const sessionOpts = {
  cwd: rawCwd,
  agentDir: agentDir || getAgentDir(),
  sessionManager,
  settingsManager,
  isChild,
};

// Add model if specified
if (model) {
  sessionOpts.model = model;
}

// Add thinking level if specified
if (thinkingLevel) {
  sessionOpts.thinkingLevel = thinkingLevel;
}

// Add max turns if specified
if (maxTurns !== undefined) {
  sessionOpts.maxTurns = maxTurns;
}

// Add tool names if specified
if (toolNames.length > 0) {
  sessionOpts.tools = toolNames;
}

// Add resource loader
sessionOpts.resourceLoader = resourceLoader;

// ---------------------------------------------------------------------------
// Create the AgentSession
// ---------------------------------------------------------------------------

let session;

try {
  const created = await createAgentSession(sessionOpts);
  session = created.session;

  if (!session) {
    log("error", "createAgentSession returned without a session");
    process.exit(1);
  }

  // Set a session name for identification
  const baseName = agentType || "subagent";
  session.setSessionName(baseName);
  log("info", `AgentSession created: type=${baseName}, model=${model?.provider ?? "default"}`);

} catch (err) {
  log("error", `Failed to create AgentSession: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Start the UDS server
// ---------------------------------------------------------------------------

let server;

try {
  server = new UdsServer(socketPath);
  await server.start(session);
  log("info", `UDS server listening on ${socketPath}`);
} catch (err) {
  log("error", `Failed to start UDS server: ${err.message}`);
  await cleanup();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Session event subscription (delegated to uds-server.ts)
// ---------------------------------------------------------------------------
// The UDS server (uds-server.ts) subscribes to session events internally
// and forwards them to connected clients. The child process does NOT
// subscribe directly to avoid duplicate event processing.
//
// Log event types for debugging purposes.
//
// Note: sendEvent and unsubscribe are no-ops here since the server handles
// event forwarding independently.
// ---------------------------------------------------------------------------

/** No-op: The UDS server handles event forwarding to clients. */
function sendEvent(_event) {
  // No-op - server handles event forwarding
}

/** No-op unsubscribe function. */
const unsubscribe = () => {
  // No-op — uds-server.ts manages its own subscription lifecycle
};

// Subscriptions handled by the UDS server

// ---------------------------------------------------------------------------
// Handle unhandled exceptions
// ---------------------------------------------------------------------------

process.on("uncaughtException", async (err) => {
  const message = `uncaught exception: ${err.message}${err.stack ? "\n" + err.stack : ""}`;
  log("error", message);
  notifyParentOfError(message);  // Tell parent WHY we crashed
  sendEvent({ type: "error", message });
  await cleanup();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const message = `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`;
  log("error", message);
  notifyParentOfError(message);  // Tell parent WHY we crashed
  sendEvent({ type: "error", message });
  await cleanup();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Cleanup and shutdown
// ---------------------------------------------------------------------------

let shutdownInFlight = false;

/**
 * Send an error message to the parent via IPC before exiting.
 * This ensures the parent knows WHY the child crashed, not just that it did.
 */
function notifyParentOfError(message) {
  try {
    process.send({
      type: "child_error",
      message,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // IPC not available — child will still log to stderr
  }
}

async function cleanup() {
  if (shutdownInFlight) return;
  shutdownInFlight = true;

  try {
    // Unsubscribe from session events
    if (typeof unsubscribe === "function") {
      unsubscribe();
    }
  } catch {
    /* ignore unsubscribe errors */
  }

  try {
    // Shut down the UDS server (closes socket, removes file)
    if (server && typeof server.shutdown === "function") {
      server.shutdown();
    }
  } catch {
    /* ignore shutdown errors */
  }
}

process.on("SIGTERM", async () => {
  log("debug", "Received SIGTERM");
  await cleanup();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("debug", "Received SIGINT");
  await cleanup();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Log startup completion for the parent (when PI_SUBAGENTS_LOG_LEVEL=debug)
// ---------------------------------------------------------------------------
logAlways("uds-child process started (log level: " + CHILD_LOG_LEVEL + ")");


