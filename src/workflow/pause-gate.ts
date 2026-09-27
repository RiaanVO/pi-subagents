/**
 * Pause gate — a minimal pause/resume state machine.
 *
 * Extracted from the inline `paused` / `pauseWaiters` / `pauseGate` /
 * `releasePause` machinery that lived inside {@link runWorkflow}. The
 * gateway is the single place that decides whether an agent may proceed
 * past the concurrency gate: if the run is paused the agent parks here,
 * and on resume every parked agent is woken.
 */

export class PauseGate {
  private paused = false;
  private waiters = new Set<() => void>();

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Park here while the run is paused.
   *
   * Resolves immediately if not paused; otherwise stores `wake` on `live`
   * so a skip can eject the agent without waiting for a resume.
   */
  waitForResume(live: { wake?: () => void }): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>(resolve => {
      const wake = () => {
        this.waiters.delete(wake);
        live.wake = undefined;
        resolve();
      };
      live.wake = wake;
      this.waiters.add(wake);
    });
  }
}
