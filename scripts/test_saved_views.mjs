/** Shareable views preserve visual state while accepting old camera-only bookmarks. */
import assert from 'node:assert/strict';import{build}from'esbuild';
const result=await build({stdin:{contents:"export {validView,viewLink,sharedView} from './src/ui/explore';export {STUDIO} from './src/render/scene';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const{validView,viewLink,sharedView,STUDIO}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
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

console.log('PASS: legacy links, complete appearance, native model, illumination, camera roll, flight settings, input validation, long view links');
