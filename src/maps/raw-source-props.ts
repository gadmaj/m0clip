// Adapted from noclip.website StaticDetailObject.ts (Copyright 2018 Jasper
// St. Pierre, MIT; see LICENSE.noclip) and scripts/import_source_props.py.
import type { SourceWorld, SourceFrame, SourceSurface } from './raw-source-geometry';
import type { SourceBspReservation, SourceEntity } from './raw-source-bsp';
import type { SourceLightingRequirement } from './raw-source-lighting';
import type { SourceFileSystem } from './raw-source-files';
import { decodeValveLzma, sourceAbort, sourceLzmaWorkingBytes } from './raw-source-lzma';
import { SourceModelBinary as Binary, sourceModelPath, sourceQAngle, sourceModelMultiply, sourceModelPoint, type SourceModelVector } from './raw-source-model-binary';
import { SourceStudioImport, SourceStudioMissingResourceError, type SourceStudioModel, type SourceStudioOptions } from './raw-source-studio';
export { sourceQAngle } from './raw-source-model-binary';

export interface SourcePropPlacement {
  kind: 'static-prop' | 'entity-model'; index: number; entityIndex?: number;
  modelPath: string; classname: string;
  sourceOrigin: SourceModelVector; sourceAngles: SourceModelVector; scale: number;
  /** Column-major transform: MODEL-LOCAL METRES/Z-up -> world.frame METRES/Z-up.
   * Convert model vertices AND bone/inverse-bind translations by .0254 once
   * before applying this matrix. Rotation and authored modelscale are included;
   * metresPerUnit is NOT embedded in its linear part. */
  matrix: Float64Array; matrixInputUnits: 'metres';
  skin: number; body: number; solid: number; flags: number; flagsEx: number;
  /** Authored BSP leaf IDs, independent of current worldmodel reachability/PVS. */
  leaves: Uint16Array;
  /** Source point in Source units; framed point in metres, respectively. */
  sourceLightingOrigin?: SourceModelVector; worldLightingOrigin?: SourceModelVector;
  castShadow: boolean; fadeMinDistance: number; fadeMaxDistance: number; forcedFadeScale: number;
  /** Raw authored RGBA byte-domain modulation, not linear-light RGB. Fade
   * distances above remain Source units (including negative disable sentinels). */
  diffuseModulation: [number,number,number,number];
  dxLevels?: [number,number]; cpuLevels?: [number,number]; gpuLevels?: [number,number];
  lightmapResolution?: [number,number]; disableX360?: number;
  render: SourceEntityRender; animation?: SourceEntityAnimation;
  /** Exact entity including outputs, or exact owned static-prop record. */
  entity?: SourceEntity; rawBlob?: Blob;
}
export interface SourceEntityRender {
  mode: number; effect: number; color: SourceModelVector; amount: number;
  initiallyDisabled: boolean; renderFx: string; castShadow: boolean; receiveShadow: boolean;
}
export interface SourceEntityAnimation {
  defaultAnimation: string; sequence: string; cycle: number; playbackRate: number;
  skin: number; body: number; temporalSupport: 'authored-state-not-simulated';
}
export interface SourceBrushVisual {
  entityIndex: number; entity: SourceEntity; classname: string; model: number;
  sourceOrigin: SourceModelVector; sourceAngles: SourceModelVector;
  /** Apply to surfaces.positions, already model-native metres, exactly once. */
  matrix: Float64Array; matrixInputUnits: 'metres';
  sourceModelOrigin: SourceModelVector; bounds: [SourceModelVector,SourceModelVector];
  headnode: number; firstFace: number; faceCount: number; faces: Uint32Array;
  /** Shared per BSP model: positions are native metres; sourcePositions retain
   * original Source units for material/lightmap mapping. Normals/tangents are
   * Source-axis model-local, with no map origin/yaw baked. */
  surfaces: readonly SourceSurface[];
  baselineVisible: boolean; render: SourceEntityRender;
  capability: 'authored-brush-placement-only' | 'nonvisual-brush';
}
export interface SourceEntityVisual {
  entityIndex: number; entity: SourceEntity;
  kind: 'studio-model' | 'brush' | 'sprite' | 'rope' | 'environment' | 'unclassified';
  /** Every authored entity remains represented; these are not gameplay instances. */
  sourceOrigin: SourceModelVector; sourceAngles: SourceModelVector; render: SourceEntityRender;
}
export interface SourceGameLump {
  id: number; flags: number; version: number; absoluteOffset: number; length: number;
  rawBlob: Blob; decodedBlob: Blob;
}
export interface SourceProps {
  placements: readonly SourcePropPlacement[]; brushes: readonly SourceBrushVisual[];
  entities: readonly SourceEntityVisual[]; gameLumps: readonly SourceGameLump[];
  /** No missing-model mesh substitutes. Placements always retain their exact IDs. */
  models: ReadonlyMap<string, SourceStudioModel>;
  missingModels: readonly { path: string; resources: readonly string[] }[];
  missingMaterials: readonly { model: string; name: string; candidates: readonly string[] }[];
  missingAnimationResources: readonly { model: string; path: string }[];
  /** Completeness of model triplets, model VMT-file existence and ANI/include
   * resources ONLY. Resolving brush VMTs and all shader/texture dependencies is
   * the caller's separate requirement; never map-support qualification. */
  completeResources: boolean; frame: SourceFrame; originalBspBlob: Blob;
  /** Blocking admission for retained authored visual payloads this importer cannot
   * emit (populated detail objects, overlays). Never satisfied by limitations text. */
  requirements: readonly SourceLightingRequirement[];
  limitations: readonly string[];
}
export interface SourcePropsOptions extends SourceStudioOptions {
  /** Aggregate logical decoded payload bytes of ALL game lumps (each record is
   * also bounded by it). Retained copies and codec workspace are additionally
   * charged to the owning BSP import's aggregate ceilings before any read. */
  maxGameLumpBytes?: number;
  maxGameLumps?: number;
  /** Branches reused sprp version numbers with different layouts. Default follows
   * BSP19/20 TF2 vs BSP21/22 CS:GO, unless only the other branch's record size
   * fits the lump exactly; a lump neither size fits is refused, never guessed. */
  staticPropVariant?: 'source2007' | 'left4dead';
}

/** Explicit, testable frame seam shared by brush/model placement. */
export function sourcePropMatrix(frame: SourceFrame, origin: readonly number[], angles: readonly number[], scale = 1): Float64Array {
  if(!Number.isFinite(scale)||scale<=0||origin.length!==3||angles.length!==3||[...origin,...angles].some(v=>!Number.isFinite(v)))throw new Error('Invalid Source prop transform');
  const rotation=sourceQAngle([0,-frame.yaw,0]), local=sourceQAngle(angles);
  for(let c=0;c<3;c++)for(let r=0;r<3;r++)local[c*4+r]*=scale;
  const translation=sourceModelPoint(rotation,origin.map((v,i)=>(v-frame.origin[i])*frame.metresPerUnit));
  const matrix=sourceModelMultiply(rotation,local); matrix.set(translation,12);return matrix;
}
function scalar(values: Readonly<Record<string,string>>, key: string, fallback: number): number {
  const text=values[key];if(text===undefined||text==='')return fallback;const value=Number(text);if(!Number.isFinite(value))throw new Error(`Invalid Source entity ${key}: ${text}`);return value;
}
function vector(values: Readonly<Record<string,string>>, key: string, fallback: SourceModelVector=[0,0,0]): SourceModelVector {
  const text=values[key];if(!text)return [...fallback];const parts=text.trim().split(/\s+/).map(Number);if(parts.length!==3||parts.some(v=>!Number.isFinite(v)))throw new Error(`Invalid Source entity ${key}: ${text}`);return parts as SourceModelVector;
}
function integer(values: Readonly<Record<string,string>>,key:string,fallback:number):number{const n=scalar(values,key,fallback);if(!Number.isSafeInteger(n))throw new Error(`Invalid integer Source entity ${key}`);return n;}
function entityAngles(e: Readonly<Record<string,string>>): SourceModelVector {
  if(e.angles)return vector(e,'angles');const yaw=scalar(e,'angle',0);return yaw===-1?[-90,0,0]:yaw===-2?[90,0,0]:[0,yaw,0];
}
function entityRender(entity: SourceEntity): SourceEntityRender {
  const e=entity.values,color:SourceModelVector=[255,255,255];let amount=255;
  // Source applies both color32 and renderamt to the same alpha byte in key order.
  for(const [key,text] of entity.pairs){
    const suffix=key.indexOf('#'),name=(suffix<0?key:key.slice(0,suffix)).toLowerCase();
    if(name==='rendercolor'||name==='rendercolor32'){
      const parts=text.trim().split(/\s+/).map(Number);
      if((parts.length!==3&&parts.length!==4)||parts.some(v=>!Number.isFinite(v)))throw new Error(`Invalid Source entity ${key}: ${text}`);
      for(let i=0;i<3;i++)color[i]=Math.trunc(parts[i])&255;
      amount=parts.length===4?Math.trunc(parts[3])&255:255;
    }else if(name==='renderamt'){
      const value=Number(text);if(!Number.isFinite(value))throw new Error(`Invalid Source entity ${key}: ${text}`);
      amount=Math.trunc(value)&255;
    }
  }
  return {mode:integer(e,'rendermode',0),effect:integer(e,'renderfx',0),color,amount,initiallyDisabled:scalar(e,'StartDisabled',scalar(e,'startdisabled',0))!==0,renderFx:e.renderfx??'',castShadow:scalar(e,'disableshadows',0)===0,receiveShadow:scalar(e,'disablereceiveshadows',0)===0};
}
const staticRender=():SourceEntityRender=>({mode:0,effect:0,color:[255,255,255],amount:255,initiallyDisabled:false,renderFx:'',castShadow:true,receiveShadow:true});

const DETAIL_PROPS = 0x64707270, DETAIL_PROPS_VERSION = 4;
interface GameLumpEntry { id: number; flags: number; version: number; offset: number; length: number; end: number; stored: number; workspace: number }
/** Ownership of every record is validated and charged before any payload read:
 * aliased/overlapping records are refused, never multiplied or shared. */
async function gameLumps(world:SourceWorld,maximum:number,maxCount:number,signal?:AbortSignal):Promise<SourceGameLump[]> {
  const bsp=world.bsp,container=bsp.lumps[35],bytes=await bsp.getLump(35,signal);sourceAbort(signal);
  if(!bytes.length)return [];
  const table=new Binary(bytes,'BSP game-lump directory'),count=table.u(0);
  if(count>maxCount)throw new Error('Source game-lump count limit exceeded');
  table.range(4,count,16);
  // Offsets are absolute BSP positions; an outer-compressed container maps them
  // into its own decoded bytes, which the BSP import already owns.
  const inner=!!container.uncompressedSize,base=container.offset,payloadStart=base+4+count*16,limitEnd=inner?base+bytes.length:base+container.length;
  const entries:GameLumpEntry[]=[];
  for(let i=0;i<count;i++){
    const p=4+i*16,id=table.u(p),flags=table.h(p+4),version=table.h(p+6),offset=table.u(p+8),length=table.u(p+12);
    let end=offset+length;
    if(length){
      if(flags&~1)throw new Error(`Unsupported game-lump flags ${flags}`);
      // Compressed game lumps use uncompressed filelen; the next directory
      // offset (including Valve's empty sentinel) bounds their stored payload.
      if(flags&1){end=limitEnd;for(let j=0;j<count;j++){const next=table.u(4+j*16+8);if(next>offset&&next<end)end=next;}}
      if(length>maximum||end<offset||end-offset>maximum)throw new Error('Source game-lump allocation limit or invalid range');
      if(offset<payloadStart||end>limitEnd||(!inner&&end>bsp.file.size))throw new Error('Game-lump payload outside its container or overlapping the directory');
    }
    entries.push({id,flags,version,offset,length,end,stored:end-offset,workspace:0});
  }
  const owned=entries.filter(e=>e.length).sort((a,b)=>a.offset-b.offset);
  for(let i=1;i<owned.length;i++)if(owned[i].offset<owned[i-1].end)throw new Error('Aliased or overlapping Source game-lump payloads');
  // Bounded 17-byte headers fix each codec's exact workspace before any payload read.
  const compressed=owned.filter(e=>e.flags&1);
  const headerReservation=bsp.reserve(0,inner?0:compressed.length*17);
  try{
    for(const e of compressed){
      const header=inner?new DataView(bytes.buffer,bytes.byteOffset+e.offset-base,Math.min(17,e.end-e.offset)):new DataView(await bsp.file.slice(e.offset,Math.min(e.offset+17,e.end)).arrayBuffer());
      sourceAbort(signal);
      if(header.byteLength!==17||header.getUint32(0,true)!==0x414d5a4c)throw new Error('Invalid Valve LZMA game-lump header');
      const stored=17+header.getUint32(8,true),property=header.getUint8(12),dictionary=header.getUint32(13,true);
      // Padding may separate the next game lump; stored bytes never exceed the owned range.
      if(header.getUint32(4,true)!==e.length||stored>e.end-e.offset)throw new Error('Compressed game-lump size mismatch or stored bytes outside its range');
      if(property>=225||dictionary>maximum)throw new Error('Unsupported or excessive game-lump LZMA properties');
      e.stored=stored;e.workspace=sourceLzmaWorkingBytes(stored,stored,e.length,property,dictionary);
    }
    headerReservation.complete();
  }catch(error){headerReservation.fail(false);throw error;}
  // Decodes run sequentially, so one maximal workspace covers them; every
  // retained Blob copy (inner slices, decoded outputs) is charged in full.
  let logical=0,retained=0,workspace=0;
  for(const e of owned){
    logical+=e.length;
    if(inner)retained+=e.end-e.offset;
    if(e.flags&1){retained+=e.length;workspace=Math.max(workspace,e.workspace);}
  }
  if(logical>maximum)throw new Error('Source aggregate game-lump decoded limit exceeded');
  const reservation=bsp.reserve(retained,workspace),result:SourceGameLump[]=[];
  let codecStarted=false;
  try{
    for(const e of entries){
      sourceAbort(signal);
      if(!e.length){result.push({id:e.id,flags:e.flags,version:e.version,absoluteOffset:e.offset,length:0,rawBlob:new Blob(),decodedBlob:new Blob()});continue;}
      const rawBlob=inner?new Blob([bytes.subarray(e.offset-base,e.end-base)]):bsp.file.slice(e.offset,e.end);let decodedBlob=rawBlob;
      if(e.flags&1){
        const raw=new Uint8Array(await rawBlob.slice(0,e.stored).arrayBuffer());sourceAbort(signal);
        codecStarted=true;decodedBlob=new Blob([await decodeValveLzma(raw,e.length,maximum,signal)]);
      }
      result.push({id:e.id,flags:e.flags,version:e.version,absoluteOffset:e.offset,length:e.length,rawBlob,decodedBlob});
    }
    reservation.complete();
  }catch(error){reservation.fail(codecStarted);throw error;}
  return result;
}
/** Bounded count reads: object-free detail metadata draws nothing and is admitted;
 * populated or unrecognized payloads block; malformed layouts are refused. */
async function detailPropRequirement(lumps:readonly SourceGameLump[],signal?:AbortSignal):Promise<SourceLightingRequirement|undefined>{
  const matches=lumps.filter(l=>l.id===DETAIL_PROPS&&l.length);
  if(matches.length>1)throw new Error('Duplicate Source detail-prop game lump');
  if(!matches.length)return undefined;
  const blob=matches[0].decodedBlob,version=matches[0].version;
  if(version!==DETAIL_PROPS_VERSION)return {code:'detail-prop-runtime',blocking:true,detail:`Detail-prop game lump version ${version} (${blob.size} bytes) is unrecognized; no detail objects are emitted.`};
  const u32=async(p:number)=>{
    if(p+4>blob.size)throw new Error('Truncated Source detail-prop lump');
    const value=new DataView(await blob.slice(p,p+4).arrayBuffer()).getUint32(0,true);sourceAbort(signal);return value;
  };
  // DetailObjectDictLump_t 128 B, DetailSpriteDictLump_t 32 B, DetailObjectLump_t 52 B.
  const models=await u32(0),sprites=await u32(4+models*128),objects=await u32(8+models*128+sprites*32);
  if(12+models*128+sprites*32+objects*52!==blob.size)throw new Error('Invalid Source detail-prop lump layout');
  return objects?{code:'detail-prop-runtime',blocking:true,detail:`${objects} authored detail objects (${models} model and ${sprites} sprite dictionary entries) require detail-prop assembly; none are emitted.`}:undefined;
}
/** doverlay_t is 352 B; any populated overlay lump blocks admission. */
function overlayRequirement(world:SourceWorld):SourceLightingRequirement|undefined{
  const lump=world.bsp.lumps[45],size=lump.uncompressedSize||lump.length;
  if(!size)return undefined;
  if(lump.version===0&&size%352)throw new Error('Truncated Source overlay lump');
  return {code:'overlay-runtime',blocking:true,detail:lump.version===0?`${size/352} authored overlays require overlay assembly; none are emitted.`:`Overlay lump version ${lump.version} (${size} bytes) is unrecognized; no overlays are emitted.`};
}

/** Logical retained-ownership units, not engine heap metrics: one static-prop
 * record's placement object, vectors, matrix, render state and raw slice, and one
 * model path string. Authored leaf IDs are charged at 2 bytes each. */
const STATIC_PROP_RECORD_BYTES=2048,STATIC_PROP_NAME_BYTES=320;
/** Strict native sprp decoding; rejects unrecognized fork record sizes. The
 * plain clone is working capacity of the owning BSP import for its whole parse;
 * every retained name/record/leaf is charged to that import before allocation. */
export async function readSourceStaticProps(world: SourceWorld, lumps: readonly SourceGameLump[], options: SourcePropsOptions = {}): Promise<SourcePropPlacement[]> {
  const matches=lumps.filter(l=>l.id===0x73707270&&l.length);
  if(matches.length>1)throw new Error('Duplicate Source static-prop game lump');
  if(!matches.length)return [];
  const lump=matches[0],version=lump.version,bsp=world.bsp,signal=options.signal;
  if(version<4||version>11)throw new Error(`Unsupported Source static-prop version ${version}`);
  const working=bsp.reserve(0,lump.decodedBlob.size);
  let ownership:SourceBspReservation|undefined;
  try{
    const data=new Binary(new Uint8Array(await lump.decodedBlob.arrayBuffer()),'sprp');sourceAbort(signal);
    const nameCount=data.u(0);data.range(4,nameCount,128);
    let p=4+nameCount*128;const leafCount=data.u(p);p+=4;data.range(p,leafCount,2);const leafStart=p;p+=leafCount*2;
    const count=data.u(p);p+=4;
    const stride=(branch:'source2007'|'left4dead')=>56+(version>=5?4:0)+(version>=6&&version<=7?4:0)+(version>=8?4:0)+(branch==='left4dead'?((version>=7?4:0)+(version>=9?4:0)+(version>=10?4:0)+(version>=11?4:0)):(version>=7?8:0));
    let fork=options.staticPropVariant;
    if(!fork){
      // BSP19/20 conventionally carry TF2-lineage records and BSP21/22 L4D-lineage
      // ones. The one evidenced exception is L4D1: BSP20 with 68-byte version-8
      // L4D records. Other mismatches still refuse rather than guess a layout.
      const conventional=bsp.version>=21?'left4dead':'source2007',records=data.bytes.length-p;
      fork=bsp.version===20&&version===8&&count*stride(conventional)!==records&&count*stride('left4dead')===records?'left4dead':conventional;
    }
    const size=stride(fork);
    data.range(p,count,size);if(p+count*size!==data.bytes.length)throw new Error(`Unsupported sprp v${version}/${fork} record size; select the actual branch, not an inferred stride`);
    // Lean preflight: authored leaf ranges may be reused by any number of records,
    // so every record's own expansion is charged in full before anything is allocated.
    let leafIds=0;
    for(let i=0,q=p;i<count;i++,q+=size){
      if((i&65535)===65535){await new Promise<void>(resolve=>setTimeout(resolve,0));sourceAbort(signal);}
      const modelIndex=data.h(q+24),first=data.h(q+26),n=data.h(q+28);
      if(modelIndex>=nameCount||first>leafCount||n>leafCount-first)throw new Error('sprp model/leaf range out of bounds');
      leafIds+=n;
    }
    const retained=nameCount*STATIC_PROP_NAME_BYTES+count*STATIC_PROP_RECORD_BYTES+leafIds*2;
    if(!Number.isSafeInteger(retained))throw new Error('Source static-prop ownership exceeds the safe integer range');
    // Validate authored leaf IDs against the original BSP, not just reachable leaves.
    const leafBytes=await bsp.getLump(10,signal),leafStride=bsp.lumps[10].version===0?56:32,totalLeaves=leafBytes.length/leafStride;
    if(!Number.isInteger(totalLeaves))throw new Error('Malformed BSP leaves for prop visibility');
    sourceAbort(signal);ownership=bsp.reserve(retained,0);
    const names:string[]=[];
    for(let i=0;i<nameCount;i++)names.push(sourceModelPath(data.string(4+i*128,128)));
    const props:SourcePropPlacement[]=[];
    const worldFrameMatrix=sourcePropMatrix(world.frame,[0,0,0],[0,0,0]);
    for(let i=0;i<count;i++){
      if((i&1023)===0){if(i)await new Promise<void>(resolve=>setTimeout(resolve,0));sourceAbort(signal);}
      const start=p,origin=data.vec(p),angles=data.vec(p+12),modelIndex=data.h(p+24),first=data.h(p+26),n=data.h(p+28),solid=data.b(p+30);let flags=data.b(p+31);
      const leaves=new Uint16Array(n);for(let j=0;j<n;j++){leaves[j]=data.h(leafStart+(first+j)*2);if(leaves[j]>=totalLeaves)throw new Error('sprp BSP leaf index out of bounds');}
      const skin=data.i(p+32),fadeMinDistance=data.f(p+36),fadeMaxDistance=data.f(p+40);p+=56;
      let forcedFadeScale=1,flagsEx=0,scale=1,dxLevels:SourcePropPlacement['dxLevels'],cpuLevels:SourcePropPlacement['cpuLevels'],gpuLevels:SourcePropPlacement['gpuLevels'],lightmapResolution:SourcePropPlacement['lightmapResolution'],disableX360:number|undefined;
      const diffuseModulation:SourcePropPlacement['diffuseModulation']=[255,255,255,255];
      if(version>=5){forcedFadeScale=data.f(p);p+=4;}
      if(version>=6&&version<=7){dxLevels=[data.h(p),data.h(p+2)];p+=4;}
      if(version>=8){cpuLevels=[data.b(p),data.b(p+1)];gpuLevels=[data.b(p+2),data.b(p+3)];p+=4;}
      if(fork==='left4dead'){
        if(version>=7){for(let k=0;k<4;k++)diffuseModulation[k]=data.b(p+k);p+=4;}
        if(version>=9){disableX360=data.u(p);p+=4;}
        if(version>=10){flagsEx=data.u(p);p+=4;}
        if(version>=11){scale=data.f(p);p+=4;}
      }else if(version>=7){flags=data.u(p);lightmapResolution=[data.h(p+4),data.h(p+6)];p+=8;}
      const sourceLightingOrigin=flags&2?data.vec(start+44):undefined,render=staticRender();render.castShadow=!(flags&16);
      props.push({kind:'static-prop',index:i,modelPath:names[modelIndex],classname:'prop_static',sourceOrigin:origin,sourceAngles:angles,scale,matrix:sourcePropMatrix(world.frame,origin,angles,scale),matrixInputUnits:'metres',skin,body:0,solid,flags,flagsEx,leaves,sourceLightingOrigin,worldLightingOrigin:sourceLightingOrigin?sourceModelPoint(worldFrameMatrix,sourceLightingOrigin.map(v=>v*world.frame.metresPerUnit)):undefined,castShadow:render.castShadow,fadeMinDistance,fadeMaxDistance,forcedFadeScale,diffuseModulation,dxLevels,cpuLevels,gpuLevels,lightmapResolution,disableX360,render,rawBlob:lump.decodedBlob.slice(start,p)});
    }
    // Placements own their charge for the import lifetime; the plain clone does not.
    ownership.complete();working.complete();
    return props;
  }catch(error){ownership?.fail(false);working.fail(false);throw error;}
}

export async function readSourceProps(world: SourceWorld, filesystem: Pick<SourceFileSystem,'readFile'>, options: SourcePropsOptions = {}): Promise<SourceProps> {
  sourceAbort(options.signal);
  const maximum=options.maxGameLumpBytes??128*1024*1024;if(!Number.isSafeInteger(maximum)||maximum<=0)throw new Error('Invalid Source game-lump limit');
  const maxCount=options.maxGameLumps??4096;if(!Number.isSafeInteger(maxCount)||maxCount<=0)throw new Error('Invalid Source game-lump count limit');
  const requirements:SourceLightingRequirement[]=[],overlays=overlayRequirement(world);if(overlays)requirements.push(overlays);
  const lumps=await gameLumps(world,maximum,maxCount,options.signal),details=await detailPropRequirement(lumps,options.signal);if(details)requirements.push(details);
  const placements=await readSourceStaticProps(world,lumps,options),brushes:SourceBrushVisual[]=[],entities:SourceEntityVisual[]=[];
  const modelsBytes=await world.bsp.getLump(14,options.signal),modelTable=new Binary(modelsBytes,'BSP models');if(modelsBytes.length%48)throw new Error('Malformed BSP model table');
  const facesLump=world.bsp.lumps[53].length&&world.bsp.lumps[58].length?58:7,faceBytes=await world.bsp.getLump(facesLump,options.signal);if(faceBytes.length%56)throw new Error('Malformed BSP face table');
  const brushModels=new Map<number,{faces:Uint32Array;surfaces:readonly SourceSurface[]}>();
  // First entity per targetname, as entities.find returned; built once on first use.
  let targetMap:Map<string,SourceEntity>|undefined;
  const targets=()=>{
    if(!targetMap){targetMap=new Map();for(const other of world.bsp.entities){const name=other.values.targetname;if(name!==undefined&&!targetMap.has(name))targetMap.set(name,other);}}
    return targetMap;
  };
  for(let i=0;i<world.bsp.entities.length;i++){
    const entity=world.bsp.entities[i],e=entity.values,classname=e.classname??'',origin=vector(e,'origin'),angles=entityAngles(e),render=entityRender(entity),model=e.model??'';
    const kind:SourceEntityVisual['kind']=model.toLowerCase().endsWith('.mdl')?'studio-model':model.startsWith('*')?'brush':/sprite|glow/.test(classname)?'sprite':/^(?:keyframe_rope|move_rope)$/.test(classname)?'rope':/^(?:env_|light|sky_|color_correction)/.test(classname)?'environment':'unclassified';
    entities.push({entityIndex:i,entity,kind,sourceOrigin:origin,sourceAngles:angles,render});
    if(kind==='studio-model'){
      const scale=scalar(e,'modelscale',1),skin=integer(e,'skin',0),body=integer(e,'body',0),animation:SourceEntityAnimation={defaultAnimation:e.DefaultAnim??e.defaultanim??'',sequence:e.sequence??'',cycle:scalar(e,'cycle',0),playbackRate:scalar(e,'playbackrate',1),skin,body,temporalSupport:'authored-state-not-simulated'};
      const lightingTarget=e.lightingorigin?targets().get(e.lightingorigin):undefined;
      if(e.lightingorigin&&!lightingTarget)throw new Error(`Missing Source prop lightingorigin target ${e.lightingorigin}`);
      placements.push({kind:'entity-model',index:placements.length,entityIndex:i,modelPath:sourceModelPath(model),classname,sourceOrigin:origin,sourceAngles:angles,scale,matrix:sourcePropMatrix(world.frame,origin,angles,scale),matrixInputUnits:'metres',skin,body,solid:integer(e,'solid',6),flags:0,flagsEx:0,leaves:new Uint16Array(),sourceLightingOrigin:lightingTarget?vector(lightingTarget.values,'origin'):undefined,castShadow:render.castShadow,fadeMinDistance:scalar(e,'fademindist',-1),fadeMaxDistance:scalar(e,'fademaxdist',0),forcedFadeScale:scalar(e,'fadescale',1),diffuseModulation:[...render.color,render.amount],render,animation,entity});
    }else if(kind==='brush'){
      if(!/^\*\d+$/.test(model))throw new Error(`Invalid BSP brush model reference ${model}`);
      const index=Number(model.slice(1));if(index===0)throw new Error('Entity cannot instance worldmodel 0');const p=modelTable.range(index*48,48),firstFace=modelTable.i(p+40),faceCount=modelTable.i(p+44);
      if(firstFace<0||faceCount<0||firstFace>faceBytes.length/56||faceCount>faceBytes.length/56-firstFace)throw new Error('BSP brush face range out of bounds');
      let geometry=brushModels.get(index);
      if(!geometry){
        const surfaces=await world.decodeModelSurfaces(index,options.signal);sourceAbort(options.signal);
        geometry={faces:Uint32Array.from({length:faceCount},(_,j)=>firstFace+j),surfaces};
        brushModels.set(index,geometry);
      }
      const nonvisual=/^(?:trigger_|func_(?:areaportal|occluder|ladder|viscluster|precipitation|buyzone|bomb_target|hostage_rescue|clip_vphysics))/.test(classname),baselineVisible=!nonvisual&&!render.initiallyDisabled&&render.mode!==6&&render.mode!==10&&(render.mode===0||render.amount!==0);
      brushes.push({entityIndex:i,entity,classname,model:index,sourceOrigin:origin,sourceAngles:angles,matrix:sourcePropMatrix(world.frame,origin,angles),matrixInputUnits:'metres',sourceModelOrigin:modelTable.vec(p+24),bounds:[modelTable.vec(p),modelTable.vec(p+12)],headnode:modelTable.i(p+36),firstFace,faceCount,faces:geometry.faces,surfaces:geometry.surfaces,baselineVisible,render,capability:nonvisual?'nonvisual-brush':'authored-brush-placement-only'});
    }
  }
  const models=new Map<string,SourceStudioModel>(),missingModels:SourceProps['missingModels'][number][]=[],missingMaterials:SourceProps['missingMaterials'][number][]=[],missingAnimationResources:SourceProps['missingAnimationResources'][number][]=[];
  const studio=new SourceStudioImport(filesystem,options);
  for(const path of new Set(placements.map(p=>p.modelPath))){
    sourceAbort(options.signal);
    try{
      const model=await studio.readModel(path),missingNames=new Set<string>();models.set(path,model);
      for(const material of model.materials)if(!material.path){missingNames.add(material.name);missingMaterials.push({model:path,name:material.name,candidates:material.candidates});}
      for(const mesh of model.meshes)for(const material of mesh.materialBySkin)if(!material.path&&!missingNames.has(material.name)){missingNames.add(material.name);missingMaterials.push({model:path,name:material.name,candidates:material.candidates});}
      for(const resource of model.missingResources)missingAnimationResources.push({model:path,path:resource});
    }
    catch(error){if(error instanceof SourceStudioMissingResourceError)missingModels.push({path,resources:error.paths});else throw error;}
  }
  // Lighting samples use the original authored Source point, never a twice-framed
  // mesh centre. For non-overridden props Source uses its rotated illumination point.
  const worldMatrix=sourcePropMatrix(world.frame,[0,0,0],[0,0,0]);
  for(const p of placements){
    if(!p.sourceLightingOrigin){
      const model=models.get(p.modelPath);
      if(model){
        const rotation=sourceQAngle(p.sourceAngles),point=sourceModelPoint(rotation,model.illuminationPosition.map(v=>v*p.scale));
        p.sourceLightingOrigin=point.map((v,i)=>v+p.sourceOrigin[i]) as SourceModelVector;
      }
    }
    if(p.sourceLightingOrigin&&!p.worldLightingOrigin)p.worldLightingOrigin=sourceModelPoint(worldMatrix,p.sourceLightingOrigin.map(v=>v*world.frame.metresPerUnit));
  }
  return {placements,brushes,entities,gameLumps:lumps,models,missingModels,missingMaterials,missingAnimationResources,completeResources:!missingModels.length&&!missingMaterials.length&&!missingAnimationResources.length,frame:world.frame,originalBspBlob:world.bsp.file,requirements,limitations:['Authored baseline studio and brush placements only; moving doors/platforms, entity parenting, outputs, gameplay and ragdolls are not simulated. Static collision is assembled separately by raw-source-collision.','Native animation channels, sequences and external/include-model resources are retained, not sampled or qualified for recording/export.','All entities and game lumps are retained; sprite/rope/particle visuals require their own assembly, and populated detail-prop or overlay payloads are blocking requirements. Missing resources are reported explicitly, never replaced with meshes or fake collision.']};
}
