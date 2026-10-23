/** Chromium smoke check of the permanent entry point and live interactive UI. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chooseVisual}=require('./choose-visual.cjs');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const fallback=await browser.newPage({javaScriptEnabled:false});
 await fallback.goto('https://gadmaj.org/mowat/',{waitUntil:'domcontentloaded',timeout:120000});
 const direct=fallback.getByRole('link',{name:'Open m0clip.com',exact:true});
 assert.equal(await direct.getAttribute('href'),'https://m0clip.com/');assert.ok(await direct.isVisible());await fallback.close();
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:.5}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://gadmaj.org/mowat/?plain&body=stock&url=https%3A%2F%2Fexample.org%2F&release='+Date.now()+'#rename-check',{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForURL(url=>url.origin==='https://m0clip.com',{timeout:30000});
 await require('./launch-scene.cjs').launchScene(page, { controls: true });
 assert.equal(await page.title(),'m0clip');
 const url=new URL(page.url());assert.equal(url.origin,'https://m0clip.com');assert.equal(url.pathname,'/');assert.ok(url.searchParams.has('plain'));assert.equal(url.searchParams.get('body'),'stock');assert.equal(url.searchParams.get('url'),'https://example.org/');assert.equal(url.hash,'#rename-check');
 const isolated=await page.evaluate(()=>crossOriginIsolated);assert.ok(isolated);
 const before=await page.locator('#play-window').boundingBox(),grip=await page.getByRole('button',{name:'Move Play panel',exact:true}).boundingBox();
 await page.mouse.move(grip.x+30,grip.y+15);await page.mouse.down();await page.mouse.move(grip.x+70,grip.y+45,{steps:5});await page.mouse.up();
 const after=await page.locator('#play-window').boundingBox();assert.ok(after.x>before.x+20&&after.y>before.y+15);
 await page.getByText('Robot appearance',{exact:true}).click();await chooseVisual(page,'character','round');assert.match(await page.locator('#character-trigger').textContent(),/round/i);
 await page.screenshot({path:path.join(os.homedir(),'.local/state/unitree-renderer/public-release.png')});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({url:page.url(),title:true,queryAndFragment:true,isolated,drag:true,character:true,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
