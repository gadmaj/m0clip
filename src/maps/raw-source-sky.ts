/** Camera-centered Source 2D sky, not sky_camera/PVS geometry.
 * Plane/UV conventions follow scripts/source_extras.py and noclip.website Main.ts
 * (Copyright 2018 Jasper St. Pierre, MIT; LICENSE.noclip). */
import type { SourceFrame } from './raw-source-geometry';
import type { SourceLightingRequirement } from './raw-source-lighting';
import { SourceGlb } from './raw-source-gltf';
import { SourceMaterialExport, type SourceSkyMaterial } from './raw-source-materials';

export interface SourceSkyOptions {
  signal?: AbortSignal;
  /** Sky-only accessor bytes/vertices; native texture and finished GLB caps belong
   * to the shared import-owned material exporter and SourceGlb respectively. */
  maxGeometryBytes?: number;
  maxVertices?: number;
}
export interface SourceSkyResult {
  faces: { suffix: string; node: number; material: number }[];
  requirements: SourceLightingRequirement[];
  geometryBytes: number;
  vertices: number;
}
const FACES = [['rt', 0x503], ['lf', 0x413], ['bk', 0x153], ['ft', 0x043], ['up', 0x205], ['dn', 0x304]] as const;
const CORNERS = [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const;
const GEOMETRY_BYTES = 6 * 4 * (3 + 3 + 2) * 4 + 6 * 2;

/** Append all six authored native faces to the owning props GLB. A missing or
 * unsupported face emits no sky nodes and retains a structured blocker. Material
 * resources already resolved in this import remain owned by its GLB. Configure
 * materials with this same import signal so its queued reads/decodes cancel too. */
export async function appendSourceSky(glb: SourceGlb, materials: SourceMaterialExport,
  frame: Pick<SourceFrame, 'yaw'>, skyName: string | null, options: SourceSkyOptions = {}): Promise<SourceSkyResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  const result: SourceSkyResult = { faces: [], requirements: [], geometryBytes: 0, vertices: 0 };
  if (!Number.isFinite(frame.yaw)) throw new Error('Invalid Source sky world yaw');
  if (!skyName) return result; // No authored ordinary sky is not an invented one.
  if (skyName.length > 1024) throw new Error('Source sky name exceeds path limit');
  const maxBytes = options.maxGeometryBytes ?? GEOMETRY_BYTES, maxVertices = options.maxVertices ?? 24;
  if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(maxVertices) || maxBytes < GEOMETRY_BYTES || maxVertices < 24)
    throw new Error('Source sky geometry limit exceeded');
  const bindings: SourceSkyMaterial[] = [];
  for (const [suffix] of FACES) {
    signal?.throwIfAborted();
    const name = `skybox/${skyName}${suffix}`;
    const binding = await materials.skyMaterial(name);
    signal?.throwIfAborted();
    if (binding) bindings.push(binding);
  }
  // Material diagnostics include selected texture paths, not just the six VMTs.
  // The import is transactional: preserving all current material blockers avoids
  // hiding cached texture errors shared with a previously encountered face.
  result.requirements = materials.requirements.slice();
  if (bindings.length !== 6) {
    if (!result.requirements.length) result.requirements.push({ code: 'sky-incomplete', blocking: true,
      detail: 'The authored sky needs six selected native face materials and textures.' });
    return result;
  }
  signal?.throwIfAborted();
  const indices = glb.accessor(new Uint16Array([0, 2, 1, 0, 3, 2]), 'SCALAR', { target: 34963 });
  const theta = -frame.yaw * Math.PI / 180, cos = Math.cos(theta), sin = Math.sin(theta);
  for (let fi = 0; fi < FACES.length; fi++) {
    signal?.throwIfAborted();
    const [suffix, plane] = FACES[fi], { material, transform } = bindings[fi];
    const positions = new Float32Array(12), normals = new Float32Array(12), uv = new Float32Array(8);
    for (let i = 0; i < CORNERS.length; i++) {
      const [s, t] = CORNERS[i], g = [-s, s, -t, t, -1, 1];
      const x = g[plane >> 8 & 15], y = g[plane >> 4 & 15], z = g[plane & 15];
      positions[i * 3] = cos * x - sin * y; positions[i * 3 + 1] = sin * x + cos * y; positions[i * 3 + 2] = z;
      // The cube has unit half-extent, with inward face normals. No Source unit
      // scaling or spawn translation: Scene centers each sky node on its camera.
      const nx = -g[plane >> 8 & 15], ny = -g[plane >> 4 & 15];
      // Constant face axis is encoded by nibble 4/5, not the varying corners.
      const ax = (plane >> 8 & 15) >= 4 ? nx : 0, ay = (plane >> 4 & 15) >= 4 ? ny : 0;
      normals[i * 3] = cos * ax - sin * ay; normals[i * 3 + 1] = sin * ax + cos * ay;
      normals[i * 3 + 2] = (plane & 15) >= 4 ? -z : 0;
      const u = Math.max(1 / 512, Math.min(511 / 512, s * .5 + .5));
      const v = Math.max(1 / 512, Math.min(511 / 512, 1 - (t * .5 + .5)));
      uv[i * 2] = transform[0] * u + transform[1] * v + transform[2];
      uv[i * 2 + 1] = transform[3] * u + transform[4] * v + transform[5];
    }
    const mesh = glb.json.meshes.length;
    glb.json.meshes.push({ name: `sky:${suffix}`, primitives: [{ attributes: {
      POSITION: glb.accessor(positions, 'VEC3', { target: 34962, bounds: true }),
      NORMAL: glb.accessor(normals, 'VEC3', { target: 34962 }), TEXCOORD_0: glb.accessor(uv, 'VEC2', { target: 34962 }),
    }, indices, material }] });
    const node = glb.json.nodes.length;
    glb.json.nodes.push({ name: `sky:${suffix}`, mesh, extras: { sourceSky: true, sourceSkyTextureTransform: [...transform] } });
    glb.json.scenes[glb.json.scene].nodes.push(node);
    result.faces.push({ suffix, node, material });
  }
  result.geometryBytes = GEOMETRY_BYTES; result.vertices = 24;
  return result;
}
