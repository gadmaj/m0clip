/** Prepare solid, lossless glTF materials using temporary copies, leaving the
 * live viewer's textures, diffuse-only state and wireframe untouched. */
import * as THREE from 'three';
import { sourceDiffuseOnly } from '../render/source-textures';
import { diffuseOnlyImage } from './lossless-images';

const exportCopies = new WeakMap<THREE.Material, THREE.Material>();
/** The live material a temporary export copy stands for (identity otherwise), so
 * exporter plugins read live render state, such as Source base UV bindings, without
 * the copy owning or mutating it. */
export function losslessExportSource(material: THREE.Material): THREE.Material {
  return exportCopies.get(material) ?? material;
}

export function prepareLosslessTextures(root: THREE.Object3D): () => void {
  const textures = new Map<THREE.Texture,Map<'native'|'diffuse'|'normal',THREE.Texture>>();
  const materials = new Map<THREE.Material,THREE.Material>();
  const changed: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  const prepare = (original: THREE.Material) => {
    const previous = materials.get(original); if (previous) return previous;
    const gray=sourceDiffuseOnly(original);
    const entries = Object.entries(original).filter(([name,value]) => value instanceof THREE.Texture
      &&(value.userData.sourceNativeTexture||value.userData.mimeType==='image/webp'||gray&&name==='map'&&value.format===THREE.RGBAFormat));
    const wireframe = 'wireframe' in original && original.wireframe === true;
    if (!entries.length && !wireframe) return original;
    const clone = original.clone(); materials.set(original,clone); exportCopies.set(clone, original);
    if (wireframe && 'wireframe' in clone) clone.wireframe = false;
    for (const [name,value] of entries) {
      const texture = value as THREE.Texture;
      const neutral=gray&&name==='map',signedNormal=name==='normalMap'&&texture.userData.sourceNativeTexture?.format===22;
      const variant=neutral?'diffuse':signedNormal?'normal':'native';let variants=textures.get(texture);
      if(!variants){variants=new Map();textures.set(texture,variants)}
      let copy=variants.get(variant);
      if (!copy) {
        // Native BC/mip textures retain a lossless export source, including lazy
        // RGBA images. Export that source as PNG without GPU decompression.
        copy = new THREE.Texture().copy(texture);copy.format=THREE.RGBAFormat;copy.mipmaps=[];copy.userData={...copy.userData,mimeType:'image/png'};
        delete copy.userData.sourceNativeTexture;delete copy.userData.sourceVtf;
        if(neutral)copy.source=new THREE.Source(diffuseOnlyImage(texture.image));
        if(signedNormal){
          // UV88 is signed XY; portable glTF normal maps require unsigned RGB.
          const image=texture.image as {width:number;height:number;data:Float32Array};
          const pixels=new Uint8Array(image.width*image.height*4);
          for(let i=0;i<pixels.length;i+=4){
            const x=Math.max(-1,Math.min(1,image.data[i])),y=Math.max(-1,Math.min(1,image.data[i+1]));
            pixels[i]=Math.round((x+1)*127.5);pixels[i+1]=Math.round((y+1)*127.5);
            pixels[i+2]=Math.round((Math.sqrt(Math.max(0,1-x*x-y*y))+1)*127.5);pixels[i+3]=255;
          }
          copy.source=new THREE.Source({width:image.width,height:image.height,data:pixels});
          copy.type=THREE.UnsignedByteType;copy.colorSpace=THREE.NoColorSpace;
        }
        variants.set(variant,copy);
      }
      (clone as unknown as Record<string,unknown>)[name] = copy;
    }
    return clone;
  };
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const original = object.material;
    const copies = [original].flat().map(prepare);
    if (copies.some((material,index) => material !== [original].flat()[index])) {
      changed.push({mesh:object,material:original});
      object.material = Array.isArray(original) ? copies : copies[0];
    }
  });
  return () => {
    for (const entry of changed) entry.mesh.material = entry.material;
    for (const material of materials.values()) material.dispose();
    for (const variants of textures.values())for(const texture of variants.values())texture.dispose();
  };
}
