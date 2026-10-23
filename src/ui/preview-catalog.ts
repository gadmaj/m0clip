import { authoredCharacter, CHARACTER_CHOICES, characterPhysics, compatibleBody, isBodyVisual } from '../characters/catalog';
import { decodePmodelId, pmodelRecord, searchPmodels } from '../characters/pmodels';
import type { VisualPickerConfig } from './visual-picker';

/** Frozen scene renders: safe in the pre-load launch shell (no renderer imports). */
export function previewImage(kind:'robot'|'character'|'body'|'head'|'map'|'terrain',value:string,robot?:string):HTMLElement {
  const holder=document.createElement('span'); holder.className='static-preview';
  const image=document.createElement('img'); image.alt=''; image.decoding='async'; image.loading='lazy';
  image.crossOrigin='anonymous';
  const name=kind==='map'&&value.startsWith('map:')?`map-${value.slice(4)}`:`${kind}-${value}`;
  image.src=kind==='character'?characterPreviewUrl(value,robot??'r1'):`/assets/previews/${encodeURIComponent(name)}.webp`;
  image.onerror=()=>{holder.textContent=`Preview unavailable: ${value}`;holder.setAttribute('role','status');};
  holder.append(image);return holder;
}

/** Attach only cheap static thumbnail URLs; gallery rendering stays lazy. */
export function staticPreviewOptions(select:HTMLSelectElement,kind:'robot'|'terrain'):void {
  for(const option of select.options){
    const name=kind==='robot'?`robot-${option.value}`:option.value.startsWith('map:')?`map-${option.value.slice(4)}`:`terrain-${option.value}`;
    option.dataset.preview=`/assets/previews/${encodeURIComponent(name)}.webp`;
  }
}

/** Static metadata only: this does not load geometry or a remote model index. */
export function characterPreviewUrl(value:string,robot:string):string {
  const definition=authoredCharacter(value);
  if(definition)return definition.preview;
  const remote=decodePmodelId(value);
  if(remote)return pmodelRecord(remote).thumbnail;
  return `/assets/previews/${encodeURIComponent(value==='dog'?'body-dog':`character-${robot}-${value}`)}.webp`;
}

export function characterDescription(value:string):string {
  if(value==='custom')return 'Current parts and paint.';
  if(value==='stock')return '';
  if(value==='dog')return 'Half-Life 2';
  const definition=authoredCharacter(value);
  if(definition)return `${definition.attribution.creator} · ${definition.attribution.license}`;
  const remote=decodePmodelId(value);
  return remote?`${remote.game==='hl'?'Half-Life':'Sven Co-op'} · ${remote.name}. Compatible humanoid rig required.`
    :'';
}

/** Restore a selected remote identity without requesting the source index. */
export function characterOptions(select:HTMLSelectElement,selected:string,robot:string,disableUnsupported=false):void {
  select.replaceChildren();
  for(const choice of CHARACTER_CHOICES){
    const option=new Option(choice.label,choice.id);option.dataset.preview=characterPreviewUrl(choice.id,robot);
    option.disabled=disableUnsupported&&isBodyVisual(choice.id)&&!compatibleBody(choice.id,robot);
    option.title=option.disabled?`Requires ${characterPhysics(choice.id)==='go2'?'Go2':'R1'} physics.`:characterDescription(choice.id);
    select.add(option);
  }
  if(!Array.from(select.options).some(option=>option.value===selected)){
    const remote=decodePmodelId(selected);
    if(remote){const record=pmodelRecord(remote);const option=new Option(`${record.name} · ${record.game==='hl'?'Half-Life':'Sven Co-op'}`,record.id);option.dataset.preview=record.thumbnail;option.title=characterDescription(record.id);option.disabled=disableUnsupported&&!compatibleBody(record.id,robot);if(option.disabled)option.title='Requires R1 physics.';select.add(option);}
    else {const custom=new Option('Custom mix', 'custom');custom.disabled=true;custom.title='Keep the current mix and paint.';select.add(custom);}
  }
  select.value=selected;
}

export function sourceModelCatalog(compatible:boolean):NonNullable<VisualPickerConfig['catalog']> {
  return {label:'Search Source models',load:async(query,offset,signal)=>{
    const page=await searchPmodels(query,{offset,limit:40,signal});
    return {...page,options:page.results.map(record=>({value:record.id,label:`${record.name} · ${record.game==='hl'?'Half-Life':'Sven Co-op'}`,thumbnail:record.thumbnail,
      description:compatible?'':'Requires R1 physics.',disabled:!compatible}))};
  }};
}
