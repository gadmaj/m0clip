import {SearchPicker} from './search-picker';
/** Map filenames, game groups and simulation terrains share the searchable select UI. */
export class TerrainPicker extends SearchPicker {
  constructor(select:HTMLSelectElement){super(select,{id:'terrain',label:'Map or terrain',listLabel:'Maps and terrains',
    placeholder:'Search map filenames…',category:'Simulation terrains',empty:'No matching maps or terrains.'});}
}
