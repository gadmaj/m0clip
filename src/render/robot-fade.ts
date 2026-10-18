export interface RobotFade { from: number; target: number; elapsed: number }
export const ROBOT_FADE_SECONDS = .25;
export function fadeOpacity(from: number, target: number, elapsed: number) {
  const t = Math.max(0, Math.min(1, elapsed / ROBOT_FADE_SECONDS));
  return from + (target - from) * t * t * (3 - 2 * t);
}
export function recordedRobotOpacity(initial: RobotFade | undefined,
  events: readonly { t: number; kind: string; label: string }[], time: number) {
  if (!initial) return 1; // older takes predate noclip fading
  let from = initial.from, target = initial.target, start = -initial.elapsed;
  for (const event of events) {
    if (event.t > time) break;
    if (event.kind !== 'noclip' || !['Noclip on', 'Noclip off'].includes(event.label)) continue;
    from = fadeOpacity(from, target, event.t - start);
    target = event.label === 'Noclip on' ? 0 : 1; start = event.t;
  }
  return fadeOpacity(from, target, time - start);
}
