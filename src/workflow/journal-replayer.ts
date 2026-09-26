import type { WorkflowJournalEntry } from "./journal.js";

/**
 * journal-replayer.ts — prefix-aware journal replay for a workflow run.
 *
 * Encapsulates the replay-at-a-position logic that used to live inline in
 * `runWorkflow`: check that the replayable prefix is still intact, fetch the
 * journaled entry at the given position, verify the key, and mark the prefix
 * lost when anything mismatches.
 *
 * Kept in its own module so the helper can be tested independently of the
 * worker / RPC machinery that drives a run.
 */
export class JournalReplayer {
  constructor(
    private journalEntries: readonly WorkflowJournalEntry[],
    private prefixIntactRef: { value: boolean },
    private onPrefixLost?: () => void,
  ) {}

  /**
   * Try to replay the call at `index` with the given `key`.
   *
   * Returns the journaled entry if the prefix is intact and the key matches,
   * otherwise marks the prefix lost and returns `undefined`.
   */
  tryAt(index: number, key: string): WorkflowJournalEntry | undefined {
    if (!this.prefixIntactRef.value) return undefined;
    const entry = this.journalEntries[index];
    if (entry === undefined || entry.index !== index || entry.key !== key || !entry.ok) {
      this.prefixIntactRef.value = false;
      this.onPrefixLost?.();
      return undefined;
    }
    return entry;
  }
}
