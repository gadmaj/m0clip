/** A planning wait must be released outside the worker's serialized work queue. */
export class StartupGate {
  private sequence = 0;
  private pending?: { generation: number; token: string; resolve: (proceed: boolean) => void };

  wait(generation: number): { token: string; ready: Promise<boolean> } {
    this.cancel();
    const token = `${generation}:${++this.sequence}`;
    const ready = new Promise<boolean>(resolve => { this.pending = { generation, token, resolve }; });
    return { token, ready };
  }

  proceed(generation: number, token: string): boolean {
    const pending = this.pending;
    if (!pending || pending.generation !== generation || pending.token !== token) return false;
    this.pending = undefined;
    pending.resolve(true);
    return true;
  }

  finish(generation: number) {
    if (this.pending?.generation === generation) this.cancel();
  }

  cancel() {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(false);
  }
}
