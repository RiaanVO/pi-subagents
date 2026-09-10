# UDS + Tmux Workspace: Remote Subagent Execution

## Overview

This architecture enables running subagents as **separate Node.js processes** that communicate with the parent via **Unix Domain Sockets (UDS)**, while optionally displaying them in **tmux windows** for direct terminal interaction.

The result: same real-time API surface as in-process subagents, with process isolation and direct terminal access to each subagent.

### What This Solves

- Direct interaction with subagents in their own tmux windows (full TUI, run commands, browse files)
- Real-time visibility: live tool calls, streaming text, cost tracking, turn counters
- Instant steering: inject messages into running subagents with zero latency
- Process isolation: crash a subagent without affecting the parent, kill independently
- Full feature parity with in-process: tool modification, compaction, structured output, worktree isolation

### What This Replaces

The existing `runAgent()` in `agent-runner.ts` creates a new `AgentSession` in-process via `createAgentSession()`. The UDS path spawns a separate child process instead, connecting back via UDS for real-time communication.

**Zero changes to `pi-coding-agent` are required.** The extension spawns child processes directly using Node.js `fork()` and loads `@earendil-works/pi-coding-agent` as a module within the child.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Tmux Session: "pi-subagents" (optional)                        │
│                                                                 │
│  ┌─ Window 0: pi-subagents ──────────────────────────────────┐  │
│  │  pi (main session — your conversation)                     │  │
│  │                                                            │  │
│  │  Agent("Explore", "find auth files")                       │  │
│  │    └── transport: "uds" + tmuxEnabled: true                │  │
│  │                                                              │  │
│  │  Agent("Audit", "review security")                         │  │
│  │    └── transport: "uds" + tmuxEnabled: true                │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ Window 1: explore-1 ────────────────────────────────────┐  │
│  │  node uds-child.mjs (with env vars)                        │  │
│  │                                                            │  │
│  │  Full TUI (stdio inherited)                                │  │
│  │  UDS socket: ~/.pi/subagents/sockets/sock-<uuid>           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ Window 2: audit-1 ──────────────────────────────────────┐  │
│  │  node uds-child.mjs (with env vars)                        │  │
│  │  (same pattern)                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

         Unix Domain Sockets (IPC)
        ~/.pi/subagents/sockets/sock-abc123
        ~/.pi/subagents/sockets/sock-def456
```

### Two Tmux Spawning Modes

The `tmux-workspace.ts` module provides **two distinct spawning methods**:

| Method | Command | Mode | Description |
|--------|---------|------|-------------|
| `spawnSubagent()` | `pi -c` or `pi -p "<prompt>"` | Interactive / Print | Spawns a full `pi` TUI in the window. Steering via `session.steer()` if session file is shared. |
| `spawnUdsSubagent()` | `node uds-child.mjs` | UDS | Spawns the UDS child process. Parent controls via UDS socket (steer, abort, setTools). Full TUI available via stdio. |

**UDS mode** (`spawnUdsSubagent`) is used when `transport: "uds"` + `tmuxEnabled: true`. The child process runs the same `uds-child.mjs` that the parent would fork for non-tmux UDS agents, but inside a tmux window for visibility.

---

## Communication Protocol

Newline-delimited JSON over UDS streams. Bidirectional.

### Child → Parent Events

Fired for every agent event, mirroring the in-process `AgentSession` event system:

```json
// Readiness
{"seq": 1, "type": "ready"}                    // Child fully initialized

// Agent lifecycle
{"seq": 2, "type": "turn_start", "turnCount": 3}
{"seq": 3, "type": "turn_end", "turnCount": 3}
{"seq": 4, "type": "compaction", "reason": "threshold", "tokensBefore": 18000}
{"seq": 5, "type": "completed", "result": "Agent finished here", "toolUses": 5}
{"seq": 6, "type": "aborted"}
{"seq": 7, "type": "error", "message": "provider error"}

// Agent output
{"seq": 8, "type": "message_start", "messageId": "msg_...", "role": "assistant"}
{"seq": 9, "type": "text_delta", "delta": "Looking", "fullText": "Looking at"}
{"seq": 10, "type": "message_end", "messageId": "msg_...", "usage": {"input": 2400, "output": 800, "cacheWrite": 1200, "cost": {"total": 0.012}}}

// Tool activity
{"seq": 11, "type": "tool_execution_start", "toolName": "read", "toolCallId": "call_..."}
{"seq": 12, "type": "tool_execution_end", "toolName": "read", "toolCallId": "call_...", "success": true}

// Agent settling (after message_end)
{"seq": 13, "type": "agent_settled"}
```

### Parent → Child Commands

Sent by the parent agent manager to control the subagent:

```json
// Steering (first message uses prompt(), subsequent use steer())
{"type": "steer", "message": "Also check the config files"}

// Abort
{"type": "abort"}

// Tool scoping
{"type": "setTools", "tools": ["read", "grep", "find"]}
{"type": "excludeTools", "tools": ["write"]}

// Thinking level
{"type": "setThinking", "level": "high"}

// Compact context
{"type": "compact", "instructions": "Summarize the auth discussion"}
```

### Command Acknowledgements

Every command receives a `command_ack` response:

```json
{"seq": 14, "type": "command_ack", "command": "steer"}
{"seq": 15, "type": "command_ack", "command": "abort"}
{"seq": 16, "type": "command_ack", "command": "setTools"}
{"seq": 17, "type": "command_ack", "command": "setThinking"}
{"seq": 18, "type": "command_ack", "command": "compact"}
```

### Connection Lifecycle

```
Child forks (ud-agent-runner.ts fork())
  ↓
Child: read PI_SUBAGENTS_UDS_SOCKET from env
  ↓
Child: create/open AgentSession (from session file or new)
  ↓
Child: bind UDS server at socket path
  ↓
Child: subscribe to session events → emit on socket
  ↓
Child: emit { type: "ready" } (all subscriptions active)
  ↓
Parent: connect to child's socket
  ↓
Child: receive commands from socket → route to session methods
  ↓
Child: streams agent events → parent (turn_start, text_delta, etc.)
  ↓
Child: runs full TUI (user can interact in tmux window)
```

---

## Child Process (`src/uds-child.mjs`)

A standalone script that runs as a child process. It loads `@earendil-works/pi-coding-agent` as a module and mirrors the in-process `runAgent()` behavior, but communicates via UDS instead of shared memory.

### Environment Variables

The child receives configuration via these environment variables:

| Env Var | Purpose | Set By |
|---------|---------|--------|
| `PI_SUBAGENTS_UDS_SOCKET` | Socket path for this child to bind | Parent (generated `sock-<uuid>`) |
| `PI_SUBAGENTS_SESSION_FILE` | Session file to resume (may be empty) | Parent |
| `PI_CODING_AGENT_DIR` | Agent config directory | Parent (`getAgentDir()`) |
| `PI_CODING_AGENT_SESSION_DIR` | Session storage directory | Parent |
| `PI_SUBAGENTS_AGENT_TYPE` | Agent type name (e.g., "Explore") | Parent |
| `PI_SUBAGENTS_PROMPT` | The user prompt / initial message | Parent |
| `PI_SUBAGENTS_MODEL` | Model as "provider/id" | Parent |
| `PI_SUBAGENTS_THINKING` | Thinking level ("off", "low", "medium", "high") | Parent |
| `PI_SUBAGENTS_MAX_TURNS` | Maximum turns for this session | Parent |
| `PI_SUBAGENTS_CWD` | Working directory | Parent |
| `PI_SUBAGENTS_ISOLATED` | "true" if isolated mode | Parent |
| `PI_SUBAGENTS_TOOLS` | Comma-separated tool names | Parent |
| `PI_SUBAGENTS_TOOL_NAMES` | Alias for TOOLS | Parent |
| `PI_SUBAGENTS_LOG_LEVEL` | Log verbosity (ERROR/WARN/INFO/DEBUG) | User override |

### Key Behavior

- **Runs a full `pi` TUI** — `stdio: ["inherit", "inherit", "inherit", "ipc"]` (4th stdio is IPC for error propagation)
- **Binds a UDS socket** as a side channel for parent-to-child control
- **Session events** are streamed to connected parent
- **Commands from parent** (steer, abort, setTools, setThinking, compact) are routed to `session.*`
- **First steer uses `session.prompt()`**, subsequent steers use `session.steer()` — this avoids overwriting the initial prompt
- **User input** in the tmux window goes to the TUI normally — no conflict with UDS commands
- **Structured logging** with `PI_SUBAGENTS_LOG_LEVEL` env var (default: ERROR, debug: INFO/DEBUG)
- **IPC error propagation** — child sends `process.send({ type: "child_error", message, stack })` before exiting, captured by parent's `child.on("message")` listener

### Auto-Build Support

Before spawning the child, `uds-agent-runner.ts` checks if `dist/uds-server.js` exists. If not (development mode), it auto-compiles the project using `tsc` and creates `dist/package.json` with `{"type":"module"}` for ESM support.

---

## UDS Server (`src/uds-server.ts`)

Manages the UDS socket, routing events from the session to the parent, and commands from the parent to the session.

### Key Implementation Details

- **Binds to a single socket path** — accepts exactly one connection from parent
- **Ready handshake** — after all subscriptions are set up, emits `{ type: "ready" }` before any `session_created` or other events. This prevents the race condition where the parent sends a steer command before the child is fully initialized.
- **First steer → prompt()** — when the first steer message arrives, the server calls `session.prompt()` instead of `session.steer()` to ensure the initial message is properly treated as a prompt.
- **Command acknowledgment** — every command receives a `command_ack` response.
- **Error handling** — unknown commands get `{ type: "error", message: "unknown command: X" }`. Command failures get `{ type: "error", message: "command error (X): ..." }`.
- **Compaction** — calls `(session as any).compact(instructions)` — returns an error if compact is not available on the session.
- **Session is typed as `any` internally** — the server casts the session to access methods like `setThinkingLevel`, `compact`, etc. that may not be in the TypeScript types.

### Cleanup

`shutdown()` destroys the client socket, closes the server, unsubscribes from session events, and removes the socket file from the filesystem.

---

## Agent Manager Integration (`src/agent-manager.ts`)

The `AgentManager` gains three new spawn paths in addition to the existing in-process path:

### `startViaUds()` — Basic UDS

Spawns a child via `uds-agent-runner.ts`, connects to its socket, and streams events. The child handles its own `AgentSession` lifecycle; the parent only observes and forwards.

### `startViaTmuxUds()` — UDS + tmux

Delegates the tmux spawn to `tmux-workspace.ts`'s `spawnUdsSubagent()`, then connects to the pre-created socket via `streamFromUdsSocket()`. This reuses the same event streaming logic but the child was spawned inside a tmux window by the parent.

### `streamFromUdsSocket()` — Shared Event Stream

Connects to an existing UDS socket (either from `uds-agent-runner` or `tmux-workspace`), waits for the `ready` event, then streams all events into the record. Used by both `startViaUds()` and `startViaTmuxUds()`.

### UDS Client Tracking

The manager maintains `private udsClients: Map<string, { client: net.Socket; socketPath: string }>` to track active UDS connections for steering/abort. These are registered in `onClientConnected` and cleaned up after the agent settles.

### Stale Socket Cleanup

A periodic timer (`setInterval` every 30s) scans `~/.pi/subagents/sockets/` for socket files not owned by any running agent, and removes them. This handles crashed children that left behind stale sockets.

### Transport Flow

1. `Agent` tool params include `transport` and `tmux_enabled`
2. `resolveAgentInvocationConfig()` resolves transport from: per-call param → agent frontmatter → global default → `"in-process"`
3. `spawn()` checks `transport` value and dispatches to the appropriate path:
   - `"in-process"` → existing `runAgent()` flow
   - `"uds"` (no tmux) → `startViaUds()`
   - `"uds"` + `tmuxEnabled` → `startViaTmuxUds()`

---

## Tmux Workspace (`src/tmux-workspace.ts`)

Manages tmux windows for subagent visibility and direct interaction.

### Session Layout

- **Master session**: `pi-subagents` (window 0 is the dashboard)
- **Subagent windows**: named `<type-slug>-<desc-slug>` or `<type-slug>-<num>` on collision
  - Example: `explore-1`, `audit-2`, `code-review-3`
- **Window titles**: show agent type and running status

### Two Spawning Modes

#### `spawnSubagent(type, prompt, options)` — Interactive/Print

Spawns `pi -c` (continue/resume) or `pi -p "<prompt>"` (print mode) inside a tmux window. The `pi` CLI runs a full TUI. Steering works via `session.steer()` if the session file is shared.

**Environment**: inherits parent env. No UDS socket. Uses `pi` CLI directly.

#### `spawnUdsSubagent(type, prompt, options)` — UDS

Spawns `node uds-child.mjs` with UDS environment variables inside a tmux window. The parent controls via UDS socket. Full TUI available via stdio.

**Environment variables**: Same as basic UDS mode (PI_SUBAGENTS_UDS_SOCKET, etc.)

### Tmux CLI (`pi-tmux`)

The tmux-workspace module has a built-in CLI when run directly:

```
pi-tmux init              — Initialize workspace session
pi-tmux spawn <type> <prompt> — Spawn a subagent (interactive/pi mode)
pi-tmux list              — List active subagents
pi-tmux attach <window>   — Show how to attach to a window
pi-tmux stop <window>     — Send Ctrl+C to stop a subagent
pi-tmux results           — Show subagent results
pi-tmux dashboard         — Update the dashboard
```

### Socket Tracking

`WINDOW_SOCKET_MAP: Map<string, string>` maps window names to UDS socket paths. Used by `steerTmuxWindow()` and `stopTmuxWindow()` to find the socket for a given window.

---

## Settings & Configuration

### Transport Settings

Three ways to set the transport:

1. **Per-call** — `transport: "uds"` or `"tmux"` in the `Agent` tool parameters
2. **Per-agent** — `transport: "uds"` in `.pi/agents/<name>.md` frontmatter
3. **Global default** — `"defaultTransport": "uds"` in `subagents.json`

Omit all three (or set to `"in-process"`) for the current inline behavior.

### Settings Schema (`subagents.json`)

```json
{
  "defaultTransport": "in-process",  // "in-process" | "uds"
  "tmuxEnabled": false               // boolean: run UDS agents in tmux windows
}
```

**Note**: `"tmux"` as a `defaultTransport` value is silently downgraded to `"uds"` (tmux is now a separate flag).

### Frontmatter

```yaml
---
name: Explore
model: sonnet
thinking: high
transport: tmux       # "uds" or "tmux" (tmux implies uds)
---
```

### UI Settings (Settings Panel)

Two new settings appear in the `/agents → Settings` panel:
- **Default transport** — in-process or uds
- **Tmux display** — on/off

---

## Resume Workflow

### Scenario 1: Resume a Completed Agent

```
Agent A finished → socket deleted
  ↓
User launches new agent with resume: "<id>" or session file
  ↓
Parent spawns NEW child process
  ├── New socket: sock-<new-uuid>
  ├── Same session file: ~/.pi/agent/sessions/xxx.jsonl
  └── Tmux: new window (or same if shared session file)
  ↓
Child opens session file → full conversation history restored
Child binds new socket → parent connects
Agent continues from where it left off
```

**The session file carries the conversation.** The socket is transient — just a pipe for this particular execution.

```
On disk (persistent):
  ~/.pi/agent/sessions/abc123.jsonl
  Contains: user messages, assistant messages, tool calls, all history

On disk (ephemeral, per-run):
  ~/.pi/subagents/sockets/sock-<uuid>
  Only exists while child process is alive
  Deleted when child exits
```

### Scenario 2: Steering a Running Agent

```
Agent A is still running
  ↓
User types: steer_subagent({ agent_id: "abc123", message: "also check config files" })
  ↓
Agent is still "running" → socket is still live
  ↓
Parent sends: { type: "steer", message: "also check config files" }
  ↓
Message delivered immediately via existing socket
```

### Summary

| State | Action |
|-------|--------|
| Running | Steering through existing socket |
| Stopped | Spawn new child, new socket, resume session file |
| Crashed | Spawn new child, new socket, resume session file (parent cleans up stale socket) |

Three paths, no overlap.

---

## Backward Compatibility

| Aspect | Behavior |
|--------|----------|
| Default transport | `"in-process"` — no change to existing behavior |
| Agent frontmatter | `transport` field is optional — defaults to `"in-process"` |
| Existing tools | `Agent`, `SubagentWorkflow`, `get_subagent_result`, `steer_subagent` — same names, same schema |
| New transport option | `transport: "uds"` or `"tmux"` — opt-in, backward compatible |
| Tmux dependency | Optional — only needed when `transport: "tmux"` or `tmuxEnabled: true` |

No breaking changes. Existing sessions, agent files, and workflows continue to work identically.

---

## Socket Lifecycle

### Creation

1. Parent generates unique path: `~/.pi/subagents/sockets/sock-<uuid>`
2. Parent passes path to child via `PI_SUBAGENTS_UDS_SOCKET` env var
3. Child binds UDS server at that path (accepts one connection)
4. Parent connects to the socket

### Completion

Three paths, all idempotent via `unlinkSync(path)`:

1. **Child exits cleanly** → child deletes socket file, parent deletes it too (no-op)
2. **Parent removes agent** → parent closes socket connection, deletes socket file
3. **Child crashes** → socket file persists as "stale" → parent periodic scan deletes it every 30 seconds

### Cleanup on Parent Exit

**Not implemented.** When the parent session ends, there is no automatic mechanism to abort all connected UDS children. The tmux windows and socket files will be cleaned up on next startup via the stale socket cleanup timer.

---

## Error Propagation

When a child process crashes:

1. **Child side** — `uds-child.mjs` logs the error to stderr and sends `process.send({ type: "child_error", message, stack })` via IPC before exiting.
2. **Parent side** — `uds-agent-runner.ts` listens on `child.on("message")` to capture error details, stores it in the result's `failure` field.
3. **Agent Manager** — The record gets `status: "error"` and `error` set to the failure message.

This prevents silent child crashes where the parent only sees "exit code 1" with no cause.

---

## Testing Infrastructure

### Test Coverage

- **`test/uds-transport.test.ts`** — UDS server ↔ client message exchange via real sockets (mocked session). Tests event streaming, command routing, command acknowledgements, ready handshake.
- **`test/uds-agent-runner.test.ts`** — Config resolution, utility helpers (steer/abort/cleanup). Child process and net modules are mocked.
- **`test/uds-integration.test.ts`** — Full event chain through UdsServer with mocked session. Tests completed, aborted, error scenarios.
- **`test/uds-child-lifecycle.test.ts`** — File existence checks, IPC error propagation, child startup.
- **`test/tmux-uds.test.ts`** — Socket path generation, directory management, socket cleanup, window-socket mapping. Pure function tests.
- **`test/tmux-integration.test.ts`** — Tmux session management, window creation, dashboard, UDS socket integration.
- **`test/tmux-spawn-dispatch.test.ts`** — Tmux spawn logic, env var building, window naming.
- **`test/tmux-enabled-settings.test.ts`** — Settings persistence, legacy downgrade, round-trip.

### What Can Be Reused

1. **All wiring tests** (`*-wiring.test.ts`) — already mock at the tool/registration level
2. **Agent manager tests** (`agent-manager.test.ts`) — mock `runAgent`, transport is internal
3. **Tool scoping tests** — assert on tool allowlists, not transport
4. **Print-mode E2E tests** — parameterize with transport config

---

## Key Design Decisions

### 1. Child Runs Full TUI

The child is a standalone script that runs a full TUI in its tmux window (via inherited stdio). This allows the user to:
- Switch to the window and interact directly
- Run `bash`, `read`, `write`, etc. in the child's session
- Debug issues by browsing the child's output

The UDS is a **side channel** for parent-to-child control. It does not replace the TUI.

### 2. Socket Path Location

Socket files live in `~/.pi/subagents/sockets/` (created on first use). This keeps them alongside other pi state rather than in `/tmp`.

### 3. Unique Socket Paths Per Child

Each child gets a unique UUID-based path. This prevents "address already in use" errors even if the parent spawns children rapidly.

### 4. Ready Handshake

The child emits `{ type: "ready" }` after all subscriptions are set up. The parent waits for this before sending the initial steer command. This prevents the race condition where a steer arrives before the session is ready.

### 5. Tmux Is Optional

Tmux windows are controlled by `tmuxEnabled` in settings or `tmux_enabled` in the Agent tool call. When not enabled, UDS agents work exactly like in-process agents but in separate processes (useful for isolation, debugging, or future remote execution).

### 6. No Changes to pi-coding-agent

The child is a standalone script (`uds-child.mjs`) that:
- Loads `@earendil-works/pi-coding-agent` as a Node.js module
- Calls `createAgentSession()` directly (same as in-process)
- Binds a UDS socket as a side channel
- Receives configuration via process env vars

### 7. Stale Socket Cleanup

On startup, the extension starts a periodic interval (30s) that scans `~/.pi/subagents/sockets/` for stale socket files (from crashed children) and removes them.

### 8. Auto-Build

If `dist/uds-server.js` doesn't exist (development mode), the runner auto-compiles the project before spawning the child. This means `uds-agent-runner.ts` works both in development (`-e src/index.ts`) and production (`npm run build` followed by the bundled extension).

---

## Implementation Order (Completed)

1. ✅ **UDS server** (`uds-server.ts`) + **child process** (`uds-child.mjs`)
   - Socket binding, event subscription, command routing, ready handshake
   - Error propagation via IPC
   - Structured logging with LOG_LEVEL

2. ✅ **UDS agent runner** (`uds-agent-runner.ts`)
   - Spawn child process, connect to socket, subscribe to events, wait for completion
   - Auto-build support
   - `transport: "uds"` added to `RunOptions`

3. ✅ **Tmux workspace** (`tmux-workspace.ts`)
   - Two spawning modes: interactive/pi and UDS
   - Session/window management
   - Dashboard rendering
   - CLI interface

4. ✅ **Extension integration** (`agent-manager.ts`, `types.ts`, `index.ts`, `settings.ts`, `invocation-config.ts`)
   - Wire UDS transport into `AgentManager`
   - Frontmatter support, settings, commands
   - UI settings panel additions

5. ✅ **Tests**
   - UDS protocol unit tests (8 test files)
   - Wiring tests updated for UDS paths
   - Tmux workspace tests

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/uds-child.mjs` | Child process bootstrap — creates AgentSession, binds UDS socket |
| `src/uds-server.ts` | UDS server — routes events and commands between session and socket |
| `src/uds-agent-runner.ts` | Parent-side runner — forks child, connects to socket, streams events |
| `src/tmux-workspace.ts` | Tmux management — spawns windows, manages dashboard, socket tracking |
| `src/agent-manager.ts` | AgentManager — dispatches spawn paths (in-process / UDS / UDS+tmux) |
| `src/types.ts` | `AgentTransport` type: `"in-process"` \| `"uds"` |
| `src/settings.ts` | Settings: `defaultTransport`, `tmuxEnabled`, legacy downgrade |
| `src/index.ts` | Extension wiring — transport params, steering path, UI settings |
| `scripts/uds-test-standalone.mjs` | Diagnostic CLI for testing UDS child process |
| `src/check-uds-imports.mjs` | Build-time import and file existence validation |
