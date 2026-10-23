/** Validate shared appearance data before it reaches material and asset loaders. */
import type { Appearance } from '../render/scene';
import { KIT_REGIONS, KIT_STYLES } from '../render/robot-kit-data';
import { isBodyVisual } from '../characters/catalog';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const number=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const color=(v:unknown)=>number(v,0,0xffffff)&&Number.isInteger(v);
const colorway=(v:unknown)=>v==='grey'||v==='product'||v==='model';
const finishes=new Set(['gloss','satin','matte','rubber','metal','gunmetal','mirror']);
const paintAxes=new Set(['color','finish','roughness','metalness','clearcoat']);
export function validAppearance(v:unknown):v is Appearance {
  if(!object(v)||!colorway(v.colorway)||!object(v.parts)||Object.keys(v.parts).length>256)return false;
  if(v.sourceBody!==undefined&&!isBodyVisual(v.sourceBody))return false;
  if(v.sourceBodyColorway!==undefined&&!colorway(v.sourceBodyColorway))return false;
  if(v.modules!==undefined&&(!object(v.modules)||Object.entries(v.modules).some(([region,style])=>
    !(KIT_REGIONS as readonly string[]).includes(region)||!(KIT_STYLES as readonly unknown[]).includes(style))))return false;
  for(const [name,paint]of Object.entries(v.parts)) {
    if(!name||name.length>200||['__proto__','constructor','prototype'].includes(name)||!object(paint))return false;
    const keys=Object.keys(paint);
    if(!keys.length||keys.some(key=>!paintAxes.has(key)||paint[key]===undefined))return false;
    if(paint.color!==undefined&&!color(paint.color))return false;
    if(paint.finish!==undefined&&(typeof paint.finish!=='string'||!finishes.has(paint.finish)))return false;
    for(const key of ['roughness','metalness','clearcoat'])if(paint[key]!==undefined&&!number(paint[key],0,1))return false;
  }
  if(v.robotLight!==undefined) {
    const l=v.robotLight;
    if(!object(l)||typeof l.dull!=='boolean'||!number(l.brightness,0,100)||!color(l.color)||!number(l.range,1,30))return false;
  }
  return true;
}
