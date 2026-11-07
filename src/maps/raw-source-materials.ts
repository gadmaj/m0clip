/** Native material assets for the existing Source renderer. No network or substitute textures.
 * Source material/VTF conventions: noclip.website (Jasper St. Pierre, MIT; LICENSE.noclip).
 */
import { canonicalSourcePath, type SourceFileSystem } from './raw-source-files';
import { createSourceMaterialResolver, SourceMaterialBudget, sourceMaterialPath, type ResolvedSourceMaterial, type SourceMaterialOptions } from './raw-source-vmt';
import { readSourceVtf, type SourceVtf } from './raw-source-vtf';
import { sourceVtfPixelKind } from './raw-source-vtf-codec';
import { SourceGlb, type SourceGltfRoot } from './raw-source-gltf';
import { encodeSourcePng } from './raw-source-png';
import { compileSourceTemporalProxies } from '../render/source-material-proxies';

type MaterialRecord = SourceGltfRoot['materials'][number];
export interface SourceMaterialRequirement { code: string; path: string; detail: string; blocking: true }
export interface SourceMaterialExportOptions extends SourceMaterialOptions {
  maxInputBytes?: number;
  maxMaterials?: number;
  maxTextures?: number;
  /** Decoded top level plus its encoded slice; retained GLB outputs have their own cap. */
  maxTextureWorkingBytes?: number;
}
export interface SourceSkyMaterial {
  readonly material: number;
  /** Baked after the sky seam clamp, not applied a second time by the renderer. */
  readonly transform: readonly number[];
}
const TEXTURE_EXTENSION = 'M0CLIP_texture_vtf';
const EFFECT_TEXTURES: Readonly<Record<string, string>> = {
  $bumpmap: 'bumpmapIndex', $envmapmask: 'envmapmaskIndex',
  $phongexponenttexture: 'phongexponenttextureIndex', $selfillummask: 'selfillummaskIndex',
  $basetexture2: 'basetexture2Index', $detail: 'detailIndex',
};
const NON_RENDER_PARAMETERS: Readonly<Record<string, true>> = {
  $surfaceprop: true, $surfaceprop2: true, $keywords: true, $tooltexture: true,
};
const SKY_PARAMETERS: Readonly<Record<string, true>> = {
  $basetexture: true, $hdrbasetexture: true, $hdrcompressedtexture: true, $frame: true,
  $basetexturetransform: true, $color: true, $color2: true, $nofog: true, $ignorez: true, $nocull: true,
};
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Invalid Source material resource limit');
  return result;
}

/** One exporter belongs to one import and one GLB. Missing resources and unsupported
 * behavior remain blockers for the caller's transaction; a partial GLB is not a map.
 */
export class SourceMaterialExport {
  readonly requirements: SourceMaterialRequirement[] = [];
  private readonly files = new Map<string, Promise<Blob | undefined>>();
  private readonly layouts = new Map<string, Promise<SourceVtf | undefined>>();
  private readonly payloads = new Map<string, Promise<number>>();
  private readonly textures = new Map<string, Promise<number | undefined>>();
  private readonly materials = new Map<string, Promise<number | undefined>>();
  private readonly skyMaterials = new Map<string, Promise<SourceSkyMaterial | undefined>>();
  private readonly descriptors = new Map<string, Promise<ResolvedSourceMaterial | undefined>>();
  private readonly originals: Record<string, unknown> = Object.create(null);
  private readonly maxInputBytes: number;
  private readonly maxMaterials: number;
  private readonly maxTextures: number;
  private readonly maxTextureWorkingBytes: number;
  private imageQueue:Promise<void>=Promise.resolve();
  private readQueue: Promise<void> = Promise.resolve();
  private readonly resolveMaterial: (name: string) => Promise<ResolvedSourceMaterial | undefined>;
  private readonly resourceBudget: SourceMaterialBudget;
  private inputBytes = 0;
  private readonly filesystem: Pick<SourceFileSystem, 'readFile'>;

  constructor(private readonly glb: SourceGlb, filesystem: Pick<SourceFileSystem, 'readFile'>,
    private readonly options: SourceMaterialExportOptions = {}) {
    this.maxInputBytes = limit(options.maxInputBytes, 512 * 1024 ** 2);
    this.maxMaterials = limit(options.maxMaterials, 16384);
    this.maxTextures = limit(options.maxTextures, 16384);
    this.maxTextureWorkingBytes=limit(options.maxTextureWorkingBytes,512*1024**2);
    this.filesystem = { readFile: (path, signal) => this.readFile(filesystem, path, signal) };
    this.resourceBudget = options.resourceBudget ?? new SourceMaterialBudget(options);
    this.resolveMaterial = createSourceMaterialResolver(this.filesystem, { ...options, resourceBudget: this.resourceBudget });
    glb.json.extras ??= {};
    if (Object.hasOwn(glb.json.extras, 'sourceMaterials')) throw new Error('A GLB already owns its Source material exporter');
    glb.json.extras.sourceMaterials = this.originals;
  }

  private block(code: string, path: string, detail: string): void {
    this.resourceBudget.reserve(1, 1, 128 + path.length * 2 + detail.length * 2);
    this.requirements.push({ code, path, detail, blocking: true });
  }

  private readFile(filesystem: Pick<SourceFileSystem, 'readFile'>, path: string, signal?: AbortSignal): Promise<Blob | undefined> {
    this.options.signal?.throwIfAborted(); signal?.throwIfAborted();
    path = canonicalSourcePath(path);
    let pending = this.files.get(path);
    if (!pending) {
      // Unknown selected-resource sizes cannot safely share the remaining quota.
      // Queue unique extractions; pending callers own no decompressed body yet.
      pending = this.readQueue.then(async () => {
        this.options.signal?.throwIfAborted(); signal?.throwIfAborted();
        const allowance = this.maxInputBytes - this.inputBytes;
        const blob = await filesystem.readFile(path, signal ?? this.options.signal, allowance);
        this.options.signal?.throwIfAborted(); signal?.throwIfAborted();
        if (blob) {
          if (blob.size > allowance) throw new Error('Source material input byte limit exceeded');
          this.inputBytes += blob.size;
        }
        return blob;
      });
      this.readQueue = pending.then(() => {}, () => {});
      this.files.set(path, pending);
    }
    return pending;
  }

  private layout(path: string): Promise<SourceVtf | undefined> {
    let pending = this.layouts.get(path);
    if (!pending) {
      pending = this.filesystem.readFile(path, this.options.signal).then(async blob => {
        if (!blob) { this.block('missing-texture', path, 'Select the local game file containing this texture.'); return undefined; }
        return readSourceVtf(blob, this.options.signal);
      });
      this.layouts.set(path, pending);
    }
    return pending;
  }

  /** Native face order, exact authored frame. Original VTF is embedded once even
   * when multiple frames/faces are used. HDR and signed data never become byte PNGs.
   */
  texture(path: string, frame = 0, face = 0): Promise<number | undefined> {
    this.options.signal?.throwIfAborted();
    path = canonicalSourcePath(path);
    if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isSafeInteger(face) || face < 0 || face > 5) throw new Error(`Invalid Source texture frame/face: ${path}`);
    const key = `${path}\0${frame}\0${face}`;
    let pending = this.textures.get(key);
    if (!pending) {
      if (this.textures.size >= this.maxTextures) throw new Error('Source texture variant limit exceeded');
      pending = this.encodeTexture(path, frame, face);
      this.textures.set(key, pending);
    }
    return pending;
  }

  private payload(path:string):Promise<number>{
    let pending=this.payloads.get(path);
    if(!pending){
      pending=this.filesystem.readFile(path,this.options.signal).then(blob=>{
        if(!blob)throw new Error(`Selected Source texture disappeared: ${path}`);
        return this.glb.view(blob);
      });
      this.payloads.set(path,pending);
    }
    return pending;
  }

  private byteImage(layout:SourceVtf,frame:number,face:number,path:string):Promise<Blob|undefined>{
    const {width,height,format}=layout.header,bytePixels=sourceVtfPixelKind(format)==='byte';
    const decodedBytes=width*height*(bytePixels?4:16),workingBytes=decodedBytes+layout.levels[0].sliceBytes;
    if(workingBytes>this.maxTextureWorkingBytes)throw new Error(`Source texture working byte limit exceeded: ${path}`);
    if(!bytePixels)return Promise.resolve(undefined); // Native-only float texture: no wasted/clamping decode.
    if((width*4+1)*height>1024**3)throw new Error(`Source PNG filtered byte limit exceeded: ${path}`);
    // At most one decoded image is reachable during conversion, regardless of
    // concurrent materials. Native payloads and completed images stay immutable.
    const pending=this.imageQueue.then(async()=>{
      this.options.signal?.throwIfAborted();
      const pixels=await layout.decode({frame,face,mip:0},this.options.signal);
      if(!(pixels.data instanceof Uint8Array))throw new Error(`Source texture pixel representation differs: ${path}`);
      return encodeSourcePng(width,height,pixels.data,this.options.signal);
    });
    this.imageQueue=pending.then(()=>{},()=>{});
    return pending;
  }

  private async encodeTexture(path: string, frame: number, face: number): Promise<number | undefined> {
    const layout = await this.layout(path);
    if (!layout) return undefined;
    if (layout.header.depth !== 1) {
      this.block('volume-texture-runtime', path, `Native GPU volume upload is required for depth ${layout.header.depth}; no slice was substituted.`);
      return undefined;
    }
    if(frame>=layout.header.frames||face>=layout.header.faces)throw new Error(`Source texture frame/face out of range: ${path}`);
    const png=await this.byteImage(layout,frame,face,path);
    const json = this.glb.json;
    const payload=await this.payload(path);
    let image: number | undefined;
    if (png) {
      image = json.images.length;
      json.images.push({ bufferView: this.glb.view(png), mimeType: 'image/png' });
    }
    const flags = layout.header.flags, point = !!(flags & 1), noMip = !!(flags & 256) || layout.header.mipCount === 1;
    const trilinear = !!(flags & 2) || !!(flags & 16) && !point;
    const sampler = { wrapS: flags & 4 ? 33071 : 10497, wrapT: flags & 8 ? 33071 : 10497,
      magFilter: point ? 9728 : 9729, minFilter: noMip ? point ? 9728 : 9729 : point ? trilinear ? 9986 : 9984 : trilinear ? 9987 : 9985 };
    let samplerIndex = json.samplers.findIndex(s => s.wrapS === sampler.wrapS && s.wrapT === sampler.wrapT && s.magFilter === sampler.magFilter && s.minFilter === sampler.minFilter);
    if (samplerIndex < 0) { samplerIndex = json.samplers.length; json.samplers.push(sampler); }
    const index = json.textures.length;
    json.textures.push({ name: path, sampler: samplerIndex, ...(image === undefined ? {} : { source: image }),
      extensions: { [TEXTURE_EXTENSION]: { path, bufferView: payload, frame, face } } });
    json.extensionsUsed ??= [];
    if (!json.extensionsUsed.includes(TEXTURE_EXTENSION)) json.extensionsUsed.push(TEXTURE_EXTENSION);
    if (image === undefined) {
      json.extensionsRequired ??= [];
      if (!json.extensionsRequired.includes(TEXTURE_EXTENSION)) json.extensionsRequired.push(TEXTURE_EXTENSION);
    }
    return index;
  }

  /** Cubemap bindings are caller-selected from the actual BSP/prop position, not
   * guessed by basename. Geometry/lightmap variants remain the scene assembler's job.
   */
  material(name: string, localCubeFaces?: readonly number[]): Promise<number | undefined> {
    this.options.signal?.throwIfAborted();
    const path = sourceMaterialPath(name);
    if (localCubeFaces && (localCubeFaces.length !== 6 || localCubeFaces.some(i => !Number.isSafeInteger(i) || i < 0 || i >= this.glb.json.textures.length))) throw new Error('Invalid native Source cubemap bindings');
    const key = localCubeFaces ? `${path}\0${localCubeFaces.join(',')}` : path;
    let pending = this.materials.get(key);
    if (!pending) {
      if (this.materials.size + this.skyMaterials.size >= this.maxMaterials) throw new Error('Source material variant limit exceeded');
      pending = this.encodeMaterial(path, localCubeFaces?.slice());
      this.materials.set(key, pending);
    }
    return pending;
  }

  /** Ordinary camera-centered sky only. Compressed HDR needs a different native
   * four-tap shader; binding its RGB bytes as a generic sky would be incorrect. */
  skyMaterial(name: string): Promise<SourceSkyMaterial | undefined> {
    this.options.signal?.throwIfAborted();
    const path = sourceMaterialPath(name);
    let pending = this.skyMaterials.get(path);
    if (!pending) {
      if (this.materials.size + this.skyMaterials.size >= this.maxMaterials) throw new Error('Source material variant limit exceeded');
      pending = this.encodeSkyMaterial(path);
      this.skyMaterials.set(path, pending);
    }
    return pending;
  }

  private async encodeSkyMaterial(path: string): Promise<SourceSkyMaterial | undefined> {
    let pending = this.descriptors.get(path);
    if (!pending) { pending = this.resolveMaterial(path); this.descriptors.set(path, pending); }
    const descriptor = await pending;
    this.options.signal?.throwIfAborted();
    if (!descriptor) { this.block('missing-material', path, 'Select the local game file containing this sky material.'); return undefined; }
    this.originals[path] = { shader: descriptor.shader, sources: descriptor.sources, parameters: descriptor.parameters,
      proxies: descriptor.proxies, fallbackBlocks: descriptor.fallbackBlocks, selectedFallback: descriptor.selectedFallback,
      capability: descriptor.capability };
    const start = this.requirements.length, parameters = descriptor.parameters;
    if (!['sky', 'unlitgeneric', 'sdk_unlitgeneric'].includes(descriptor.shader))
      this.block('sky-shader-runtime', path, `Native sky shader ${descriptor.shader} is not implemented.`);
    if (descriptor.proxies.length) this.block('sky-proxy-runtime', path, 'Authored sky proxies require native evaluation.');
    for (const parameter of Object.keys(parameters)) if (!Object.hasOwn(SKY_PARAMETERS, parameter) && !Object.hasOwn(NON_RENDER_PARAMETERS, parameter) && !parameter.startsWith('$compile'))
      this.block('sky-parameter-runtime', path, `Authored sky parameter ${parameter} requires native interpretation.`);
    for (const issue of descriptor.capability.issues) {
      if (['shader', 'parameter', 'proxies'].includes(issue.code)) continue;
      this.block(`sky-${issue.code}-runtime`, path, issue.detail);
    }
    // Never substitute LDR when an authored HDR resource is missing/unsupported.
    const compressed = parameters.$hdrcompressedtexture?.trim();
    if (compressed) {
      this.block('sky-hdr-compressed-runtime', path, 'Authored compressed HDR sky requires alpha-weighted four-tap sampling and an eightfold color scale.');
      return undefined;
    }
    const textureName = parameters.$hdrbasetexture?.trim() || parameters.$basetexture?.trim();
    if (!textureName) { this.block('sky-missing-base-texture', path, 'This sky material has no authored base texture.'); return undefined; }
    if (textureName.toLowerCase().startsWith('_rt_') || textureName.toLowerCase() === 'env_cubemap') {
      this.block('sky-texture-runtime', path, `Sky texture ${textureName} is not a selected local 2D image.`);
      return undefined;
    }
    const texturePath = sourceMaterialPath(textureName, 'vtf'), frame = Number(descriptor.metadata.frame);
    const color2 = descriptor.shader === 'sky' ? [1, 1, 1] : descriptor.metadata.color2 as readonly number[];
    const color = descriptor.metadata.color.map((value, i) => value * color2[i]);
    if (color.length !== 3 || color.some(value => !Number.isFinite(value) || value < 0 || value > 1))
      this.block('sky-hdr-tint-runtime', path, 'Authored sky tint exceeds the glTF color factor range; no clamped color was substituted.');
    if (!Number.isSafeInteger(frame) || frame < 0)
      this.block('sky-texture-frame', path, `Authored sky frame ${frame} is not a static nonnegative frame.`);
    if (this.requirements.length !== start) return undefined;
    let layout: SourceVtf | undefined;
    try { layout = await this.layout(texturePath); }
    catch (error) {
      this.options.signal?.throwIfAborted();
      // Binary/codec diagnostics retain their exact reason. VFS, allocation and
      // cancellation errors propagate; they are never discarded as missing files.
      if (!(error instanceof Error) || !error.message.startsWith('Source VTF:')) throw error;
      this.block('sky-texture-format', texturePath, error.message);
      return undefined;
    }
    this.options.signal?.throwIfAborted();
    if (!layout) return undefined;
    if (layout.header.faces !== 1 || layout.header.depth !== 1 || layout.header.colorSpace === 'signed-normalized') {
      this.block('sky-texture-dimensionality', texturePath, 'Sky faces require native unsigned or HDR 2D images; no cubemap, volume slice or signed normal map was substituted.');
      return undefined;
    }
    if (frame >= layout.header.frames) {
      this.block('sky-texture-frame', texturePath, `Authored sky frame ${frame} exceeds ${layout.header.frames} native frames.`);
      return undefined;
    }
    const texture = await this.texture(texturePath, frame);
    this.options.signal?.throwIfAborted();
    if (texture === undefined) return undefined;
    const material = this.glb.json.materials.length;
    this.glb.json.materials.push({ name: path, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1,
      baseColorFactor: [...color, 1], baseColorTexture: { index: texture } },
      doubleSided: descriptor.metadata.nocull, alphaMode: 'OPAQUE',
      extras: { sourceVertexLighting: 1, sourceUnlit: true } });
    return { material, transform: descriptor.transforms.$basetexturetransform?.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  }

  private async encodeMaterial(path: string, localCubeFaces?: readonly number[]): Promise<number | undefined> {
    let pending = this.descriptors.get(path);
    if (!pending) { pending = this.resolveMaterial(path); this.descriptors.set(path, pending); }
    const descriptor = await pending;
    if (!descriptor) { this.block('missing-material', path, 'Select the local game file containing this material.'); return undefined; }
    this.originals[path] = { shader: descriptor.shader, sources: descriptor.sources, parameters: descriptor.parameters,
      proxies: descriptor.proxies, fallbackBlocks: descriptor.fallbackBlocks, selectedFallback: descriptor.selectedFallback,
      capability: descriptor.capability };
    if (descriptor.capability.shaderFamily !== 'generic') this.block('material-shader-runtime', path, `Native shader ${descriptor.shader} is not implemented by the existing renderer.`);
    const temporal = compileSourceTemporalProxies(descriptor,
      detail => this.block('material-proxy-runtime', path, detail),
      (work, entries, bytes) => this.resourceBudget.reserve(work, entries, bytes));
    for (const parameter of descriptor.capability.unknownParameters) if (!Object.hasOwn(NON_RENDER_PARAMETERS, parameter) && !parameter.startsWith('$compile'))
      this.block('material-parameter-runtime', path, `Authored ${parameter} requires native interpretation.`);
    for(const issue of descriptor.capability.issues){
      if(issue.code==='shader'||issue.code==='parameter'||issue.code==='proxies'||issue.code==='render-target'||issue.code==='local-cubemap')continue;
      this.block(`material-${issue.code}-runtime`,path,issue.detail);
    }
    const meta: Record<string, unknown> = { ...descriptor.metadata };
    if (temporal.operations.length) meta.temporalProxies = temporal;
    const color2=descriptor.metadata.color2;
    const factor=[...descriptor.metadata.color.map((v,i)=>v*(Array.isArray(color2)?color2[i]:1)),Number(descriptor.metadata.alpha??1)];
    if(factor.length!==4||factor.some(v=>!Number.isFinite(v)||v<0||v>1)){
      this.block('material-hdr-tint-runtime',path,'Authored tint/alpha is outside the core glTF factor range; original values are retained without clamping.');
      return undefined;
    }
    if(descriptor.metadata.alphatest&&(descriptor.metadata.alphatestreference<0||descriptor.metadata.alphatestreference>1)){
      this.block('material-alpha-cutoff-runtime',path,'Authored alpha-test threshold is outside the core glTF range.');
      return undefined;
    }
    for(const flag of ['ignorez','znearer','decal','selfillumfresnel','vertexalpha'])if(descriptor.metadata[flag])
      this.block('material-flag-runtime',path,`Authored $${flag} requires native shader/state support.`);
    const base=descriptor.textures.find(texture=>texture.parameter==='$basetexture'&&texture.kind==='file');
    const baseLayout=base?.path?await this.layout(base.path):undefined;
    const alphaTexture=!!baseLayout&&!!(baseLayout.header.flags&0x3000)&&descriptor.metadata.translucent
      &&!descriptor.metadata.selfillum&&!descriptor.metadata.basealphaenvmapmask&&!descriptor.metadata.opaquetexture;
    const translucent=alphaTexture||!!descriptor.metadata.vertexalpha;
    if(descriptor.metadata.alphatest)meta.additive=false; // Native alpha-test branch wins over additive state.
    else if(descriptor.metadata.additive&&!translucent)this.block('material-additive-runtime',path,'Native one-plus-one additive blending is distinct from alpha-weighted glow and requires native blend-state support.');
    const record: MaterialRecord = { name: path, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: .85,
      baseColorFactor: factor },
      doubleSided: descriptor.metadata.nocull, alphaMode: descriptor.metadata.alphatest ? 'MASK' : translucent || descriptor.metadata.additive ? 'BLEND' : 'OPAQUE',
      extras: { sourceMaterial: meta, sourceUnlit: descriptor.metadata.unlit, sourceSelfIllum: !!descriptor.metadata.selfillum,
        sourceSelfIllumTint: descriptor.metadata.selfillumtint } };
    if (descriptor.metadata.alphatest) record.alphaCutoff = descriptor.metadata.alphatestreference;
    for (const texture of descriptor.textures) {
      if(!Number.isInteger(texture.frame)||texture.frame<0)continue;
      if (texture.kind === 'runtime') { this.block('material-render-target-runtime', path, `Authored ${texture.parameter} needs ${texture.name}.`); continue; }
      if (texture.kind === 'local-cubemap') {
        if(texture.parameter!=='$envmap')this.block('material-local-cubemap',path,`Authored ${texture.parameter} cannot use an envmap binding.`);
        else if (localCubeFaces) meta.envmapFaces = localCubeFaces;
        else this.block('material-local-cubemap', path, 'Bind the actual BSP-local cubemap for this surface or prop.');
        continue;
      }
      if (!texture.path) throw new Error(`Source texture path missing: ${path} ${texture.parameter}`);
      if (texture.parameter === '$envmap') {
        const layout=await this.layout(texture.path);
        if(!layout)continue;
        // Shipped Source materials can assign a spherical/2D envmap. Native
        // ParameterTexture.fetch disables it rather than pretending it has faces.
        if(layout.header.faces!==6){meta.envmap='';continue;}
        const faces: number[] = [];
        for (let face = 0; face < 6; face++) { const index = await this.texture(texture.path, texture.frame, face); if (index !== undefined) faces.push(index); }
        if (faces.length === 6) meta.envmapFaces = faces;
        continue;
      }
      if (texture.parameter !== '$basetexture' && !Object.hasOwn(EFFECT_TEXTURES, texture.parameter)) {
        this.block('material-texture-runtime', path, `Authored ${texture.parameter} has no native resource binding.`); continue;
      }
      const layout=await this.layout(texture.path);
      if(!layout)continue;
      if(layout.header.faces!==1){
        this.block('material-texture-dimensionality',path,`Authored ${texture.parameter} requires a 2D texture; a cubemap face was not substituted.`);
        continue;
      }
      const index = await this.texture(texture.path, texture.frame);
      if (index === undefined) continue;
      if (texture.parameter === '$basetexture') record.pbrMetallicRoughness!.baseColorTexture = { index };
      else { meta[EFFECT_TEXTURES[texture.parameter]] = index; if (texture.parameter === '$bumpmap') record.normalTexture = { index }; }
      if (texture.parameter === '$basetexture' && temporal.operations.some(operation => operation.kind === 'animatedtexture')) {
        const frames: number[] = [];
        this.resourceBudget.reserve(layout.header.frames, layout.header.frames, 32 + layout.header.frames * 8);
        for (let frame = 0; frame < layout.header.frames; frame++) {
          const animated = await this.texture(texture.path, frame);
          if (animated !== undefined) frames.push(animated);
        }
        if (frames.length === layout.header.frames) meta.animationFrames = frames;
      }
    }
    if(!descriptor.textures.some(texture=>texture.parameter==='$basetexture')&&Array.isArray(meta.envmapFaces))
      factor.fill(0,0,3); // Native envmap-only material binds black diffuse, not white.
    this.options.signal?.throwIfAborted();
    const index = this.glb.json.materials.length;
    this.glb.json.materials.push(record);
    return index;
  }
}
