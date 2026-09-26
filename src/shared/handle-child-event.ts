/**
 * handle-child-event.ts — Shared handler for child process events.
 *
 * Extracted from `uds-agent-runner.ts` where it was duplicated
 * between `runViaUds()` and `connectToUdsSocket()` as exact copy-paste.
 */

import type { ToolActivity } from "../agent-runner.js";
import type { LifetimeUsage } from "../usage.js";

/**
 * Child message types — re-exported here so callers don't need to
 * import from uds-agent-runner.ts.
 */
export interface ChildMessage {
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

/**
 * Shared callbacks for the handleChildEvent handler.
 * Matches the callback signatures used across the UDS runner.
 */
export interface ChildEventCallbacks {
  onTextDelta?: (delta: string, fullText: string) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number; cost?: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

/**
 * Mutable state that the handleChildEvent handler updates.
 */
export interface ChildEventState {
  responseText: string;
  turnCount: number;
  completed: boolean;
  aborted: boolean;
  error: string | undefined;
}

/**
 * Handle events from a child process, updating state and firing callbacks.
 *
 * This is the deduplicated handler extracted from both `runViaUds()`
 * and `connectToUdsSocket()` in `uds-agent-runner.ts`.
 *
 * @param msg - The parsed child message.
 * @param callbacks - Callbacks fired for text deltas, tool activity, usage, and compaction.
 * @param state - Mutable state object updated by the handler.
 */
export function handleChildEvent(
  msg: ChildMessage,
  callbacks: ChildEventCallbacks,
  state: ChildEventState,
): void {
  switch (msg.type) {
    case "turn_start": {
      state.turnCount++;
      break;
    }

    case "turn_end": {
      // turn_end may carry a final turnCount
      if (msg.turnCount != null) state.turnCount = msg.turnCount;
      break;
    }

    case "text_delta": {
      state.responseText += msg.delta as string;
      callbacks.onTextDelta?.(msg.delta as string, state.responseText);
      break;
    }

    case "tool_execution_start": {
      callbacks.onToolActivity?.({ type: "start", toolName: msg.toolName as string });
      break;
    }

    case "tool_execution_end": {
      callbacks.onToolActivity?.({ type: "end", toolName: msg.toolName as string });
      break;
    }

    case "message_end": {
      const usage = msg.usage;
      if (usage) {
        callbacks.onAssistantUsage?.({
          input: usage.input,
          output: usage.output,
          cacheWrite: usage.cacheWrite ?? 0,
          cost: usage.cost,
        });
      }
      break;
    }

    case "compaction": {
      callbacks.onCompaction?.({
        reason: (msg.reason as "manual" | "threshold" | "overflow") ?? "threshold",
        tokensBefore: msg.tokensBefore ?? 0,
      });
      break;
    }

    case "completed": {
      state.completed = true;
      if (msg.result != null && msg.result !== "") {
        state.responseText = msg.result as string;
      }
      break;
    }

    case "aborted": {
      state.aborted = true;
      state.completed = true;
      break;
    }

    case "error": {
      state.error = msg.message;
      state.completed = true;
      break;
    }

    default:
      // Unknown message type — ignore
      break;
  }
}
