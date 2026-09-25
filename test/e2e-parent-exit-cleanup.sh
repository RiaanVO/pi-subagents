#!/usr/bin/env bash
# e2e-parent-exit-cleanup.sh
#
# End-to-end test for the parent-exit-cleanup feature.
#
# Verifies that when pi shuts down cleanly (via /quit), the pi-subagents
# tmux session and all subagent windows are cleaned up by the extension's
# session_shutdown handler → cleanupTmuxOnExit().
#
# Usage: bash test/e2e-parent-exit-cleanup.sh
# Exit 0 = pass, Exit 1 = fail

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
SESSION="pi-subagents"
PI_SOCKET="/tmp/tmux-e2e-pi"
PI_BIN="/opt/homebrew/bin/pi"
TMUX_BIN="/opt/homebrew/bin/tmux"
DEFAULT_SOCKET="/private/tmp/tmux-501/default"
DEFAULT_SOCKET_DIR="$(dirname "$DEFAULT_SOCKET")"
LOG_FILE="$HOME/.pi/subagents/e2e-cleanup.log"
PASS=0
FAIL=0

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() {
  local msg="[$(date +%H:%M:%S.%3N)] $1: $2"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

pass() { ((PASS++)); log "PASS" "$1"; }
fail() { ((FAIL++)); log "FAIL" "$1"; }

# ─── Phase 0: Cleanup ────────────────────────────────────────────────────────

log "INFO" "=========================================="
log "INFO" "E2E Test: Parent Exit Cleanup"
log "INFO" "=========================================="

# Kill any existing sessions
$TMUX_BIN kill-session -t "$SESSION" 2>/dev/null || true
$TMUX_BIN -S "$PI_SOCKET" kill-server 2>/dev/null || true

# Clean up socket directory
rm -f "$DEFAULT_SOCKET" 2>/dev/null || true
mkdir -p "$DEFAULT_SOCKET_DIR" 2>/dev/null || true

# Ensure default socket directory exists (no symlink — use real path)
mkdir -p "$DEFAULT_SOCKET_DIR" 2>/dev/null || true
rm -f "$DEFAULT_SOCKET" 2>/dev/null || true

log "INFO" "Phase 0: Cleanup complete"

# ─── Phase 1: Create test windows ────────────────────────────────────────────

log "INFO" "Phase 1: Creating test tmux windows..."

# Create the pi-subagents session on the DEFAULT socket
$TMUX_BIN new-session -d -s "$SESSION" -x 200 -y 50 -n "dashboard" "sleep 3600"

# Create test subagent windows
for i in 1 2 3; do
  case $i in
    1) name="explore-${i}";;
    2) name="audit-${i}";;
    3) name="general-${i}";;
  esac
  $TMUX_BIN new-window -t "$SESSION" -n "$name" "sleep 3600"
done

# Verify
WINDOWS=$($TMUX_BIN list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null)
WINDOW_COUNT=$(echo "$WINDOWS" | grep -cv '^dashboard$' || true)

if [ "$WINDOW_COUNT" -eq 3 ]; then
  pass "Created $WINDOW_COUNT test windows: $(echo $WINDOWS | tr '\n' ', ')"
else
  fail "Expected 3 test windows, found $WINDOW_COUNT"
fi

# ─── Phase 2: Run pi and trigger /quit ───────────────────────────────────────

log "INFO" "Phase 2: Starting pi in tmux..."

# Start pi on a SEPARATE tmux server
$TMUX_BIN -S "$PI_SOCKET" new-session -d -s pi -x 200 -y 50 -n "pi" "pi 'hi'"

# Wait for pi to be ready by polling pane content
READY=0
TIMEOUT=30
for ((i=0; i<TIMEOUT; i++)); do
  sleep 1
  OUTPUT=$($TMUX_BIN -S "$PI_SOCKET" capture-pane -t pi -p 2>/dev/null || true)
  if echo "$OUTPUT" | grep -q "How can I help"; then
    READY=1
    log "INFO" "Pi is ready after $((i+1))s"
    break
  fi
done

if [ "$READY" -eq 0 ]; then
  fail "Pi did not become ready within ${TIMEOUT}s"
  log "INFO" "Pane output (last 200 chars):"
  $TMUX_BIN -S "$PI_SOCKET" capture-pane -t pi -p 2>/dev/null | tail -5 | while read -r line; do log "INFO" "  $line"; done
  # Try to send /quit anyway
  $TMUX_BIN -S "$PI_SOCKET" send-keys -t pi '/quit' C-m 2>/dev/null || true
  sleep 5
fi

# Send /quit to trigger session_shutdown
log "INFO" "Sending /quit..."
$TMUX_BIN -S "$PI_SOCKET" send-keys -t pi '/quit' C-m

# Wait for pi to exit and cleanup to complete
sleep 15

# ─── Phase 3: Verify cleanup ─────────────────────────────────────────────────

log "INFO" "Phase 3: Verifying cleanup..."

# Check if the pi-subagents session still exists
if $TMUX_BIN has-session -t "$SESSION" 2>/dev/null; then
  REMAINING=$($TMUX_BIN list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null || echo "unknown")
  fail "Session '${SESSION}' still exists with windows: $REMAINING"
else
  pass "Session '${SESSION}' was cleaned up"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

log "INFO" "=========================================="
log "INFO" "RESULTS: $PASS passed, $FAIL failed"
log "INFO" "=========================================="

# Clean up
$TMUX_BIN -S "$PI_SOCKET" kill-server 2>/dev/null || true
rm -f "$DEFAULT_SOCKET" 2>/dev/null || true

if [ "$FAIL" -gt 0 ]; then
  log "INFO" "✗ E2E test FAILED"
  exit 1
else
  log "INFO" "✓ E2E test PASSED"
  exit 0
fi
