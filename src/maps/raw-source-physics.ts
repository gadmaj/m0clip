import type { SourceWorld } from './raw-source-geometry';
import { sourceAbort } from './raw-source-lzma';

export interface SourcePhysicsXmlOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  maxValues?: number;
  maxChunks?: number;
}

/** Actual collision for the existing map.xml include seam. Limits cover this
 * writer's ASCII output, numeric values and retained chunks, not caller geometry
 * or whole-browser memory. Compilation/contact acceptance remains separate. */
export function sourceWorldPhysicsXml(world: Pick<SourceWorld, 'collision'>, options: SourcePhysicsXmlOptions = {}): string {
  const { signal } = options;
  sourceAbort(signal);
  const maxBytes = options.maxBytes ?? 128 * 1024 ** 2;
  const maxValues = options.maxValues ?? 2_000_000, maxChunks = options.maxChunks ?? 1_000_000;
  for (const value of [maxBytes, maxValues, maxChunks])
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid Source collision XML limit');
  const head = '<mujoco model="raw_source_world"><compiler angle="radian"/><asset>';
  const middle = '</asset><worldbody>', tail = '</worldbody></mujoco>';
  let bytes = head.length + middle.length + tail.length, chunks = 3, count = 0;
  if (bytes > maxBytes || chunks > maxChunks) throw new RangeError('Source collision XML limit exceeded');
  const assets: string[] = [], geoms: string[] = [];
  const append = (target: string[], text: string) => {
    if (text.length > maxBytes - bytes || chunks >= maxChunks) throw new RangeError('Source collision XML limit exceeded');
    bytes += text.length; chunks++; target.push(text);
  };
  const numbers = (target: string[], values: ArrayLike<number>) => {
    if (!Number.isSafeInteger(values.length) || values.length < 0 || values.length > maxValues - count)
      throw new RangeError('Source collision XML numeric limit exceeded');
    count += values.length;
    const text: string[] = new Array(values.length);
    let length = Math.max(0, values.length - 1);
    for (let i = 0; i < values.length; i++) {
      if ((i & 2047) === 0) sourceAbort(signal);
      const value = values[i];
      if (!Number.isFinite(value)) throw new Error('Nonfinite Source collision value');
      // Preserve small/slanted real hulls instead of rounding to 0.1mm.
      text[i] = value === 0 ? '0' : value.toPrecision(10);
      length += text[i].length;
      if (length > maxBytes - bytes) throw new RangeError('Source collision XML limit exceeded');
    }
    append(target, text.join(' '));
  };
  for (let i = 0; i < world.collision.length; i++) {
    sourceAbort(signal);
    const shape = world.collision[i], name = `source_collision_${i}`;
    if (shape.kind === 'heightfield') {
      append(assets, `<hfield name="${name}" nrow="${shape.rows}" ncol="${shape.columns}" size="`);
      numbers(assets, shape.size); append(assets, '" elevation="'); numbers(assets, shape.elevations); append(assets, '"/>\n');
      append(geoms, `<geom type="hfield" hfield="${name}" pos="`);
      numbers(geoms, shape.position); append(geoms, '" quat="'); numbers(geoms, shape.quaternion);
      append(geoms, '" group="3" friction="1 0.005 0.0001"/>\n');
    } else if (shape.kind === 'box') {
      append(geoms, '<geom type="box" pos="'); numbers(geoms, shape.position);
      append(geoms, '" size="'); numbers(geoms, shape.halfExtents);
      append(geoms, '" quat="'); numbers(geoms, shape.quaternion);
      append(geoms, '" group="3" friction="1 0.005 0.0001"/>\n');
    } else {
      append(assets, `<mesh name="${name}" vertex="`); numbers(assets, shape.vertices); append(assets, '"/>\n');
      append(geoms, `<geom type="mesh" mesh="${name}" group="3" friction="1 0.005 0.0001"/>\n`);
    }
  }
  sourceAbort(signal);
  return head + assets.join('') + middle + geoms.join('') + tail;
}
