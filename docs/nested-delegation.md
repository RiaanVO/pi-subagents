# Nested Subagent Delegation

A subagent can spawn its own child agents — and retrieve their results — forming
a delegation tree rather than a flat fan-out.

> ⚠️ **Opt-in only.** Nested delegation is **disabled by default**.
> An agent file must set `allowed_subagents` in its frontmatter to unlock the
> nested tools. See [Opting in](#opting-in) for details.

## How it works

Add `allowed_subagents` to your agent's `.md` frontmatter:

| Value | Effect |
|---|---|
| *(omitted or `undefined`)* | No nested tools — the subagent **cannot** spawn children at all |
| `"all"` | Any **enabled** agent type is available to the child |
| `["type1", "type2"]` | Only the listed agent types (narrow allowlist) |

```yaml
---
description: "Task coordinator that delegates subtasks"
tools: read, bash, grep
allowed_subagents: "all"
---
You are a coordinator. Delegate work to child agents and synthesize their results.
```

```yaml
---
description: "Specialized reviewer"
tools: read, grep
allowed_subagents: ["reviewer", "validator"]
---
You can delegate to reviewers and validators only.
```

When `allowed_subagents` is set, the subagent receives **three extra tools**
beyond the usual subagent tool set:

| Tool | Purpose |
|---|---|
| `Agent` | Spawn a child-safe nested subagent (same params as the top-level tool) |
| `get_subagent_result` | Poll or wait for a background child's result |
| `steer_subagent` | Send mid-run guidance to a running child |

Without these tools, a subagent can spawn children but has **no way to retrieve
their results** — the old limitation documented in `issues/nested-agent-delegation.md`.

## Ownership scoping

Children can only access, poll, resume, and steer agents **they themselves
spawned**. They cannot see into other parents' children:

```
Parent A                    Parent B
├── child-1 (has tools)     ├── child-3 (has tools)
│   └── grandchild-1        │   └── grandchild-2
│       ← can read own      │       ← can read own
│         grandchildren     │         grandchildren
│       ← CANNOT access     │       ← CANNOT access
│         child-2 or        │         child-4 or
│         grandchild-2      │         grandchild-1
└── child-2                 └── child-4
```

If a child tries to access an agent owned by another parent:

```
Error: Nested agent not found or not owned by this parent: "child-3".
```

## Depth limits

Nesting respects `maxSubagentDepth` from your `subagents.json` settings
(default: **2**).

```json
{
  "maxSubagentDepth": 2
}
```

| Depth | Who it is |
|---|---|
| 0 | Top-level subagent (spawned by the user) |
| 1 | Child of the top-level subagent |
| 2 | Grandchild — maximum by default |

Set `maxSubagentDepth: 0` or `1` to disable nested delegation entirely.
The depth is enforced at spawn time — a call that would exceed it returns an
error:

```
Nested subagent call blocked (depth=2, max=2). Complete the task directly.
```

The cap is per-branch, so deeper branches in a fan-out do not consume the
budget of shallower ones.

## The fan-out → wait → fan-in pattern

The most common use case for nested delegation is orchestrating parallel children,
waiting for all of them, and synthesizing their results.

### Foreground children (inline results)

By default, nested spawns are **foreground** — the call blocks and returns the
child's result inline:

```yaml
---
description: "Research coordinator"
allowed_subagents: ["researcher"]
---
Synthesize the research findings.
```

The agent code (from the model's perspective):

```
1. Spawn child A (foreground, blocks until done)
2. Spawn child B (foreground, blocks until done)
3. Spawn child C (foreground, blocks until done)
4. Synthesize A's, B's, and C's results
```

```
Agent(type="researcher", prompt="Research X...", description="research X")
→ "Researcher found: X details..."

Agent(type="researcher", prompt="Research Y...", description="research Y")
→ "Researcher found: Y details..."

Agent(type="researcher", prompt="Research Z...", description="research Z")
→ "Researcher found: Z details..."

Final answer: synthesizing all three findings...
```

### Background children (parallel, polled)

For truly parallel execution — the parent continues while children run — use
`run_in_background: true` and poll with `get_subagent_result`:

```yaml
---
description: "Parallel coordinator"
allowed_subagents: ["worker"]
---
Delegate tasks to multiple workers in parallel.
```

The agent code:

```
1. Spawn child A as background → gets "worker-1"
2. Spawn child B as background → gets "worker-2"
3. Spawn child C as background → gets "worker-3"
4. get_subagent_result("worker-1", wait=true)
5. get_subagent_result("worker-2", wait=true)
6. get_subagent_result("worker-3", wait=true)
7. Synthesize results
```

### Complete fan-out → fan-in example

Here is what a full delegation tree might look like, with depth 2:

```
User
 └── Coordinator (depth 1, allowed_subagents: "all")
      ├── Researcher → gathers market data (depth 2)
      ├── Analyst   → analyzes competitors    (depth 2)
      └── Writer    → drafts the report       (depth 2)
```

The coordinator agent reads something like:

```
1. spawnAndWait(Researcher, "Research current market trends...")
2. spawnAndWait(Analyst,   "Analyze top 5 competitors...")
3. spawnAndWait(Writer,    "Draft report from findings...")
4. Return the synthesized report
```

Each of the depth-2 agents has the usual subagent tools but **no nested tools**
(unless they also set `allowed_subagents`), because the default depth limit is 2.

## Steering running children

`steer_subagent` lets you push new instructions to a child that is still running:

```
1. Spawn Worker A in background → "worker-a"
2. steer_subagent("worker-a", "Focus on security issues first.")
3. spawnAndWait(Worker B, "Review codebase...")
4. get_subagent_result("worker-a", wait=true)
5. Synthesize both results
```

Steering messages sent before the child's session is ready are **queued** and
applied once the session starts. If the child has already finished, the call
returns an error.

## Background children and resource attribution

When a background child completes, its token usage (input, output, cache writes)
is **propagated up the entire ancestor chain** — not just to the immediate
parent. A grandchild's spend is attributed to its parent and grandparent
alike, so each level's record shows its total cost including descendants.

Nested children also stream their output to an **output transcript** file
under the root session's `tasks/` directory. A child's own `output_transcript`
frontmatter takes precedence over the project default.

## Types of agents at depth 2

Since `maxSubagentDepth` defaults to 2, agents at depth 2 can only be leaf
workers — they complete the delegated task and return. They cannot further
delegate unless:

- The user sets `maxSubagentDepth: 3` or higher, **and**
- The depth-2 agent also has `allowed_subagents` set

This keeps the default behavior flat (user → subagent → leaf) while allowing
deeper trees when needed.

## Agent config fields

From `src/types.ts` (`AgentConfig.allowedSubagents`):

```typescript
/**
 * Nested delegation, off by default: undefined = no nested tools;
 * "all" = any enabled agent; string[] = only those agent types.
 */
allowedSubagents?: "all" | string[];
```

From `src/nested-tools.ts` (`NestedToolContext`):

```typescript
interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  /** "all" = any enabled agent; string[] = only those types. Never empty. */
  allowedSubagents: "all" | string[];
  configCwd: string;
}
```

The three nested tools are built by `createNestedSubagentTools()`, scoped so
each child only sees its own grandchildren via the `ownsRecord()` guard.
