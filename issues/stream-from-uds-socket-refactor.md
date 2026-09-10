# Issue: streamFromUdsSocket() "Minor Hack" — Connect-Only Helper Needed

## Context

In `agent-manager.ts`, the `streamFromUdsSocket()` method is a shared helper used by both `startViaUds()` (basic UDS) and `startViaTmuxUds()` (UDS + tmux).

The problem: `runViaUds()` in `uds-agent-runner.ts` was designed to **spawn a child AND connect to its socket**. But `startViaTmuxUds()` already has the child spawned (by `tmux-workspace.ts`'s `spawnUdsSubagent()`) — it only needs to **connect to an existing socket** and stream events.

The current workaround in `streamFromUdsSocket()`:
- Manually polls for the socket file (`accessSync` in a loop)
- Connects via `net.createConnection()`
- Handles all event parsing inline
- Duplicates much of the connection and event handling logic from `runViaUds()`

The code comment says:
> "For now, reuse runViaUds but override the socket — this requires a minor hack. Better: create a wrapper that connects to an existing socket."

## Files

- `src/agent-manager.ts` — `streamFromUdsSocket()`, `startViaUds()`, `startViaTmuxUds()`
- `src/uds-agent-runner.ts` — `runViaUds()` (spawn + connect), connection logic, event handling
- `src/tmux-workspace.ts` — `spawnUdsSubagent()` (already creates the socket)

## Decisions to Make

- Should `runViaUds()` expose a `connectOnly()` static method?
- Or should we extract a shared `connectToSocket(socketPath, callbacks)` utility?
- Does the event parsing logic need to be duplicated at all?
- Should `streamFromUdsSocket()` be a proper method on `AgentManager` that reuses the parsing logic?

---

## Research Report

# Current Duplication Analysis

## 1. Data Flow in `streamFromUdsSocket()` (agent-manager.ts, ~lines 1340–1540)

Here is the step-by-step data flow:

### Step 1: Dynamic imports
The function dynamically imports everything it needs — `runViaUds`, `agent-types.js`, `agent-runner.js`, `node:crypto`, `node:fs`, `node:child_process`, `node:os`, `node:url`, `node:path`, `node:net`. This is heavy — most of these are only used to re-declare constants and helper patterns that already exist in `runViaUds`.

### Step 2: Configuration resolution (duplicated from runViaUds)
```
const agentConfig = getAgentConfig(type);
const resolvedModel = resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);
const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;
const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns);
const toolNames = getToolNamesForType(type);
```
This is **exactly the same 4 lines** that `runViaUds()` does at its beginning (lines 75–82 in uds-agent-runner.ts).

### Step 3: Socket polling (duplicated from runViaUds)
```
await new Promise<void>((resolve, reject) => {
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += SOCKET_POLL_INTERVAL_MS;
    try {
      accessSync(socketPath);
      socketReady = true;
      clearInterval(timer);
      resolve();
    } catch {
      if (elapsed >= SOCKET_POLL_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`Socket ${socketPath} not ready...`));
      }
    }
  }, SOCKET_POLL_INTERVAL_MS);
  timer.unref();
});
```
This is the **exact same polling loop** as in `runViaUds()` lines 129–147. Same interval (50ms), same timeout (5000ms), same `accessSync` approach, same `timer.unref()`.

### Step 4: Socket connection (duplicated from runViaUds)
```
const client = net.createConnection({ path: socketPath });

await new Promise<void>((resolve, reject) => {
  client.once("connect", () => resolve());
  client.once("error", (err) => reject(err));
  const timer = setTimeout(() => {
    client.destroy();
    reject(new Error(`Failed to connect to UDS socket...`));
  }, CONNECT_TIMEOUT_MS);
  timer.unref();
});
```
This is the **exact same connection pattern** as `runViaUds()` lines 154–166. Same `net.createConnection`, same timeout (5000ms), same error handling.

### Step 5: State variable declarations (duplicated from runViaUds)
```
let buffer = "";
let readyReceived = false;
let responseText = "";
let turnCount = 0;
let toolUses = 0;
let completed = false;
let aborted = false;
let error: string | undefined;
```
**Exactly the same variable declarations** as `runViaUds()` lines 172–179.

### Step 6: Data handler with line buffering (duplicated from runViaUds)
```
client.on("data", (data: Buffer) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "ready" && !readyReceived) readyReceived = true;
        handleChildEvent(msg);
      } catch { /* skip malformed */ }
    }
  }
});
```
This is **identical to `runViaUds()` lines 181–196**. Same buffering strategy, same line splitting, same JSON parsing, same ready handshake check.

### Step 7: `sendCommand` helper (duplicated from runViaUds)
```
function sendCommand(command: Record<string, unknown>): void {
  if (!client.destroyed && !client.writableEnded) {
    client.write(JSON.stringify(command) + "\n");
  }
}
```
**Exactly the same** as `runViaUds()` lines 198–202.

### Step 8: `handleChildEvent` (duplicated from runViaUds)
```
function handleChildEvent(msg: any): void {
  switch (msg.type) {
    case "turn_start": turnCount++; break;
    case "turn_end": if (msg.turnCount != null) turnCount = msg.turnCount; break;
    case "text_delta":
      responseText += msg.delta;
      options.onTextDelta?.(msg.delta as string, responseText);
      break;
    case "tool_execution_start":
      toolUses++;
      options.onToolActivity?.({ type: "start", toolName: msg.toolName as string });
      break;
    case "tool_execution_end":
      options.onToolActivity?.({ type: "end", toolName: msg.toolName as string });
      break;
    case "message_end": { ... usage handling ... }
    case "compaction": { ... }
    case "completed": completed = true; ...
    case "aborted": aborted = true; completed = true; break;
    case "error": error = msg.message; completed = true; break;
  }
}
```
This is **the same event handling logic** as `runViaUds()` lines 204–255. Every case matches:
- `turn_start` → increment turnCount
- `turn_end` → update turnCount from message
- `text_delta` → append to responseText, call `onTextDelta`
- `tool_execution_start` → increment toolUses, call `onToolActivity({ type: "start" })`
- `tool_execution_end` → call `onToolActivity({ type: "end" })`
- `message_end` → call `onAssistantUsage` with usage data
- `compaction` → call `onCompaction` with reason and tokensBefore
- `completed` → set completed, overwrite responseText if message.result exists
- `aborted` → set aborted=true, completed=true
- `error` → set error, completed=true

### Step 9: Steer command with ready handshake (duplicated from runViaUds)
Both functions have the same pattern:
1. If `readyReceived`, send `{ type: "steer", message: prompt }` immediately
2. Otherwise, wait up to 2 seconds for the `ready` message, then send steer

In `streamFromUdsSocket()` (lines ~1480–1515), the implementation is slightly simpler (no re-registration of original handler) but the **logic structure is identical**.

### Step 10: Abort signal handling (duplicated from runViaUds)
```
const abortPromise = new Promise<void>((resolve) => {
  if (!options.signal) { resolve(); return; }
  if (options.signal.aborted) { sendCommand({ type: "abort" }); resolve(); return; }
  options.signal.addEventListener("abort", () => {
    aborted = true;
    sendCommand({ type: "abort" });
    resolve();
  }, { once: true });
});
```
This mirrors `runViaUds()` lines 257–270. Same pattern: check signal existence, check if already aborted, add one-shot listener.

### Step 11: Completion waiting (slightly different)
- `streamFromUdsSocket()`: Uses a polling interval checking `completed` flag every 100ms
- `runViaUds()`: Uses `child.once("exit")` plus the `completed` flag (more robust — catches crashes)

### Step 12: Cleanup and result
Both return the same `UdsRunResult` shape:
```
{
  responseText: responseText.trim(),
  session: null as unknown as AgentSession,
  aborted,
  steered: false,
  failure: error,
  structuredJson,
  structuredRetried,
  client,
  socketPath,
}
```

---

## 2. Exact Duplication Mapping

| Logic Block | `runViaUds()` Location | `streamFromUdsSocket()` Location |
|---|---|---|
| Config resolution (agentConfig, model, maxTurns, toolNames) | Lines 75–82 | Lines ~1350–1360 |
| Socket polling loop | Lines 129–147 | Lines ~1378–1395 |
| Socket connection with timeout | Lines 154–166 | Lines ~1397–1409 |
| State variable declarations | Lines 172–179 | Lines ~1412–1418 |
| Data handler with line buffering | Lines 181–196 | Lines ~1420–1435 |
| `sendCommand` helper | Lines 198–202 | Lines ~1440–1444 |
| `handleChildEvent` switch | Lines 204–255 | Lines ~1446–1475 |
| Steer command with ready handshake | Lines 257–290 | Lines ~1477–1510 |
| Abort signal handling | Lines 257–270 | Lines ~1512–1522 |
| Completion waiting + cleanup | Lines 280–320 | Lines ~1524–1535 |
| Result building (`buildResult`) | Lines 325–335 | Lines ~1537–1545 |

**Approximately 130-150 lines of code are duplicated** between these two functions, covering the entire socket connection → message parsing → event handling → completion pipeline.

---

## 3. What `runViaUds()` does that `streamFromUdsSocket()` doesn't need

| Feature | Description |
|---|---|
| **Child process spawning** | `runViaUds()` calls `fork(UDS_CHILD_PATH, { ... })` to spawn the child. `streamFromUdsSocket()` assumes the child is already running. |
| **Environment building** | `runViaUds()` builds `childEnv` with 12+ environment variables (PI_SUBAGENTS_UDS_SOCKET, PI_SUBAGENTS_AGENT_TYPE, PI_SUBAGENTS_PROMPT, etc.). `streamFromUdsSocket()` doesn't need this. |
| **Auto-compile check** | `runViaUds()` calls `ensureUDSServerCompiled()` which checks for and compiles `dist/uds-server.js` if missing. `streamFromUdsSocket()` skips this. |
| **Socket path generation** | `runViaUds()` calls `randomUUID()` to generate a new socket path and `mkdirSync` to create the directory. `streamFromUdsSocket()` receives a pre-existing socket path. |
| **Child IPC error handler** | `runViaUds()` sets up `child.on("message", ...)` to capture child crash reasons. `streamFromUdsSocket()` has no child reference. |
| **Child exit tracking** | `runViaUds()` tracks `childExited` promise for error reporting. `streamFromUdsSocket()` doesn't track child process state. |
| **Self-cleanup on child exit** | `runViaUds()` has a `child.once("exit", onExit)` handler that cleans up socket and resolves if child exits without sending completion. `streamFromUdsSocket()` uses polling instead. |

---

## 4. What `streamFromUdsSocket()` does that `runViaUds()` doesn't do

| Feature | Description |
|---|---|
| **Connect to pre-existing socket** | `streamFromUdsSocket()` receives a socket path from outside (from `spawnUdsSubagent()`), whereas `runViaUds()` generates its own. |
| **Delayed steer** | `streamFromUdsSocket()` doesn't have an initial steer message built into its flow in the same way — it's already past the spawn, so the prompt arrives as a steer command after connection. |
| **No child process reference** | `streamFromUdsSocket()` has no `child` variable, so it cannot kill or monitor the child process directly. |
| **Uses polling for completion** | `streamFromUdsSocket()` polls every 100ms for the `completed` flag, while `runViaUds()` uses child process exit + message-based completion. |

---

## 5. Extractable Shared Components

### 5.1 Socket Connection Utility
Both functions share the exact same pattern:
1. Poll for socket existence (`accessSync` in a loop)
2. Create TCP connection to socket path
3. Wait for connection with timeout

```typescript
interface SocketConnection {
  client: net.Socket;
  socketPath: string;
}

async function connectToSocket(socketPath: string, pollInterval = 50, pollTimeout = 5000, connectTimeout = 5000): Promise<SocketConnection> {
  // Poll for socket
  // Create connection with timeout
  return { client, socketPath };
}
```

### 5.2 Message Parser / Event Dispatcher
Both functions share the exact same message parsing logic:
1. Line-buffered data handler (accumulate in buffer, split by `\n`)
2. JSON parse each line
3. Handle `ready` handshake
4. `handleChildEvent` switch dispatching to callbacks

```typescript
interface EventCallbacks {
  onTextDelta: (delta: string, fullText: string) => void;
  onToolActivity: (activity: ToolActivity) => void;
  onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number; cost?: number }) => void;
  onCompaction: (info: { reason: string; tokensBefore: number }) => void;
}

interface StreamState {
  responseText: string;
  turnCount: number;
  toolUses: number;
  completed: boolean;
  aborted: boolean;
  error: string | undefined;
  readyReceived: boolean;
}

function wireSocketEvents(
  client: net.Socket,
  callbacks: EventCallbacks,
  state: StreamState,
): { sendCommand: (cmd: Record<string, unknown>) => void; waitForReady: () => Promise<void> }
```

### 5.3 Steer Command Sender
Both functions share the ready-handshake → steer pattern:

```typescript
async function sendSteerCommand(
  client: net.Socket,
  prompt: string,
  readyReceived: boolean,
): Promise<void> { /* same ready-wait logic in both */ }
```

### 5.4 Abort Handler
Both functions share the same abort signal handling:

```typescript
function setupAbortHandler(
  signal: AbortSignal | undefined,
  client: net.Socket,
  onAbort: () => void,
): () => void { /* same pattern */ }
```

### 5.5 Completion Tracker
The `completed`/`aborted`/`error` state machine is shared:

```typescript
interface CompletionTracker {
  completed: boolean;
  aborted: boolean;
  failure: string | undefined;
  promise: Promise<void>;
}
```

---

## 6. Refactoring Options

### Option A: `connectOnly()` Static Method on `UdsAgentRunner`

**Concept**: Add a static `connectOnly(socketPath, callbacks)` method to the `UdsAgentRunner` class (or as a standalone function) that takes a pre-existing socket path and returns a wired connection with all event handlers.

**Pros**:
- Minimal change to `runViaUds()` — just add one new method
- `streamFromUdsSocket()` becomes a thin wrapper: connect → wire → wait
- Clear separation: `runViaUds()` = spawn + connect; `connectOnly()` = connect only
- Both use the same parsing logic, zero duplication

**Cons**:
- `streamFromUdsSocket()` still exists as a separate method in `AgentManager`, which means `AgentManager` still imports and calls `runViaUds` unnecessarily
- The `startViaUds()` path in `AgentManager` would still call `runViaUds()` (spawn + connect), which is fine
- `startViaTmuxUds()` would call `connectOnly()` instead

**Refactored flow**:
```
startViaUds() → runViaUds() (spawn + connect → stream)
startViaTmuxUds() → spawnUdsSubagent() → connectOnly() (connect → stream)
```

**Estimated lines to remove**: ~120 lines from `streamFromUdsSocket()` (replaced by one import + one call)

---

### Option B: Extract Shared Components into `uds-connection.ts`

**Concept**: Create a new module `src/uds-connection.ts` that exports:
- `connectToSocket(socketPath)` — polling + connection
- `wireSocketEvents(client, callbacks)` — data handler + event dispatch
- `sendSteerCommand(client, prompt, readyReceived)` — steer with ready handshake
- `waitForCompletion(state, signal)` — completion tracking

`runViaUds()` imports and uses these. `streamFromUdsSocket()` is eliminated entirely — it's replaced by a call chain using these primitives.

**Pros**:
- Maximum code reuse
- Single source of truth for socket connection, message parsing, event handling
- Each component is independently testable
- `AgentManager` doesn't need to know about `runViaUds` internals

**Cons**:
- More refactoring effort — `runViaUds()` needs to be decomposed
- Creates a new module that becomes a shared dependency
- Some components (like the compile check) are still spawn-specific

**Refactored flow**:
```
startViaUds() → runViaUds() (uses shared connection components internally)
startViaTmuxUds() → spawnUdsSubagent() → use same connection components
```

---

### Option C: Make `streamFromUdsSocket()` the Primary Connection Logic

**Concept**: Flip the dependency. Make `streamFromUdsSocket()` the canonical implementation (since it's already the more generic "connect to existing socket" case). Have `runViaUds()` delegate to `streamFromUdsSocket()` after spawning.

**Pros**:
- `streamFromUdsSocket()` already handles the more general case (pre-existing socket)
- `runViaUds()` becomes: spawn → wait for socket → call `streamFromUdsSocket()`
- Clean delegation pattern

**Cons**:
- `streamFromUdsSocket()` is currently a private method on `AgentManager` — making it the shared logic means it needs to be extracted
- Circular import risk: `uds-agent-runner.ts` would need to import from `agent-manager.ts` (bad)
- Would need to lift `streamFromUdsSocket()` out of `AgentManager` into a utility module

---

### Option D: Two-Level Abstraction — `UdsChildProcess` + `UdsConnection`

**Concept**: Split into two orthogonal abstractions:
1. **`UdsChildProcess`**: Handles spawning, environment building, auto-compile, child tracking
2. **`UdsConnection`**: Handles socket polling, connection, message parsing, event dispatching, completion

`runViaUds()` = `UdsChildProcess.spawn()` → `UdsConnection.connectAndStream()`
`streamFromUdsSocket()` = `UdsConnection.connectAndStream()` (no spawn needed)

**Pros**:
- Clean separation of concerns
- Best testability — connection logic can be tested with mock sockets
- Both paths share 100% of connection/event code

**Cons**:
- Most refactoring effort
- May be overkill for the current codebase size

---

## 7. Decision Trade-offs

| Criterion | Option A: `connectOnly()` | Option B: Extract Components | Option C: Flip Primary | Option D: Two-Level |
|---|---|---|---|---|
| **Effort** | Low (add method) | Medium (new module) | Medium (extract method) | High (new abstractions) |
| **Duplication removal** | ~95% | ~100% | ~100% | ~100% |
| **Testability** | Good | Excellent | Good | Excellent |
| **Circular deps risk** | None | Low (careful design) | High | None |
| **Import simplicity** | Simple one-liner | Moderate | Simple one-liner | Moderate |
| **Future extensibility** | Good | Best | Good | Best |
| **Minimal behavioral change** | ✅ Best | Moderate | Moderate | Moderate |

---

## 8. The "Minor Hack" Explained

The comment in `streamFromUdsSocket()` says:

> "For now, reuse runViaUds but override the socket — this requires a minor hack. Better: create a wrapper that connects to an existing socket."

**What the hack actually is**: `streamFromUdsSocket()` doesn't actually reuse `runViaUds()`. The comment was aspirational — it says "reuse" but the implementation **duplicates** `runViaUds()`'s entire connection and event handling logic inline instead of actually calling it. The "hack" is that:

1. `runViaUds()` internally generates a **new** socket path and spawns a child — it cannot be used as-is because `spawnUdsSubagent()` already generated the socket path and spawned the child.
2. The function cannot simply pass a "pre-existing socket path" parameter to `runViaUds()` because `runViaUds()` hardcodes socket path generation (line 115: `const socketPath = join(SUBAGENT_SOCKET_DIR, `sock-${randomUUID()}`)`) and child spawning.
3. So instead of calling `runViaUds()`, the author copied its connection + event parsing code verbatim into `streamFromUdsSocket()`, creating ~120 lines of duplication.

The "better" solution the comment alludes to is what Option A/B describe: extract the connection/event logic out of `runViaUds()` so it can be called with either a fresh socket (spawn case) or a pre-existing socket (tmux case).

---

## 9. Recommended Approach

### Primary Recommendation: Option A (`connectOnly()` static method)

**Why**: It provides the best balance of effort vs. benefit:

1. **Lowest effort** — just add one new exported function `connectToSocket()` in `uds-agent-runner.ts`
2. **Near-complete deduplication** — `streamFromUdsSocket()` becomes ~20 lines instead of ~150
3. **No new modules** — keeps changes contained in existing files
4. **No circular dependencies** — `uds-agent-runner.ts` already exports helpers, adding one more is natural
5. **Zero behavioral change** — `runViaUds()` keeps its current structure, `startViaTmuxUds()` just calls a different function

### Implementation sketch:

```typescript
// In uds-agent-runner.ts — new exported function

/**
 * Connect to a pre-existing UDS socket and stream events.
 * Unlike runViaUds(), this does NOT spawn a child process.
 * Use when the child is already running (e.g., spawned via tmux).
 */
export async function connectToUdsSocket(
  socketPath: string,
  prompt: string,
  options: {
    onTextDelta?: (delta: string, fullText: string) => void;
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number; cost?: number }) => void;
    onCompaction?: (info: { reason: string; tokensBefore: number }) => void;
    signal?: AbortSignal;
  },
): Promise<UdsRunResult> {
  // ... all the shared logic:
  // 1. Poll for socket (existing polling loop)
  // 2. Connect (existing connection code)
  // 3. Wire events (existing data handler + handleChildEvent)
  // 4. Send steer with ready handshake (existing steer logic)
  // 5. Wait for completion (existing abort + completion logic)
  // 6. Cleanup and return result (existing buildResult)
}
```

Then `streamFromUdsSocket()` becomes:

```typescript
private async streamFromUdsSocket(
  id: string,
  record: AgentRecord,
  socketPath: string,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: SpawnOptions,
  _effectiveCwd: string,
): Promise<UdsRunResult> {
  return connectToUdsSocket(socketPath, prompt, {
    onTextDelta: options.onTextDelta,
    onToolActivity: options.onToolActivity,
    onAssistantUsage: options.onAssistantUsage,
    onCompaction: options.onCompaction,
    signal: options.signal,
  });
}
```

This eliminates **~120 lines** of duplicated code and makes the relationship between the two code paths explicit.

### Optional Future Enhancement: Option B

After Option A lands, if the codebase grows (e.g., more UDS transport variants), Option B's component extraction would naturally follow. The `connectToUdsSocket()` function can be incrementally decomposed into smaller exported utilities without breaking changes, since callers only depend on the top-level function.
