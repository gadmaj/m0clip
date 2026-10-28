/** Map inspection controls and browser-local / URL camera bookmarks. */
import { isTerrain, type TerrainName } from '../sim/terrain';
import type { Appearance, HeadVisual } from '../render/scene';
import { DEFAULT_DISPLAY, normalizeDisplay, validDisplay, type SceneDisplay } from '../render/display';
import { validAppearance } from './view-appearance';
import type { LookState } from './look';
import { compatibleBody } from '../characters/catalog';
import {validLocalMap,type LocalMapIdentity} from '../maps/source';

export interface SavedView {
  version: 1; robot: string; terrain: TerrainName;
  localMap?:LocalMapIdentity;
  position: [number, number, number]; target: [number, number, number]; fov: number;
  display: SceneDisplay; flashlight: boolean; look: LookState;
  // Optional additions keep version-1 bookmarks and links usable.
  appearance?:Appearance;sourceHead?:HeadVisual;
  orientation?:[number,number,number,number];noclip?:boolean;
  flight?:{speed:number;hover:boolean};
}
const BOOKMARKS_KEY = 'ume-saved-views-v1', DISPLAY_KEY = 'ume-display';
type Bookmark={name:string;view:SavedView};
const TERRAIN_NAMES:Record<string,string>={flat:'Flat ground',rough:'Rough ground',slope:'Slope',stairs:'Stairs',park:'Park'};
const viewLocation=(view:SavedView)=>{
  const id=view.terrain.slice(4);
  const terrain=view.terrain.startsWith('map:local-')?(view.localMap?.name??'Local map')
    :view.terrain.startsWith('map:')?(/\.bsp$/i.test(id)?id:id+'.bsp')
      :(TERRAIN_NAMES[view.terrain]??view.terrain);
  return `${terrain} · ${view.robot.replace(/_/g,' ').toUpperCase()}`;
};
const vector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

export function validView(v: unknown): v is SavedView {
  if (!v || typeof v !== 'object') return false;
  const s = v as SavedView;
  if (s.version !== 1 || !['r1', 'r1_air', 'r1_air_edu', 'g1', 'g1_air', 'go2'].includes(s.robot)
      || !isTerrain(s.terrain) || !vector(s.position) || !vector(s.target)
      || !Number.isFinite(s.fov) || s.fov < 5 || s.fov > 150
      || !validDisplay(s.display) || typeof s.flashlight !== 'boolean' || !s.look
      || !['auto', 'studio', 'map', 'custom', 'daylight', 'overcast', 'night'].includes(s.look.preset)) return false;
  if(s.look.antialiasing!==undefined&&!['fxaa','msaa4','none'].includes(s.look.antialiasing))return false;
  if(s.appearance!==undefined&&(!validAppearance(s.appearance)||!compatibleBody(s.appearance.sourceBody,s.robot)))return false;
  if(s.sourceHead!==undefined&&(s.sourceHead!=='stock'&&s.sourceHead!=='ghost'||s.sourceHead==='ghost'&&!s.robot.startsWith('r1')))return false;
  if(s.noclip!==undefined&&typeof s.noclip!=='boolean')return false;
  if(s.orientation!==undefined&&(!Array.isArray(s.orientation)||s.orientation.length!==4||!s.orientation.every(Number.isFinite)
    ||Math.abs(s.orientation.reduce((n,v)=>n+v*v,0)-1)>.001))return false;
  if(s.flight!==undefined&&(!s.flight||typeof s.flight.hover!=='boolean'||!Number.isFinite(s.flight.speed)||s.flight.speed<1||s.flight.speed>200))return false;
  if(s.localMap!==undefined&&!validLocalMap(s.localMap,s.terrain))return false;
  const l = s.look.custom;
  return !!l && typeof l.shadows === 'boolean' && ['sunAzimuth', 'sunElevation', 'sunIntensity', 'sunColor',
    'ambient', 'skyColor', 'groundColor', 'fill', 'reflections', 'exposure', 'background']
    .every((k) => Number.isFinite(l[k as keyof typeof l]));
}

export function viewLink(view: SavedView, base = location.href): string {
  if(!validView(view))throw new Error('This view contains invalid settings.');
  const url = new URL(base);
  if(view.appearance) {
    if(view.robot.startsWith('r1'))url.searchParams.set('body',view.appearance.sourceBody??'stock');
    else url.searchParams.delete('body');
  }
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(view))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if(encoded.length+6>131072)throw new Error('This view is too large for a share link.');
  url.hash = 'view=' + encoded;
  return url.href;
}

export function sharedView(hash = location.hash): SavedView | null {
  try {
    if (!hash.startsWith('#view=') || hash.length > 131072) return null;
    const text = atob(hash.slice(6).replace(/-/g, '+').replace(/_/g, '/'));
    const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0))));
    return validView(v) ? v : null;
  } catch { return null; }
}

function button(text: string, click: () => void) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
  b.textContent = text; b.onclick = click; return b;
}
function fold(parent: HTMLElement, title: string) {
  const root = document.createElement('details'); root.className = 'fold';
  const summary = document.createElement('summary'); summary.textContent = title;
  const body = document.createElement('div'); body.className = 'fold-body';
  root.append(summary, body); parent.append(root); return body;
}

export class ExplorePanel {
  private display = { ...DEFAULT_DISPLAY };
  private liveDisplay: SceneDisplay | null = null;
  private shotChanged: (() => void) | null = null;
  private renderScope!: HTMLElement;
  private viewScope!: HTMLElement;
  private readOnly = false;
  private checks = new Map<keyof SceneDisplay, HTMLInputElement>();
  private liveViewControls: HTMLButtonElement[] = [];
  private bookmarks: Bookmark[] = [];
  private list: HTMLElement;
  private message: HTMLElement;
  private link: HTMLInputElement;
  private search: HTMLInputElement;
  private results: HTMLElement;
  private undo: HTMLButtonElement;
  private deleted:{bookmark:Bookmark;index:number}|null=null;
  private editing:Bookmark|null=null;
  private restoreRequest=0;

  constructor(parent: HTMLElement, private callbacks: {
    display: (display: SceneDisplay) => void; capture: () => SavedView; restore: (view: SavedView) => Promise<void>;
  }) {
    try {
      const display: unknown = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? 'null');
      if (validDisplay(display)) this.display = normalizeDisplay(display);
      const saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '[]');
      if (Array.isArray(saved)) this.bookmarks = saved.filter((v) => typeof v?.name === 'string' && validView(v.view));
    } catch { /* use defaults if a browser preference is damaged */ }
    const render = fold(parent, 'Render controls');
    this.renderScope = document.createElement('div'); this.renderScope.className = 'sub';
    this.renderScope.textContent = 'LIVE'; render.append(this.renderScope);
    for (const [key, label] of Object.entries({ textures: 'Textures', wireframe: 'Map wireframe', characterWireframe: 'Character wireframe', map: 'Map geometry', decals: 'Decals and markings', robot: 'Robot' })) {
      const row = document.createElement('label'); row.className = 'lk-check';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.display[key as keyof SceneDisplay];
      input.onchange = () => this.setDisplay({ ...this.display, [key]: input.checked });
      this.checks.set(key as keyof SceneDisplay, input); row.append(input, ' ' + label); render.append(row);
    }
    callbacks.display(this.display);
    const views = fold(parent, 'Saved views');
    this.viewScope = document.createElement('div'); this.viewScope.className = 'sub'; this.viewScope.textContent = 'LIVE';
    views.append(this.viewScope);
    const name = document.createElement('input'); name.type = 'text'; name.placeholder = 'View name (optional)'; name.setAttribute('aria-label', 'View name (optional)');
    name.maxLength = 80; name.style.minWidth = '0'; name.style.flex = '1';
    const saveRow = document.createElement('div'); saveRow.className = 'row';
    const save=()=>{
      const unavailable = this.viewUnavailable();
      if (unavailable) { this.showMessage(unavailable); return; }
      try{
        const view=callbacks.capture();if(!validView(view))throw new Error('Wait for the scene to finish loading, then save the view again.');
        let number=1;while(this.bookmarks.some(bookmark=>bookmark.name===`View ${number}`))number++;
        const title=name.value.trim()||`View ${number}`;
        if(!this.persist([...this.bookmarks,{name:title,view}]))return;
        name.value='';this.search.value='';this.editing=null;this.renderBookmarks();this.showMessage(`Saved “${title}” in this browser.`);
      }catch(error){this.showMessage(error instanceof Error?error.message:String(error))}
    };
    name.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();save()}};
    const saveButton = button('Save view', save);
    this.liveViewControls.push(saveButton);
    saveRow.append(name, saveButton);
    this.search=document.createElement('input');this.search.type='search';this.search.className='saved-view-filter';
    this.search.placeholder='Search names, map files or robots';this.search.setAttribute('aria-label','Search saved views');this.search.setAttribute('aria-controls','saved-view-list');
    this.search.oninput=()=>{this.editing=null;this.renderBookmarks()};
    this.search.onkeydown=event=>{if(event.key==='Escape'&&this.search.value){event.preventDefault();event.stopPropagation();this.search.value='';this.renderBookmarks()}};
    this.results=document.createElement('div');this.results.className='saved-view-state';this.results.setAttribute('role','status');
    this.list = document.createElement('div');this.list.id='saved-view-list';this.list.setAttribute('role','list');this.list.setAttribute('aria-label','Saved views');
    this.message = document.createElement('div'); this.message.className = 'saved-view-state'; this.message.setAttribute('aria-live', 'polite');
    this.undo=button('Undo delete',()=>{
      if(!this.deleted)return;const {bookmark,index}=this.deleted,next=[...this.bookmarks];next.splice(Math.min(index,next.length),0,bookmark);
      if(!this.persist(next))return;
      this.deleted=null;this.undo.hidden=true;this.search.value='';this.renderBookmarks();this.showMessage(`Restored “${bookmark.name}”.`);this.search.focus({preventScroll:true});
    });this.undo.classList.add('saved-view-undo');this.undo.hidden=true;
    this.link = document.createElement('input'); this.link.type = 'text'; this.link.readOnly = true; this.link.hidden = true;
    this.link.setAttribute('aria-label', 'Shareable view link'); this.link.style.width = '100%';
    this.link.style.marginTop = '6px';
    const help = document.createElement('p'); help.className = 'saved-view-state';
    help.textContent = 'Saves the camera, robot appearance, lighting and flight settings. In LIVE, C resumes robot follow outside Flight. Links need the same map and robot assets on the receiving server.';
    const shareRow = document.createElement('div'); shareRow.className = 'row';
    const shareButton = button('Share current view', () => {
      const unavailable = this.viewUnavailable();
      if (unavailable) { this.showMessage(unavailable); return; }
      try{void this.share(callbacks.capture())}catch(error){this.showMessage(error instanceof Error?error.message:String(error))}
    });
    this.liveViewControls.push(shareButton);
    shareRow.append(shareButton);
    views.append(saveRow, shareRow,
      this.link,this.message,this.undo,this.search,this.results,this.list,help);
    this.renderBookmarks();
  }

  getDisplay(): SceneDisplay { return { ...this.display }; }

  setDisplay(display: SceneDisplay) {
    if (this.readOnly) return;
    this.display = normalizeDisplay(display);
    for (const [k, checkbox] of this.checks) checkbox.checked = this.display[k];
    if (!this.liveDisplay) localStorage.setItem(DISPLAY_KEY, JSON.stringify(this.display));
    this.callbacks.display(this.display);
    this.shotChanged?.();
  }

  beginShotEdit(display: SceneDisplay, changed: () => void): void {
    if (this.readOnly) return;
    this.liveDisplay ??= this.getDisplay();
    this.shotChanged = null;
    this.setDisplay(display);
    this.shotChanged = changed;
    this.renderScope.textContent = 'SHOT';
    this.syncViewControls();
  }

  endShotEdit(): void {
    if (this.readOnly) return;
    const live = this.liveDisplay;
    this.shotChanged = null;
    if (live) this.setDisplay(live);
    this.liveDisplay = null;
    this.renderScope.textContent = 'LIVE';
    this.syncViewControls();
  }

  setReadOnly(on: boolean): void {
    this.readOnly = on;
    for (const checkbox of this.checks.values()) checkbox.disabled = on;
    this.syncViewControls();
  }

  private viewUnavailable(): string | null {
    return this.readOnly ? 'LIVE · Finish export to save/share the current view or restore one.'
      : this.liveDisplay ? 'LIVE · Close Timeline to save/share the current view or restore one.' : null;
  }

  private syncViewControls(): void {
    const reason = this.viewUnavailable();
    this.viewScope.textContent = reason ?? 'LIVE';
    for (const control of [...this.liveViewControls, ...this.list.querySelectorAll<HTMLButtonElement>('.saved-view-restore')]) {
      control.disabled = !!reason;
      if (reason) control.setAttribute('aria-description', reason);
      else control.removeAttribute('aria-description');
    }
  }

  showMessage(text:string){this.message.textContent=text;}

  async restoreView(view:SavedView,restore=this.callbacks.restore) {
    const unavailable = this.viewUnavailable();
    if (unavailable) { this.showMessage(unavailable); return; }
    const request=++this.restoreRequest;this.showMessage('Restoring view…');
    try{await restore(view);if(request===this.restoreRequest)this.showMessage('View restored.');}
    catch(error){if(request===this.restoreRequest)this.showMessage(error instanceof Error?error.message:String(error));}
  }

  private persist(bookmarks:Bookmark[]):boolean {
    try{localStorage.setItem(BOOKMARKS_KEY,JSON.stringify(bookmarks));this.bookmarks=bookmarks;return true}
    catch{this.showMessage('Could not save views in this browser. Free some browser storage or allow site storage, then try again.');return false}
  }

  private async share(view: SavedView) {
    let url:string;
    try{url=viewLink(view);}catch(error){this.showMessage(error instanceof Error?error.message:String(error));return;}
    this.link.hidden = false; this.link.value = url;
    try {
      await navigator.clipboard.writeText(url); this.message.textContent = 'View link copied.';
    } catch {
      this.link.focus(); this.link.select(); this.message.textContent = 'Copy the selected view link.';
    }
  }

  private renderBookmarks() {
    this.list.replaceChildren();
    this.search.hidden=!this.bookmarks.length&&!this.search.value;
    const tokens=this.search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches=this.bookmarks.filter(bookmark=>{
      const text=`${bookmark.name} ${viewLocation(bookmark.view)} ${bookmark.view.terrain} ${bookmark.view.robot}`.toLocaleLowerCase();
      return tokens.every(token=>text.includes(token));
    });
    this.results.textContent=tokens.length?`${matches.length} of ${this.bookmarks.length} saved views`:`${this.bookmarks.length} saved ${this.bookmarks.length===1?'view':'views'}`;
    this.results.hidden=!this.bookmarks.length&&!tokens.length;
    if (!this.bookmarks.length) {
      const empty = document.createElement('p'); empty.className = 'saved-view-state'; empty.textContent = 'No saved views. Select Save view to save this camera and settings.';
      this.list.append(empty); return;
    }
    if(!matches.length){const empty=document.createElement('p');empty.className='saved-view-state';empty.textContent='No matching views. Try another name, map file or robot.';this.list.append(empty);return}
    matches.forEach(bookmark => {
      const index=this.bookmarks.indexOf(bookmark);
      const row = document.createElement('div');row.className='saved-view-item';row.setAttribute('role','listitem');
      if(this.editing===bookmark){this.renderRename(row,bookmark);this.list.append(row);return}
      const restore = button(bookmark.name, () => {void this.restoreView(bookmark.view);});
      restore.classList.add('saved-view-restore');restore.setAttribute('aria-label',bookmark.name);
      restore.title = `Restore ${bookmark.name} on ${viewLocation(bookmark.view)}`;
      const title=document.createElement('span'),location=document.createElement('span');title.className='saved-view-name';title.textContent=bookmark.name;title.dir='auto';
      location.className='saved-view-location';location.textContent=viewLocation(bookmark.view);location.id=`saved-view-location-${index}`;
      restore.setAttribute('aria-describedby',location.id);restore.replaceChildren(title,location);
      const open=document.createElement('span');open.className='saved-view-open';open.setAttribute('aria-hidden','true');
      open.innerHTML='<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';restore.append(open);
      const share = button('Share', () => { void this.share(bookmark.view); });
      share.setAttribute('aria-label',`Share ${bookmark.name}`);
      const rename=button('Rename',()=>{
        this.editing=bookmark;this.renderBookmarks();const input=this.list.querySelector<HTMLInputElement>('.saved-view-rename');input?.focus({preventScroll:true});input?.select();
      });rename.setAttribute('aria-label',`Rename ${bookmark.name}`);
      const remove = button('Delete', () => {
        if(!this.persist(this.bookmarks.filter(item=>item!==bookmark)))return;
        this.deleted={bookmark,index};this.undo.hidden=false;this.renderBookmarks();this.showMessage(`Deleted “${bookmark.name}”.`);(this.search.hidden?this.undo:this.search).focus({preventScroll:true});
      });remove.classList.add('ghost','danger');
      remove.setAttribute('aria-label', `Delete ${bookmark.name}`);
      const actions=document.createElement('div');actions.className='row saved-view-actions';actions.append(share,rename,remove);
      row.append(restore,actions);this.list.append(row);
      restore.disabled = this.readOnly || !!this.liveDisplay;
      const reason = this.viewUnavailable();
      if (reason) restore.setAttribute('aria-description', reason);
    });
  }

  private renderRename(row:HTMLElement,bookmark:Bookmark){
    const input=document.createElement('input');input.type='text';input.className='saved-view-rename';input.value=bookmark.name;input.maxLength=80;input.setAttribute('aria-label',`New name for ${bookmark.name}`);
    const cancel=()=>{this.editing=null;this.renderBookmarks();this.search.focus({preventScroll:true})};
    const save=()=>{
      const name=input.value.trim();if(!name){input.setCustomValidity('Enter a view name.');input.reportValidity();return}
      if(!this.persist(this.bookmarks.map(item=>item===bookmark?{...item,name}:item)))return;
      this.editing=null;this.search.value='';this.renderBookmarks();this.showMessage(`Renamed view to “${name}”.`);this.search.focus({preventScroll:true});
    };
    input.oninput=()=>input.setCustomValidity('');
    input.onkeydown=event=>{if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();event.stopPropagation();event.key==='Enter'?save():cancel()}};
    const actions=document.createElement('div');actions.className='row saved-view-actions';actions.append(button('Save name',save),button('Cancel',cancel));row.append(input,actions);
  }
}
