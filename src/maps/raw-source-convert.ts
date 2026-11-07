/** Browser/worker CPU assembly of explicitly selected Source files. The result is
 * generated assets with unresolved requirements, not permission to install a
 * partial map. The caller owns final validation and the live-map transaction. */
import { readSourceBsp, decodeSourceWorld } from './raw-source-bsp';
import { SourceFileSystem, type SourceMount } from './raw-source-files';
import { SourceGlb } from './raw-source-gltf';
import { SourceMaterialExport } from './raw-source-materials';
import { buildSourceLighting, type SourceLightingRequirement } from './raw-source-lighting';
import { appendSourceLightingAssets, appendSourceCubemaps } from './raw-source-lighting-glb';
import { readSourceProps, type SourcePropPlacement } from './raw-source-props';
import { sourceQAngle, sourceModelPoint } from './raw-source-model-binary';
import { appendSourceWorld } from './raw-source-world-glb';
import { appendSourceProps } from './raw-source-props-glb';
import { appendSourceSky } from './raw-source-sky';
import { sourceWorldPhysicsXml } from './raw-source-physics';
import { assembleSourceEntityCollision } from './raw-source-collision';
import { composeSourceMapFiles, type SourceMapFiles } from './raw-source-manifest';
import { SourceAmbient, type SourceAmbientSample } from '../render/source-ambient';
import { sourceLightstylePatterns, sourceLightstyleValue } from '../render/source-lightstyle-values';

export type SourceAssemblyStage = 'bsp' | 'companions' | 'geometry' | 'lighting' | 'world' | 'props' | 'sky' | 'packaging';
export interface SourceMapAssemblyOptions {
  mapName: string;
  name: string;
  game: string;
  /** Ordered explicit game mounts. The selected BSP's own pak takes precedence. */
  mounts: readonly SourceMount[];
  signal?: AbortSignal;
  onStage?(stage: SourceAssemblyStage): void;
  /** Generated output cap, not HTTP bytes or a whole-browser memory estimate. */
  maxOutputBytes?: number;
  maxMetadataBytes?: number;
  maxMetadataAllocationBytes?: number;
  /** Conservative node/probe/light visits for initial native prop caches. */
  maxPropLightingWork?: number;
}
export interface SourceMapAssembly extends SourceMapFiles {
  counts: { worldFaces: number; collision: number; props: number; skyFaces: number; outputBytes: number };
}
const MIB = 1024 ** 2, METRES = .0254;
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid Source assembly ${label} limit`);
  return value;
}

export async function assembleSourceMap(file: Blob, options: SourceMapAssemblyOptions): Promise<SourceMapAssembly> {
  const { signal, mapName, name, game, onStage } = options;
  if (options.mounts.length > 128) throw new RangeError('Source assembly mount limit exceeded');
  const sourceMounts = options.mounts.slice();
  const maxOutput = positive(options.maxOutputBytes ?? 512 * MIB, 'output');
  const maxMetadata = positive(options.maxMetadataBytes ?? 16 * MIB, 'metadata');
  const maxAllocation = positive(options.maxMetadataAllocationBytes ?? 128 * MIB, 'metadata allocation');
  const maxPropLightingWork = positive(options.maxPropLightingWork ?? 200_000_000, 'prop lighting work');
  if (!/^[a-z\d_-]{1,128}$/i.test(mapName)) throw new Error('Invalid Source map stem');
  const stage = (value: SourceAssemblyStage) => { signal?.throwIfAborted(); onStage?.(value); signal?.throwIfAborted(); };
  stage('bsp');
  const bsp = await readSourceBsp(file, { signal });
  stage('companions');
  const pak = await bsp.getLump(40, signal);
  const mounts: readonly SourceMount[] = pak.length
    ? [{ kind: 'zip', label: 'Selected map pak', file: new Blob([pak]) }, ...sourceMounts]
    : sourceMounts;
  const filesystem = await SourceFileSystem.create(mounts, signal);
  stage('geometry');
  const world = await decodeSourceWorld(bsp, { signal });
  const props = await readSourceProps(world, filesystem, { signal });
  // Brush-entity collision joins the world model's collision in one physics
  // closure; every unsupported authored collision is a blocking requirement.
  const entityCollision = await assembleSourceEntityCollision(world, props, { signal });
  const physicsWorld = { ...world, collision: [...world.collision, ...entityCollision.collision] };
  // Atlas each unique brush model once; placement remains the world writer's job.
  const surfaces = world.surfaces.slice(), brushModels = new Set<number>();
  for (const brush of props.brushes) {
    signal?.throwIfAborted();
    if (brushModels.has(brush.model)) continue;
    if (brush.surfaces.length > 2_000_000 - surfaces.length) throw new RangeError('Source assembly surface limit exceeded');
    brushModels.add(brush.model);
    for (const surface of brush.surfaces) surfaces.push(surface);
  }
  stage('lighting');
  const lighting = await buildSourceLighting({ ...world, surfaces }, filesystem, {
    signal, mapName,
    selectedCompanionPaths: filesystem.files.map(entry => entry.path),
  });
  const physics = new Map<string, Blob>();
  {
    const xml = sourceWorldPhysicsXml(physicsWorld, { signal, maxBytes: Math.min(maxOutput, 128 * MIB) });
    physics.set('map.xml', new Blob([xml], { type: 'application/xml' }));
  }
  let ownedOutput = physics.get('map.xml')!.size;
  const remaining = () => {
    signal?.throwIfAborted();
    if (ownedOutput >= maxOutput) throw new RangeError('Source assembly output limit exceeded');
    return maxOutput - ownedOutput;
  };
  stage('world');
  const worldGlb = new SourceGlb(remaining()), worldMaterials = new SourceMaterialExport(worldGlb, filesystem, { signal });
  const assets = await appendSourceLightingAssets(worldGlb, worldMaterials, lighting, {
    signal, maxAtlasBytes: 512 * MIB, maxOutputBytes: remaining(), maxCubeWork: 200_000_000,
  });
  for (const blob of assets.files.values()) {
    if (blob.size > remaining()) throw new RangeError('Source assembly output limit exceeded');
    ownedOutput += blob.size;
  }
  const worldResult = await appendSourceWorld(worldGlb, worldMaterials, world, lighting, {
    signal, brushes: props.brushes, lightmaps: assets.lightmaps, maxGeometryBytes: Math.min(256 * MIB, remaining()), maxVertices: 4_000_000,
    cubeForSurface(surface) {
      let x = 0, y = 0, z = 0;
      const points = surface.sourcePositions;
      for (let i = 0; i < points.length; i += 3) { x += points[i]; y += points[i + 1]; z += points[i + 2]; }
      const count = points.length / 3;
      return assets.cubeAt([x / count, y / count, z / count]);
    },
  });
  const visual = worldGlb.finish(signal);
  if (visual.size > remaining()) throw new RangeError('Source assembly output limit exceeded');
  ownedOutput += visual.size;
  stage('props');
  const propGlb = new SourceGlb(remaining()), propMaterials = new SourceMaterialExport(propGlb, filesystem, { signal });
  const propCubes = await appendSourceCubemaps(propMaterials, lighting.cubemaps, { signal, maxWork: 200_000_000 });
  const ambient = new SourceAmbient();
  ambient.setData(lighting.native.lighting);
  const patterns = sourceLightstylePatterns(lighting.native.lightstyles.patterns);
  const initialStyles = Float32Array.from(patterns, pattern => sourceLightstyleValue(pattern, 0));
  ambient.styleValue = style => initialStyles[style] ?? 1;
  const yaw = -world.frame.yaw * Math.PI / 180, cos = Math.cos(yaw), sin = Math.sin(yaw);
  let maxProbes = 0, lightingWork = 0;
  for (const leaf of lighting.native.lighting.leaves) maxProbes = Math.max(maxProbes, leaf.length);
  const sampleWork = lighting.native.lighting.nodes.length + maxProbes * 6 + lighting.native.lighting.lights.length * 8;
  let lastPlacement: SourcePropPlacement | undefined, lastOrigin: readonly number[] | undefined;
  const lightOrigin = (placement: SourcePropPlacement): readonly number[] => {
    if (placement === lastPlacement && lastOrigin) return lastOrigin;
    let point: readonly number[];
    if (placement.sourceLightingOrigin) point = placement.sourceLightingOrigin;
    else {
      const model = props.models.get(placement.modelPath);
      if (!model) throw new Error(`Missing selected Source model ${placement.modelPath}`);
      const local = sourceModelPoint(sourceQAngle(placement.sourceAngles), model.illuminationPosition);
      point = [placement.sourceOrigin[0] + local[0] * placement.scale,
        placement.sourceOrigin[1] + local[1] * placement.scale, placement.sourceOrigin[2] + local[2] * placement.scale];
    }
    lastPlacement = placement; lastOrigin = point;
    return point;
  };
  const propResult = await appendSourceProps(propGlb, propMaterials, props, world, {
    signal, maxGeometryBytes: Math.min(256 * MIB, remaining()), maxVertices: 4_000_000,
    maxMetadataBytes: maxAllocation,
    collisionForPlacement: placement => entityCollision.props.get(placement),
    cubeForPlacement: placement => propCubes.cubeAt(lightOrigin(placement)),
    lightingForPlacement(placement) {
      if (sampleWork > maxPropLightingWork - lightingWork) throw new RangeError('Source prop lighting work limit exceeded');
      lightingWork += sampleWork;
      const point = lightOrigin(placement), dx = (point[0] - world.frame.origin[0]) * METRES;
      const dy = (point[1] - world.frame.origin[1]) * METRES, dz = (point[2] - world.frame.origin[2]) * METRES;
      const cache: SourceAmbientSample = { cube: [], lights: [] };
      ambient.sample(cos * dx - sin * dy, sin * dx + cos * dy, dz, cache);
      return cache;
    },
  });
  stage('sky');
  const sky = await appendSourceSky(propGlb, propMaterials, world.frame, lighting.authored.skyName, { signal });
  const propVisual = propGlb.finish(signal);
  if (propVisual.size > remaining()) throw new RangeError('Source assembly output limit exceeded');
  ownedOutput += propVisual.size;
  stage('packaging');
  const requirements: SourceLightingRequirement[] = [...world.requirements, ...props.requirements, ...entityCollision.requirements,
    ...worldResult.requirements, ...propResult.requirements,
    ...worldMaterials.requirements, ...propMaterials.requirements, ...sky.requirements];
  // Only the exact writer-resolved unlit faces lose their missing-bake requirement.
  const resolved = new Set(worldResult.resolvedUnlitFaces);
  const unresolved = (requirement: SourceLightingRequirement) => requirement.code !== 'face-without-baked-samples'
    || requirement.face === undefined || !resolved.has(requirement.face);
  const output = composeSourceMapFiles(physicsWorld, { ...lighting, requirements: lighting.requirements.filter(unresolved) },
    { ...assets, requirements: assets.requirements.filter(unresolved) }, {
      id: mapName, name, game, physics, visual, props: propVisual,
      renderer: lighting.identity.hdr ? null : { version: 1, color: 'ldr-gamma-lut', antialiasing: 'fxaa' },
      requirements: requirements.filter(unresolved), signal, maxOutputBytes: maxOutput,
      maxMetadataBytes: maxMetadata, maxMetadataAllocationBytes: maxAllocation,
    });
  // A positive worldspawn minpropscreenwidth force-fades every placement whose model
  // lacks STUDIOHDR_FLAGS_NO_FORCED_FADE (0x800): the same unqualified display path
  // that per-placement prop-fade-runtime refuses.
  const levelFade = output.manifest.source_prop_view?.levelScreenFade;
  let forcedFades = 0;
  if (levelFade && levelFade[0] > 0) for (const { placement } of propResult.placements)
    if (!((props.models.get(placement.modelPath)?.flags ?? 0) & 0x800)) forcedFades++;
  const admission = forcedFades ? [...output.requirements, Object.freeze({ code: 'prop-level-screen-fade-runtime', blocking: true as const,
    detail: `Worldspawn minpropscreenwidth ${levelFade![0]} force-fades ${forcedFades} props; forced screen fade requires qualified native camera/display integration.` })]
    : output.requirements;
  let outputBytes = 0;
  for (const blob of output.files.values()) outputBytes += blob.size;
  signal?.throwIfAborted();
  return { ...output, requirements: Object.freeze(admission), counts: { worldFaces: worldResult.faces.length, collision: physicsWorld.collision.length,
    props: propResult.placements.length, skyFaces: sky.faces.length, outputBytes } };
}
