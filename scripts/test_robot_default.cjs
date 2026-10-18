/** Keep R1 as the neutral default, while retaining explicit Dog selection and persistence. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
  const page=await browser.newPage({deviceScaleFactor:Number(process.env.TEST_DPR||1)}),errors=[];page.on('pageerror',e=>errors.push(e.message));let dogRequests=0;page.on('request',r=>{if(r.url().endsWith('/halflife2-dog/dog.glb'))dogRequests++});
  await page.addInitScript(()=>{if(!sessionStorage.getItem('legacy-default-seeded')){localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'}));localStorage.setItem('ume-appearance',JSON.stringify({r1:{colorway:'product',sourceBody:'dog',parts:{},robotLight:{brightness:0,color:0xffffff,range:8,dull:true}}}));sessionStorage.setItem('legacy-default-seeded','1')}});
  const renderLoop=body=>process.env.RENDER_ON_DEMAND?body.replaceAll('this.renderLoop()','void 0'):body;
  await page.route('**/src/main.ts*',async r=>{const response=await r.fetch();await r.fulfill({response,body:renderLoop((await response.text()).replace('new App();','window.__app=new App();'))})});
  await page.route('**/assets/main-*.js',async r=>{const response=await r.fetch(),original=await response.text(),body=renderLoop(original.replace(/new ([A-Za-z_$][\w$]*);export\{/,'window.__app=new $1;export{'));assert.notEqual(body,original);await r.fulfill({response,body})});
  const base=process.env.BASE_URL||'http://127.0.0.1:5176';await page.goto(base+'/?plain');await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
  assert.equal(await page.evaluate(()=>window.__app.view.getBodyVisualState().applied),'stock');assert.equal(dogRequests,0);assert.equal(await page.evaluate(()=>window.__app.view.getAppearance().robotLight.dull),true);
  await page.getByText('Robot appearance',{exact:true}).click();const model=page.getByLabel('Robot model',{exact:true});assert.equal(await model.inputValue(),'stock');assert.ok(await model.locator('option[value="dog"]').count());
  await model.selectOption('dog');await page.waitForFunction(()=>window.__app.view.getBodyVisualState().applied==='dog');assert.equal(await page.evaluate(()=>window.__app.view.sourceBody.bones.length),58);
  // A later explicit choice remains persistent; the migration must not keep undoing it.
  await page.goto(base+'/?plain');await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.getBodyVisualState().applied==='dog',null,{timeout:120000});
  await page.goto(base+'/?plain&body=stock');await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});assert.equal(await page.evaluate(()=>window.__app.view.getBodyVisualState().applied),'stock');assert.deepEqual(errors,[]);
  console.log(JSON.stringify({neutralDefault:true,legacyPreviewReset:true,noDefaultCharacterDownload:true,lightPreserved:true,dogOptional:true,nativeBones:58,explicitChoicePersists:true,stockLink:true,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
