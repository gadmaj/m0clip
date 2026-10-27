/** Shareable views preserve visual state while accepting old camera-only bookmarks. */
import assert from 'node:assert/strict';import{build}from'esbuild';
const result=await build({stdin:{contents:"export {ExplorePanel,validView,viewLink,sharedView} from './src/ui/explore';export {LookPanel} from './src/ui/look';export {Panel} from './src/ui/panel';export {STUDIO} from './src/render/scene';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const{ExplorePanel,LookPanel,Panel,validView,viewLink,sharedView,STUDIO}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const legacy={version:1,robot:'r1',terrain:'flat',position:[2,-2,1],target:[0,0,.7],fov:60,display:{textures:true,wireframe:false,map:true,robot:true},flashlight:false,look:{preset:'auto',custom:STUDIO}};
assert.ok(validView(legacy));assert.deepEqual(sharedView(new URL(viewLink(legacy,'https://example.test/')).hash),legacy);
for(const wireframe of [false,true])for(const characterWireframe of [false,true]) {
 const v={...legacy,display:{...legacy.display,wireframe,characterWireframe}};
 assert.ok(validView(v));assert.deepEqual(sharedView(new URL(viewLink(v,'https://example.test/')).hash),v);
}
for(const characterWireframe of [null,0,'true'])assert.equal(validView({...legacy,display:{...legacy.display,characterWireframe}}),false);
for(const antialiasing of ['fxaa','msaa4','none']) {
 const v={...legacy,look:{...legacy.look,antialiasing}};
 assert.deepEqual(sharedView(new URL(viewLink(v,'https://example.test/')).hash),v);
}
assert.equal(validView({...legacy,look:{...legacy.look,antialiasing:'invalid'}}),false);
const modules={head:'boxy',torso:'round',arms:'prism',legs:'stock'};
const modular={...legacy,appearance:{colorway:'grey',parts:{},modules}};
assert.deepEqual(sharedView(new URL(viewLink(modular,'https://example.test/')).hash),modular);
for(const bad of [{head:'unknown'},{unknown:'boxy'},JSON.parse('{"__proto__":"round"}')])assert.equal(validView({...modular,appearance:{...modular.appearance,modules:bad}}),false);
const view={...legacy,appearance:{colorway:'model',sourceBody:'dog',sourceBodyColorway:'model',parts:{left_elbow_link:{color:0x2398ff,finish:'metal',roughness:.3,metalness:.8,clearcoat:.2},torso:{finish:'metal'},head:{color:0x43aaff},wrist:{roughness:.71}},robotLight:{brightness:25,color:0xffcc99,range:10,dull:false}},sourceHead:'stock',orientation:[0,0,Math.sin(.3),Math.cos(.3)],noclip:true,flight:{speed:70,hover:true}};
assert.ok(validView(view));const url=new URL(viewLink(view,'https://example.test/?body=stock'));assert.equal(url.searchParams.get('body'),'dog');assert.deepEqual(sharedView(url.hash),view);
assert.equal(new URL(viewLink({...view,appearance:{...view.appearance,sourceBody:'stock'}},url.href)).searchParams.get('body'),'stock');
for(const update of [{orientation:[0,0,0,0]},{flight:{speed:201,hover:true}},{noclip:'yes'},{sourceHead:'unknown'},{robot:'go2'},{appearance:{...view.appearance,robotLight:{...view.appearance.robotLight,range:0}}},{appearance:{...view.appearance,parts:{head:{color:-1,finish:'metal'}}}},{appearance:{...view.appearance,parts:{head:{color:0xffffff,finish:'unknown'}}}},{appearance:{...view.appearance,parts:JSON.parse('{"__proto__":{"color":1,"finish":"metal"}}')}}])assert.equal(validView({...view,...update}),false,JSON.stringify(update));
const parts=Object.fromEntries(Array.from({length:100},(_,i)=>['very_long_part_name_'+i,{color:0x123456,finish:'metal',roughness:.234,metalness:.8,clearcoat:.1}]));const large={...view,appearance:{...view.appearance,parts}};const hash=new URL(viewLink(large,'https://example.test/')).hash;assert.ok(hash.length>12000);assert.deepEqual(sharedView(hash),large);
assert.equal(sharedView('#view='+('x'.repeat(131072))),null);assert.equal(sharedView('#view=not-valid'),null);

// Exercise the actual shared display controller at its renderer/storage boundary.
const preferences=new Map(),writes=[],applied=[];
globalThis.localStorage={setItem(key,value){preferences.set(key,value);writes.push([key,value]);}};
const displayPanel=Object.create(ExplorePanel.prototype);
Object.assign(displayPanel,{display:{...legacy.display,decals:true,characterWireframe:false},
 liveDisplay:null,shotChanged:null,readOnly:false,checks:new Map(),
 liveViewControls:[],list:{querySelectorAll:()=>[]},message:{textContent:''},
 renderScope:{textContent:''},viewScope:{textContent:''},callbacks:{display(value){applied.push({...value});}}});
const liveDisplay=displayPanel.getDisplay();
displayPanel.setDisplay(liveDisplay);
const livePreference=preferences.get('ume-display'),liveWriteCount=writes.length;
let firstEdits=0,secondEdits=0;
const recordedDisplay={...liveDisplay,textures:false,wireframe:true,characterWireframe:undefined,robot:false};
displayPanel.beginShotEdit(recordedDisplay,()=>firstEdits++);
assert.equal(displayPanel.getDisplay().characterWireframe,true,'Legacy shot wireframe falls back independently of live settings');
assert.equal(firstEdits,0,'Entering review is not a deliberate saved edit');
displayPanel.setDisplay({...displayPanel.getDisplay(),decals:false,characterWireframe:false});
assert.equal(firstEdits,1);
assert.equal(preferences.get('ume-display'),livePreference,'Shot edits never overwrite live preferences');
assert.equal(writes.length,liveWriteCount);
displayPanel.beginShotEdit({...liveDisplay,map:false},()=>secondEdits++);
assert.equal(firstEdits,1,'Switching shot does not save the outgoing shot with incoming values');
assert.equal(secondEdits,0);
displayPanel.setReadOnly(true);
const frozenDisplay=displayPanel.getDisplay();
displayPanel.setDisplay(liveDisplay);displayPanel.endShotEdit();
assert.deepEqual(displayPanel.getDisplay(),frozenDisplay,'Encoding freezes display and context transitions');
displayPanel.setReadOnly(false);
displayPanel.setDisplay({...frozenDisplay,robot:false});
assert.equal(secondEdits,1);
displayPanel.endShotEdit();
assert.deepEqual(displayPanel.getDisplay(),liveDisplay,'Leaving/switching review restores the first live snapshot');
assert.equal(secondEdits,1,'Restoration must not become a saved shot edit');
assert.deepEqual(applied.at(-1),liveDisplay);
assert.equal(preferences.get('ume-display'),livePreference);
const returnedDisplay=displayPanel.getDisplay();returnedDisplay.robot=false;
assert.equal(displayPanel.getDisplay().robot,true,'Consumers cannot mutate the owned display snapshot');
displayPanel.setDisplay({...liveDisplay,map:false});
assert.equal(JSON.parse(preferences.get('ume-display')).map,false,'Deliberate live changes persist after review');

// Saved-view navigation/capture is LIVE-only, not an alternate way to replace a reviewed scene.
let restores=0;
const restore=async()=>{restores++};
displayPanel.beginShotEdit(liveDisplay,()=>{});
await displayPanel.restoreView(legacy,restore);
assert.equal(restores,0);
assert.match(displayPanel.message.textContent,/Close timeline/);
displayPanel.endShotEdit();displayPanel.setReadOnly(true);
await displayPanel.restoreView(legacy,restore);
assert.equal(restores,0);
assert.match(displayPanel.message.textContent,/locked during export/);
displayPanel.setReadOnly(false);await displayPanel.restoreView(legacy,restore);
assert.equal(restores,1);

// The live Look and added lights survive direct take switching without preference writes.
const rigLight={id:'key',name:'Key',kind:'point',enabled:true,color:0xffffff,intensity:10,position:[1,2,3],target:[0,0,1],range:0,angle:30,penumbra:.2};
const liveLook={preset:'studio',custom:{...STUDIO},antialiasing:'fxaa'};
let lighting,lights=[structuredClone(rigLight)],head='ghost',appearance={colorway:'grey',parts:{},sourceBody:'dog'};
const lookPanel=Object.create(LookPanel.prototype),lightScopes=[];
Object.assign(lookPanel,{preset:liveLook.preset,custom:{...STUDIO},antialiasing:'fxaa',
 liveLook:null,liveLights:null,readOnly:false,headLocked:false,mapLight:null,paints:{},heads:{},
 robot:'r1',selected:'',sourceBodyLinkApplied:false,shotChanged:null,shotReset:null,
 view:{setSourceLighting(){},setSourceAntialiasing(){},setLighting(value){lighting=structuredClone(value)},
 getShotLights(){return structuredClone(lights)},setShotLights(value){lights=structuredClone(value)},
 getAppearance(){return structuredClone(appearance)},setAppearance(value,nextHead){appearance=structuredClone(value);if(nextHead)head=nextHead},
 partNames(){return []},highlight(){},getHeadVisual(){return head}},
 renderLighting(){},renderPaint(){},shotLights:{show(readOnly,shot){lightScopes.push({readOnly,shot})},setReadOnly(readOnly){lightScopes.push({readOnly})}}});
const beforeLookWrites=writes.length;
lookPanel.beginShotEdit({preset:'night',custom:{...STUDIO},antialiasing:'none'},()=>{},()=>{},[]);
assert.equal(lights.length,0);
lookPanel.beginShotEdit({preset:'custom',custom:{...STUDIO,exposure:1.8},antialiasing:'msaa4'},()=>{},()=>{},[{...rigLight,id:'rim',name:'Rim'}]);
lookPanel.setReadOnly(true);lookPanel.endShotEdit();
assert.equal(lookPanel.getState().preset,'custom','Encoding blocks context transitions');
lookPanel.setReadOnly(false);lookPanel.endShotEdit();
assert.deepEqual(lookPanel.getState(),liveLook);
assert.deepEqual(lights,[rigLight]);
assert.deepEqual(lighting,STUDIO);
assert.equal(writes.length,beforeLookWrites,'Entering, switching and leaving review do not persist live preferences');
lookPanel.setHeadLocked(true);
assert.deepEqual(lightScopes.at(-1),{readOnly:false},'Recording shell lock does not lock the independent added-light rig');
lookPanel.setHeadLocked(false);

// Explicit launch/shared appearance wins before the first model appearance is applied.
globalThis.location={href:'https://example.test/?body=dog'};
lookPanel.paints.r1={colorway:'product',parts:{},sourceBody:'dog'};
const launchAppearance={colorway:'grey',parts:{torso:{color:0x123456}},sourceBody:'stock'};
const beforeOverrideWrites=writes.length;
lookPanel.onModel('r1','stock',launchAppearance);
assert.deepEqual(appearance,launchAppearance);
assert.equal(head,'stock');
assert.equal(writes.length,beforeOverrideWrites,'Initialization overrides are not deliberate preference changes');
launchAppearance.parts.torso.color=0xffffff;
assert.equal(lookPanel.paints.r1.parts.torso.color,0x123456,'Caller-owned initialization data is never aliased');

// Review locks preserve pre-existing disabled states, including relocated scene pickers.
const control=disabled=>({disabled,setAttribute(){},removeAttribute(){}});
const reset=control(false),unavailable=control(true),robot=control(false),terrain=control(true);
const panel=Object.create(Panel.prototype),scope={textContent:''},sectionScope={textContent:''};
const picker={sync(){}};
Object.assign(panel,{reviewing:false,liveDisabled:new WeakMap(),liveControls:[reset,unavailable],
 liveSections:[{querySelector(){return sectionScope},querySelectorAll(){return[robot,terrain]}}],
 simulationScope:scope,robotPicker:picker,terrainPicker:picker,policyPicker:picker,flashlightBtn:{title:''}});
panel.setReviewScope(true);panel.setReviewScope(true);
for(const item of[reset,unavailable,robot,terrain])assert.equal(item.disabled,true);
assert.match(sectionScope.textContent,/Recorded motion is fixed/);
panel.setReviewScope(false);
assert.equal(reset.disabled,false);assert.equal(unavailable.disabled,true);
assert.equal(robot.disabled,false);assert.equal(terrain.disabled,true,'A pre-existing map lock survives review');
console.log('PASS: legacy links, complete appearance, native model, illumination, camera roll, flight settings, input validation, long view links');
