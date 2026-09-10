/**
 * uds-child-lifecycle.test.ts — Tests for the UDS child process lifecycle.
 *
 * Two categories of tests:
 *
 * 1. File existence check: Verifies that uds-child.mjs exists at spawn time.
 *    This catches the classic "ENOENT: no such file or directory" runtime crash.
 *
 * 2. IPC error propagation: Verifies that child processes can send error
 *    messages to their parent via process.send() before exiting. This ensures
 *    the parent knows WHY a child crashed instead of just seeing "exit code 1".
 *
 * NOTE: Full child process lifecycle tests (ready handshake, command exchange)
 * are in uds-transport.test.ts which uses the real UdsServer class with mocked
 * sessions. Those tests are more reliable because they don't involve spawning
 * actual child processes.
 */

import fs from "node:fs";
import { join } from "node:path";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UDS child lifecycle", () => {
  describe("file existence checks", () => {
    it("uds-child.mjs exists at spawn time", () => {
      // This is the most common runtime crash source:
      // "ENOENT: no such file or directory, access '.../uds-child.mjs'"
      // Adding this test ensures we never forget to include it in the build.
      const udsChildPath = join(__dirname, "..", "src", "uds-child.mjs");
      expect(fs.existsSync(udsChildPath)).toBe(true);
    });

    it("uds-server.ts exists as a source file", () => {
      const udsServerPath = join(__dirname, "..", "src", "uds-server.ts");
      expect(fs.existsSync(udsServerPath)).toBe(true);
    });

    it("uds-agent-runner.ts exists as a source file", () => {
      const runnerPath = join(__dirname, "..", "src", "uds-agent-runner.ts");
      expect(fs.existsSync(runnerPath)).toBe(true);
    });
  });

  describe("IPC error propagation", () => {
    it("child can send error to parent via process.send()", async () => {
      // Create a minimal child that sends an IPC error message before exiting
      const errorScript = join(tmpdir(), `uds-error-ipc-${Date.now()}.mjs`);
      fs.writeFileSync(errorScript, `
process.send({ type: "child_error", message: "test error from IPC" });
process.exit(1);
`);

      const errorChild = fork(errorScript, {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      const messages: any[] = [];

      errorChild.on("message", (msg) => {
        messages.push(msg);
      });

      await new Promise<void>((resolve) => {
        errorChild.once("exit", () => resolve());
      });

      // Verify the IPC message was received
      expect(messages.find((m) => m.type === "child_error")).toBeDefined();
      expect(messages.find((m) => m.type === "child_error")?.message).toBe(
        "test error from IPC",
      );

      try { fs.unlinkSync(errorScript); } catch { /* ignore */ }
    });

    it("child can send error + stack trace via IPC", async () => {
      const errorScript = join(tmpdir(), `uds-error-stack-${Date.now()}.mjs`);
      fs.writeFileSync(errorScript, `
try {
  throw new Error("deliberate test error");
} catch (err) {
  process.send({
    type: "child_error",
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
}
`);

      const errorChild = fork(errorScript, {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      const messages: any[] = [];

      errorChild.on("message", (msg) => {
        messages.push(msg);
      });

      await new Promise<void>((resolve) => {
        errorChild.once("exit", () => resolve());
      });

      expect(messages.find((m) => m.type === "child_error")).toBeDefined();
      expect(typeof messages.find((m) => m.type === "child_error")?.stack).toBe(
        "string",
      );

      try { fs.unlinkSync(errorScript); } catch { /* ignore */ }
    });
  });
});
