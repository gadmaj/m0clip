/** RGBA PNG encoding without canvas premultiplication (Source packs masks in alpha). */
import { zlibSync } from 'fflate';
const table=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function chunk(name:string,data:Uint8Array) {
  const output=new Uint8Array(data.length+12),view=new DataView(output.buffer);view.setUint32(0,data.length);
  for(let i=0;i<4;i++)output[4+i]=name.charCodeAt(i);output.set(data,8);
  let crc=0xffffffff;for(let i=4;i<output.length-4;i++)crc=table[(crc^output[i])&255]^(crc>>>8);
  view.setUint32(output.length-4,(crc^0xffffffff)>>>0);return output;
}
export function encodeRgbaPNG(width:number,height:number,rgba:Uint8Array,flipY=false):Uint8Array {
  if(rgba.length!==width*height*4)throw new Error('PNG pixel dimensions do not match.');
  const rows=new Uint8Array((width*4+1)*height),header=new Uint8Array(13),view=new DataView(header.buffer);
  view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=6;
  for(let y=0;y<height;y++){const from=(flipY?height-y-1:y)*width*4;rows.set(rgba.subarray(from,from+width*4),y*(width*4+1)+1)}
  const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlibSync(rows,{level:6})),chunk('IEND',new Uint8Array())];
  const output=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){output.set(part,at);at+=part.length}return output;
}
