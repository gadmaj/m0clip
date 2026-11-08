/** Capture the real dialog's GLB download; the App, not the fixture, owns the canvas. */
const path=require('node:path');
const {createReadStream}=require('node:fs'),{createHash}=require('node:crypto');
const artifactPath=require('./test-artifacts.cjs');

module.exports=async function captureGlb(page,{fps,camera,floor,file,range}){
  let failed=false;
  try{
    await page.evaluate(options=>{
      const a=window.__app,d=a.dialog,save=d.host.save;
      window.__glbCaptureContext={out:{...d.out},range:[a.timeline.rangeIn,a.timeline.rangeOut],save};
      window.__exportedGlb=null;
      if(options.range)[a.timeline.rangeIn,a.timeline.rangeOut]=options.range;
      Object.assign(d.out,{glbFps:options.fps,glbCamera:options.camera,glbFloor:options.floor});
      d.host.save=(blob,extension)=>{if(extension==='glb')window.__exportedGlb=blob;save(blob,extension)};
      a.openExport('data');
    },{fps,camera,floor,range});
    const [download]=await Promise.all([
      page.waitForEvent('download',{timeout:180000}),
      page.getByRole('button',{name:'Export .glb',exact:true}).click(),
    ]);
    const output=path.resolve(artifactPath(file));
    await download.saveAs(output);
    await page.waitForFunction(()=>!window.__app.exporting&&!window.__app.dialog.busy,null,{timeout:180000});
    const expected=await page.evaluate(async()=>{
      const blob=window.__exportedGlb;
      if(!(blob instanceof Blob))throw new Error('The actual export dialog did not save a GLB.');
      const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
      return{bytes:blob.size,sha256:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
    });
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of createReadStream(output)){hash.update(chunk);bytes+=chunk.length;}
    if(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256)throw new Error('The downloaded GLB differs from the actual dialog Blob.');
    return output;
  }catch(error){failed=true;throw error;}
  finally{
    try{
      const restored=await page.evaluate(()=>{
        const c=window.__glbCaptureContext;if(!c)return true;
        const a=window.__app,d=a.dialog;if(d.busy)return false;
        d.host.save=c.save;d.close();Object.assign(d.out,c.out);
        [a.timeline.rangeIn,a.timeline.rangeOut]=c.range;
        delete window.__glbCaptureContext;return true;
      });
      if(!restored)throw new Error('The actual GLB job is still running; close the owned browser after retaining the failure.');
    }catch(error){if(!failed)throw error;console.error('GLB capture cleanup failed:',error);}
  }
};
