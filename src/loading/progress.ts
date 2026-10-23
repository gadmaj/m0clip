import type { TransferUpdate } from './transfers';

export interface LoadingSnapshot {
  loaded: number;
  knownTotal: number;
  active: number;
  unknown: number;
  remaining: number;
  etaSeconds: number | null;
  stalled: boolean;
}

/** Decoded asset payload, not wire bytes. A discovered total is only a minimum. */
export class SceneProgress {
  private generation = 0;
  private resources = new Map<string, TransferUpdate>();
  private loaded = 0;
  private started = 0;
  private lastByte = 0;
  private samples: Array<{ at: number; bytes: number }> = [];

  begin(now: number): number {
    this.generation++;
    this.resources.clear();
    this.loaded = 0;
    this.started = this.lastByte = now;
    this.samples = [{ at: now, bytes: 0 }];
    return this.generation;
  }

  update(generation: number, updates: readonly TransferUpdate[], now: number) {
    if (generation !== this.generation) return;
    for (const update of updates) {
      const previous = this.resources.get(update.id);
      // A late batch must not resurrect a completed, failed or cancelled request.
      if (previous && previous.state !== 'loading') continue;
      const loaded = Math.max(previous?.loaded ?? 0, update.loaded);
      const delta = loaded - (previous?.loaded ?? 0);
      this.loaded += delta;
      if (delta > 0) this.lastByte = now;
      if (previous) {
        previous.loaded = loaded;
        previous.total = update.total;
        previous.state = update.state;
      } else {
        this.resources.set(update.id, { ...update, loaded });
      }
    }
  }

  snapshot(now: number): LoadingSnapshot {
    const last = this.samples[this.samples.length - 1];
    if (last.at === now) last.bytes = this.loaded;
    else this.samples.push({ at: now, bytes: this.loaded });
    const cutoff = now - 5_000;
    while (this.samples.length > 1 && this.samples[1].at <= cutoff) this.samples.shift();

    let knownTotal = 0, active = 0, unknown = 0;
    for (const resource of this.resources.values()) {
      if (resource.state === 'loading') {
        active++;
        if (resource.total === null) unknown++;
        knownTotal += Math.max(resource.total ?? 0, resource.loaded);
      } else {
        // Failed/abandoned optional assets still consumed these bytes, but their
        // unreceived remainder is not a pending download after Original recovery.
        knownTotal += resource.loaded;
      }
    }
    const remaining = knownTotal - this.loaded;
    const stalled = active > 0 && now - this.lastByte >= 3_500;
    const first = this.samples[0], elapsed = now - first.at;
    const bytes = this.loaded - first.bytes;
    const etaSeconds = active > 0 && unknown === 0 && remaining > 0
      && !stalled && now - this.started >= 1_500 && elapsed >= 1_000 && bytes > 0
      ? remaining / (bytes / (elapsed / 1_000)) : null;
    return { loaded: this.loaded, knownTotal, active, unknown, remaining, etaSeconds, stalled };
  }
}

export function downloadTime(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3_600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  const minutes = Math.ceil(rounded / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
