/**
 * activity-tracker.ts — Tracks agent activity state and provides callback wiring.
 *
 * Extracted from `index.ts` where `createActivityTracker` was defined inline.
 * Used by both foreground and background spawn paths to avoid duplication.
 */

import type { AgentActivity } from "../ui/agent-widget.js";
import type { LifetimeUsage } from "../usage.js";

/** Callbacks returned by createActivityTracker for wiring into agent spawn options. */
export interface ActivityTrackerCallbacks {
  onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => void;
  onTextDelta: (delta: string, fullText: string) => void;
  onTurnEnd: (turnCount: number) => void;
  onSessionCreated: (session: any) => void;
  onAssistantUsage: (usage: LifetimeUsage) => void;
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 *
 * @param maxTurns - Optional turn limit displayed in the UI.
 * @param onStreamUpdate - Optional callback fired on every state change.
 * @returns State object and callback object for wiring into agent spawn options.
 */
export function createActivityTracker(
  maxTurns?: number,
  onStreamUpdate?: () => void,
): { state: AgentActivity; callbacks: ActivityTrackerCallbacks } {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => {
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}
