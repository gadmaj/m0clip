import './visual-picker.css';
import { previewMedia } from './preview-media';
import { registerPreviewAsset } from '../loading/preview-assets';

export interface VisualCatalogOption {
  value:string; label:string; thumbnail?:string; description?:string; disabled?:boolean;
}
export interface VisualCatalogPage {
  options:VisualCatalogOption[]; total:number; offset:number; limit:number;
}
export interface VisualPickerConfig {
  id:string; label:string; title?:string; search?:boolean;
  preview:(value:string,label:string)=>HTMLElement|Promise<HTMLElement>;
  description?:(value:string)=>string;
  /** Called only after the user explicitly opens this mode. Results do not select anything. */
  catalog?:{label:string;load:(query:string,offset:number,signal:AbortSignal)=>Promise<VisualCatalogPage>};
  intake?: {label:string;select:(file:File,signal:AbortSignal)=>Promise<void>};
}
/** A view over a canonical select, never a second selection model. */
export class VisualPicker {
  private static opened = new Set<VisualPicker>();
  static get active(){return this.opened.size > 0;}
  readonly root = document.createElement('div');
  readonly button = document.createElement('button');
  /** Selected option's dataset.detail, associated with the trigger as a description. */
  private readonly triggerDetail = document.createElement('span');
  private dialog:HTMLDialogElement|null = null;
  private observer:IntersectionObserver|null = null;
  private generation = 0;
  private disposed = false;
  private request:AbortController|null = null;
  private searchTimer?:number;
  private refreshIncluded:(()=>void)|null=null;
  private readonly changed = () => this.sync();
  constructor(private select:HTMLSelectElement, private config:VisualPickerConfig){
    this.root.className='visual-picker';
    this.button.type='button'; this.button.className='btn visual-picker-trigger';
    this.button.id=`${config.id}-trigger`; this.button.dataset.visualPicker=config.id;
    this.button.setAttribute('aria-label',config.label); this.button.setAttribute('aria-haspopup','dialog');
    this.triggerDetail.id=`${config.id}-trigger-detail`; this.triggerDetail.hidden=true;
    select.before(this.root); this.root.append(select,this.button,this.triggerDetail);
    select.hidden=true; select.tabIndex=-1; select.setAttribute('aria-hidden','true');
    this.button.addEventListener('click',()=>this.open());
    this.button.addEventListener('keydown',event=>{
      if(event.repeat&&(event.key==='Enter'||event.key===' '))event.preventDefault();
    });
    select.addEventListener('change',this.changed); this.sync();
  }
  sync(preserveSearch=false){
    // Optional dataset.label is compact visible text; option.label stays the complete accessible identity.
    const selected=this.select.selectedOptions[0],compact=selected?.dataset.label,full=selected?.label??'';
    const shortened=!!compact&&!!full&&compact!==full;
    this.button.textContent=`${(shortened?compact:full) || this.config.label} ▦`;
    this.button.setAttribute('aria-label',shortened?`${this.config.label}: ${full}`:this.config.label);
    if(shortened)this.button.title=full;else this.button.removeAttribute('title');
    this.triggerDetail.textContent=selected?.dataset.detail??'';
    // Keep caller-owned description ids (e.g. live instructions) beside the selected metadata.
    const described=(this.button.getAttribute('aria-describedby')??'').split(/\s+/).filter(id=>id&&id!==this.triggerDetail.id);
    if(this.triggerDetail.textContent)described.push(this.triggerDetail.id);
    if(described.length)this.button.setAttribute('aria-describedby',described.join(' '));else this.button.removeAttribute('aria-describedby');
    const thumbnail=selected?.dataset.preview;
    if(thumbnail){registerPreviewAsset(thumbnail);const image=document.createElement('img');image.crossOrigin='anonymous';image.loading='lazy';image.decoding='async';image.src=thumbnail;image.alt='';image.onerror=()=>{image.remove();this.button.append(' · Preview unavailable');};this.button.prepend(image);}
    this.button.disabled=this.disabled;
    if(this.dialog){
      if(preserveSearch&&!this.button.disabled&&this.refreshIncluded)this.refreshIncluded();
      else this.close();
    }
  }
  private get disabled(){
    return this.select.disabled||(!this.config.catalog&&!Array.from(this.select.options).some(option=>
      !option.disabled&&!(option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled)));
  }
  private cancelRequest(){this.request?.abort();this.request=null;window.clearTimeout(this.searchTimer);this.searchTimer=undefined;}
  private close(restore=true){
    const dialog=this.dialog; if(!dialog)return;
    this.dialog=null; ++this.generation; this.cancelRequest();this.observer?.disconnect(); this.observer=null;
    this.refreshIncluded=null;
    dialog.close(); dialog.remove(); VisualPicker.opened.delete(this);
    window.dispatchEvent(new Event('visual-picker-close'));
    if(restore) (document.getElementById(`${this.config.id}-trigger`) as HTMLButtonElement|null)?.focus({preventScroll:true});
    if(restore)queueMicrotask(()=>{if(!VisualPicker.active)(document.getElementById(`${this.config.id}-trigger`) as HTMLButtonElement|null)?.focus({preventScroll:true});});
  }
  private open(){
    if(this.disposed || this.disabled || this.dialog)return;
    for(const picker of VisualPicker.opened)picker.close(false);
    const dialog=document.createElement('dialog'); this.dialog=dialog;
    for(const type of ['keydown','keyup','pointerdown','pointerup','click'])dialog.addEventListener(type,event=>event.stopPropagation());
    dialog.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!event.isComposing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey){event.preventDefault();this.close();}
    });
    dialog.className='visual-picker-dialog'; dialog.dataset.visualPicker=this.config.id;
    const header=document.createElement('header');
    const title=document.createElement('h2'); title.id=`${this.config.id}-gallery-title`; title.textContent=this.config.title??`Choose ${this.config.label}`; title.tabIndex=-1;
    dialog.setAttribute('aria-labelledby',title.id);
    const close=document.createElement('button'); close.type='button'; close.className='btn'; close.textContent='Close'; close.onclick=()=>this.close();
    header.append(title,close); dialog.append(header);
    const action=(text:string,callback:()=>void)=>{const button=document.createElement('button');button.type='button';button.className='btn';button.textContent=text;button.onclick=callback;return button;};
    let sourceMode=false,offset=0,page:VisualCatalogPage|null=null;
    const modes=document.createElement('div');modes.className='visual-picker-actions';
    const included=action('Included',()=>switchMode(false));
    const source=action(this.config.catalog?.label??'Source models',()=>switchMode(true));
    if(this.config.catalog){modes.append(included,source);dialog.append(modes);}
    let search:HTMLInputElement|undefined;
    if(this.config.search!==false||this.config.catalog){search=document.createElement('input'); search.type='search'; search.placeholder=`Search ${this.config.label.toLowerCase()}…`; search.setAttribute('aria-label',`Search ${this.config.label}`); dialog.append(search);}
    const grid=document.createElement('div'); grid.className='visual-picker-grid'; dialog.append(grid);
    // Complete identity of the focused, otherwise selected, visible card (dataset.detail / compact labels only).
    const detail=document.createElement('p');detail.id=`${this.config.id}-gallery-detail`;detail.dataset.visualPickerDetail='';detail.hidden=true;dialog.append(detail);
    const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;dialog.append(status);
    if(this.config.intake){
      const input=document.createElement('input');input.type='file';input.accept='.zip,application/zip';input.hidden=true;dialog.append(input);
      const actions=document.createElement('div');actions.className='visual-picker-actions';header.after(actions);
      const intake=action(this.config.intake.label,()=>input.click());actions.append(intake);
      input.onchange=async()=>{const file=input.files?.[0];if(!file)return;this.cancelRequest();const request=this.request=new AbortController();intake.disabled=true;status.hidden=false;status.textContent='Reading map index…';try{await this.config.intake!.select(file,request.signal);if(this.dialog===dialog)this.close();}catch(error){if(this.dialog===dialog){status.textContent=error instanceof Error?error.message:String(error);intake.disabled=false;input.value='';}}};
    }
    const navigation=document.createElement('div');navigation.className='visual-picker-actions';navigation.hidden=true;
    const previous=action('Previous',()=>{offset=Math.max(0,offset-(page?.limit??40));void loadSource();});
    const next=action('Next',()=>{offset+=(page?.limit??40);void loadSource();});
    const retry=action('Retry',()=>{void loadSource();});
    const cancel=action('Cancel search',()=>{this.cancelRequest();++this.generation;grid.removeAttribute('aria-busy');status.hidden=false;status.textContent='Search cancelled.';cancel.hidden=true;retry.hidden=false;});
    navigation.append(previous,next,retry,cancel);dialog.append(navigation);
    const cards:Array<{button:HTMLButtonElement;option:HTMLOptionElement;group:string;slot:HTMLElement;loaded:boolean;detail:string}>=[];
    const groups:Array<{heading:HTMLElement;buttons:HTMLButtonElement[]}>=[];
    const reset=()=>{++this.generation;this.cancelRequest();this.observer?.disconnect();grid.replaceChildren();cards.length=0;groups.length=0;grid.scrollTop=0;status.hidden=true;detail.hidden=true;detail.textContent='';};
    const add=(option:HTMLOptionElement,group:string,parentDisabled:boolean,remote=false)=>{
      const button=document.createElement('button'); button.type='button'; button.className='visual-picker-card'; button.dataset.value=option.value;
      button.disabled=option.disabled||parentDisabled; button.setAttribute('aria-pressed',String(this.select.value===option.value));
      const slot=document.createElement('span'); slot.className='visual-picker-preview'; slot.textContent='Preview loading…';
      const compact=option.dataset.label,shortened=!!compact&&compact!==option.label,metadata=option.dataset.detail;
      const name=document.createElement('span'); name.textContent=shortened?compact:option.label;button.append(slot,name);
      const described:string[]=[];
      const note=(text:string)=>{const small=document.createElement('small');small.id=`${this.config.id}-option-${cards.length}-note`;small.textContent=text;button.append(small);described.push(small.id);};
      const description=option.title||(!remote?this.config.description?.(option.value):undefined);
      if(description)note(description);
      if(button.disabled&&!description)note('Unavailable');
      const full=shortened||metadata?[option.label,metadata].filter(Boolean).join(' · '):'';
      // Shortened visible text: the accessible name carries the exact option label and notes become descriptions.
      if(shortened)button.setAttribute('aria-label',option.label);else described.length=0;
      if(metadata){const text=document.createElement('span');text.id=`${this.config.id}-option-${cards.length}-detail`;text.hidden=true;text.textContent=metadata;button.append(text);described.unshift(text.id);}
      if(full){button.title=full;button.setAttribute('aria-describedby',described.join(' '));}
      button.onclick=()=>{
        if(this.select.disabled||button.disabled)return;
        if(remote){
          const existing=Array.from(this.select.options).find(item=>item.value===option.value);
          if(!existing){option.dataset.catalog='true';this.select.add(option);}
        } else if(!this.select.contains(option))return;
        const changed=this.select.value!==option.value;
        this.select.value=option.value;this.close();
        // Even re-selecting a remembered option is an explicit choice.
        if(changed||this.config.catalog)this.select.dispatchEvent(new Event('change',{bubbles:true}));
        this.sync();
      };
      grid.append(button);const card={button,option,group,slot,loaded:false,detail:full};cards.push(card);
      this.observer?.observe(button);
      return button;
    };
    const loadPreview=(card:typeof cards[number])=>{
      if(card.loaded||card.button.hidden||this.dialog!==dialog)return;card.loaded=true;
      const generation=this.generation;
      Promise.resolve().then(()=>{
        if(this.generation!==generation||this.dialog!==dialog||card.button.hidden)return null;
        if(sourceMode&&card.option.dataset.preview)return previewMedia({still:card.option.dataset.preview});
        return this.config.preview(card.option.value,card.option.label);
      }).then(preview=>{if(!preview){card.loaded=false;return;}if(this.generation!==generation||this.dialog!==dialog){preview.remove();return;}card.slot.replaceChildren(preview);}).catch(()=>{if(this.generation===generation)card.slot.textContent='Preview unavailable';});
    };
    this.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const card=cards.find(c=>c.button===entry.target);if(card)loadPreview(card);}},{root:grid,rootMargin:'100px'});
    const cardFor=(node:EventTarget|null)=>node instanceof Node?cards.find(card=>card.button.contains(node)):undefined;
    /** Focused card, else the selected card; never a filtered-out or previously rendered card. */
    const showDetail=()=>{
      const focused=cardFor(document.activeElement);
      const card=focused&&!focused.button.hidden?focused:cards.find(item=>item.option.value===this.select.value&&!item.button.hidden);
      const text=card?.detail??'';
      if(detail.textContent!==text){detail.textContent=text;if(focused&&card===focused)focused.button.scrollIntoView({block:'nearest'});}
      // Reserve the line while any card has details so focus moves do not resize the grid.
      detail.hidden=!cards.some(item=>item.detail);
    };
    const filter=()=>{const tokens=search?.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)??[];for(const card of cards){const text=`${card.option.dataset.label??''} ${card.option.label} ${card.option.value} ${card.group} ${card.option.title} ${card.option.dataset.detail??''}`.toLocaleLowerCase();card.button.hidden=!tokens.every(token=>text.includes(token));if(!card.button.hidden)this.observer?.observe(card.button);}for(const group of groups)group.heading.hidden=group.buttons.every(b=>b.hidden);status.textContent='No matching options.';status.hidden=cards.some(c=>!c.button.hidden);showDetail();};
    grid.addEventListener('focusin',showDetail);
    grid.addEventListener('focusout',showDetail);
    const renderIncluded=()=>{
      reset();navigation.hidden=true;
      for(const child of this.select.children){
        if(child instanceof HTMLOptGroupElement){const heading=document.createElement('h3');heading.textContent=child.label;grid.append(heading);groups.push({heading,buttons:Array.from(child.children).filter((o):o is HTMLOptionElement=>o instanceof HTMLOptionElement).map(o=>add(o,child.label,child.disabled))});}
        else if(child instanceof HTMLOptionElement)add(child,'',false);
      }
      filter();
    };
    this.refreshIncluded=()=>{
      if(sourceMode)return;
      const active=document.activeElement,focused=cards.find(card=>card.button===active)?.option.value;
      const scroll=grid.scrollTop;
      renderIncluded();grid.scrollTop=scroll;
      if(focused===undefined)return;
      const target=cards.find(card=>card.option.value===focused&&!card.button.hidden&&!card.button.disabled)?.button;
      if(target){target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});}
      else (search??title).focus({preventScroll:true});
    };
    const loadSource=async()=>{
      const catalog=this.config.catalog;if(!catalog)return;
      reset();const generation=this.generation,request=new AbortController();this.request=request;page=null;
      navigation.hidden=false;previous.disabled=true;next.disabled=true;retry.hidden=true;cancel.hidden=false;
      status.hidden=false;status.textContent='Loading Source model index…';grid.setAttribute('aria-busy','true');
      try{
        const result=await catalog.load(search?.value??'',offset,request.signal);
        if(request.signal.aborted||this.dialog!==dialog||generation!==this.generation)return;
        page=result;offset=result.offset;
        for(const item of result.options){const option=new Option(item.label,item.value);option.title=item.description??'';option.disabled=!!item.disabled;if(item.thumbnail)option.dataset.preview=item.thumbnail;add(option,'',false,true);}
        status.textContent=result.total?`${result.offset+1}–${Math.min(result.total,result.offset+result.options.length)} of ${result.total}`:'No matching Source models.';
        previous.disabled=result.offset===0;next.disabled=result.offset+result.limit>=result.total;
      }catch(error){if(request.signal.aborted||this.dialog!==dialog||generation!==this.generation)return;status.textContent=`Source search failed: ${error instanceof Error?error.message:String(error)}`;retry.hidden=false;}
      finally{if(this.dialog===dialog&&generation===this.generation){grid.removeAttribute('aria-busy');cancel.hidden=true;this.request=null;}}
    };
    const switchMode=(value:boolean)=>{sourceMode=value;offset=0;if(search){search.value='';search.placeholder=value?'Search Source models…':`Search ${this.config.label.toLowerCase()}…`;}included.setAttribute('aria-pressed',String(!value));source.setAttribute('aria-pressed',String(value));if(value)void loadSource();else renderIncluded();search?.focus();};
    if(search)search.oninput=()=>{if(!sourceMode){filter();return;}this.cancelRequest();++this.generation;offset=0;previous.disabled=true;next.disabled=true;for(const card of cards)card.button.disabled=true;this.searchTimer=window.setTimeout(()=>{void loadSource();},180);};
    grid.onkeydown=event=>{
      if(event.ctrlKey||event.metaKey||event.altKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      const buttons=cards.map(c=>c.button).filter(b=>!b.hidden&&!b.disabled);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;
      event.preventDefault();const step=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1;
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+step))]?.focus();
    };
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    document.body.append(dialog);VisualPicker.opened.add(this);dialog.showModal();switchMode(false);
    window.dispatchEvent(new Event('visual-picker-open'));(search??title).focus();
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.close(false);this.select.removeEventListener('change',this.changed);this.root.remove();}
}
