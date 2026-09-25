/**
 * uds-server.ts — Unix Domain Socket (UDS) server for bidirectional
 * communication between the parent orchestrator and a child pi agent session.
 *
 * - Binds a single Unix socket at a given path.
 * - Accepts exactly one connection.
 * - Subscribes to an AgentSession's event stream and serialises events as
 *   newline-delimited JSON over the socket.
 * - Reads commands from the client and routes them to the session methods.
 */

import fs from "node:fs";
import net from "node:net";
import type { ImageContent, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/* ──────────────────────────────────────────────────────────────────────
 *  Types
 * ────────────────────────────────────────────────────────────────────── */

/** Event payload that is sent over the socket. */
interface UdsEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

/** Partial UdsEvent for initial construction before seq/type are added. */
interface UdsEventPartial {
  type?: string;
  [key: string]: unknown;
}

/** Commands the parent sends to the child over the socket. */
interface UdsCommand {
  type: string;
  [key: string]: unknown;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Helpers
 * ────────────────────────────────────────────────────────────────────── */

let seq = 0;
function nextSeq(): number { return ++seq; }

/**
 * Write a JSON object as a line to the socket (newline-delimited).
 * Silently ignores errors — the parent has disconnected.
 */
function sendLine(sock: net.Socket, obj: unknown): void {
  try {
    const line = JSON.stringify(obj) + "\n";
    sock.write(line, "utf-8");
  } catch {
    // Socket is gone; ignore.
  }
}

/**
 * Send a UDS event line to the connected client.
 * Only fires if a connection is active.
 */
function emitEvent(sock: net.Socket | null, event: UdsEventPartial): void {
  if (sock && !sock.destroyed) {
    sendLine(sock, event);
  }
}

/* ──────────────────────────────────────────────────────────────────────
 *  UdsServer
 * ────────────────────────────────────────────────────────────────────── */

export class UdsServer {
  private _socketPath: string;
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private session: AgentSession | null = null;

  /** The socket path on the filesystem. */
  get socketPath(): string { return this._socketPath; }

  constructor(socketPath: string) {
    this._socketPath = socketPath;
  }

  /* ── start(session) ─────────────────────────────────────────────── */

  /**
   * Bind the socket, accept one connection, and wire up event streaming
   * + command routing for the given session.
   *
   * Protocol handshake:
   *   1. Client connects
   *   2. Server emits { type: "ready" } (all subscriptions active)
   *   3. Client may now send commands safely
   *   4. Server emits { type: "session_created", status: "active" }
   */
  start(session: AgentSession): Promise<void> {
    this.session = session;

    return new Promise((resolve, reject) => {
      // Clean up any stale socket file first.
      try { fs.unlinkSync(this._socketPath); } catch { /* ignore */ }

      this.server = net.createServer((client) => {
        if (this.client) {
          // Already have a connection; refuse the second.
          client.end("Only one connection allowed\n");
          return;
        }
        this.client = client;
        client.on("error", (err) => this.emitError(`socket error: ${err.message}`));
        client.on("close", () => {
          // Send disconnected event while the socket is still usable.
          emitEvent(this.client, { seq: nextSeq(), type: "disconnected" });
          this.client = null;
        });

        // ---------- command handler ----------
        let buf = "";
        client.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf-8");
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const cmd: UdsCommand = JSON.parse(trimmed);
              this.routeCommand(cmd);
            } catch (err: unknown) {
              this.emitError(`parse error: ${(err as Error).message}`);
            }
          }
        });

        // ---------- ready handshake: emit AFTER all subscriptions are set up ----------
        // This tells the parent that the child is fully initialized and ready
        // to receive commands. The parent should wait for this before sending steer.
        this.sendEvent({ type: "ready" });

        // ---------- subscribe to session events ----------
        this.sendEvent({ type: "session_created", status: "active" });

        // Track turn count for turn_end events.
        let turnCount = 0;
        let currentMessageText = "";
        let turnCountAtMessageStart = 0;

        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          switch (event.type) {
            case "turn_end": {
              turnCount++;
              emitEvent(this.client, {
                seq: nextSeq(),
                type: "turn_end",
                turnCount,
              });
              break;
            }

            case "message_start":
              currentMessageText = "";
              turnCountAtMessageStart = turnCount;
              emitEvent(this.client, {
                seq: nextSeq(),
                type: "message_start",
                turnCount,
                turnCountAtMessageStart,
                messageId: (event as any).messageId,
                role: event.message.role,
              });
              break;

            case "message_update": {
              const me = event.assistantMessageEvent;
              if (me.type === "text_delta") {
                currentMessageText += me.delta;
                emitEvent(this.client, {
                  seq: nextSeq(),
                  type: "text_delta",
                  turnCount,
                  delta: me.delta,
                  fullText: currentMessageText,
                });
              }
              break;
            }

            case "message_end": {
              if (event.message.role === "assistant") {
                const u = (event.message as any).usage;
                emitEvent(this.client, {
                  seq: nextSeq(),
                  type: "message_end",
                  turnCount,
                  usage: u ? {
                    input: u.input ?? 0,
                    output: u.output ?? 0,
                    cacheWrite: u.cacheWrite ?? 0,
                    cacheRead: u.cacheRead ?? 0,
                    cost: { total: u.cost?.total ?? 0 },
                  } : undefined,
                });
              }
              break;
            }

            case "tool_execution_start": {
              emitEvent(this.client, {
                seq: nextSeq(),
                type: "tool_execution_start",
                turnCount,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
              });
              break;
            }

            case "tool_execution_end": {
              const duration = (event as any).duration ?? 0;
              emitEvent(this.client, {
                seq: nextSeq(),
                type: "tool_execution_end",
                turnCount,
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                success: !event.isError,
                duration,
              });
              break;
            }

            case "agent_end": {
              const status = (event as any).status ?? "completed";
              emitEvent(this.client, {
                seq: nextSeq(),
                type: "completed",
                turnCount,
                status,
              });
              break;
            }

            case "agent_settled": {
              const status = (event as any).status ?? "completed";
              emitEvent(this.client, {
                seq: nextSeq(),
                type: "completed",
                turnCount,
                status,
              });
              // Close server and exit child process after session completes
              setTimeout(() => {
                this.shutdown();
                // All timeouts cleared, event loop empty → process exits
              }, 500);
              break;
            }

            case "compaction_end": {
              const aborted = (event as any).aborted;
              if (!aborted && event.result) {
                emitEvent(this.client, {
                  seq: nextSeq(),
                  type: "compaction",
                  turnCount,
                  reason: event.reason,
                  tokensBefore: event.result.tokensBefore,
                  compactionCount: (event.result as any).compactionCount,
                });
              }
              break;
            }
          }
        });

        // Store the unsubscribe handle so we can clean up on shutdown.
        (this as any)._unsubscribe = unsubscribe;

        resolve();
      });

      this.server.on("error", (err) => reject(err));

      this.server.listen(this._socketPath, () => {
        // Socket is ready.
      });
    });
  }

  /* ── Command routing ────────────────────────────────────────────── */

  private routeCommand(cmd: UdsCommand): void {
    if (!this.session) {
      this.emitError("no session");
      return;
    }

    try {
      switch (cmd.type) {
        case "steer": {
          const message = cmd.message as string | undefined;
          const images = cmd.images as ImageContent[] | undefined;
          if (message) {
            // First message should use prompt(), subsequent ones use steer()
            const isFirst = this.session.messages.length <= 1;
            if (isFirst) {
              this.session.prompt(message).then(() => {
              }).catch((err) => {
                console.error(`[uds-child] session.prompt() error: ${err.message}`);
              });
            } else {
              this.session.steer(message, images);
            }
          }
          this.sendEvent({ seq: nextSeq(), type: "command_ack", command: "steer" });
          break;
        }
        case "abort": {
          this.session.abort();
          this.sendEvent({ seq: nextSeq(), type: "command_ack", command: "abort" });
          break;
        }
        case "setTools": {
          const tools = cmd.tools as string[];
          this.session.setActiveToolsByName(tools);
          this.sendEvent({ seq: nextSeq(), type: "command_ack", command: "setTools" });
          break;
        }
        case "excludeTools": {
          const excluded = new Set(cmd.tools as string[]);
          const allTools = this.session.getAllTools();
          const filtered = allTools
            .filter((t) => !excluded.has(t.name))
            .map((t) => t.name);
          this.session.setActiveToolsByName(filtered);
          this.sendEvent({ seq: nextSeq(), type: "command_ack", command: "excludeTools" });
          break;
        }
        case "setThinking": {
          const level = cmd.level as ThinkingLevel | undefined;
          if (level) {
            this.session.setThinkingLevel(level);
          }
          this.sendEvent({ seq: nextSeq(), type: "command_ack", command: "setThinking" });
          break;
        }
        case "compact": {
          const instructions = cmd.instructions as string | undefined;
          const compact = (this.session as any).compact;
          if (typeof compact === "function") {
            compact(instructions);
          } else {
            this.sendEvent({ seq: nextSeq(), type: "error", message: "compaction not available" });
          }
          this.sendEvent({ seq: nextSeq(), type: "command_ack", command: "compact" });
          break;
        }
        default:
          this.sendEvent({ seq: nextSeq(), type: "error", message: `unknown command: ${cmd.type}` });
      }
    } catch (err: unknown) {
      this.emitError(`command error (${cmd.type}): ${(err as Error).message}`);
    }
  }

  /* ── Public API (called by child process) ─────────────────────── */

  /**
   * Emit an arbitrary event to the connected client.  Used by the child
   * process for lifecycle events (abort, error) that the session
   * subscription does not fire automatically.
   */
  emit(partial: UdsEventPartial): void {
    emitEvent(this.client, { seq: nextSeq(), ...partial });
  }

  /* ── Internal helpers ───────────────────────────────────────────── */

  private sendEvent(event: UdsEventPartial): void {
    const full = { seq: nextSeq(), ...event } as UdsEvent;
    emitEvent(this.client, full);
  }

  private emitError(message: string): void {
    this.sendEvent({ type: "error", message });
  }

  /* ── shutdown ───────────────────────────────────────────────────── */

  /**
   * Close the socket, clean up subscriptions, and remove the socket file
   * from the filesystem.
   */
  shutdown(): void {
    try {
      const unsub = (this as any)._unsubscribe as (() => void) | undefined;
      if (typeof unsub === "function") { unsub(); }
    } catch { /* ignore unsubscribe errors */ }

    this.session = null;

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    try {
      fs.unlinkSync(this._socketPath);
    } catch { /* socket file may already be removed */ }
  }
}
