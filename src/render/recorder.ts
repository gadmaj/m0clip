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
  const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,row=width*4;
  const pixels=new Uint8Array(row*height);
  const read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer|null;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
  try{gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);}
  finally{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);}
  if(gl.isContextLost())return Promise.reject(new BlankCaptureError());
  // GL rows run bottom-up; PNG wants straight alpha while the canvas buffer is premultiplied.
  const image=new ImageData(width,height),out=image.data;
  const premultiplied=gl.getContextAttributes()?.premultipliedAlpha!==false;
  let visible=false;
  for(let y=0;y<height;y++){
    for(let source=(height-1-y)*row,target=y*row,end=target+row;target<end;source+=4,target+=4){
      const alpha=pixels[source+3];
      if(alpha===0)continue;
      visible=true;
      const scale=premultiplied?255/alpha:1;
      out[target]=pixels[source]*scale;out[target+1]=pixels[source+1]*scale;out[target+2]=pixels[source+2]*scale;out[target+3]=alpha;
    }
  }
  if(!visible)return Promise.reject(new BlankCaptureError());
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  // willReadFrequently keeps this canvas in CPU memory, off the GPU snapshot path.
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return Promise.reject(new Error('PNG canvas unavailable.'));
  context.putImageData(image,0,0);
  const {promise,resolve,reject}=Promise.withResolvers<Blob>();
  canvas.toBlob(blob=>{canvas.width=0;canvas.height=0;if(blob)resolve(blob);else reject(new Error('PNG encoding failed.'));},'image/png');
  return promise;
}
