# Issue: Agent Session Resume Does Not Work

## Problem

The `resume` parameter on the `Agent` tool is documented as follows:

> "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other run, so pass run_in_background: false to block and get the result inline. **An agent can only be resumed once its current run has finished** — stop it from /agents → Workflows first."

In practice, **resuming an agent session is not possible** through the tool interface. All attempts return errors indicating the session no longer exists.

## Test Matrix

| Scenario | Method | Result |
|----------|--------|--------|
| Resume after sync completion (by name) | `run_in_background: false`, then `resume: "<name>"` | ❌ `"Agent not found: '<name>'. It may have been cleaned up."` |
| Resume after bg completion (by ID) | `run_in_background: true`, wait for completion, then `resume: "<id>"` | ❌ `"Agent has no active session to resume."` |
| Resume while bg agent is running | `run_in_background: true`, then immediately `resume: "<id>"` | ❌ `"Agent has no active session to resume."` |
| Resume with exact same prompt | Any method | ❌ Same errors |

## Error Messages

1. **`"Agent not found: '<name/id>'. It may have been cleaned up."`**
   - Occurs when trying to resume after a synchronous (`run_in_background: false`) agent completes.
   - The session is cleaned up immediately after completion.

2. **`"Agent '<id>' has no active session to resume."`**
   - Occurs when trying to resume after a background agent completes (either while running or after `get_subagent_result` returns).
   - The session was already cleaned up before the resume was attempted.

## Root Cause

The session cleanup lifecycle appears to be:

```
Agent launched (bg)
  → Agent completes
  → Session cleaned up immediately
  → Resume attempt → "no active session" ❌
```

There is **no window** between completion and cleanup where a resume is possible.

## Documentation Contradiction

The docs state: *"An agent can only be resumed once its current run has finished — stop it from /agents → Workflows first."*

This implies:
1. Let the agent finish its run
2. **Stop** it via `/agents → Workflows` (UI action)
3. Then resume it

However:
- There is **no tool** to stop an agent — only the UI can do this
- Even if the agent is stopped (not let to finish), sessions may still be cleaned up
- The "once its run has finished" clause suggests resuming after completion, but sessions are already gone by then

## Side Notes

During testing, I also observed that agents sometimes complete with **0 tool_uses** and **empty/minimal output** even when given substantive prompts. This appears to be a separate issue with agent execution consistency, though it may be related to how sessions are managed.

Example output files sometimes contain only the user message with no assistant response, indicating the agent never actually produced output.

## Implications

- **No persistent state across invocations**: Agents are stateless. Each launch is a fresh session.
- **No checkpoint/resume workflows**: You cannot pause an agent, make a decision, and resume where it left off.
- **No multi-turn agent conversations**: An agent cannot be split across multiple turns — everything must happen in one continuous run.
- **Workaround needed for long-running tasks**: Must use `run_in_background: true` + `get_subagent_result` (single-shot) or restructure as multiple independent agents.

## Workarounds

### 1. Sequential Independent Agents

Instead of resuming, launch a new agent with a prompt that incorporates the previous agent's result:

```
# Launch agent 1
Agent(prompt="...") → get result

# Pass result to agent 2
Agent(prompt="Continuing from: <previous result>, now do X...") → get result
```

### 2. Shared State via Files

Have the agent write intermediate state to a file:

```python
# In agent 1's prompt: "Write your progress to /path/to/progress.txt"
# In agent 2's prompt: "Read /path/to/progress.txt and continue from there."
```

### 3. SubagentWorkflow for Multi-Step Tasks

Use `SubagentWorkflow` with phased execution, which supports deterministic multi-step orchestration without needing session resume.

## Open Questions

- Is there a hidden API or tool to keep sessions alive after completion?
- Does `SubagentWorkflow` support resuming individual phases?
- Is the session cleanup timing configurable?
- Can the orchestrator request a "checkpoint" before the agent finishes?

## Files Referenced

- Agent tool definition
- `get_subagent_result` tool definition
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (agent documentation)
