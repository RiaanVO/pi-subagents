/**
 * turn-monitor.ts — Turn counting and soft/hard limit enforcement.
 *
 * Extracted from runAgent to provide standalone turn tracking for
 * max_turns enforcement with graceful soft-limit steering and
 * hard-limit abort after grace turns.
 */

export class TurnMonitor {
  private _turnCount = 0;
  private _softLimitReached = false;
  private _aborted = false;

  constructor(
    private maxTurns: number | undefined,
    private graceTurns: number,
    private onSoftLimit: () => void,
    private onHardLimit: () => void,
  ) {}

  get turnCount(): number { return this._turnCount; }
  get softLimitReached(): boolean { return this._softLimitReached; }
  get aborted(): boolean { return this._aborted; }

  onTurnEnd(): void {
    this._turnCount++;
    if (this.maxTurns != null) {
      if (!this._softLimitReached && this._turnCount >= this.maxTurns) {
        this._softLimitReached = true;
        this.onSoftLimit();
      } else if (this._softLimitReached && this._turnCount >= this.maxTurns + this.graceTurns) {
        this._aborted = true;
        this.onHardLimit();
      }
    }
  }
}
