# Issue: No Graceful Shutdown on Parent Exit

## Context

The UDS + tmux workspace system spawns child processes that survive parent exit (by design — tmux detach lets agents keep running). However, when the parent exits cleanly (via `/quit`, SIGINT, etc.), there is **no mechanism** to:

1. Send `abort` commands to all connected UDS children via their sockets
2. Clean up tmux subagent windows
3. Clean up the `pi-subagents` tmux session itself

Currently, the only cleanup is the 30-second stale socket cleanup timer that runs on next startup.

## Files

- `src/agent-manager.ts` — `udsClients` tracking, `startViaUds()`, `startViaTmuxUds()`
- `src/tmux-workspace.ts` — tmux session/window management
- `src/uds-server.ts` — shutdown method (exists but not called on parent exit)
- `src/uds-agent-runner.ts` — client/connection tracking

## Decisions to Make

- Should parent exit gracefully abort children, or should it leave them running (current behavior)?
- What's the expected behavior for each: exit via `/quit`, SIGINT, crash?
- Should we clean up tmux windows on parent exit, or only on manual disconnect?
- Should there be a config option for this behavior?

---

# Research Report: Parent-Exit-Cleanup

## Current State Analysis

### 1. Existing Cleanup Mechanisms (What's Already There)

#### a) The `session_shutdown` Handler (index.ts, ~line 1111-1138)
This is the **only** shutdown path currently wired up. It triggers when pi emits the
`session_shutdown` lifecycle event (via `/quit` or similar):

```typescript
pi.on("session_shutdown", async () => {
  rpcHandle?.unsubSpawn();
  rpcHandle?.unsubStop();
  rpcHandle?.unsubPing();
  rpcHandle?.unsubConsume();
  // ...
  for (const task of workflowTasks.values()) task.abortController.abort();
  workflowTasks.clear();
  manager.abortAll();              // ← Key line: aborts all agents
  for (const timer of pendingNudges.values()) clearTimeout(timer);
  pendingNudges.clear();
  fleet.dispose();
  await manager.dispose(pi);       // ← Cleans up UDS clients, timers, worktrees
});
```

#### b) What `manager.abortAll()` Currently Does (agent-manager.ts)
```typescript
abortAll(): number {
  // 1. Clear queued agents — mark stopped, dequeue
  for (const queued of this.queue) {
    if (record) { record.status = "stopped"; record.completedAt = Date.now(); count++; }
  }
  this.dequeue(() => true);

  // 2. Abort running agents
  for (const record of this.agents.values()) {
    if (record.status === "running") {
      record.abortController?.abort();           // In-process: abort signal
      record.status = "stopped";                  // UDS: will set below
      record.completedAt = Date.now();
      count++;
    }
  }
  return count;
}
```

**IMPORTANT:** This function does NOT check `udsClients`. It only:
- Sets `record.status = "stopped"` and fires `abortController.abort()`
- For UDS agents, the `abortController.abort()` signals the `abortPromise` in
  `uds-agent-runner.ts`, which calls `sendCommand({ type: "abort" })` to the child socket

This means UDS children DO receive the abort command through the normal abort path
(race between `childCompletionPromise` and `abortPromise`). The child's `routeCommand`
handles `"abort"` → `this.session.abort()`.

#### c) What `manager.dispose()` Does (agent-manager.ts, line ~2191)
```typescript
async dispose(pi?: ExtensionAPI): Promise<void> {
  clearInterval(this.cleanupInterval);            // Stop 60s cleanup timer
  this.stopStaleSocketCleanup();                  // Stop 30s stale socket timer
  this.dequeue(() => true);                       // Release queue waiters
  const sessions = [...this.agents.values()].map(r => r.session);
  this.agents.clear();
  this.startups.clear();

  // Clean up UDS client connections and socket files
  for (const [, { client, socketPath }] of this.udsClients) {
    await cleanupUdsAgent(client, socketPath);    // destroy() + unlinkSync()
  }
  this.udsClients.clear();

  // Prune orphaned worktrees
  if (pi) { pruneWorktrees(pi, repo); ... }

  // Awaited: emit session_shutdown into child sessions
  await Promise.all(sessions.map(s => shutdownChildSession(s)));
}
```

#### d) Child Process Signal Handling (uds-child.mjs, line ~363)
```javascript
process.on("SIGTERM", async () => { await cleanup(); process.exit(0); });
process.on("SIGINT",  async () => { await cleanup(); process.exit(0); });
```

The child also has its own `cleanup()` function that:
- Unsubscribes from session events
- Calls `server.shutdown()` which closes the socket, removes the socket file, and
  unsubscribes from the session

#### e) UdsServer.shutdown() (uds-server.ts, line ~270)
```typescript
shutdown(): void {
  // Unsubscribe from session events
  // Null session reference
  // Destroy client socket
  // Close server
  // unlinkSync(socketPath)
}
```

### 2. What is ALREADY Working on Clean Exit

When the parent exits via `/quit` (which fires `session_shutdown`):

| Action | Status | Mechanism |
|--------|--------|-----------|
| Abort in-process agents | ✅ Works | `abortController.abort()` → agent runner handles it |
| Send abort to UDS children | ✅ Works | `abortPromise` races → `sendCommand({ type: "abort" })` |
| Clean up UDS client sockets | ✅ Works | `manager.dispose()` → `cleanupUdsAgent()` |
| Remove stale socket files | ✅ Works | Child cleanup + `dispose()` cleanup |
| Stop stale socket timer | ✅ Works | `stopStaleSocketCleanup()` |
| Dispose child sessions | ✅ Works | `shutdownChildSession()` emits `session_shutdown` |
| Prune worktrees | ✅ Works | `pruneWorktrees()` in dispose |
| Clear queue waiters | ✅ Works | `dequeue(() => true)` |

### 3. What is MISSING on Clean Exit

| Missing Item | Severity | Details |
|-------------|----------|---------|
| **No tmux window cleanup** | 🔴 HIGH | All `pi-subagents` windows persist after parent exit |
| **No tmux session cleanup** | 🔴 HIGH | The `pi-subagents` session itself persists with an empty dashboard |
| **No `process.on("SIGINT")` at parent level** | 🟡 MEDIUM | If pi is killed with SIGINT from the shell, `session_shutdown` may not fire |
| **No `process.on("SIGTERM")` at parent level** | 🟡 MEDIUM | Same issue as SIGINT |
| **No `process.on("exit")` at parent level** | 🟡 MEDIUM | For crash/unexpected exit scenarios |
| **No tmux window → agentId mapping exposed** | 🟡 MEDIUM | `record.tmuxWindow` exists but there's no reverse lookup for cleanup |
| **No config option** | 🟢 LOW | No user control over "what happens when parent exits" |
| **No window-level Ctrl+C before delete** | 🟢 LOW | Would be cleaner than `kill-session` |

### 4. What is NOT Applicable

| Not Applicable | Reason |
|----------------|--------|
| Sending abort via UDS sockets | Already works — `abortAll()` + `abortPromise` sends abort to all children |
| Stale socket cleanup | Already works — 30-second timer runs on next startup, plus immediate cleanup on exit |
| In-process agent cleanup | Already works — `abortController.abort()` handles it |
| Child process self-cleanup | Already works — `uds-child.mjs` handles SIGTERM/SIGINT |

---

## Code Path Mapping (What Needs to Change)

### Path 1: Tmux Window Cleanup on Parent Exit

**Entry point:** `index.ts` — `session_shutdown` handler

**Files to modify:**

1. **`src/tmux-workspace.ts`** — Add cleanup functions:
   ```typescript
   // NEW: Get all subagent window names (returns window names as strings)
   export function getAllSubagentWindowNames(): string[] { ... }
   
   // NEW: Send Ctrl+C to a tmux window (graceful stop)
   export function stopWindowGracefully(windowName: string): void { ... }
   
   // NEW: Delete a specific tmux window
   export function deleteWindow(windowName: string): void { ... }
   
   // NEW: Delete the entire pi-subagents tmux session
   export function killTmuxSession(): void { ... }
   ```

2. **`src/agent-manager.ts`** — Optionally expose tmux window tracking:
   - The `record.tmuxWindow` field already exists on the record
   - `dispose()` could optionally accept a parameter to clean up tmux windows
   - Or, add a new `disposeAll(pi, options?)` that takes a `{ cleanTmux: boolean }` option

3. **`src/index.ts`** — Wire tmux cleanup into `session_shutdown`:
   ```typescript
   pi.on("session_shutdown", async () => {
     // ... existing code ...
     
     // NEW: Clean up tmux windows before session teardown
     if (isTmuxEnabled()) {
       // Option A: Send Ctrl+C to each window
       const windows = getAllSubagentWindowNames();
       for (const w of windows) {
         stopWindowGracefully(w);
         await waitForWindowExit(w, 2000); // brief grace period
       }
       // Option B: Delete the entire session
       killTmuxSession();
     }
   });
   ```

### Path 2: Process-Level Signal Handlers (Optional Enhancement)

**Files to modify:**

1. **`src/index.ts`** — Add process-level handlers:
   ```typescript
   // NEW: Handle unexpected process termination
   let isShuttingDown = false;
   process.on("SIGINT", () => {
     if (isShuttingDown) process.exit(0); // double SIGINT = force
     isShuttingDown = true;
     // session_shutdown will fire naturally from pi, but this is a safety net
   });
   
   process.on("SIGTERM", () => {
     if (isShuttingDown) process.exit(0);
     isShuttingDown = true;
   });
   
   process.on("exit", (code) => {
     // Best-effort cleanup — cannot await in this handler
     if (code !== 0) {
       // On crash, just kill the tmux session
       execSync(`tmux kill-session -t ${TMUX_SESSION_NAME} 2>/dev/null`, { stdio: "pipe" });
     }
   });
   ```

2. **Potential conflict:** These handlers must NOT interfere with pi's own signal handling.
   They should only be added when pi doesn't already handle them.

### Path 3: Config Option (Optional)

**Files to modify:**

1. **`src/settings.ts`** — Add settings:
   ```typescript
   interface SubagentsSettings {
     // ... existing settings ...
     
     /**
      * Cleanup behavior when parent session exits.
      * - "abort": Abort all agents and clean up tmux windows (default)
      * - "detach": Leave agents running, only clean up sockets (current behavior)
      * - "stop": Send Ctrl+C to each tmux window but keep the session
      */
     parentExitCleanup?: "abort" | "detach" | "stop";
   }
   ```

2. **`src/index.ts`** — Read setting in `session_shutdown`:
   ```typescript
   pi.on("session_shutdown", async () => {
     // ... existing code ...
     
     const cleanupMode = getParentExitCleanupMode();
     if (cleanupMode !== "detach" && isTmuxEnabled()) {
       cleanupTmuxOnExit(cleanupMode);
     }
   });
   ```

---

## Decision Options

### Option A: Minimal — Fix tmux cleanup only

**Scope:** Only add tmux window/session cleanup to the existing `session_shutdown` handler.

**Pros:**
- Minimal code change (2-3 new functions in tmux-workspace.ts, ~10 lines in index.ts)
- Fixes the most visible problem (orphaned tmux windows)
- No behavioral change for in-process agents
- No new config needed

**Cons:**
- Only works when `session_shutdown` fires (not on force-kill)
- No user configurability

**Implementation effort:** ~1-2 hours

### Option B: Full — Signal handlers + tmux cleanup + config

**Scope:** Add process-level signal handlers, tmux cleanup, and a config option.

**Pros:**
- Most comprehensive solution
- Works for all exit scenarios (clean exit, SIGINT, SIGTERM, crash)
- User can choose desired behavior
- Future-proof

**Cons:**
- More complex
- Risk of conflicting with pi's own signal handling
- More test surface area
- Harder to get right (race conditions on double-signal)

**Implementation effort:** ~4-6 hours

### Option C: Middle Ground — tmux cleanup + signal handlers, no config

**Scope:** Add tmux cleanup + basic signal handlers, but keep behavior fixed (always clean up).

**Pros:**
- Fixes the most visible problem (orphaned tmux windows)
- Handles SIGTERM gracefully (more scenarios than just `session_shutdown`)
- Simpler than full config approach
- ~80% of the value of Option B

**Cons:**
- No user configurability
- Signal handlers still need careful integration testing

**Implementation effort:** ~2-3 hours

---

## Trade-offs

### Aggressive Abort (kill all)

| Aspect | Details |
|--------|---------|
| **Approach** | `tmux kill-session -t pi-subagents` — force kill everything |
| **Pros** | Guaranteed clean state; fast; simple; no race conditions |
| **Cons** | Children don't get a chance to clean up; socket files may be stale; abrupt |
| **Best for** | Crash recovery; force-quit scenarios |

### Graceful Disconnect (Ctrl+C → stop → delete)

| Aspect | Details |
|--------|---------|
| **Approach** | Send Ctrl+C to each window → wait → delete windows → delete session |
| **Pros** | Clean shutdown; children can flush state; socket files properly removed; `session.abort()` semantics |
| **Cons** | Slower; race condition risk if a hung child doesn't respond to Ctrl+C; needs timeout |
| **Best for** | Clean exit via `/quit`; SIGINT; normal shutdown |

### Leave Running (current behavior)

| Aspect | Details |
|--------|---------|
| **Approach** | Do nothing; tmux detach philosophy |
| **Pros** | Matches "tmux detach" semantics; agents truly survive parent exit |
| **Cons** | Orphaned tmux windows pile up; stale sockets until 30s cleanup; confusing UX |
| **Best for** | Users who intentionally detach and want agents to keep running |

### Hybrid (Recommended)

| Aspect | Details |
|--------|---------|
| **Approach** | Graceful for clean exit, aggressive for crash |
| **Clean exit** (`session_shutdown`): Ctrl+C each window, wait briefly (1s), then delete session |
| **Crash/force** (`process.on("exit")`): `tmux kill-session -t pi-subagents` |
| **Pros** | Best of both worlds; clean for normal use, safe for crashes |
| **Cons** | Slightly more code |
| **Best for** | Default behavior |

---

## Tmux Session Management: Current Capabilities

The tmux workspace already has all the tmux commands needed for cleanup, but none are
currently exported for this purpose:

### Existing (read-only) functions in `tmux-workspace.ts`:

| Function | tmux command | Purpose |
|----------|-------------|---------|
| `listSubagents()` | `tmux list-windows -t pi-subagents -F "#{window_index}:#{window_name}:#{window_active}"` | List all windows |
| `getPanePid(windowName)` | `tmux display-message -t pi-subagents:{windowName} -p "#{pane_pid}"` | Get pane PID |
| `windowExists(windowName)` | `tmux has-session -t pi-subagents:{windowName}` | Check window existence |
| `stopWindow(windowName)` | `tmux send-keys -t pi-subagents:{windowName} "C-c" C-m` | Send Ctrl+C |
| `getSubagentInfo(windowName)` | `tmux list-windows -t pi-subagents -F "#{window_index}:#{window_name}:#{window_active}:#{pane_pid}:#{pane_current_path}"` | Get detailed info |
| `getTmuxSubagentStatus()` | `kill -0 {pid}` | Check if process alive |
| `getOrCreateSession()` | `tmux has-session -t pi-subagents` | Ensure session exists |

### Missing (cleanup) functions needed:

| Needed Function | tmux command | Description |
|----------------|-------------|-------------|
| `getAllSubagentWindowNames()` | `list-windows` | Return array of window names (skip window 0) |
| `deleteWindow(windowName)` | `tmux kill-window -t pi-subagents:{windowName}` | Delete a specific window |
| `killTmuxSession()` | `tmux kill-session -t pi-subagents` | Kill entire session |
| `stopAndDeleteWindow(windowName)` | `stopWindow` → `deleteWindow` | Graceful stop then delete |

### Iterating All Windows

The `listSubagents()` function already iterates all windows from tmux. A cleanup function
would simply extend this pattern:

```typescript
// This already exists in listSubagents():
const output = execSync(
  `tmux list-windows -t ${TMUX_SESSION_NAME} -F "#{window_index}:#{window_name}:#{window_active}"`,
  { stdio: "pipe", encoding: "utf-8" }
).trim();

// A cleanup version would iterate and kill:
for (const line of output.split("\n")) {
  const [indexStr, windowName] = line.split(":");
  if (parseInt(indexStr, 10) === 0) continue; // Skip dashboard
  execSync(`tmux kill-window -t ${TMUX_SESSION_NAME}:${windowName}`, { stdio: "pipe" });
}
execSync(`tmux kill-session -t ${TMUX_SESSION_NAME}`, { stdio: "pipe" });
```

---

## Mapping the tmux Window Tracking Chain

The current code tracks tmux windows at multiple levels:

1. **`agent-manager.ts`**: `record.tmuxWindow` — set in `startViaTmuxUds()` at line 1194
   ```typescript
   record.tmuxWindow = windowName;  // Stored on the AgentRecord
   ```
   This is available in the `agents` Map, so `listAgents()` returns records with `tmuxWindow`.

2. **`tmux-workspace.ts`**: `WINDOW_SOCKET_MAP` — maps window name → socket path
   ```typescript
   const WINDOW_SOCKET_MAP = new Map<string, string>();
   // Set at line 392: WINDOW_SOCKET_MAP.set(windowName, socketPath);
   ```
   This is module-level and not accessible from agent-manager.

3. **Not connected**: There's no reverse lookup from `agentId` → `tmuxWindow` exposed.
   The `record.tmuxWindow` field exists but `manager.listAgents()` already gives callers
   access to it.

### Current Cleanup Gap

When `dispose()` runs, it cleans up `udsClients` (the socket connections) but has NO
knowledge of tmux windows. The `record.tmuxWindow` field is available on the AgentRecord
but is never used during cleanup.

---

## Process Lifecycle Flow — Current State

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Parent process (pi subagents extension)                                │
│                                                                         │
│  session_shutdown fires                                                │
│       │                                                                 │
│       ▼                                                                 │
│  1. Unregister RPC handlers                                            │
│  2. Abort workflow tasks                                               │
│  3. manager.abortAll()                                                  │
│       │   └──→ for each running agent:                                  │
│       │       ├── in-process: abortController.abort()                   │
│       │       └── UDS: record.status = "stopped"                      │
│       │                                                               │
│       │  NOTE: abortAll() does NOT directly send abort to UDS children │
│       │  (The abort goes through the abortPromise in uds-agent-runner) │
│       │                                                               │
│  4. Clear pending nudges                                               │
│  5. fleet.dispose()                                                    │
│  6. manager.dispose(pi)                                                │
│       │   └──→ clearInterval(cleanupInterval)                         │
│       │   └──→ stopStaleSocketCleanup()                               │
│       │   └──→ dequeue(() => true)                                    │
│       │   └──→ agents.clear()                                         │
│       │   └──→ for each udsClient: cleanupUdsAgent()                  │
│       │   └──→ prune worktrees                                        │
│       │   └──→ await shutdownChildSession() for each child session    │
│       │                                                               │
│  ❌ NO tmux window cleanup                                             │
│  ❌ NO tmux session cleanup                                            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Child process (uds-child.mjs)                                           │
│                                                                         │
│  Normal completion:                                                     │
│    agent_settled event → server.shutdown() → process exits naturally   │
│                                                                         │
│  SIGTERM/SIGINT:                                                        │
│    cleanup() → unsubscribe → server.shutdown() → process.exit(0)       │
│                                                                         │
│  Abort received via socket:                                             │
│    routeCommand("abort") → session.abort() → agent_end event           │
│                                                                         │
│  No process-level signal handling in parent to reach children directly   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  tmux session: pi-subagents                                              │
│                                                                         │
│  After parent exit:                                                     │
│    Window 0: "dashboard" — stale, empty                                │
│    Window 1: "explore-1" — PERSISTS (child process still running)      │
│    Window 2: "audit-2" — PERSISTS (child process still running)        │
│    ...                                                                  │
│                                                                         │
│  Socket files:                                                          │
│    ~/.pi/subagents/sockets/sock-* — cleaned up by dispose()             │
│    Stale sockets (crashed children) — cleaned by 30s timer on restart  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Recommended Scope for First Implementation

### Priority 1: tmux window cleanup on clean exit (~1-2 hours)

**What:**
1. Add `getAllSubagentWindowNames()` to tmux-workspace.ts (reuses `listSubagents()` logic)
2. Add `killTmuxSession()` to tmux-workspace.ts
3. Wire it into `session_shutdown` in index.ts

**Code changes:** ~30 lines total

**Behavior:**
- On `session_shutdown`, call `killTmuxSession()` to remove all windows and the session
- Only runs if tmux is enabled (check `isTmuxEnabled()`)
- Swallows errors (tmux may not be installed, session may already be gone)

### Priority 2: Graceful stop before session kill (~1-2 hours)

**What:**
1. Before killing the tmux session, send Ctrl+C to each active window
2. Wait briefly (1-2 seconds) for graceful shutdown
3. Then kill the session

**Behavior:**
- More graceful — children get a chance to stop cleanly
- Won't hang: bounded timeout

### Priority 3: Signal handler safety net (~1 hour)

**What:**
1. Add `process.on("SIGTERM")` that calls the tmux cleanup
2. Only if `session_shutdown` hasn't already fired

**Behavior:**
- Catches cases where pi is killed with SIGTERM (less common)
- Must not conflict with pi's own handler
- Use a guard flag (`isShuttingDown`) to handle double-signal

### NOT Recommended for First Implementation

- Config options (nice to have, but adds complexity)
- Aggressive `process.on("exit")` handler (best-effort only, hard to test)
- Kill children via `kill -9` on their PIDs (unnecessarily aggressive)
- Child process awareness of parent exit (overkill; child self-cleanup already works)

### Implementation Order

1. **`tmux-workspace.ts`** — Add 3 cleanup functions
2. **`index.ts`** — Wire into `session_shutdown`, guarded by `isTmuxEnabled()`
3. **Test:** Start agents, quit pi, verify tmux windows are gone
4. **Iterate:** Add Ctrl+C before kill, then signal handlers

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| tmux cleanup blocks `session_shutdown` | Low | Medium | Keep cleanup fire-and-forget; don't await |
| Double-signal (SIGINT fires before session_shutdown) | Low | Low | Guard flag; session_shutdown will still fire |
| `tmux` command not available | Medium | Low | Wrap in try/catch; `isTmuxAvailable()` check |
| Cleanup runs when no tmux session exists | Low | Low | `tmux kill-session` fails silently if session gone |
| Conflict with pi's own exit handling | Low | Medium | Don't exit process in our handlers; just do cleanup |
| Race between abort and tmux cleanup | Low | Low | Abort runs first (in `abortAll()`), tmux cleanup runs after |

---

*Research completed. The key finding is that the current `session_shutdown` handler already handles UDS child abort and socket cleanup correctly. The single gap is tmux window/session cleanup, which is a straightforward addition requiring only 3 new functions in tmux-workspace.ts and ~10 lines of wiring in index.ts.*
