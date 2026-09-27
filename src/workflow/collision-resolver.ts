/**
 * collision-resolver.ts — acting on a collision verdict.
 *
 * `decideWorkflowCollision` (in `collisions.ts`) does the pure policy work.
 * This module owns the host-facing side: reading the registry, warning the
 * user, and removing our tool from the active set.
 *
 * The `collisionsChecked` flag lives at the call site (index.ts) as a simple
 * one-shot guard — the flag itself is incidental plumbing.
 */

import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import type { RegisteredToolInfo } from "./collisions.js";
import { decideWorkflowCollision } from "./collisions.js";

export interface CollisionResolverDeps {
  /** Mutable one-shot guard. Set to true after the first check. */
  collisionsCheckedRef: { value: boolean };
  /** Whether workflows are currently enabled (may be false from a prior collision). */
  isWorkflowsEnabled: () => boolean;
  /** Whether the user explicitly pinned workflows on. */
  isWorkflowsPinned: () => boolean;
  /** The full tool list as registered in the pi host. */
  getAllTools: () => readonly RegisteredToolInfo[];
  /** Our tool's description — used to distinguish our registration from others. */
  ownDescription: string;
  /** Currently active tool names. */
  getActiveTools: () => string[];
  /** Replace the active tool set. */
  setActiveTools: (tools: string[]) => void;
  /** Warn the user (UI or console). */
  warn: (message: string) => void;
  /** Called when we decide to stand down: disable workflows and refresh UI. */
  onStandDown: () => void;
}

/**
 * Resolve a workflow collision.
 *
 * Best-effort and swallowed — a diagnostic that took the session down would be
 * worse than the collision it reports.
 */
export function resolveWorkflowCollisions(deps: CollisionResolverDeps): void {
  if (deps.collisionsCheckedRef.value) return;
  deps.collisionsCheckedRef.value = true;

  try {
    if (!deps.isWorkflowsEnabled()) return;

    const verdict = decideWorkflowCollision({
      tools: deps.getAllTools(),
      ownDescription: deps.ownDescription,
      pinned: deps.isWorkflowsPinned(),
    });
    if (verdict.kind === "none") return;
    if (verdict.kind === "report") {
      deps.warn(verdict.message);
      return;
    }

    deps.onStandDown();
    deps.warn(verdict.message);

    if (!verdict.withdraw) return;
    const active = deps.getActiveTools();
    if (active.includes(SUBAGENT_TOOL_NAMES.WORKFLOW)) {
      deps.setActiveTools(active.filter(name => name !== SUBAGENT_TOOL_NAMES.WORKFLOW));
    }
  } catch {
    // getAllTools/setActiveTools are unavailable in some hosts (print mode,
    // RPC). Not being able to check is not a reason to fail the session.
  }
}
