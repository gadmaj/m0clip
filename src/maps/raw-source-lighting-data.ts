/** Native Source lighting/visibility metadata. Binary layouts follow Valve BSP and
 * noclip.website BSPFile.ts (Copyright 2018 Jasper St. Pierre, MIT, LICENSE.noclip).
 * Serialized names follow scripts/source_lightmaps.py/source_visibility.py. */
import type { SourceWorld } from './raw-source-geometry';
import { canonicalSourcePath as sourceLightingPath, type SourceFileSystem } from './raw-source-files';
import type { SourceAmbientLightingData, SourceLightingOptions, SourceLightingRequirement, SourceLightingResult, SourceNativeLightStyles, SourceWorldLightData } from './raw-source-lighting';
import { sourceAbort } from './raw-source-lzma';
import { readSourceVisibility } from './raw-source-visibility';
export function sourceLightingBase64(bytes: Uint8Array): string {
  // Bounded temporary strings; no spreading an entire BSP onto the call stack.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x6000) {
    let part = '';
    for (let j = i; j < Math.min(i + 0x6000, bytes.length); j++) part += String.fromCharCode(bytes[j]);
    parts.push(btoa(part));
  }
  return parts.join('');
}
export function sourceLightingLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid Source lighting ${name} limit`);
  return result;
}
export async function sourceLightingYield(signal?: AbortSignal): Promise<void> {
  sourceAbort(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  sourceAbort(signal);
}

class Records {
  readonly view: DataView;
  readonly count: number;
  constructor(readonly bytes: Uint8Array, readonly stride: number, readonly name: string) {
    if (bytes.length % stride) throw new Error(`Source lighting ${name}: truncated record`);
    this.count = bytes.length / stride;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  at(i: number, field: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.count || field < 0 || field >= this.stride) throw new Error(`Source lighting ${this.name}: index out of bounds`);
    return i * this.stride + field;
  }
  i(i: number, f: number): number { return this.view.getInt32(this.at(i, f), true); }
  u(i: number, f: number): number { return this.view.getUint16(this.at(i, f), true); }
  s(i: number, f: number): number { return this.view.getInt16(this.at(i, f), true); }
  f(i: number, f: number): number {
    const n = this.view.getFloat32(this.at(i, f), true);
    if (!Number.isFinite(n)) throw new Error(`Source lighting ${this.name}: nonfinite float`);
    return n;
  }
  vec(i: number, f: number): number[] { return [this.f(i, f), this.f(i, f + 4), this.f(i, f + 8)]; }
}
function range(first: number, count: number, total: number, name: string): void {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0 || first > total || count > total - first) throw new Error(`Source lighting ${name}: range out of bounds`);
}
function number(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  if (!text.trim() || !Number.isFinite(Number(text))) throw new Error(`Invalid authored Source lighting number: ${text}`);
  return Number(text);
}
function vector(text: string | undefined): number[] {
  const values = (text ?? '0 0 0').trim().split(/\s+/).map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite)) throw new Error('Invalid authored Source lighting vector');
  return values;
}

export async function readSourceLightingMetadata(world: SourceWorld, filesystem: Pick<SourceFileSystem, 'readFile'>, options: SourceLightingOptions, requirements: SourceLightingRequirement[], patterns: SourceNativeLightStyles['patterns']) {
  const { bsp, frame } = world, signal = options.signal, hdr = bsp.lumps[53].length > 0;
  const maxRecords = sourceLightingLimit(options.maxRecords, 2_000_000, 'records'), maxWork = sourceLightingLimit(options.maxWork, 200_000_000, 'work');
  let records = 0, work = 0;
  const spend = (n: number) => { work += n; if (!Number.isSafeInteger(work) || work > maxWork) throw new Error('Source lighting metadata work limit exceeded'); };
  const record = (n: number) => { records += n; if (!Number.isSafeInteger(records) || records > maxRecords) throw new Error('Source lighting metadata record limit exceeded'); };
  record(bsp.entities.length);
  for (const entity of bsp.entities) { record(entity.pairs.length); spend(entity.pairs.length); }
  const load = async (id: number, stride: number, versions: number[] = [0]) => {
    if (bsp.lumps[id].length && !versions.includes(bsp.lumps[id].version)) throw new Error(`Unsupported Source lighting lump ${id} version ${bsp.lumps[id].version}`);
    const result = new Records(await bsp.getLump(id, signal), stride, `lump ${id}`);
    record(result.count); return result;
  };
  const leafVersion = bsp.lumps[10].version;
  if (leafVersion !== 0 && leafVersion !== 1) throw new Error(`Unsupported Source lighting leaf version ${leafVersion}`);
  const leafs = await load(10, leafVersion === 0 ? 56 : 32, [0, 1]), planes = await load(1, 20);
  const nativeVisibility = await readSourceVisibility(world, { signal, maxRecords: maxRecords - records, maxWork: maxWork - work });
  record(nativeVisibility.usage.records); spend(nativeVisibility.usage.work);
  requirements.push(...nativeVisibility.requirements);
  const { head, nodes } = nativeVisibility.tree, visibility = nativeVisibility.data;
  const ambientLightingLump: 55 | 56 = hdr && bsp.lumps[55].length ? 55 : 56;
  const ambientIndexLump: 51 | 52 = ambientLightingLump === 55 ? 51 : 52;
  const ambient = await bsp.getLump(ambientLightingLump, signal), index = await load(ambientIndexLump, 4);
  // Intermediate Source stores one cube per leaf without indices; its version
  // is not fixed (NeoTokyo writes the byte length). Indexed layout requires v1.
  if (leafVersion === 1 && index.count && index.count !== leafs.count) throw new Error('Source ambient index/leaf count mismatch');
  if (leafVersion === 1 && index.count && (ambient.length % 28 || (ambient.length && bsp.lumps[ambientLightingLump].version !== 1))) throw new Error('Invalid indexed Source ambient sample layout');
  const missingAmbientIndex = leafVersion === 1 && !index.count && !!ambient.length && bsp.lumps[ambientLightingLump].version === 1;
  if (missingAmbientIndex) requirements.push({ code: 'missing-ambient-index', blocking: true, detail: 'Indexed ambient lighting has no matching index lump; raw cubes retained without inventing leaf assignments.' });
  if (leafVersion === 1 && !index.count && ambient.length && !missingAmbientIndex && ambient.length !== leafs.count * 24) throw new Error('Invalid legacy Source ambient sample layout');
  if (hdr && leafVersion === 1 && (!bsp.lumps[55].length || missingAmbientIndex)) requirements.push({ code: 'mixed-hdr-ambient', blocking: true, detail: 'HDR face lighting lacks matching usable HDR ambient data; original HDR/LDR lumps retained without cross-pairing their indices.' });
  const leaves: number[][][] = [], leafAreas: number[] = [];
  const cube = (bytes: Uint8Array, offset: number, pos: number[]): number[] => {
    range(offset, 24, bytes.length, 'ambient cube'); record(1); spend(24);
    const values = [...pos];
    for (let side = 0; side < 6; side++) {
      const at = offset + side * 4, e = bytes[at + 3], scale = 2 ** (e > 127 ? e - 256 : e);
      for (let c = 0; c < 3; c++) values.push(bytes[at + c] * scale);
    }
    return values;
  };
  for (let i = 0; i < leafs.count; i++) {
    if ((i & 511) === 0) await sourceLightingYield(signal);
    const lo = [leafs.s(i, 8), leafs.s(i, 10), leafs.s(i, 12)], hi = [leafs.s(i, 14), leafs.s(i, 16), leafs.s(i, 18)];
    if (lo.some((v, k) => v > hi[k])) throw new Error('Inverted Source leaf bounds');
    const centre = lo.map((v, k) => (v + hi[k]) / 2), samples: number[][] = [];
    if (leafVersion === 0) samples.push(cube(leafs.bytes, i * 56 + 30, centre));
    else if (index.count) {
      const count = index.u(i, 0), first = index.u(i, 2);
      if(count===0&&first!==0)range(first,1,leafs.count,'ambient referenced leaf');
      else range(first,count,ambient.length/28,'ambient samples');
      for (let j = 0; j < count; j++) {
        const at = (first + j) * 28;
        samples.push(cube(ambient, at, lo.map((v, k) => v + (hi[k] - v) * ambient[at + 24 + k] / 255)));
      }
    } else if (ambient.length && !missingAmbientIndex) samples.push(cube(ambient, i * 24, centre));
    leaves.push(samples);
    leafAreas.push(leafs.u(i, 6) & 0x1ff);
  }
  if(leafVersion===1&&index.count)for(let i=0;i<leafs.count;i++){
    if((i&511)===0)await sourceLightingYield(signal);
    const first=index.u(i,2);
    if(index.u(i,0)===0&&first!==0&&index.u(first,0)!==0){
      // Source borrows the referenced leaf's probes AND its reconstruction bounds.
      const samples=leaves[first];record(samples.length);spend(samples.length*21);
      leaves[i]=samples;
    }
  }
  if (!leaves.some(s => s.length)) requirements.push({ code: 'missing-ambient-probes', blocking: true, detail: 'BSP has no leaf ambient samples; no replacement probe/color was generated.' });
  const worldLightsLump: 15 | 54 = hdr && bsp.lumps[54].length ? 54 : 15;
  const lightVersion = bsp.lumps[worldLightsLump].version;
  if (bsp.lumps[worldLightsLump].length && lightVersion !== 0 && lightVersion !== 1) throw new Error('Unsupported Source worldlight version');
  const rawLights = await load(worldLightsLump, lightVersion === 1 ? 100 : 88, [0, 1]), lights: SourceWorldLightData[] = [];
  for (let i = 0; i < rawLights.count; i++) {
    const extra = lightVersion === 1 ? 12 : 0, pos = rawLights.vec(i, 0), color = rawLights.vec(i, 12), normal = rawLights.vec(i, 24), kind = rawLights.i(i, 40 + extra), style = rawLights.i(i, 44 + extra);
    if (kind < 0 || kind > 5 || style < 0 || style > 255 || color.some(v => v < 0)) throw new Error('Invalid Source worldlight kind/style/color');
    const inner = rawLights.f(i, 48 + extra), outer = rawLights.f(i, 52 + extra), exponent = rawLights.f(i, 56 + extra), attenuation = rawLights.vec(i, 64 + extra);
    let radius = rawLights.f(i, 60 + extra);
    if (radius < 0 || attenuation.some(v => v < 0)) throw new Error('Invalid Source worldlight attenuation/radius');
    if ((kind === 1 || kind === 2) && attenuation[0] === 0 && attenuation[1] === 0 && attenuation[2] === 0) attenuation[2] = 1;
    if (radius === 0) {
      const [constant, linear, quadratic] = attenuation, strength = Math.hypot(...color) / (worldLightsLump === 54 ? .015 : .03);
      if (quadratic) { const discriminant = linear ** 2 - 4 * quadratic * (constant - strength); radius = discriminant > 0 ? (-linear + Math.sqrt(discriminant)) / (2 * quadratic) : 2000; }
      else radius = linear ? (strength - constant) / linear : 2000;
    }
    lights.push({ pos, color, normal, kind, style, inner, outer, exponent, radius, attenuation, flags: rawLights.i(i, 76 + extra) });
  }
  const lighting: SourceAmbientLightingData = { origin: [...frame.origin], yaw: frame.yaw, head, nodes, leaves, lights };
  const entities = bsp.entities.map(entity => Object.fromEntries(entity.pairs.map(([k, v]) => [k.toLowerCase(), v])));
  const areaRecords = await load(20, 8), portalRecords = await load(21, 12), clipVertices = await load(41, 12);
  const areaPortalClipVertices = new Float32Array(clipVertices.count * 3);
  const areas = Array.from({ length: areaRecords.count }, (_, i) => ({ numPortals: areaRecords.i(i, 0), firstPortal: areaRecords.i(i, 4) }));
  const areaPortals = Array.from({ length: portalRecords.count }, (_, i) => ({ key: portalRecords.u(i, 0), otherArea: portalRecords.u(i, 2), firstClipVertex: portalRecords.u(i, 4), clipVertexCount: portalRecords.u(i, 6), plane: portalRecords.i(i, 8) }));
  for (const area of areas) range(area.firstPortal, area.numPortals, areaPortals.length, 'area portals');
  if (areas.length && leafAreas.some(a => a >= areas.length)) throw new Error('Source leaf references missing area');
  for (const portal of areaPortals) { range(portal.otherArea, 1, areas.length, 'other area'); range(portal.firstClipVertex, portal.clipVertexCount, clipVertices.count, 'portal clip vertices'); range(portal.plane, 1, planes.count, 'portal plane'); }
  for (let i = 0; i < clipVertices.count; i++) areaPortalClipVertices.set(clipVertices.vec(i, 0), i * 3);
  if (areaPortals.length || entities.some(e => ['func_areaportal', 'func_areaportalwindow'].includes(e.classname))) requirements.push({ code: 'area-portal-runtime', blocking: true, detail: 'Native PVS renderer does not simulate area-portal open/close state. Exact areas, portals, clip vertices and authored entities retained.' });
  const companions = new Map<string, Blob>(), selected = new Set((options.selectedCompanionPaths ?? []).map(sourceLightingPath));
  const companionMaximum = sourceLightingLimit(options.maxCompanionBytes, 128 * 1024 * 1024, 'companion bytes');
  let companionBytes = 0;
  const resolve = async (path: string): Promise<Blob | undefined> => {
    path = sourceLightingPath(path);
    const prior = companions.get(path); if (prior) return prior;
    if (!selected.has(path)) { requirements.push({ code: 'unselected-local-companion', path, blocking: true, detail: 'Explicitly select this local companion through the VFS; no search/network fallback is permitted.' }); return; }
    const blob = await filesystem.readFile(path, signal); sourceAbort(signal);
    if (!blob) { requirements.push({ code: 'missing-local-companion', path, blocking: true, detail: 'Selected local companion is absent from the caller-owned VFS.' }); return; }
    if (blob.size > companionMaximum - companionBytes) throw new Error('Source lighting aggregate companion byte limit exceeded');
    companionBytes += blob.size; companions.set(path, blob); return blob;
  };
  if (options.mapName !== undefined && (!options.mapName || /[\\/:\x00-\x1f]/.test(options.mapName) || options.mapName === '.' || options.mapName === '..')) throw new Error('Invalid explicit Source lighting map name');
  const cubes = await load(42, 16), cubemaps: SourceLightingResult['cubemaps'] = [];
  for (let i = 0; i < cubes.count; i++) {
    const position = [cubes.i(i, 0), cubes.i(i, 4), cubes.i(i, 8)], size = cubes.bytes[i * 16 + 12];
    const path = options.mapName ? sourceLightingPath(`materials/maps/${options.mapName}/c${position.join('_')}${hdr ? '.hdr' : ''}.vtf`) : null;
    cubemaps.push({ position, size, hdr, path, ...(path ? { blob: await resolve(path) } : {}) });
  }
  if (cubes.count && !options.mapName) requirements.push({ code: 'cubemap-map-name', blocking: true, detail: 'Caller must supply selected BSP mapName to resolve authored cubemap paths.' });
  const startup: [string, string][] = [], dynamicTargets = new Set<string>();
  for (let i = 0; i < bsp.entities.length; i++) {
    const e = entities[i];
    for (const [key, value] of bsp.entities[i].pairs) {
      if (!key.toLowerCase().startsWith('on')) continue;
      const parts = value.includes('\x1b') ? value.split('\x1b') : value.includes('\\x1b') ? value.split('\\x1b') : value.split(',');
      if (parts.length !== 5) {
        requirements.push({ code: 'entity-output-runtime', blocking: true, detail: 'Unrecognized authored entity output syntax retained verbatim for native interpretation.' });
        continue;
      }
      const target = parts[0].toLowerCase(), action = parts[1].toLowerCase();
      if (number(parts[4], 0) === 0) continue;
      if (e.classname === 'logic_auto' && key.toLowerCase() === 'onmapspawn' && number(parts[3], 0) <= 0 && ['enable', 'disable', 'toggle'].includes(action) && !target.includes('*') && !target.startsWith('!')) startup.push([target, action]);
      else dynamicTargets.add(target);
    }
    if (['light', 'light_spot', 'light_glspot', 'light_environment'].includes(e.classname)) {
      const style = number(e.style, -1);
      if (!Number.isInteger(style) || style < -1 || style > 254) throw new Error('Invalid authored Source light style');
      if (style >= 32) {
        const defaultStyle = number(e.defaultstyle, -1);
        if (!Number.isInteger(defaultStyle) || defaultStyle < -1 || defaultStyle > 254) throw new Error('Invalid authored default Source light style');
        patterns[style] = { pattern: e.pattern ?? null, default: defaultStyle, off: !!(number(e.spawnflags, 0) & 1) };
        if (e.pattern && !/^[a-z]+$/.test(e.pattern)) throw new Error('Invalid authored Source lightstyle pattern');
      }
    }
  }
  const startupByTarget = new Map<string, string[]>();
  for (const [target, action] of startup) {
    const actions = startupByTarget.get(target);
    if (actions) actions.push(action);
    else startupByTarget.set(target, [action]);
  }
  const colorCorrections: SourceLightingResult['native']['colorCorrections'] = [], lutFiles = new Map<string, string>();
  const angle = -frame.yaw * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  for (const e of entities) {
    if (e.classname !== 'color_correction') continue;
    if (e.parentname) requirements.push({ code: 'parented-color-correction', blocking: true, detail: `Color controller ${e.targetname ?? ''} requires authored parent transforms.` });
    if(number(e.maxweight,1)!==1)requirements.push({code:'color-correction-weight-runtime',blocking:true,detail:`Color controller ${e.targetname??''} has an authored maxweight not representable by the native layer ABI.`});
    if(number(e.fadeinduration,0)>0||number(e.fadeoutduration,0)>0)requirements.push({code:'color-correction-fade-runtime',blocking:true,detail:`Color controller ${e.targetname??''} requires time-varying authored fade weights.`});
    if (!e.filename) { requirements.push({ code: 'missing-color-filename', blocking: true, detail: 'Authored color controller has no LUT filename.' }); continue; }
    const source = sourceLightingPath(e.filename), blob = await resolve(source);
    if (!blob) continue;
    if (blob.size !== 32 * 32 * 32 * 3) throw new Error(`Invalid Source 32-cubed RGB LUT byte length: ${source}`);
    let file = lutFiles.get(source);
    if (!file) { file = `source-color-${lutFiles.size}.rgb`; lutFiles.set(source, file); }
    const p = vector(e.origin).map((v, k) => v - frame.origin[k]), origin = [.0254 * (c * p[0] - s * p[1]), .0254 * (s * p[0] + c * p[1]), .0254 * p[2]];
    let enabled = !number(e.startdisabled ?? e.start_disabled, 0);
    for (const action of startupByTarget.get((e.targetname ?? '').toLowerCase()) ?? []) {
      spend(1);
      if (action === 'enable') enabled = true;
      else if (action === 'disable') enabled = false;
      else if (action === 'toggle') enabled = !enabled;
    }
    colorCorrections.push({ file, source, origin, enabled, minfalloff: number(e.minfalloff, -1) * .0254, maxfalloff: number(e.maxfalloff, -1) * .0254 });
  }
  const authoredClasses: Record<string, true> = { worldspawn: true, light_environment: true, env_sun: true, env_fog_controller: true, fog_volume: true, sky_camera: true, env_tonemap_controller: true, color_correction: true, color_correction_volume: true, logic_auto: true, func_areaportal: true, func_areaportalwindow: true, light: true, light_spot: true, light_glspot: true };
  const authoredEntities = bsp.entities.filter((_, i) => Object.hasOwn(authoredClasses, entities[i].classname));
  const startupTargets = new Set(startup.map(([target]) => target));
  if ([...dynamicTargets].some(target => target.includes('*') || target.startsWith('!'))) requirements.push({ code: 'dynamic-lighting-target-runtime', blocking: true, detail: 'Wildcard/contextual entity-output targets require native entity resolution; all original outputs retained.' });
  for (const e of entities) {
    if (['env_sun', 'env_fog_controller', 'fog_volume', 'env_tonemap_controller', 'color_correction_volume'].includes(e.classname)) requirements.push({ code: `authored-${e.classname}-runtime`, blocking: true, detail: `Authored ${e.classname} is retained verbatim; existing native renderer does not implement its full behavior.` });
    if (e.targetname && (dynamicTargets.has(e.targetname.toLowerCase()) || dynamicTargets.has('*')) && Object.hasOwn(authoredClasses, e.classname)) requirements.push({ code: 'lighting-entity-runtime', blocking: true, detail: `Lighting controller ${e.targetname} has authored dynamic outputs; full entity behavior is retained, not simulated by the existing native pipeline.` });
    if (e.classname !== 'color_correction' && e.targetname && startupTargets.has(e.targetname.toLowerCase()) && Object.hasOwn(authoredClasses, e.classname)) requirements.push({ code: 'startup-lighting-entity-runtime', blocking: true, detail: `Immediate startup input targets ${e.classname}; only color-correction startup inputs are currently evaluated by the native pipeline.` });
  }
  sourceAbort(signal);
  return { lighting, visibility, colorCorrections, companions, cubemaps, areas, areaPortals, areaPortalClipVertices, leafAreas,
    authored: { skyName: entities.find(e => e.classname === 'worldspawn')?.skyname ?? null, entities: authoredEntities },
    identity: { hdr, lightingLump: hdr ? 53 as const : 8 as const, worldLightsLump, ambientLightingLump, ambientIndexLump } };
}
