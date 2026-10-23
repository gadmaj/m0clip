/** Chromium: dedicated WASM runtime against the prior general bundle on the real R1 catalog. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {unzipSync}=require('fflate'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const catalog=JSON.parse(await fs.readFile('public/assets/packs/r1-default-v1.json','utf8'));
 const base=process.env.BASE_URL||'http://127.0.0.1:5176',results={},errors=[],requests={};
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  for(const flavor of ['general','wasm']) {
   const context=await browser.newContext(),page=await context.newPage();requests[flavor]=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('.wasm'))requests[flavor].push(r.url())});
   await page.route('**/?ort-reference',r=>r.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:'<body></body>'}));
   await page.route('**/__ort-model/*',async route=>{
    const i=Number(new URL(route.request().url()).pathname.split('/').at(-1)),entry=catalog[i];
    const zip=new Uint8Array(await fs.readFile(path.join('public',entry.downloadUrl)));
    const name=entry.manifest.checkpoints[0].file,files=unzipSync(zip,{filter:file=>file.name===name});
    assert.ok(files[name],`${entry.id}: canonical ONNX missing from its pack`);
    await route.fulfill({contentType:'application/octet-stream',body:Buffer.from(files[name])});
   });
   await page.goto(base+'/?ort-reference');
   await page.evaluate(async flavor=>{
    window.__ort=await import(flavor==='wasm'?'/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs':'/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs');
    window.__ort.env.wasm.numThreads=1;
   },flavor);
   results[flavor]=[];
   for(let i=0;i<catalog.length;i++) {
    const result=await page.evaluate(async i=>{
     const ort=window.__ort,buffer=await(await fetch('/__ort-model/'+i)).arrayBuffer();
     const session=await ort.InferenceSession.create(buffer,{executionProviders:['wasm']});
     try {
      const inputs=session.inputMetadata.map(m=>({name:m.name,type:m.type,shape:m.shape.map(d=>typeof d==='number'&&d>0?d:1)}));
      const outputs=[];
      for(let seed=0;seed<3;seed++) {
       const feeds={};for(const input of inputs) {
        if(input.type!=='float32')throw new Error('Unexpected policy input '+JSON.stringify(input));
        const count=input.shape.reduce((a,b)=>a*b,1),data=Float32Array.from({length:count},(_,j)=>Math.sin(j*.031+seed*.27)*.15);
        feeds[input.name]=new ort.Tensor('float32',data,input.shape);
       }
       const out=await session.run(feeds);outputs.push(Object.fromEntries(session.outputNames.map(n=>[n,Array.from(out[n].data)])));
      }
      return {inputs,outputs};
     }finally{await session.release();}
    },i);
    results[flavor].push(result);
    if((i+1)%20===0)console.log(`${flavor}: ${i+1}/${catalog.length} real policies`);
   }
   await context.close();
  }
  const comparisons=[];
  for(let i=0;i<catalog.length;i++) {
   const a=results.general[i],b=results.wasm[i];assert.deepEqual(a.inputs,b.inputs);
   let maximum=0,values=0;
   for(let seed=0;seed<3;seed++)for(const name of Object.keys(a.outputs[seed])) {
    const x=a.outputs[seed][name],y=b.outputs[seed][name];assert.equal(x.length,y.length);
    for(let k=0;k<x.length;k++){assert.ok(Number.isFinite(x[k])&&Number.isFinite(y[k]));maximum=Math.max(maximum,Math.abs(x[k]-y[k]));values++;}
   }
   assert.equal(maximum,0,`${catalog[i].id}: CPU policy outputs changed`);
   comparisons.push({id:catalog[i].id,inputs:a.inputs,maximum,values});
  }
  assert.deepEqual(errors,[]);assert.ok(requests.general.some(u=>u.includes('.jsep.')));assert.ok(requests.wasm.every(u=>!u.includes('.jsep.'))&&requests.wasm.length>0);
  const directory=path.join(os.homedir(),'.local/state/unitree-renderer/ort-comparison');await fs.mkdir(directory,{recursive:true});
  const report={policies:catalog.length,seeds:3,comparisons,requests,errors};await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({policies:catalog.length,seeds:3,exact:true,requests,errors}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
