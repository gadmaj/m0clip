/** Canvas-only waiting-room game. No simulator controls or assets. */
export class Pong {
  private readonly context: CanvasRenderingContext2D;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly keys = new Set<string>();
  private readonly events = new AbortController();
  private readonly colors: { background: string; line: string; text: string; accent: string };
  private paused = true;
  private stopped = false;
  private animation = 0;
  private last = 0;
  private player = 120;
  private opponent = 120;
  private x = 210;
  private y = 120;
  private vx = 145;
  private vy = 70;
  private score = [0, 0];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly button: HTMLButtonElement, autoPlay = false) {
    this.context = canvas.getContext('2d')!;
    canvas.width = 420; canvas.height = 240;
    const style = getComputedStyle(document.documentElement);
    this.colors = { background: style.getPropertyValue('--bg'), line: style.getPropertyValue('--line-hi'), text: style.getPropertyValue('--text'), accent: style.getPropertyValue('--accent') };
    button.addEventListener('click', () => { this.setPaused(!this.paused); if (!this.paused) canvas.focus({ preventScroll: true }); }, { signal: this.events.signal });
    canvas.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S', ' ', 'p', 'P'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if ([' ', 'p', 'P'].includes(event.key)) { if (!event.repeat) this.setPaused(!this.paused); return; }
      this.keys.add(event.key.toLowerCase());
    }, { signal: this.events.signal });
    canvas.addEventListener('keyup', event => { this.keys.delete(event.key.toLowerCase()); event.stopPropagation(); }, { signal: this.events.signal });
    canvas.addEventListener('blur', () => this.setPaused(true), { signal: this.events.signal });
    canvas.addEventListener('pointerdown', event => {
      canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
      this.movePointer(event); this.setPaused(false);
    }, { signal: this.events.signal });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse' || canvas.hasPointerCapture(event.pointerId)) this.movePointer(event);
    }, { signal: this.events.signal });
    canvas.addEventListener('pointercancel', () => this.setPaused(true), { signal: this.events.signal });
    window.addEventListener('blur', () => this.setPaused(true), { signal: this.events.signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.setPaused(true); }, { signal: this.events.signal });
    this.reduced.addEventListener('change', () => this.setPaused(true), { signal: this.events.signal });
    this.setPaused(!autoPlay || this.reduced.matches);
  }

  private movePointer(event: PointerEvent) {
    const box = this.canvas.getBoundingClientRect();
    this.player = Math.max(24, Math.min(216, (event.clientY - box.top) / box.height * 240));
  }

  private setPaused(paused: boolean) {
    this.paused = paused; this.keys.clear();
    this.button.textContent = paused ? 'Play Pong' : 'Pause Pong';
    this.button.setAttribute('aria-pressed', String(!paused));
    cancelAnimationFrame(this.animation); this.animation = 0;
    this.draw();
    // Reduced-motion users start paused; playing the revealed court remains opt-in.
    if (!paused && !this.stopped && !document.hidden) {
      this.last = performance.now(); this.animation = requestAnimationFrame(this.tick);
    }
  }

  stop() { this.stopped = true; this.setPaused(true); this.events.abort(); }

  private tick = (now: number) => {
    if (this.paused || this.stopped) return;
    const dt = Math.min(.035, (now - this.last) / 1000); this.last = now;
    const direction = Number(this.keys.has('arrowdown') || this.keys.has('s')) - Number(this.keys.has('arrowup') || this.keys.has('w'));
    this.player = Math.max(24, Math.min(216, this.player + direction * 235 * dt));
    this.opponent += Math.max(-105 * dt, Math.min(105 * dt, this.y - this.opponent));
    this.opponent = Math.max(24, Math.min(216, this.opponent));
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.y < 5 || this.y > 235) { this.y = Math.max(5, Math.min(235, this.y)); this.vy *= -1; }
    if (this.vx < 0 && this.x < 26 && this.x > 12 && Math.abs(this.y - this.player) < 29) {
      this.x = 26; this.vx = Math.abs(this.vx); this.vy = (this.y - this.player) * 6;
    }
    if (this.vx > 0 && this.x > 394 && this.x < 408 && Math.abs(this.y - this.opponent) < 29) {
      this.x = 394; this.vx = -Math.abs(this.vx); this.vy = (this.y - this.opponent) * 6;
    }
    if (this.x < 0 || this.x > 420) {
      this.score[this.x < 0 ? 1 : 0]++; this.x = 210; this.y = 120; this.vx *= -1; this.vy = 70;
    }
    this.draw(); this.animation = requestAnimationFrame(this.tick);
  };

  private draw() {
    const c = this.context;
    c.fillStyle = this.colors.background; c.fillRect(0, 0, 420, 240);
    c.strokeStyle = this.colors.line; c.setLineDash([5, 7]);
    c.beginPath(); c.moveTo(210, 0); c.lineTo(210, 240); c.stroke(); c.setLineDash([]);
    c.fillStyle = this.colors.text; c.fillRect(14, this.player - 24, 8, 48); c.fillRect(398, this.opponent - 24, 8, 48);
    c.fillStyle = this.colors.accent; c.fillRect(this.x - 4, this.y - 4, 8, 8);
    c.font = '18px monospace'; c.textAlign = 'center'; c.fillText(`${this.score[0]}   ${this.score[1]}`, 210, 28);
    if (this.paused) { c.font = '14px sans-serif'; c.fillStyle = this.colors.text; c.fillText('Paused', 210, 216); }
  }
}
