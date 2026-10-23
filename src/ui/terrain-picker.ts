import { VisualPicker } from './visual-picker';
import { previewImage, staticPreviewOptions } from './preview-catalog';
/** Map filenames, game groups and simulation terrains share one visual gallery. */
export class TerrainPicker extends VisualPicker {
  constructor(select:HTMLSelectElement){super(select,{id:'terrain',label:'Map or terrain',title:'Choose a map or terrain',
    preview:value=>previewImage(value.startsWith('map:')?'map':'terrain',value)});}
  override sync(preserveSearch=false){staticPreviewOptions(this.root.querySelector('select')!,'terrain');super.sync(preserveSearch);}
}
