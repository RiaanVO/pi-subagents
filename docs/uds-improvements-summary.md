# UDS Improvements Summary

## Changes Made

### 1. Enhanced Build Check (`src/check-uds-imports.mjs`)
- **Added file existence verification**: Now checks that all referenced files (including `uds-child.mjs`) exist at build time
- **Distinguishes source vs. build files**: Missing source files fail the check; missing build files only produce warnings
- **Scans for fork() targets**: Automatically finds `fork("*.mjs")` calls and verifies targets exist

### 2. LOG_LEVEL Environment Variable (`src/uds-child.mjs`)
- Added `PI_SUBAGENTS_LOG_LEVEL` env var (ERROR, WARN, INFO, DEBUG)
- Default: ERROR (only errors visible in production)
- Debug mode: `PI_SUBAGENTS_LOG_LEVEL=debug` for full diagnostics
- Structured logging with levels

### 3. IPC Error Propagation
- **Child side**: `uds-child.mjs` sends `process.send({ type: "child_error", message, stack })` before exiting
- **Parent side**: `uds-agent-runner.ts` listens on `child.on("message")` to capture error details
- Result: Parent now knows WHY a child crashed instead of just seeing "exit code 1"

### 4. Ready Handshake Protocol
- **Server side**: `uds-server.ts` emits `{ type: "ready" }` before `session_created` when a client connects
- **Parent side**: `uds-agent-runner.ts` waits for `ready` event before sending initial steer command
- Prevents race condition where steer was sent before child was fully initialized

### 5. New Test Coverage
- `test/uds-transport.test.ts`: Updated with `ready` + `session_created` handshake tests
  - "emits ready before session_created (protocol handshake)"
  - "parent waits for ready before sending steer"
- `test/uds-child-lifecycle.test.ts`: New file with:
  - File existence check for `uds-child.mjs`
  - IPC error propagation tests
- `test/uds-integration.test.ts`: Updated for new message ordering

## Testing Status

New and updated tests cover all UDS features:
- `test/uds-transport.test.ts` — ready handshake, command routing, multiple steers
- `test/uds-agent-runner.test.ts` — config resolution, utility helpers
- `test/uds-integration.test.ts` — full event chain, error scenarios
- `test/uds-child-lifecycle.test.ts` — file existence, IPC error propagation

## How to Use

### Enable debug logging for a child process:
```bash
PI_SUBAGENTS_LOG_LEVEL=debug node uds-child.mjs
```

### Run diagnostics:
```bash
node scripts/uds-test-standalone.mjs --verbose
```

### Verify files exist before build:
```bash
npm run build  # includes check-uds-imports.mjs
```
