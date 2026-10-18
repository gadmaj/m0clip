/** Chromium: searchable view library, editing, reversible deletion and storage failures. */
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const expose=source=>source.replace('new App();','window.__app=new App();').replace(/new ([A-Za-z_$][\w$]*);export\{/,'window.__app=new $1;export{').replaceAll('this.renderLoop()','void 0');
 for(const pattern of['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:expose(await response.text())})});
 await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
 const base=process.env.BASE_URL||'http://127.0.0.1:5176';
 const ready=()=>page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
 await page.goto(base+'/?plain&body=stock');await ready();
 const original=await page.evaluate(()=>{
  const a=window.__app,view=a.captureView();view.position=[2,3,4];view.target=[0,0,1];
  const legacy={...view};delete legacy.orientation;delete legacy.appearance;delete legacy.sourceHead;delete legacy.flight;delete legacy.noclip;
  const bookmarks=[{name:'Conveyor lighting study',view:{...view,terrain:'map:nt_ghost_ctg'}},{name:'Roof entrance / 入口 / مدخل',view:legacy},{name:'Long title '+ 'reference '.repeat(7),view}];
  localStorage.setItem('ume-saved-views-v1',JSON.stringify(bookmarks));return bookmarks;
 });
 await page.reload();await ready();await page.getByText('Saved views',{exact:true}).click();
 const search=page.getByRole('searchbox',{name:'Search saved views'}),list=page.getByRole('list',{name:'Saved views'}),name=page.getByLabel('View name',{exact:true});
 assert.equal(await list.getByRole('listitem').count(),3);assert.equal(await page.getByRole('button',{name:'Undo delete',exact:true}).isVisible(),false);
 await search.fill('GHOST .bsp R1');assert.equal(await list.getByRole('listitem').count(),1);assert.ok(await list.getByText('nt_ghost_ctg.bsp · R1',{exact:true}).count());
 await search.fill('no matching bookmark');assert.equal(await list.getByRole('listitem').count(),0);assert.ok(await list.getByText(/No matching views/).count());
 await search.press('Escape');assert.equal(await list.getByRole('listitem').count(),3);assert.equal(await search.inputValue(),'');
 await page.getByRole('button',{name:'Rename Conveyor lighting study',exact:true}).click();let editor=page.getByLabel('New name for Conveyor lighting study',{exact:true});
 await editor.fill('Canceled rename');await editor.press('Escape');assert.ok(await page.getByRole('button',{name:'Conveyor lighting study',exact:true}).count());
 await page.getByRole('button',{name:'Rename Conveyor lighting study',exact:true}).click();editor=page.getByLabel('New name for Conveyor lighting study',{exact:true});await editor.fill('');await editor.press('Enter');assert.equal(await editor.evaluate(e=>e.validity.valid),false);
 await editor.fill('Conveyor / 台 / سقف');await editor.press('Enter');
 let stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('ume-saved-views-v1')));assert.equal(stored[0].name,'Conveyor / 台 / سقف');assert.deepEqual(stored[0].view,original[0].view);
 await page.getByRole('button',{name:'Delete Roof entrance / 入口 / مدخل',exact:true}).click();assert.equal(await list.getByRole('listitem').count(),2);await page.getByRole('button',{name:'Undo delete',exact:true}).click();
 stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('ume-saved-views-v1')));assert.deepEqual(stored[1],original[1]);assert.equal(await list.getByRole('listitem').count(),3);
 // A full browser store must not change the in-memory library or discard typed names.
 await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='ume-saved-views-v1')throw new DOMException('Quota exceeded','QuotaExceededError');return window.__setItem.call(this,key,value)}});
 await name.fill('Keep this unsaved name');await name.press('Enter');assert.equal(await name.inputValue(),'Keep this unsaved name');assert.equal(await list.getByRole('listitem').count(),3);assert.ok(await page.getByText(/Could not save views in this browser/).count());
 await page.getByRole('button',{name:'Delete Conveyor / 台 / سقف',exact:true}).click();assert.ok(await page.getByRole('button',{name:'Conveyor / 台 / سقف',exact:true}).count());
 await page.getByRole('button',{name:'Rename Conveyor / 台 / سقف',exact:true}).click();editor=page.getByLabel('New name for Conveyor / 台 / سقف',{exact:true});await editor.fill('Quota rename');await editor.press('Enter');assert.equal(await editor.inputValue(),'Quota rename');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.evaluate(()=>{Storage.prototype.setItem=window.__setItem});
 await name.fill('Keyboard saved view');await name.press('Enter');assert.ok(await page.getByRole('button',{name:'Keyboard saved view',exact:true}).count());
 // Rename and Undo only change library metadata. Restoring still uses the full legacy view.
 await page.getByRole('button',{name:'Roof entrance / 入口 / مدخل',exact:true}).click();await page.waitForFunction(()=>!window.__app.pendingViewRestore);
 const restoredPosition=await page.evaluate(()=>window.__app.view.camera.position.toArray());restoredPosition.forEach((value,i)=>assert.ok(Math.abs(value-original[1].view.position[i])<1e-8));
 await page.getByRole('button',{name:'Share Conveyor / 台 / سقف',exact:true}).click();const link=page.getByLabel('Shareable view link',{exact:true});await link.waitFor({state:'visible'});assert.ok((await link.inputValue()).includes('#view='));
 // A restoring scene cannot be saved as a mixture of old model and new camera settings.
 await page.evaluate(()=>{window.__app.pendingViewRestore={id:10000}});await name.fill('Partial restore');await name.press('Enter');assert.equal(await name.inputValue(),'Partial restore');assert.ok(await page.getByText(/Wait for the view to finish restoring/).count());await page.evaluate(()=>{window.__app.pendingViewRestore=null});
 if(!process.env.SKIP_SCREENSHOTS){
  await name.fill('');await page.evaluate(()=>{const e=window.__app.explore;e.link.hidden=true;e.showMessage('');});
  await search.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/saved-library-desktop.png'});
  await page.setViewportSize({width:390,height:844});await search.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/saved-library-mobile.png'});
 }
 const layout=await list.evaluate(element=>({scrollWidth:element.scrollWidth,width:element.clientWidth,maxHeight:getComputedStyle(element).maxHeight,buttons:[...element.querySelectorAll('.saved-view-actions .btn')].map(b=>b.getBoundingClientRect().height)}));assert.ok(layout.scrollWidth<=layout.width);if(!process.env.SKIP_SCREENSHOTS)assert.ok(layout.buttons.every(h=>h>=44));
 const persisted=await page.evaluate(()=>localStorage.getItem('ume-saved-views-v1'));
 while(await list.getByRole('listitem').count())await list.getByRole('button',{name:/^Delete /}).first().click();
 assert.ok(await list.getByText(/No saved views yet/).count());const undo=page.getByRole('button',{name:'Undo delete',exact:true});assert.ok(await undo.evaluate(e=>document.activeElement===e));
 await page.evaluate(()=>{Storage.prototype.setItem=function(key,value){if(key==='ume-saved-views-v1')throw new DOMException('Denied','SecurityError');return window.__setItem.call(this,key,value)}});
 await undo.click();assert.equal(await list.getByRole('listitem').count(),0);assert.ok(await undo.isVisible());await page.evaluate(()=>{Storage.prototype.setItem=window.__setItem});await undo.click();assert.equal(await list.getByRole('listitem').count(),1);
 await page.evaluate(value=>localStorage.setItem('ume-saved-views-v1',value),persisted);
 const largeLibrary=await page.evaluate(()=>{
  const e=window.__app.explore,original=e.bookmarks,view={...original[0].view,terrain:'map:nt_ghost_ctg'},start=performance.now();e.bookmarks=Array.from({length:500},(_,i)=>({name:`Inspection ${String(i).padStart(4,'0')}`,view}));e.renderBookmarks();
  const built=performance.now();e.search.value='inspection 0499 ghost .bsp';e.renderBookmarks();const filtered=performance.now(),matches=e.list.querySelectorAll('[role=listitem]').length;
  e.bookmarks=original;e.search.value='';e.renderBookmarks();return{size:500,matches,renderMs:built-start,searchMs:filtered-built};
 });assert.equal(largeLibrary.matches,1);
 await page.reload();await ready();await page.getByText('Saved views',{exact:true}).click();assert.ok(await page.getByRole('button',{name:'Conveyor / 台 / سقف',exact:true}).count());assert.ok(await page.getByRole('button',{name:'Keyboard saved view',exact:true}).count());assert.equal(await page.getByRole('button',{name:'Partial restore',exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({search:true,filenames:true,rename:true,cancel:true,undo:true,legacy:true,storageFailure:true,keyboardSave:true,restore:true,share:true,partialRestoreGuard:true,persistence:true,layout,largeLibrary,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
