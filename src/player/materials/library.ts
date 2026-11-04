/** Source model materials (VMT + VTF) from the person's selected game files, as Three materials.
 *
 * Scope: static VertexLitGeneric and UnlitGeneric, the shaders of Source player and weapon
 * models. Every authored parameter is either rendered, recorded as having no effect on m0clip's
 * renderer (with the reason), or refused by name. Other shaders, including CS:GO's CustomWeapon
 * paint kits, are refused; nothing falls back to a flat, error or generic material, and no file is
 * fetched from anywhere but the selected game files.
 *
 * The result is the base Source state of the material: albedo texture, $color × $color2 modulation,
 * $alpha, alpha test or Source blend mode, and $nocull. Source lighting, bump, Phong, self-illum and
 * reflections are the job of render/source-materials.ts patchSourceMaterial: `describe(material)`
 * returns the metadata (also in material.userData.sourceMaterial, in the form that function reads),
 * the decoded textures as its MaterialResources, an explicit cube map when the VMT names one, and
 * live proxy values. Until it is patched, a VertexLitGeneric material shows unlit albedo.
 *
 * UV convention: textures upload VTF rows top first with flipY off (also the only option for S3TC),
 * so pixel row 0 is v = 0. Source Studio geometry already uses v growing downward; keep those UVs
 * unchanged. Flipping one side alone (glTF-style 1 − v, or flipY) would mirror every texture and
 * the green channel of every normal map.
 *
 * Ownership: materials and textures are shared. Loading the same resolved VMT returns the same
 * material, and a VTF used by several materials in the same color space is one texture. The
 * library owns all of them; dispose() frees them together. Don't dispose them individually. */
import * as THREE from 'three';
import type { LocalGameContent, LocalGameRead } from '../assets/local-content';
import { canonicalSourcePath } from '../assets/local-content';
import type { MaterialResources } from '../../render/source-materials';
import { decodeSourceMip, sourceNativeCube } from '../../render/source-vtf';
import { readMaterialFile, SourceMaterialError } from './errors';
import { resolveSourceMaterial, sourceMaterialPath, type ResolvedSourceMaterial, type SourceMaterialParameter, type SourceMaterialProfile } from './vmt';
import { readSourceVtf, SourceVtfError, SUPPORTED_VTF_FORMATS, VTF_BLOCK_FORMATS, vtfFormatName, VtfFlags, type SourceVtf, type SourceVtfHeader } from './vtf';

/** The parts of THREE.WebGLRenderer used to choose S3TC upload and anisotropy. */
export interface SourceTextureCapabilities {
  readonly extensions: { has(name: string): boolean };
  readonly capabilities: { getMaxAnisotropy(): number };
}

export interface SourceMaterialLibraryOptions {
  readonly content: LocalGameContent;
  readonly renderer: SourceTextureCapabilities;
  /** Fallback-block profile. Default DirectX level 95 without HDR. */
  readonly profile?: Partial<SourceMaterialProfile>;
  /** Parameters that aren't listed for the shader: refuse the material (default), or load it and
   * list them in the descriptor, as Source does when it ignores a parameter a shader doesn't define. */
  readonly unrecognizedParameters?: 'refuse' | 'record';
}

export type SourceTextureRole = 'basetexture' | 'bumpmap' | 'envmapmask' | 'phongexponenttexture' | 'selfillummask' | 'detail' | 'envmap';

export interface SourceTextureDescriptor {
  readonly role: SourceTextureRole;
  /** Authored parameter value. */
  readonly authored: string;
  readonly path: string;
  readonly frame: number;
  /** Face 0–5 for cube-map faces, else 0. */
  readonly face: number;
  readonly colorSpace: string;
  /** Uploaded as S3TC blocks; otherwise decoded to RGBA8 with every authored mip kept. */
  readonly compressed: boolean;
  readonly header: SourceVtfHeader;
  readonly file: LocalGameRead;
}

export type SourceBlendMode = 'opaque' | 'alpha-test' | 'blend' | 'add' | 'glow';

export type SourceMaterialRequirement =
  /** VertexLitGeneric needs patchSourceMaterial with the model's Source lighting. */
  | 'source-lighting'
  /** $envmap env_cubemap: the scene's nearest cube map must be passed to patchSourceMaterial. */
  | 'scene-cubemap'
  /** A Sine proxy drives $selfillumtint: bind live.selfillumtint and call update() each frame. */
  | 'live-selfillumtint';

export interface SourceMaterialDescriptor {
  /** The first request that resolved to this VMT. Later requests reaching the same file share the
   * material and this descriptor. */
  readonly requested: Readonly<{ name: string; searchDirectories: readonly string[] }>;
  /** VMT paths tried, in order; the first one present was used. */
  readonly searched: readonly string[];
  readonly path: string;
  readonly shader: 'vertexlitgeneric' | 'unlitgeneric';
  readonly material: ResolvedSourceMaterial;
  readonly profile: SourceMaterialProfile;
  /** Parameters the renderer uses. */
  readonly rendered: readonly SourceMaterialParameter[];
  /** Parameters with no effect on this renderer, each with the reason. */
  readonly noEffect: readonly Readonly<{ parameter: SourceMaterialParameter; reason: string }>[];
  /** Parameters at their Source default that m0clip couldn't render otherwise. */
  readonly atDefault: readonly SourceMaterialParameter[];
  /** Only with unrecognizedParameters: 'record'. */
  readonly unrecognized: readonly SourceMaterialParameter[];
  readonly textures: readonly SourceTextureDescriptor[];
  readonly blend: SourceBlendMode;
  readonly requires: readonly SourceMaterialRequirement[];
  /** For patchSourceMaterial. Textures are owned by the library. */
  readonly resources: MaterialResources;
  /** An explicit $envmap cube map (not env_cubemap). */
  readonly cube: THREE.CubeTexture | null;
  /** Values proxies change over time; update() writes them in place. */
  readonly live: Readonly<{ selfillumtint?: THREE.Vector3 }>;
  /** Every game file this material read, with its SHA-256 and source. */
  readonly files: readonly LocalGameRead[];
}

type Kind = 'bool' | 'number' | 'int' | 'vector' | 'texture' | 'transform' | 'string';

/** Material flags every shader parses (MATERIAL_VAR_*), and how each reaches the renderer. */
const FLAGS: Readonly<Record<string, 'render' | 'none' | 'refuse'>> = {
  $translucent: 'render', $additive: 'render', $alphatest: 'render', $nocull: 'render', $halflambert: 'render',
  $selfillum: 'render', $basealphaenvmapmask: 'render', $normalmapalphaenvmapmask: 'render', $opaquetexture: 'render',
  $model: 'none', $nofog: 'none', $nodecal: 'none', $suppress_decals: 'none', $no_debug_override: 'none', $no_fullbright: 'none',
  $vertexcolor: 'refuse', $vertexalpha: 'refuse', $envmapsphere: 'refuse', $envmapcameraspace: 'refuse', $ignorez: 'refuse',
  $wireframe: 'refuse', $znearer: 'refuse', $noalphamod: 'refuse', $decal: 'refuse', $multipass: 'refuse', $flat: 'refuse',
  $allowalphatocoverage: 'refuse', $ignore_alpha_modulation: 'refuse', $selfillum_envmapmask_alpha: 'refuse',
};

const NO_EFFECT_REASON: Readonly<Record<string, string>> = {
  $model: 'marks a Studio model material; m0clip already renders it as one',
  $nofog: 'm0clip\'s Source materials render without fog',
  $nodecal: 'm0clip doesn\'t project decals onto models',
  $suppress_decals: 'm0clip doesn\'t project decals onto models',
  $no_debug_override: 'affects Source\'s debug views only',
  $no_fullbright: 'affects Source\'s mat_fullbright debug view only',
  $surfaceprop: 'a physics and sound surface, not a render parameter',
  $keywords: 'editor search keywords',
};

/** Parameters rendered (or carried for patchSourceMaterial) per shader, with their value kinds. */
const COMMON: Readonly<Record<string, Kind>> = {
  $basetexture: 'texture', $frame: 'int', $color: 'vector', $color2: 'vector', $alpha: 'number', $alphatestreference: 'number',
  $envmap: 'texture', $envmapframe: 'int', $envmaptint: 'vector', $envmapcontrast: 'number', $envmapsaturation: 'number',
  $envmapmask: 'texture', $envmapmaskframe: 'int',
  $detail: 'texture', $detailframe: 'int', $detailscale: 'number', $detailblendfactor: 'number', $detailblendmode: 'int',
  $surfaceprop: 'string',
};
const VERTEXLIT: Readonly<Record<string, Kind>> = {
  ...COMMON, $selfillumtint: 'vector', $selfillummask: 'texture', $bumpmap: 'texture', $bumpframe: 'int', $envmaplightscale: 'number',
  $phong: 'bool', $phongboost: 'number', $phongexponent: 'number', $phongexponenttexture: 'texture', $phongexponentfactor: 'number',
  $phongfresnelranges: 'vector', $phongtint: 'vector', $phongalbedotint: 'bool', $phongalbedoboost: 'number',
  $basemapalphaphongmask: 'bool', $invertphongmask: 'bool',
};

/** Source parameters m0clip can't render yet. Accepted only at their Source default. */
const AT_DEFAULT_ONLY: Readonly<Record<string, readonly [Kind, number | string]>> = {
  $basetexturetransform: ['transform', ''], $bumptransform: ['transform', ''], $envmapmasktransform: ['transform', ''],
  $detailtexturetransform: ['transform', ''], $detailtint: ['vector', 1], $srgbtint: ['vector', 1], $envmapfresnel: ['number', 0],
  $fresnelreflection: ['number', 1], $lightwarptexture: ['texture', ''], $phongwarptexture: ['texture', ''], $rimlight: ['bool', 0],
  $rimlightexponent: ['number', 4], $rimlightboost: ['number', 1], $rimmask: ['bool', 0], $selfillumfresnel: ['bool', 0],
  $selfillumfresnelminmaxexp: ['string', ''], $flashlighttexture: ['texture', ''], $flashlighttextureframe: ['int', 0],
  $decaltexture: ['texture', ''], $decalblendmode: ['number', -1], $blendtintbybasealpha: ['bool', 0], $blendtintcoloroverbase: ['number', 0],
  $tintmasktexture: ['texture', ''], $treesway: ['bool', 0], $seamless_base: ['bool', 0], $seamless_detail: ['bool', 0], $seamless_scale: ['number', 0],
  $ssbump: ['bool', 0], $nodiffusebumplighting: ['bool', 0], $bumpmap2: ['texture', ''], $basetexture2: ['texture', ''],
  $rendermode: ['number', 0], $linearwrite: ['bool', 0], $gammacolorread: ['bool', 0], $ambientonly: ['bool', 0], $depthblend: ['bool', 0],
  $cloakpassenabled: ['bool', 0], $emissiveblendenabled: ['bool', 0], $fleshinteriorenabled: ['bool', 0], $detail_alpha_mask_base_texture: ['bool', 0],
  $outline: ['bool', 0], $softedges: ['bool', 0], $phongdisablehalflambert: ['bool', 0], $receiveflashlight: ['bool', 0],
};

const SINE_PARAMETERS: Readonly<Record<string, true>> = { resultvar: true, sinemin: true, sinemax: true, sineperiod: true, timeoffset: true };
const TEXTURE_ORDER: Readonly<Record<SourceTextureRole, number>> = {
  basetexture: 0, bumpmap: 1, envmapmask: 2, phongexponenttexture: 3, selfillummask: 4, detail: 5, envmap: 6,
};

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function parameterError(material: string, p: SourceMaterialParameter, detail: string): never {
  throw new SourceMaterialError('invalid-material', p.file, `Source material ${material}: ${p.key} "${p.value}" (${p.file} line ${p.line}) ${detail}`);
}
function parseNumber(material: string, p: SourceMaterialParameter): number {
  const text = p.value.trim();
  if (!NUMBER.test(text)) parameterError(material, p, 'isn\'t a number.');
  return Number(text);
}
function parseVector(material: string, p: SourceMaterialParameter, length: number): number[] {
  const text = p.value.trim(), scale = text.startsWith('{') ? 1 / 255 : 1;
  const parts = text.replace(/[[\]{}]/g, ' ').trim().split(/\s+/);
  if (!parts.every(part => NUMBER.test(part)) || (parts.length !== 1 && parts.length !== length))
    parameterError(material, p, `isn't a ${length}-component vector.`);
  const values = parts.map(part => Number(part) * scale);
  return values.length === 1 ? new Array<number>(length).fill(values[0]) : values;
}
function isIdentityTransform(material: string, p: SourceMaterialParameter): boolean {
  const words = p.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const values: Record<string, number[]> = { center: [0.5, 0.5], scale: [1, 1], rotate: [0], translate: [0, 0] };
  for (let i = 0; i < words.length;) {
    const mode = words[i++];
    if (!(mode in values)) parameterError(material, p, 'isn\'t a Source texture transform.');
    const numbers: number[] = [];
    while (i < words.length && NUMBER.test(words[i])) numbers.push(Number(words[i++]));
    if (!numbers.length) parameterError(material, p, 'isn\'t a Source texture transform.');
    values[mode] = numbers;
  }
  const [sx, sy = sx] = values.scale, [tx, ty = tx] = values.translate;
  return sx === 1 && sy === 1 && values.rotate[0] % 360 === 0 && tx === 0 && ty === 0;
}

function isDefault(material: string, p: SourceMaterialParameter, kind: Kind, fallback: number | string): boolean {
  const text = p.value.trim();
  switch (kind) {
    case 'bool': case 'int': case 'number': return parseNumber(material, p) === fallback;
    case 'vector': return parseVector(material, p, 3).every(v => v === fallback);
    case 'transform': return !text || isIdentityTransform(material, p);
    default: return text === '';
  }
}

/** VTF path of a texture parameter: materials/<value>.vtf, with an authored '.vtf' accepted. */
function texturePath(material: string, p: SourceMaterialParameter): string {
  let value = p.value.trim();
  if (value.toLowerCase().endsWith('.vtf')) value = value.slice(0, -4);
  try { return canonicalSourcePath(`materials/${value}.vtf`); } catch (error) {
    throw new SourceMaterialError('invalid-material', p.file, `Source material ${material}: ${p.key} "${p.value}" (${p.file} line ${p.line}) isn't a usable texture path.`, { cause: error });
  }
}

interface LiveSine { target: THREE.Vector3; min: number; max: number; period: number; offset: number }
interface Entry { material: THREE.MeshBasicMaterial; descriptor: SourceMaterialDescriptor }

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
    error => { signal.removeEventListener('abort', abort); reject(error); });
  return raced;
}

export class SourceMaterialLibrary {
  readonly profile: SourceMaterialProfile;
  private readonly content: LocalGameContent;
  private readonly renderer: SourceTextureCapabilities;
  private readonly unrecognizedMode: 'refuse' | 'record';
  private readonly lifetime = new AbortController();
  private readonly materials = new Map<string, Promise<Entry>>();
  private readonly files = new Map<string, Promise<SourceVtf>>();
  private readonly textures = new Map<string, Promise<THREE.CompressedTexture>>();
  private readonly owned = new Set<{ dispose(): void }>();
  private readonly descriptors = new WeakMap<THREE.Material, SourceMaterialDescriptor>();
  private readonly sines: LiveSine[] = [];

  constructor(options: SourceMaterialLibraryOptions) {
    this.content = options.content;
    this.renderer = options.renderer;
    this.profile = Object.freeze({ dxLevel: options.profile?.dxLevel ?? 95, hdr: options.profile?.hdr ?? false });
    this.unrecognizedMode = options.unrecognizedParameters ?? 'refuse';
  }

  get disposed(): boolean { return this.lifetime.signal.aborted; }

  /** Loads `name` the way Studio models look up materials: materials/<directory><name>.vmt for each
   * search directory in order ($cdmaterials, concatenated as authored), first file present wins.
   * Without directories, `name` is relative to materials/. Rejects with SourceMaterialError. */
  async load(name: string, searchDirectories: readonly string[] = [], signal?: AbortSignal): Promise<THREE.MeshBasicMaterial> {
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    const directories = searchDirectories.length ? searchDirectories : [''];
    const searched: string[] = [];
    for (const directory of directories) {
      let path: string;
      try { path = sourceMaterialPath(`${directory}${name}`); } catch (error) {
        throw new SourceMaterialError('invalid-material', `${directory}${name}`, `Material "${directory}${name}" isn't a usable Source path.`, { cause: error });
      }
      if (!searched.includes(path)) searched.push(path);
    }
    const path = searched.find(candidate => this.content.has(candidate));
    if (!path) throw new SourceMaterialError('missing-material', searched[0],
      `Material "${name}" isn't in the selected game files. Looked for ${searched.join(', ')}.`);
    let entry = this.materials.get(path);
    if (!entry) {
      const requested = Object.freeze({ name, searchDirectories: Object.freeze([...searchDirectories]) });
      entry = this.build(path, requested, Object.freeze(searched));
      this.materials.set(path, entry);
      entry.catch(() => { if (this.materials.get(path) === entry) this.materials.delete(path); });
    }
    return (await abortable(entry, signal)).material;
  }

  describe(material: THREE.Material): SourceMaterialDescriptor | undefined { return this.descriptors.get(material); }

  /** Writes proxy values for `seconds` of Source time. Allocation-free. */
  update(seconds: number): void {
    for (const sine of this.sines) {
      const v = sine.min + (sine.max - sine.min) * (Math.sin(2 * Math.PI * (seconds - sine.offset) / sine.period) * 0.5 + 0.5);
      sine.target.set(v, v, v);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.lifetime.abort(new DOMException('The Source material library was disposed.', 'AbortError'));
    for (const resource of this.owned) resource.dispose();
    this.owned.clear();
    this.materials.clear();
    this.textures.clear();
    this.files.clear();
    this.sines.length = 0;
  }

  private own<T extends { dispose(): void }>(resource: T): T {
    if (this.disposed) { resource.dispose(); this.lifetime.signal.throwIfAborted(); }
    this.owned.add(resource);
    return resource;
  }

  private vtf(path: string, wanted: string): Promise<SourceVtf> {
    let file = this.files.get(path);
    if (!file) {
      file = readMaterialFile(this.content, path, 'missing-texture', wanted, this.lifetime.signal).then(bytes => {
        try { return readSourceVtf(path, bytes); } catch (error) {
          if (error instanceof SourceVtfError) throw new SourceMaterialError(error.unsupported ? 'unsupported-texture' : 'invalid-texture', path, error.message, { cause: error });
          throw error;
        }
      });
      this.files.set(path, file);
      file.catch(() => { if (this.files.get(path) === file) this.files.delete(path); });
    }
    return file;
  }

  private texture(vtf: SourceVtf, frame: number, face: number, colorSpace: string, wanted: string): Promise<THREE.CompressedTexture> {
    const key = `${vtf.path}#${frame}#${face}#${colorSpace}`;
    let texture = this.textures.get(key);
    if (!texture) {
      texture = Promise.resolve().then(() => this.own(this.createTexture(vtf, frame, face, colorSpace, wanted)));
      this.textures.set(key, texture);
      texture.catch(() => { if (this.textures.get(key) === texture) this.textures.delete(key); });
    }
    return texture;
  }

  private createTexture(vtf: SourceVtf, frame: number, face: number, colorSpace: string, wanted: string): THREE.CompressedTexture {
    const { header } = vtf;
    if (!SUPPORTED_VTF_FORMATS.has(header.format))
      throw new SourceMaterialError('unsupported-texture', vtf.path,
        `${wanted} uses ${vtf.path}, stored as ${header.formatName}, which m0clip can't decode yet.`);
    if (frame >= header.frames || face >= header.faces)
      throw new SourceMaterialError('invalid-material', vtf.path,
        `${wanted} asks for frame ${frame}${header.faces > 1 ? `, face ${face}` : ''} of ${vtf.path}, which has ${header.frames} frame${header.frames === 1 ? '' : 's'}.`);
    const levels = vtf.levels(frame, face);
    const ext = this.renderer.extensions;
    const compressed = VTF_BLOCK_FORMATS.has(header.format) && ext.has('WEBGL_compressed_texture_s3tc')
      && (colorSpace !== THREE.SRGBColorSpace || ext.has('WEBGL_compressed_texture_s3tc_srgb'));
    // DXT1 keeps D3D's 1-bit alpha (3-colour blocks decode index 3 as transparent black) on both paths.
    const format = !compressed ? THREE.RGBAFormat : header.format === 14 ? THREE.RGBA_S3TC_DXT3_Format
      : header.format === 15 ? THREE.RGBA_S3TC_DXT5_Format : THREE.RGBA_S3TC_DXT1_Format;
    const mipmaps = compressed ? levels.map(level => ({ width: level.width, height: level.height, data: level.data }))
      : levels.map(level => decodeSourceMip({ width: level.width, height: level.height, data: level.data }, header.format));
    const texture = new THREE.CompressedTexture(mipmaps, header.width, header.height);
    (texture as THREE.Texture).format = format;
    texture.name = vtf.path;
    texture.colorSpace = colorSpace;
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.wrapS = header.flags & VtfFlags.CLAMPS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.wrapT = header.flags & VtfFlags.CLAMPT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    const point = !!(header.flags & VtfFlags.POINTSAMPLE), noMip = !!(header.flags & VtfFlags.NOMIP) || header.mipCount === 1;
    texture.magFilter = point ? THREE.NearestFilter : THREE.LinearFilter;
    texture.minFilter = noMip ? texture.magFilter : point ? THREE.NearestMipmapLinearFilter : THREE.LinearMipmapLinearFilter;
    texture.anisotropy = !point && !noMip ? Math.min(16, this.renderer.capabilities.getMaxAnisotropy()) : 1;
    texture.userData = {
      sourceNativeTexture: { path: vtf.path, frame, face, format: header.format, levels: levels.length, compressed },
      sourceTexture: { formatName: vtfFormatName(header.format), version: `7.${header.version[1]}`, flags: header.flagNames, rowOrder: 'top-first', flipY: false },
    };
    texture.needsUpdate = true;
    return texture;
  }

  private async build(path: string, requested: SourceMaterialDescriptor['requested'], searched: readonly string[]): Promise<Entry> {
    const signal = this.lifetime.signal;
    const material = await resolveSourceMaterial(this.content, path, this.profile, `Material ${path}`, signal);
    const wanted = `Material ${path}`;
    if (material.shader === 'customweapon')
      throw new SourceMaterialError('paint-kit-required', path,
        `${path} uses CS:GO's CustomWeapon shader. Its finish is composited from a paint kit (items_game.txt) and its pattern, wear and mask textures, which m0clip doesn't composite. It isn't shown as a plain or substitute material.`);
    if (material.shader !== 'vertexlitgeneric' && material.shader !== 'unlitgeneric')
      throw new SourceMaterialError('unsupported-shader', path,
        `${path} uses the ${material.authoredShader} shader. m0clip renders VertexLitGeneric and UnlitGeneric model materials only.`);
    const shader: 'vertexlitgeneric' | 'unlitgeneric' = material.shader;
    const known = shader === 'vertexlitgeneric' ? VERTEXLIT : COMMON;
    const rendered: SourceMaterialParameter[] = [], atDefault: SourceMaterialParameter[] = [], unrecognized: SourceMaterialParameter[] = [];
    const noEffect: { parameter: SourceMaterialParameter; reason: string }[] = [];
    const values = material.parameters;

    for (const p of values.values()) {
      if (p.name.startsWith('%')) { noEffect.push({ parameter: p, reason: p.name === '%keywords' ? NO_EFFECT_REASON.$keywords : 'a tool-only (%) parameter Source ignores at run time' }); continue; }
      const flag = FLAGS[p.name];
      if (flag) {
        const on = parseNumber(path, p) !== 0;
        if (flag === 'refuse' && on)
          throw new SourceMaterialError('unsupported-parameter', p.file, `${path} sets ${p.key} (${p.file} line ${p.line}), which m0clip can't render yet.`);
        if (flag === 'none') noEffect.push({ parameter: p, reason: NO_EFFECT_REASON[p.name] });
        else if (flag === 'refuse') atDefault.push(p);
        else if (shader === 'unlitgeneric' && (p.name === '$halflambert' || p.name === '$normalmapalphaenvmapmask'))
          noEffect.push({ parameter: p, reason: `UnlitGeneric has no ${p.name === '$halflambert' ? 'lighting' : 'bump map'}` });
        else rendered.push(p);
        continue;
      }
      if (known[p.name]) {
        if (p.name === '$surfaceprop') noEffect.push({ parameter: p, reason: NO_EFFECT_REASON.$surfaceprop });
        else rendered.push(p);
        continue;
      }
      const limited = AT_DEFAULT_ONLY[p.name];
      if (limited) {
        if (!isDefault(path, p, limited[0], limited[1]))
          throw new SourceMaterialError('unsupported-parameter', p.file, `${path} sets ${p.key} "${p.value}" (${p.file} line ${p.line}), which m0clip can't render yet.`);
        atDefault.push(p);
        continue;
      }
      if (this.unrecognizedMode === 'refuse')
        throw new SourceMaterialError('unsupported-parameter', p.file,
          `${path} sets ${p.key} (${p.file} line ${p.line}), which m0clip doesn't know for ${material.authoredShader}. If ${material.authoredShader} doesn't define it, Source ignores it; load with unrecognizedParameters: 'record' to do the same.`);
      unrecognized.push(p);
    }

    const get = (name: string) => values.get(name);
    const num = (name: string, fallback: number) => { const p = get(name); return p ? parseNumber(path, p) : fallback; };
    const int = (name: string) => {
      const p = get(name); if (!p) return 0;
      const v = parseNumber(path, p);
      if (!Number.isInteger(v) || v < 0) parameterError(path, p, 'isn\'t a frame number.');
      return v;
    };
    const on = (name: string) => { const p = get(name); return !!p && parseNumber(path, p) !== 0; };
    const vec = (name: string, fallback: number[]) => { const p = get(name); return p ? parseVector(path, p, fallback.length) : fallback; };

    const detailMode = int('$detailblendmode');
    if (get('$detail') && detailMode !== 0)
      throw new SourceMaterialError('unsupported-parameter', path, `${path} uses $detailblendmode ${detailMode}; m0clip renders detail mode 0 only.`);
    const saturation = get('$envmapsaturation');
    if (saturation) {
      const s = parseVector(path, saturation, 3);
      if (s[0] !== s[1] || s[1] !== s[2]) parameterError(path, saturation, 'has different values per channel, which m0clip can\'t render yet.');
    }

    // Proxies: only Sine writing $selfillumtint (the proxy on Source's model self-illum lights).
    const sines: LiveSine[] = [];
    let liveTint: THREE.Vector3 | undefined;
    for (const proxy of material.proxies) {
      if (proxy.name !== 'sine')
        throw new SourceMaterialError('unsupported-proxy', proxy.file, `${path} uses the ${proxy.key} proxy (${proxy.file} line ${proxy.line}), which m0clip doesn't evaluate.`);
      for (const key of proxy.parameters.keys()) if (!SINE_PARAMETERS[key])
        throw new SourceMaterialError('unsupported-proxy', proxy.file, `${path}: the ${proxy.key} proxy (line ${proxy.line}) sets ${key}, which m0clip doesn't evaluate.`);
      const result = (proxy.parameters.get('resultvar') ?? '').trim().toLowerCase();
      if (result !== '$selfillumtint' || shader !== 'vertexlitgeneric')
        throw new SourceMaterialError('unsupported-proxy', proxy.file, `${path}: the ${proxy.key} proxy (line ${proxy.line}) writes ${result || 'nothing'}; m0clip drives only $selfillumtint on VertexLitGeneric.`);
      const literal = (key: string, fallback: number) => {
        const text = proxy.parameters.get(key)?.trim();
        if (text === undefined) return fallback;
        if (!NUMBER.test(text)) throw new SourceMaterialError('unsupported-proxy', proxy.file, `${path}: the ${proxy.key} proxy's ${key} "${text}" isn't a number; variable inputs aren't evaluated.`);
        return Number(text);
      };
      const sine = { target: liveTint ??= new THREE.Vector3(), min: literal('sinemin', 0), max: literal('sinemax', 1), period: literal('sineperiod', 1), offset: literal('timeoffset', 0) };
      if (!(sine.period > 0)) throw new SourceMaterialError('unsupported-proxy', proxy.file, `${path}: the ${proxy.key} proxy's sineperiod must be positive.`);
      sines.push(sine);
    }
    if (sines.length > 1) throw new SourceMaterialError('unsupported-proxy', path, `${path} has ${sines.length} proxies writing $selfillumtint; Source's evaluation order isn't reproduced.`);

    // Textures. Base and cube maps are sRGB; masks, normals, exponents and detail are linear.
    const textures: SourceTextureDescriptor[] = [];
    const loadTexture = async (role: SourceTextureRole, frameParam: string, colorSpace: string) => {
      const p = get(`$${role}`);
      if (!p || !p.value.trim()) return undefined;
      const file = texturePath(path, p);
      const vtf = await this.vtf(file, `${wanted} (${p.key})`);
      const frame = frameParam ? int(frameParam) : 0;
      const texture = await this.texture(vtf, frame, 0, colorSpace, `${wanted} (${p.key})`);
      textures.push(Object.freeze({ role, authored: p.value, path: file, frame, face: 0, colorSpace,
        compressed: texture.userData.sourceNativeTexture.compressed, header: vtf.header, file: this.closureOf(file) }));
      return { texture, vtf };
    };
    const lit = shader === 'vertexlitgeneric';
    const envmapParam = get('$envmap');
    const envmap = envmapParam?.value.trim() ?? '';
    const sceneCube = envmap.toLowerCase() === 'env_cubemap';
    const [base, bump, mask, exponent, selfIllumMask, detail, cube] = await Promise.all([
      loadTexture('basetexture', '$frame', THREE.SRGBColorSpace),
      lit ? loadTexture('bumpmap', '$bumpframe', THREE.NoColorSpace) : undefined,
      loadTexture('envmapmask', '$envmapmaskframe', THREE.NoColorSpace),
      lit ? loadTexture('phongexponenttexture', '', THREE.NoColorSpace) : undefined,
      lit ? loadTexture('selfillummask', '', THREE.NoColorSpace) : undefined,
      loadTexture('detail', '$detailframe', THREE.NoColorSpace),
      (async () => {
        if (!envmapParam || !envmap || sceneCube) return null;
        const file = texturePath(path, envmapParam);
        const vtf = await this.vtf(file, `${wanted} ($envmap)`);
        if (vtf.header.faces !== 6) throw new SourceMaterialError('invalid-texture', file, `${wanted} uses ${file} as $envmap, but it isn't a cube map.`);
        const frame = int('$envmapframe');
        const faces = await Promise.all([0, 1, 2, 3, 4, 5].map(face => this.texture(vtf, frame, face, THREE.SRGBColorSpace, `${wanted} ($envmap)`)));
        for (let face = 0; face < 6; face++) textures.push(Object.freeze({ role: 'envmap' as const, authored: envmapParam.value, path: file, frame, face,
          colorSpace: THREE.SRGBColorSpace, compressed: faces[face].userData.sourceNativeTexture.compressed, header: vtf.header, file: this.closureOf(file) }));
        return this.own(sourceNativeCube(faces));
      })(),
    ]);
    signal.throwIfAborted();
    textures.sort((a, b) => TEXTURE_ORDER[a.role] - TEXTURE_ORDER[b.role] || a.face - b.face);

    // Blend state (noclip MaterialBase textureIsTranslucent / getAlphaBlendMode).
    const alphaTest = on('$alphatest');
    const translucentTexture = !!base && on('$translucent') && !on('$opaquetexture') && !on('$selfillum') && !on('$basealphaenvmapmask')
      && !!(base.vtf.header.flags & (VtfFlags.ONEBITALPHA | VtfFlags.EIGHTBITALPHA));
    const alpha = num('$alpha', 1);
    const translucent = !alphaTest && (translucentTexture || alpha < 1);
    const additive = on('$additive');
    const blend: SourceBlendMode = alphaTest ? 'alpha-test' : translucent && additive ? 'glow' : additive ? 'add' : translucent ? 'blend' : 'opaque';

    const [r, g, b] = vec('$color', [1, 1, 1]), [r2, g2, b2] = vec('$color2', [1, 1, 1]);
    for (const name of ['$color', '$color2']) if (vec(name, [1, 1, 1]).some(v => v < 0)) parameterError(path, get(name)!, 'has a negative channel.');
    // Source modulation colours are gamma-space; the shader works in linear (noclip fillGammaColor).
    const color = new THREE.Color().setRGB((r * r2) ** 2.2, (g * g2) ** 2.2, (b * b2) ** 2.2, THREE.LinearSRGBColorSpace);
    const result = new THREE.MeshBasicMaterial({
      name: path, color, map: base?.texture ?? null, opacity: alpha, transparent: blend === 'blend' || blend === 'add' || blend === 'glow',
      alphaTest: alphaTest ? num('$alphatestreference', 0.7) : 0, side: on('$nocull') ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: blend === 'opaque' || blend === 'alpha-test', toneMapped: false, fog: false,
    });
    if (blend === 'blend') result.blending = THREE.NormalBlending;
    else if (blend === 'glow') result.blending = THREE.AdditiveBlending;
    else if (blend === 'add') {
      result.blending = THREE.CustomBlending;
      result.blendEquation = THREE.AddEquation;
      result.blendSrc = THREE.OneFactor;
      result.blendDst = THREE.OneFactor;
    }

    const selfillumtint = vec('$selfillumtint', [1, 1, 1]);
    const metadata: Record<string, unknown> = {
      source: 'local-vmt', path, shader, basetexture: get('$basetexture')?.value ?? '', alphatest: alphaTest,
      alphatestreference: num('$alphatestreference', 0.7), translucent: on('$translucent'), selfillum: lit && on('$selfillum'),
      unlit: !lit, halflambert: lit && (on('$halflambert') || on('$phong')), nocull: on('$nocull'), additive,
      selfillumtint, color: [r, g, b], color2: [r2, g2, b2], alpha, ssbump: false, nodiffusebumplighting: false,
      envmap, envmaptint: vec('$envmaptint', [1, 1, 1]), envmapcontrast: num('$envmapcontrast', 0),
      envmapsaturation: saturation ? parseVector(path, saturation, 3)[0] : 1, envmaplightscale: lit ? num('$envmaplightscale', 0) : 0,
      normalmapalphaenvmapmask: lit && !!bump && on('$normalmapalphaenvmapmask'), basealphaenvmapmask: on('$basealphaenvmapmask'),
      phong: lit && on('$phong'), phongboost: num('$phongboost', 1), phongexponent: num('$phongexponent', 5),
      phongexponentfactor: num('$phongexponentfactor', 149), phongfresnelranges: vec('$phongfresnelranges', [0, 0.5, 1]),
      phongtint: vec('$phongtint', [1, 1, 1]), basealphaphongmask: on('$basemapalphaphongmask'), phongalbedotint: on('$phongalbedotint'),
      phongalbedoboost: num('$phongalbedoboost', 1), phongmaskinvert: on('$invertphongmask'), blend,
    };
    for (const role of ['bumpmap', 'envmapmask', 'phongexponenttexture', 'selfillummask', 'detail'] as const)
      if (textures.some(texture => texture.role === role)) metadata[role] = get(`$${role}`)!.value;
    if (detail) Object.assign(metadata, { detailscale: num('$detailscale', 4), detailblendfactor: num('$detailblendfactor', 1), detailblendmode: 0 });
    result.userData.sourceMaterial = metadata;
    if (liveTint) {
      // Source evaluates proxies before drawing; start from t = 0.
      const first = sines[0];
      const v = first.min + (first.max - first.min) * (Math.sin(2 * Math.PI * -first.offset / first.period) * 0.5 + 0.5);
      liveTint.set(v, v, v);
    }

    const requires: SourceMaterialRequirement[] = [];
    if (lit) requires.push('source-lighting');
    if (sceneCube) requires.push('scene-cubemap');
    if (liveTint) requires.push('live-selfillumtint');
    const chainFiles = material.chain.map(file => this.closureOf(file));
    const textureFiles = [...new Set(textures.map(texture => texture.path))].map(file => this.closureOf(file));
    const descriptor: SourceMaterialDescriptor = Object.freeze({
      requested, searched, path, shader, material, profile: this.profile,
      rendered: Object.freeze(rendered), noEffect: Object.freeze(noEffect.map(entry => Object.freeze(entry))), atDefault: Object.freeze(atDefault),
      unrecognized: Object.freeze(unrecognized), textures: Object.freeze(textures), blend, requires: Object.freeze(requires),
      resources: Object.freeze({ normal: bump?.texture, mask: mask?.texture, exponent: exponent?.texture, selfIllum: selfIllumMask?.texture, detail: detail?.texture }),
      cube, live: Object.freeze(liveTint ? { selfillumtint: liveTint } : {}), files: Object.freeze([...chainFiles, ...textureFiles]),
    });
    this.own(result);
    this.sines.push(...sines);
    this.descriptors.set(result, descriptor);
    return { material: result, descriptor };
  }

  private closureOf(path: string): LocalGameRead {
    const read = this.content.readClosure().find(entry => entry.path === path);
    if (!read) throw new Error(`Source material library: ${path} was used without being read.`);
    return read;
  }
}
