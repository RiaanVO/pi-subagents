/**
 * Agent execution handlers — extracted from the execute function in index.ts.
 *
 * Each handler encapsulates one of the four execution paths:
 *   - Schedule: register a job, return immediately
 *   - Resume: look up existing agent, resume bg or fg
 *   - Background spawn: spawn detached, join-mode batching
 *   - Foreground spawn: spawn-and-wait with spinner + streaming
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentActivity, AgentDetails } from "./ui/agent-widget.js";
import type { AgentRecord, AgentInvocation, JoinMode, SubagentType, ThinkingLevel, IsolationMode } from "./types.js";
import { getLifetimeCost, type LifetimeUsage } from "./usage.js";
import {
  formatMs,
  SPINNER,
  type UICtx,
  describeActivity,
  formatCost,
} from "./ui/agent-widget.js";
import { getForegroundOutcomeNote, partialOutputSuffix } from "./status-note.js";
import { streamToOutputFile, writeInitialEntry, createOutputFilePath } from "./output-file.js";
import { resolveJoinMode } from "./invocation-config.js";
import type { SubagentScheduler } from "./schedule.js";

// --- Types for handler context ---

/**
 * Context object passed to each handler. Contains all shared state and
 * helper functions that the handler logic needs.
 *
 * Using `any` for complex types to avoid circular dependency issues
 * and type mismatches between the original code and extracted handlers.
 */
export interface AgentDispatchContext {
  manager: any;
  pi: {
    events: { emit: (event: string, data: unknown) => void };
  };
  widget: {
    ensureTimer: () => void;
    update: () => void;
    markRunning: (id: string) => void;
    markFinished: (id: string) => void;
  };
  fleet: {
    ensureTimer: () => void;
    update: () => void;
    onAgentFinished: (id: string) => void;
  };
  agentActivity: Map<string, AgentActivity>;
  scheduler: SubagentScheduler;
  groupJoin: {
    registerGroup: (groupId: string, ids: string[]) => void;
    onAgentComplete: (record: AgentRecord) => void;
  };
  createActivityTracker: any;
  isSchedulingEnabled: () => boolean;
  isTopLevelAgent: (record: AgentRecord) => boolean;
  defaultJoinMode: JoinMode;
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  batchCounter: number;
  setBatchCounter: (n: number) => void;
  setBatchFinalizeTimer: (t: ReturnType<typeof setTimeout> | undefined) => void;
  finalizeBatch: () => void;
  sendIndividualNudge: (record: AgentRecord) => void;
  startBackgroundResume: (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ) => Promise<AgentRecord | undefined>;
  buildDetails: (
    base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
    record: AgentRecord,
    activity?: AgentActivity,
    overrides?: Partial<AgentDetails>,
  ) => AgentDetails;
  detailBaseFor: (rec: AgentRecord | undefined) => Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">;
  getDisplayName: (type: SubagentType | string) => string;
  getLifetimeCost: (usage: LifetimeUsage) => number;
  formatLifetimeTokens: (o: { lifetimeUsage: LifetimeUsage }) => string;
}

// --- HandleSchedule ---

/**
 * Schedule path: validates params, registers a job with the scheduler,
 * and returns immediately without spawning.
 */
export function handleSchedule(
  params: Record<string, unknown>,
  _ctx: ExtensionContext,
  _signal: AbortSignal | undefined,
  _onUpdate: any,
  ctxObj: AgentDispatchContext,
  fallbackNote: string,
  requestedType: string,
  thinking: ThinkingLevel | undefined,
  effectiveMaxTurns: number | undefined,
  isolated: boolean | undefined,
  isolation: IsolationMode | undefined,
): any {
  const { scheduler, isSchedulingEnabled } = ctxObj;

  if (!isSchedulingEnabled()) {
    return { content: [{ type: "text", text: "Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling." }] };
  }
  if ((params.resume as string | undefined)) {
    return { content: [{ type: "text", text: "Cannot combine `schedule` with `resume` — schedules create fresh agents." }] };
  }
  if ((params.inherit_context as boolean | undefined)) {
    return { content: [{ type: "text", text: "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time." }] };
  }
  if ((params.run_in_background as boolean | undefined) === false) {
    return { content: [{ type: "text", text: "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background." }] };
  }
  if (!scheduler.isActive()) {
    return { content: [{ type: "text", text: "Scheduler is not active in this session yet. Try again after the session has fully started." }] };
  }

  try {
    const job = scheduler.addJob({
      name: params.description as string,
      description: params.description as string,
      schedule: params.schedule as string,
      subagent_type: requestedType,
      prompt: params.prompt as string,
      model: params.model as string | undefined,
      thinking: thinking,
      max_turns: effectiveMaxTurns,
      isolated: isolated,
      isolation: isolation,
    });
    const next = scheduler.getNextRun(job.id);
    return {
      content: [{
        type: "text",
        text: `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). Next run: ${next ?? "(unknown)"}. Manage via /agents → Scheduled jobs.`,
      }],
    };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

// --- HandleResume ---

/**
 * Resume path: looks up an existing agent by ID, then either resumes it
 * in background (detached) or foreground (blocking).
 */
export async function handleResume(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  _onUpdate: any,
  ctxObj: AgentDispatchContext,
  fallbackNote: string,
  toolCallId: string | undefined,
  outputTranscript: boolean,
  effectiveMaxTurns: number | undefined,
): Promise<any> {
  const { manager, agentActivity, widget, fleet, startBackgroundResume, buildDetails, detailBaseFor, isTopLevelAgent, getDisplayName, defaultJoinMode, currentBatchAgents, batchFinalizeTimer, setBatchFinalizeTimer, finalizeBatch } = ctxObj;

  const existing = manager.getRecord(params.resume as string);
  if (!existing || !isTopLevelAgent(existing)) {
    return { content: [{ type: "text", text: `Agent not found: "${params.resume}". It may have been cleaned up.` }] };
  }
  if (!existing.session) {
    return { content: [{ type: "text", text: `Agent "${params.resume}" has no active session to resume.` }] };
  }

  const runInBackground = (params.run_in_background as boolean) !== false;

  // Background resume: detached run that notifies on completion
  if (runInBackground) {
    const id = existing.id;
    if (existing.status === "running" || existing.status === "queued") {
      return {
        content: [{
          type: "text",
          text: `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\nUse steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
        }],
      };
    }

    const record = await startBackgroundResume(ctx, existing, params.prompt as string, {
      outputTranscript,
      maxTurns: effectiveMaxTurns,
      toolCallId,
    });
    if (!record) {
      return { content: [{ type: "text", text: `Failed to resume agent "${params.resume}".` }] };
    }

    const isQueued = record.status === "queued";
    return {
      content: [{
        type: "text",
        text: `Agent ${isQueued ? "queued" : "resumed"} in background.\nAgent ID: ${id}\nType: ${existing.type}\n${record.outputFile ? `Output file: ${record.outputFile}\n` : ""}\n${isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : ""}\nYou will be notified when this agent completes.\nUse get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
      }],
      details: { ...detailBaseFor(record), toolUses: record.toolUses, tokens: "", cost: 0, durationMs: 0, status: "background" as const, agentId: id },
    };
  }

  // Foreground resume: blocking
  const record = await manager.resume(params.resume as string, params.prompt as string, signal);
  if (!record) {
    return { content: [{ type: "text", text: `Failed to resume agent "${params.resume}".` }] };
  }
  if (record.status === "error") {
    return {
      content: [{ type: "text", text: `Agent failed: ${record.error}${partialOutputSuffix(record)}` }],
      details: buildDetails(detailBaseFor(record), record),
    };
  }
  return {
    content: [{ type: "text", text: record.result?.trim() || "No output." }],
    details: buildDetails(detailBaseFor(record), record),
  };
}

// --- HandleBackgroundSpawn ---

/**
 * Background spawn path: spawns an agent in the background, wires up
 * activity tracking, join-mode batching, and returns immediately.
 */
export async function handleBackgroundSpawn(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  _signal: AbortSignal | undefined,
  _onUpdate: any,
  ctxObj: AgentDispatchContext,
  fallbackNote: string,
  toolCallId: string | undefined,
  subagentType: SubagentType,
  model: any,
  effectiveMaxTurns: number | undefined,
  isolated: boolean | undefined,
  inheritContext: boolean | undefined,
  thinking: ThinkingLevel | undefined,
  isolation: IsolationMode | undefined,
  transport: string | undefined,
  tmuxEnabled: boolean,
  agentInvocation: AgentInvocation,
  outputTranscript: boolean,
): Promise<any> {
  const { manager, pi, widget, fleet, agentActivity, createActivityTracker, defaultJoinMode, currentBatchAgents, batchFinalizeTimer, setBatchFinalizeTimer, finalizeBatch, detailBaseFor, getDisplayName } = ctxObj;

  const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

  // Wrap onSessionCreated to wire output file streaming.
  let id: string;
  const origBgOnSession = bgCallbacks.onSessionCreated;
  bgCallbacks.onSessionCreated = (session: any) => {
    origBgOnSession(session);
    const rec = manager.getRecord(id);
    if (rec?.outputFile) {
      rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
    }
  };

  // A throw here means the agent never started. Let it out.
  id = manager.spawn(pi, ctx, subagentType, params.prompt as string, {
    description: params.description as string,
    name: (params.name as string | undefined),
    model,
    maxTurns: effectiveMaxTurns,
    isolated,
    inheritContext,
    thinkingLevel: thinking,
    isBackground: true,
    isolation,
    transport,
    tmuxEnabled,
    invocation: agentInvocation,
    rootSessionId: ctx.sessionManager.getSessionId(),
    ...bgCallbacks,
  });

  // Set output file + join mode synchronously after spawn, before the
  // event loop yields — onSessionCreated is async so this is safe.
  const joinMode = resolveJoinMode(defaultJoinMode, true);
  const record = manager.getRecord(id);
  if (record && joinMode) {
    record.joinMode = joinMode;
    record.toolCallId = toolCallId;
    // attachTranscript inline
    if (record && outputTranscript) {
      record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      writeInitialEntry(record.outputFile, id, params.prompt as string, ctx.cwd);
    }
  }

  // Wait for startup (important for isolation)
  await manager.awaitStartup(id);

  if (joinMode == null || joinMode === 'async') {
    // Foreground/no join mode or explicit async — not part of any batch
  } else {
    // smart or group — add to current batch
    currentBatchAgents.push({ id, joinMode });
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    setBatchFinalizeTimer(setTimeout(finalizeBatch, 100));
  }

  agentActivity.set(id, bgState);
  widget.ensureTimer();
  widget.update();
  fleet.ensureTimer();
  fleet.update();

  // Emit created event
  pi.events.emit("subagents:created", {
    id,
    type: subagentType,
    description: params.description as string,
    isBackground: true,
  });

  const isQueued = record?.status === "queued";
  return {
    content: [{
      type: "text",
      text: `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\nAgent ID: ${id}\nType: ${getDisplayName(subagentType)}\nDescription: ${params.description}\n${record?.outputFile ? `Output file: ${record.outputFile}\n` : ""}${isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : ""}\nYou will be notified when this agent completes.\nUse get_subagent_result to retrieve full results, or steer_subagent to send it messages.\nDo not duplicate this agent's work.`,
    }],
    details: { ...detailBaseFor(record), toolUses: 0, tokens: "", cost: 0, durationMs: 0, status: "background" as const, agentId: id },
  };
}

// --- HandleForegroundSpawn ---

/**
 * Foreground spawn path: spawns an agent and waits for completion,
 * with spinner animation, streaming progress updates, and activity tracking.
 */
export async function handleForegroundSpawn(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctxObj: AgentDispatchContext,
  fallbackNote: string,
  subagentType: SubagentType,
  model: any,
  effectiveMaxTurns: number | undefined,
  isolated: boolean | undefined,
  inheritContext: boolean | undefined,
  thinking: ThinkingLevel | undefined,
  isolation: IsolationMode | undefined,
  transport: string | undefined,
  agentInvocation: AgentInvocation,
  outputTranscript: boolean,
  showCost: boolean,
): Promise<any> {
  const { manager, pi, widget, fleet, agentActivity, createActivityTracker, buildDetails, detailBaseFor, getLifetimeCost, formatLifetimeTokens } = ctxObj;

  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;
  let queuedAhead: number | undefined;

  // Stream update function — closes over local vars for the spinner/timer.
  const streamUpdate = () => {
    const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
    const details: AgentDetails = {
      ...detailBaseFor(fgRecord),
      toolUses: fgState.toolUses,
      tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
      cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
      turnCount: fgState.turnCount,
      maxTurns: fgState.maxTurns,
      durationMs: Date.now() - startedAt,
      status: "running",
      activity: queuedAhead === undefined
        ? describeActivity(fgState.activeTools, fgState.responseText)
        : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
      spinnerFrame: spinnerFrame % SPINNER.length,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
      details: details as any,
    });
  };

  const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

  // Wire session creation: register in widget + stream to output file.
  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session: any) => {
    origOnSession(session);
    // It really started — stop reporting it as queued, and repaint now
    // rather than leaving the stale line up for the next spinner tick.
    if (queuedAhead !== undefined) {
      queuedAhead = undefined;
      streamUpdate();
    }
    for (const a of manager.listAgents()) {
      if (a.session === session) {
        fgId = a.id;
        agentActivity.set(a.id, fgState);
        widget.ensureTimer();
        fleet.ensureTimer();
        fleet.update();
        break;
      }
    }
    if (fgId) {
      const rec = manager.getRecord(fgId);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
      }
    }
  };

  // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: AgentRecord;
  try {
    const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt as string, {
      description: params.description as string,
      name: (params.name as string | undefined),
      model,
      maxTurns: effectiveMaxTurns,
      isolated,
      inheritContext,
      thinkingLevel: thinking,
      isolation,
      transport,
      invocation: agentInvocation,
      signal,
      rootSessionId: ctx.sessionManager.getSessionId(),
      onQueued: (_id: string, ahead: number) => { queuedAhead = ahead; streamUpdate(); },
      ...fgCallbacks,
    }, (fgAgentId: string) => {
      const fgRec = manager.getRecord(fgAgentId);
      if (fgRec && outputTranscript) {
        fgRec.outputFile = createOutputFilePath(ctx.cwd, fgAgentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(fgRec.outputFile, fgAgentId, params.prompt as string, ctx.cwd);
      }
    });
    record = fgResult.record;
  } finally {
    clearInterval(spinnerInterval);
    if (fgId) {
      agentActivity.delete(fgId);
      widget.markFinished(fgId);
      fleet.onAgentFinished(fgId);
    }
  }

  const tokenText = formatLifetimeTokens(record);
  const details = buildDetails(detailBaseFor(record), record, fgState, { tokens: tokenText });

  if (record.status === "error") {
    return {
      content: [{ type: "text", text: `${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}` }],
      details,
    };
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  if (showCost) {
    const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
    if (costText) statsParts.push(costText);
  }
  return {
    content: [{
      type: "text",
      text: `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n${record.result?.trim() || "No output."}`,
    }],
    details,
  };
}
