/** Saved-view restore phases on the page's User Timing timeline (DevTools Performance panel, or
 * `performance.getEntriesByType('measure')`). Measures are named `m0clip:restore:<phase>`, with the
 * request and its path in `detail`. Only the latest request records; a new request clears the previous
 * one's marks and measures, and a settled request clears its own marks. Timing never affects a restore. */
export const RESTORE_TIMING_PREFIX = 'm0clip:restore:';

/** `source` resolves the map (a reattach includes the person choosing the file); `verify` is the bundle
 * check alone. `visual`, `physics` and `install` belong to a scene change; `driver` waits for the worker's
 * queued model/driver work; `visuals` waits for robot and map rendering; `camera` applies the saved view. */
export type RestorePhase = 'total' | 'previous' | 'source' | 'verify' | 'scene' | 'visual' | 'physics' | 'install'
  | 'driver' | 'visuals' | 'camera';
/** `warm`: the map and robot were already loaded. `scene`: the scene changed with its map source in hand.
 * `reattach`: the local bundle was chosen and verified again. `launch`: the startup scene carries the view. */
export type RestorePath = 'warm' | 'scene' | 'reattach' | 'launch';
export type RestoreOutcome = 'restored' | 'failed' | 'cancelled';

let latest: RestoreTiming | null = null;

function timeline(): Performance | null {
  if (typeof performance === 'undefined') return null;
  return typeof performance.mark === 'function' && typeof performance.measure === 'function'
    && typeof performance.clearMarks === 'function' && typeof performance.clearMeasures === 'function' ? performance : null;
}

export class RestoreTiming {
  private readonly marks = new Set<string>();
  private readonly detail: { request: number; path?: RestorePath; [key: string]: unknown };

  constructor(readonly request: number) {
    this.detail = { request };
    const previous = latest;
    latest = this;
    previous?.clearMarks();
    const performance = timeline();
    if (performance) try {
      const names = new Set<string>();
      for (const entry of performance.getEntriesByType('measure')) if (entry.name.startsWith(RESTORE_TIMING_PREFIX)) names.add(entry.name);
      for (const name of names) performance.clearMeasures(name);
    } catch { /* Timing is diagnostic only. */ }
    this.start('total');
  }

  /** Path and other facts reported with every later measure of this request. */
  note(values: { path?: RestorePath; [key: string]: unknown }) { Object.assign(this.detail, values); }

  start(phase: RestorePhase) { this.mark(`${phase}:start`); }

  end(phase: RestorePhase) {
    const start = `${RESTORE_TIMING_PREFIX}${phase}:start`;
    if (!this.marks.has(start)) return;
    const end = this.mark(`${phase}:end`), performance = timeline();
    if (!end || !performance || latest !== this) return;
    try { performance.measure(`${RESTORE_TIMING_PREFIX}${phase}`, { start, end, detail: { ...this.detail, phase } }); }
    catch { /* Timing is diagnostic only. */ }
  }

  finish(outcome: RestoreOutcome) {
    this.note({ outcome });
    this.end('total');
    this.clearMarks();
  }

  private mark(label: string): string | null {
    const performance = timeline();
    if (!performance || latest !== this) return null;
    const name = `${RESTORE_TIMING_PREFIX}${label}`;
    try {
      if (this.marks.has(name)) performance.clearMarks(name);
      performance.mark(name, { detail: { request: this.request } });
      this.marks.add(name);
      return name;
    } catch { return null; }
  }

  private clearMarks() {
    const performance = timeline();
    if (performance) for (const name of this.marks) try { performance.clearMarks(name); } catch { /* diagnostic */ }
    this.marks.clear();
  }
}
