#!/usr/bin/env node
/**
 * uds-test-standalone.mjs — Diagnostic CLI for UDS child process.
 *
 * A standalone tool that:
 *   1. Forks the actual uds-child.mjs with minimal env vars
 *   2. Connects to its socket
 *   3. Sends a "say hi" steer command
 *   4. Prints the response
 *
 * This is what you used to do manually with tmux, but automated and fast.
 *
 * Usage:
 *   node scripts/uds-test-standalone.mjs              # Quick smoke test
 *   node scripts/uds-test-standalone.mjs --verbose    # Verbose output
 *   node scripts/uds-test-standalone.mjs --help       # Help text
 *
 * Exit code: 0 = success, 1 = failure
 */

import { fork } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = import.meta.dirname;
const projectRoot = join(__dirname, "..");
const UDS_CHILD_PATH = join(projectRoot, "src", "uds-child.mjs");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const help = args.includes("--help") || args.includes("-h");

if (help) {
  console.log(`Usage: node scripts/uds-test-standalone.mjs [options]

Diagnostic tool for UDS child process.

Options:
  --verbose, -v    Enable verbose output
  --help, -h       Show this help text

Example:
  node scripts/uds-test-standalone.mjs --verbose

Exit code: 0 = success, 1 = failure
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[uds-diag]", ...args);
}

function logErr(...args) {
  console.error("[uds-diag]", ...args);
}

function logInfo(...args) {
  if (verbose) console.log("[uds-diag]", ...args);
}

function timestamp() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== UDS Standalone Diagnostic ===");
  log(`Child script: ${UDS_CHILD_PATH}`);
  log(`Time: ${timestamp()}`);
  log();

  // 0. Verify child script exists
  if (!fs.existsSync(UDS_CHILD_PATH)) {
    logErr(`✗ Child script not found: ${UDS_CHILD_PATH}`);
    logErr("  This is the classic 'ENOENT: no such file or directory' crash.");
    logErr("  Run 'npm run build' or check that uds-child.mjs exists.");
    return 1;
  }
  logInfo("✓ Child script exists");

  // 1. Generate socket path
  const socketPath = join(os.tmpdir(), `uds-diag-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  logInfo(`Socket path: ${socketPath}`);

  // 2. Build minimal env for child
  const childEnv = {
    ...process.env,
    PI_SUBAGENTS_UDS_SOCKET: socketPath,
    PI_SUBAGENTS_SESSION_FILE: "",
    PI_CODING_AGENT_DIR: "",
    PI_CODING_AGENT_SESSION_DIR: "",
    PI_SUBAGENTS_AGENT_TYPE: "diag-test",
    PI_SUBAGENTS_PROMPT: "Just acknowledge this test",
    PI_SUBAGENTS_MODEL: "",
    PI_SUBAGENTS_THINKING: "",
    PI_SUBAGENTS_MAX_TURNS: "1",
    PI_SUBAGENTS_CWD: process.cwd(),
    PI_SUBAGENTS_TOOLS: "",
    PI_SUBAGENTS_TOOL_NAMES: "",
    PI_SUBAGENTS_LOG_LEVEL: verbose ? "debug" : "error",
  };

  // 3. Fork child
  logInfo("Forking child process...");
  const child = fork(UDS_CHILD_PATH, {
    stdio: ["inherit", "inherit", "pipe", "ipc"],
    env: childEnv,
    cwd: process.cwd(),
    detached: false,
  });

  let childError = null;
  if (child.stderr) {
    child.stderr.on("data", (data) => {
      if (verbose) {
        console.log(`  [child stderr] ${data.toString().trim()}`);
      }
    });
  }

  child.on("message", (msg) => {
    if (msg?.type === "child_error") {
      childError = msg.message;
      logErr(`  Child reported error: ${childError}`);
    }
  });

  const childExited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (err) => resolve({ code: null, signal: null, error: err.message }));
  });

  // 4. Wait for socket
  logInfo("Waiting for child to create socket...");
  const startTime = Date.now();
  let socketCreated = false;
  while (Date.now() - startTime < 5000) {
    if (fs.existsSync(socketPath)) {
      socketCreated = true;
      logInfo(`✓ Socket created (${Date.now() - startTime}ms)`);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!socketCreated) {
    const exitInfo = await childExited;
    logErr(`✗ Child did not create socket within 5s`);
    logErr(`  Exit: code=${exitInfo.code}, signal=${exitInfo.signal}${exitInfo.error ? `, error=${exitInfo.error}` : ""}`);
    if (childError) {
      logErr(`  Child reported: ${childError}`);
    }
    return 1;
  }

  // 5. Connect to child
  logInfo("Connecting to child socket...");
  const client = net.createConnection({ path: socketPath });

  const connectResult = await new Promise((resolve) => {
    client.once("connect", () => resolve({ success: true }));
    client.once("error", (err) => resolve({ success: false, error: err.message }));
    setTimeout(() => resolve({ success: false, error: "connect timeout" }), 3000);
  });

  if (!connectResult.success) {
    logErr(`✗ Failed to connect: ${connectResult.error}`);
    return 1;
  }
  logInfo("✓ Connected");

  // 6. Collect messages (expect ready + session_created)
  logInfo("Waiting for ready handshake...");
  let readyReceived = false;
  let sessionCreated = false;
  let messages = [];
  let buffer = "";

  const waitForMessages = new Promise((resolve) => {
    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            messages.push(msg);
            if (verbose) {
              logInfo(`  Received: ${JSON.stringify(msg).slice(0, 200)}`);
            }
            if (msg.type === "ready") readyReceived = true;
            if (msg.type === "session_created") sessionCreated = true;
            // Once we have ready + session_created, we can send commands
            if (readyReceived && sessionCreated) {
              resolve();
            }
          } catch { /* skip */ }
        }
      }
    });
    // Timeout: if ready didn't arrive in 3s, resolve anyway
    setTimeout(resolve, 3000);
  });

  await waitForMessages;

  if (!readyReceived) {
    logErr("✗ Did not receive 'ready' event from child");
    return 1;
  }
  logInfo("✓ Ready handshake received");

  if (!sessionCreated) {
    logWarn("⚠ Did not receive 'session_created' (child may have crashed)");
  }

  // 7. Send steer command
  logInfo("Sending steer command...");
  const steerAck = await new Promise((resolve) => {
    let ackReceived = false;
    client.on("data", (data) => {
      if (ackReceived) return;
      const text = data.toString();
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.trim() && !ackReceived) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === "command_ack" && msg.command === "steer") {
              ackReceived = true;
              resolve(msg);
              return;
            }
          } catch { /* skip */ }
        }
      }
    });
    client.write(JSON.stringify({ type: "steer", message: "say hi" }) + "\n");
    setTimeout(() => resolve(null), 2000);
  });

  if (!steerAck) {
    logErr("✗ No command_ack received for steer");
    // Check if child already exited
    const exitInfo = await childExited;
    if (exitInfo.code !== null && exitInfo.code !== 0) {
      logErr(`  Child exited with code ${exitInfo.code}${exitInfo.signal ? ` (signal: ${exitInfo.signal})` : ""}`);
    }
    if (childError) {
      logErr(`  Child reported error: ${childError}`);
    }
    return 1;
  }
  logInfo("✓ Steer command acknowledged");

  // 8. Summary
  log();
  log("=== Test Summary ===");
  log(`✓ Child script exists`);
  log(`✓ Socket created at ${socketPath}`);
  log(`✓ Connected to child`);
  log(`✓ Ready handshake: ${readyReceived ? "received" : "MISSING"}`);
  log(`✓ Session created: ${sessionCreated ? "yes" : "no"}`);
  log(`✓ Steer command: ${steerAck ? "acknowledged" : "FAILED"}`);
  log(`  Received ${messages.length} event(s) before steer`);
  log();

  // Cleanup
  try { client.destroy(); } catch { /* ignore */ }
  try { fs.unlinkSync(socketPath); } catch { /* ignore */ }

  // Wait for child to exit
  const exitInfo = await childExited;
  logInfo(`Child exited: code=${exitInfo.code}, signal=${exitInfo.signal}`);

  return 0;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().then((code) => {
  process.exit(code);
}).catch((err) => {
  logErr(`Unexpected error: ${err.message}`);
  process.exit(1);
});
