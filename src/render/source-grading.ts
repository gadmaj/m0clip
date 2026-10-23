/** noclip SourceColorCorrection and color_correction.calcWeight (MIT, LICENSE.noclip). */
export interface SourceColorLayer {
  origin: number[]; enabled: boolean; minfalloff: number; maxfalloff: number; data: Uint8Array;
}

export function sourceColorWeight(layer: SourceColorLayer, eye: {x:number;y:number;z:number}) {
  if(!layer.enabled)return 0;
  if(layer.minfalloff>=0&&layer.maxfalloff>=0&&layer.minfalloff!==layer.maxfalloff) {
    const distance=Math.hypot(eye.x-layer.origin[0],eye.y-layer.origin[1],eye.z-layer.origin[2]);
    // Preserve the reference's actual inverse-lerp behavior, including its direction.
    return Math.max(0,Math.min(1,(distance-layer.minfalloff)/(layer.maxfalloff-layer.minfalloff)));
  }
  return 1;
}

export function sourceColorCorrectionLut(layers: Uint8Array[], weights: number[], data:Uint8Array=new Uint8Array(32*32*32*4)) {
  const total=weights.reduce((a,b)=>a+b,0),identity=total<1?1-total:0;
  if(total>=1)weights=weights.map(w=>w/total);
  const ratio=255/31;
  for(let z=0;z<32;z++)for(let y=0;y<32;y++)for(let x=0;x<32;x++) {
    const i=((z*32+y)*32+x),at=i*4,source=i*3;
    let r=x*ratio*identity,g=y*ratio*identity,b=z*ratio*identity;
    for(let layer=0;layer<layers.length;layer++) {
      const lut=layers[layer],weight=weights[layer];
      r+=lut[source]*weight;g+=lut[source+1]*weight;b+=lut[source+2]*weight;
    }
    data[at]=r;data[at+1]=g;data[at+2]=b;data[at+3]=255;
  }
  return data;
}

export async function loadSourceColorLayers(manifest: {color_corrections?: (Omit<SourceColorLayer,'data'>&{file:string})[]}, base: URL) {
  return Promise.all((manifest.color_corrections??[]).map(async layer=>{
    if(!/^source-color-\d+\.rgb$/.test(layer.file)||!Array.isArray(layer.origin)||layer.origin.length!==3
      ||!layer.origin.every(Number.isFinite)||!Number.isFinite(layer.minfalloff)||!Number.isFinite(layer.maxfalloff)
      ||typeof layer.enabled!=='boolean')throw new Error('Invalid Source color-correction metadata');
    const response=await fetch(new URL(layer.file,base));
    if(!response.ok)throw new Error('Source color-correction table failed to load');
    const data=new Uint8Array(await response.arrayBuffer());
    if(data.length<32*32*32*3)throw new Error('Source color-correction table is truncated');
    return {...layer,data};
  }));
}
