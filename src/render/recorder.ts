/** Canvas capture: PNG screenshots, and the browser download flow every export saves through.
 * (Video comes from takes: record → timeline → Export video, see src/record/.) */

/** Local date-time for file names, e.g. 2026-10-16_14-03-59. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
         `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);   // detached-anchor clicks can silently no-op
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function screenshot(canvas: HTMLCanvasElement, prefix = "r1-sim") {
  canvas.toBlob((b) => { if (b) download(b, `${prefix}_${stamp()}.png`); }, "image/png");
}

/** The drawing buffer held no visible pixel, so it is not an image of the viewport. */
export class BlankCaptureError extends Error {
  constructor() { super('The viewport drawing buffer is empty.'); this.name = 'BlankCaptureError'; }
}

/** Read the frame just drawn through the WebGL context itself, in the drawing task, and encode it
 * from CPU pixels; callers can discard the capture if the scene changes during encoding.
 * Canvas snapshots (toBlob, drawImage) are avoided: after a GPU-process reset restored the context,
 * they returned only transparent pixels while the restored context still drew and presented frames.
 * A buffer without any visible pixel rejects with BlankCaptureError instead of becoming a blank PNG. */
export function capturePng(gl:WebGL2RenderingContext):Promise<Blob>{
  const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
  if(!width||!height||gl.isContextLost())return Promise.reject(new BlankCaptureError());
  const image=new ImageData(width,height),out=image.data,pixels=new Uint8Array(out.buffer);
  const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer|null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
  try{gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);}
  finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);}
  if(gl.isContextLost())return Promise.reject(new BlankCaptureError());
  // PNG wants straight alpha; most viewport pixels are already opaque.
  const premultiplied=gl.getContextAttributes()?.premultipliedAlpha!==false;
  let visible=false;
  for(let offset=0;offset<pixels.length;offset+=4){
    const alpha=pixels[offset+3];
    if(alpha===0)continue;
    visible=true;
    if(premultiplied&&alpha<255){
      const scale=255/alpha;
      out[offset]*=scale;out[offset+1]*=scale;out[offset+2]*=scale;
    }
  }
  if(!visible)return Promise.reject(new BlankCaptureError());
  // Flip complete pixels in place: keep one full-size CPU buffer, including odd-height images.
  const rgba=new Uint32Array(image.data.buffer),half=Math.floor(height/2);
  for(let y=0;y<half;y++){
    for(let top=y*width,bottom=(height-1-y)*width,end=top+width;top<end;top++,bottom++){
      const pixel=rgba[top];rgba[top]=rgba[bottom];rgba[bottom]=pixel;
    }
  }
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  // willReadFrequently keeps this canvas in CPU memory, off the GPU snapshot path.
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return Promise.reject(new Error('PNG canvas unavailable.'));
  context.putImageData(image,0,0);
  const {promise,resolve,reject}=Promise.withResolvers<Blob>();
  canvas.toBlob(blob=>{canvas.width=0;canvas.height=0;if(blob)resolve(blob);else reject(new Error('PNG encoding failed.'));},'image/png');
  return promise;
}
