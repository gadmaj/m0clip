/** Ordered native time proxies used by selected Source materials. Parameter/reference
 * conventions: noclip.website MaterialParameters.ts (Jasper St. Pierre, MIT,
 * LICENSE.noclip). Native clock/wrapping: Source SDK 2007 TextureScroll and
 * AnimatedTexture. This is deliberately not an entity/material-proxy VM. */
import type { ResolvedSourceMaterial } from '../maps/raw-source-vmt';

export type SourceTemporalProxy =
  | { kind: 'texturescroll'; scroll: [number, number]; scale: number }
  | { kind: 'animatedtexture'; fps: number };
export interface SourceTemporalProxies {
  operations: SourceTemporalProxy[];
}

export function compileSourceTemporalProxies(descriptor: ResolvedSourceMaterial,
  block: (detail: string) => void, reserve: (work: number, entries: number, bytes: number) => void): SourceTemporalProxies {
  const operations: SourceTemporalProxy[] = [];
  let ordinal = 0;
  for (const group of descriptor.proxies) {
    reserve(group.key.length + 1, 1, 32);
    if (typeof group.value === 'string' || group.conditions.length) {
      block('Conditional or scalar Proxies block requires native interpretation.'); continue;
    }
    for (const proxy of group.value.entries) {
      reserve(proxy.key.length + proxy.spelling.length + 1, 1, 256 + proxy.spelling.length * 2);
      const label = `Proxy ${++ordinal} (${proxy.spelling})`;
      const reject = (detail: string) => block(`${label}: ${detail}`);
      if (proxy.conditions.length || typeof proxy.value === 'string') {
        reject('conditional or scalar proxy is unsupported.'); continue;
      }
      const allowed = proxy.key === 'texturescroll'
        ? ['texturescrollvar', 'texturescrollrate', 'texturescrollangle', 'texturescale']
        : proxy.key === 'animatedtexture'
          ? ['animatedtexturevar', 'animatedtextureframenumvar', 'animatedtextureframerate', 'animationnowrap'] : undefined;
      if (!allowed) { reject('native proxy implementation is unavailable.'); continue; }
      const inputs: Record<string, string> = Object.create(null);
      let invalid = false;
      for (const input of proxy.value.entries) {
        const inputLength = typeof input.value === 'string' ? input.value.length : 0;
        reserve(input.key.length + input.spelling.length + inputLength + 1, 1,
          64 + (input.spelling.length + inputLength) * 2);
        if (!allowed.includes(input.key) || input.conditions.length || typeof input.value !== 'string' || Object.hasOwn(inputs, input.key)) {
          reject(`input ${input.spelling} is unknown, conditional, duplicated or not scalar.`); invalid = true;
        } else inputs[input.key] = input.value.trim();
      }
      const scalar = (key: string, fallback: number, references: boolean): number => {
        const input = inputs[key];
        if (input === undefined) return fallback;
        reserve(input.length + 1, 0, 32 + input.length * 4);
        const ref = input.toLowerCase();
        if (references && ref === '$frame') {
          reject(`input ${key} reads mutable $frame; dynamic proxy references are unsupported.`);
          invalid = true; return fallback;
        }
        const text = references && ref.startsWith('$') ? descriptor.parameters[ref] : input;
        // Charge every referenced value on every use before normalization,
        // regex scanning or Number conversion; the shared descriptor is not a
        // cache exemption from the import's cumulative work allowance.
        if (text !== undefined) reserve(text.length * 3 + 1, 0, 32 + text.length * 4);
        const normalized = text?.trim();
        if (normalized === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
          reject(`input ${key}=${input} has no supported numeric material binding.`); invalid = true; return fallback;
        }
        const value = Number(normalized);
        if (!Number.isFinite(value)) {
          reject(`input ${key}=${input} is not finite.`); invalid = true; return fallback;
        }
        return value;
      };
      const target = (key: string): string | undefined => {
        const value = inputs[key];
        if (value === undefined) return undefined;
        reserve(value.length + 1, 0, 32 + value.length * 2);
        return value.toLowerCase();
      };
      if (proxy.key === 'texturescroll') {
        if (target('texturescrollvar') !== '$basetexturetransform') {
          reject(`target ${inputs.texturescrollvar ?? '(missing)'} has no base UV matrix binding.`); invalid = true;
        }
        const rate = scalar('texturescrollrate', 1, true), angle = scalar('texturescrollangle', 0, true), scale = scalar('texturescale', 1, true);
        if (!invalid) {
          const radians = angle * Math.PI / 180;
          operations.push({ kind: 'texturescroll', scroll: [Math.cos(radians) * rate, Math.sin(radians) * rate], scale });
        }
      } else {
        if (target('animatedtexturevar') !== '$basetexture' || target('animatedtextureframenumvar') !== '$frame') {
          reject('only $basetexture → $frame has an animation resource binding.'); invalid = true;
        }
        const fps = scalar('animatedtextureframerate', 15, false), nowrap = scalar('animationnowrap', 0, false);
        if (nowrap !== 0) { reject('animationNoWrap requires native previous-frame/wrap-callback semantics.'); invalid = true; }
        if (!descriptor.textures.some(texture => texture.parameter === '$basetexture' && texture.kind === 'file')) {
          reject('selected base texture is unavailable.'); invalid = true;
        }
        if (fps < 0) { reject('negative animation rate requires native negative-frame binding.'); invalid = true; }
        if (!invalid) operations.push({ kind: 'animatedtexture', fps });
      }
    }
  }
  return { operations };
}

// The SDK stores offsets in float variables, including the positive-wrap add.
// Preserve that rounding boundary: a tiny negative sin(180deg) residual wraps to
// zero, not an almost-one translation (important for clamp-addressed textures).
function scrollOffset(value: number): number {
  value = Math.fround(value);
  if (value < 0) value = Math.fround(value + 1 - Math.trunc(value));
  return value - Math.trunc(value);
}

/** Mutable renderer-facing state. Each material pair gets its own matrix/state;
 * update rewrites from absolute time, so rewind never integrates stale offsets. */
export class SourceTemporalProxyState {
  readonly matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  frame = 0;
  constructor(readonly program: SourceTemporalProxies, readonly frameCount: number) {}
  update(time: number): void {
    this.frame = 0;
    const matrix = this.matrix;
    for (const operation of this.program.operations) {
      if (operation.kind === 'animatedtexture') {
        // AnimatedTexture (not AnimatedEntityTexture) always starts at global 0.
        this.frame = Math.trunc(Math.max(0, time) * operation.fps) % this.frameCount;
      } else {
        const s = operation.scroll[0] * time, t = operation.scroll[1] * time;
        matrix[0] = matrix[4] = operation.scale;
        matrix[2] = scrollOffset(s); matrix[5] = scrollOffset(t);
      }
    }
  }
}
