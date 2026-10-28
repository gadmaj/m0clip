import { VisualPicker } from './visual-picker';
import { previewImage, staticPreviewOptions } from './preview-catalog';
/** Map filenames, game groups and simulation terrains share one visual gallery. */
export class TerrainPicker extends VisualPicker {
  constructor(select:HTMLSelectElement,onLocalMap?:(file:File)=>Promise<void>){super(select,{id:'terrain',label:'Map or terrain',title:'Choose a map or terrain',
    intake:onLocalMap?{label:'Open map bundle…',select:onLocalMap}:undefined,
    preview:(value,label)=>{if(value.startsWith('map:local-')){const note=document.createElement('span');note.textContent=label;return note;}return previewImage(value.startsWith('map:')?'map':'terrain',value);}});}
  override sync(preserveSearch=false){staticPreviewOptions(this.root.querySelector('select')!,'terrain');super.sync(preserveSearch);}
}
