/** Searchable native-select presentation. Canonical values and change events stay intact. */
export interface SearchPickerConfig {
  id:string;label:string;listLabel:string;placeholder:string;category:string;empty:string;
  descriptions?:boolean;policyLabels?:boolean;
}
export class SearchPicker {
  readonly root = document.createElement('div');
  readonly input = document.createElement('input');
  private popup = document.createElement('div');
  private list = document.createElement('div');
  private status = document.createElement('div');
  private options: HTMLOptionElement[] = [];
  private active = 0;

  constructor(private select: HTMLSelectElement,private config:SearchPickerConfig) {
    this.root.className = 'terrain-picker'+(config.policyLabels?' policy-picker':'');
    const icon = document.createElement('span');
    icon.className = 'terrain-search-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4 4"/></svg>';
    this.input.id = config.id+'-search'; this.input.type = 'text'; this.input.autocomplete = 'off'; this.input.spellcheck = false;
    this.input.setAttribute('role', 'combobox'); this.input.setAttribute('aria-label', config.label);
    this.input.setAttribute('aria-autocomplete', 'list'); this.input.setAttribute('aria-controls', config.id+'-options');
    this.input.setAttribute('aria-expanded', 'false'); this.input.placeholder = config.placeholder;
    this.popup.className = 'terrain-popup'+(config.policyLabels?' policy-popup':''); this.popup.hidden = true;
    this.list.id = config.id+'-options'; this.list.className = 'terrain-options';
    this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', config.listLabel);
    this.status.className = 'terrain-search-status'; this.status.setAttribute('role', 'status');
    this.popup.append(this.list, this.status); document.body.append(this.popup);
    this.select.hidden = true; this.select.tabIndex = -1;
    this.root.append(icon, this.input, this.select);
    this.input.onfocus = () => this.open();
    this.input.onclick = () => { if (this.popup.hidden) this.open(); };
    this.input.oninput = () => { this.active = 0; this.render(this.input.value); };
    this.input.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
      else if (event.key === 'Tab') this.close();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (this.popup.hidden) this.open();
        else { this.active = (this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.options.length) % (this.options.length || 1); this.highlight(); }
      } else if (event.key === 'Enter' && !this.popup.hidden) {
        event.preventDefault(); const option = this.options[this.active]; if (option) this.choose(option);
      }
    };
    document.addEventListener('pointerdown', event => {
      if (!this.root.contains(event.target as Node) && !this.popup.contains(event.target as Node)) this.close();
    });
    document.addEventListener('focusin', event => {
      if (!this.root.contains(event.target as Node) && !this.popup.contains(event.target as Node)) this.close();
    });
    window.addEventListener('resize', () => this.position());
    window.addEventListener('scroll', event => { if (!this.popup.contains(event.target as Node)) this.position(); }, true);
    this.select.addEventListener('change', () => this.sync());
    this.sync();
  }

  sync(preserveSearch=false) {
    this.input.disabled=this.select.disabled||!Array.from(this.select.options).some(option=>!option.disabled);
    if(preserveSearch&&!this.input.disabled&&!this.popup.hidden){this.render(this.input.value);return;}
    if (!this.popup.hidden) this.close();
    const option = this.select.selectedOptions[0];
    this.input.value = option?.textContent ?? '';
    this.input.title = this.input.value;
  }

  private open() {
    if(this.input.disabled)return;
    this.popup.hidden = false; this.input.setAttribute('aria-expanded', 'true');
    this.input.value = ''; this.active = Math.max(0, Array.from(this.select.options).findIndex(option => option.selected));
    this.render(''); this.position(); this.highlight();
  }

  private close() {
    if (this.popup.hidden) return;
    this.popup.hidden = true; this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant');
    this.input.value = this.select.selectedOptions[0]?.textContent ?? ''; this.input.title = this.input.value;
  }

  private choose(option: HTMLOptionElement) {
    const changed = this.select.value !== option.value;
    this.select.value = option.value; this.close(); this.input.blur();
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private render(query: string) {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    this.options = Array.from(this.select.options).filter(option => {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : this.config.category;
      const search=`${option.textContent} ${option.value} ${group} ${this.config.descriptions?option.title:''}`.toLowerCase();
      return !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled)
        && tokens.every(token => search.includes(token));
    });
    this.list.replaceChildren();
    let previous = '';
    this.options.forEach((option, index) => {
      const category = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : this.config.category;
      if (category !== previous) {
        const heading = document.createElement('div'); heading.className = 'terrain-group'; heading.textContent = category;
        heading.setAttribute('role', 'presentation'); this.list.append(heading); previous = category;
      }
      const row = document.createElement('button'); row.type = 'button'; row.className = 'terrain-option';
      row.id = `${this.config.id}-option-${index}`;row.tabIndex=-1; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected));
      if(this.config.policyLabels&&option.dataset.label){
        const title=document.createElement('span'),name=document.createElement('span');
        title.className='picker-primary';title.textContent=option.dataset.label;
        name.className='picker-secondary';name.textContent=` (${option.value})`;
        row.append(title,name);row.setAttribute('aria-label',option.textContent??'');
      }else row.textContent = option.textContent;
      row.title = option.title||option.textContent||'';
      row.onpointerdown = event => event.preventDefault(); row.onclick = () => this.choose(option);
      row.onpointermove = () => { this.active = index; this.highlight(false); };
      this.list.append(row);
    });
    this.active = Math.min(this.active, Math.max(0, this.options.length - 1));
    if (!this.options.length) {
      const empty = document.createElement('div'); empty.className = 'terrain-empty';
      empty.textContent = this.config.empty; this.list.append(empty);
    }
    this.status.textContent = `${this.options.length} ${this.options.length === 1 ? 'result' : 'results'} · ↑↓ navigate · Enter select`;
    this.highlight(); this.position();
  }

  private highlight(scroll = true) {
    const rows = this.list.querySelectorAll<HTMLButtonElement>('[role="option"]');
    rows.forEach((row, index) => row.classList.toggle('is-active', index === this.active));
    const selected = rows[this.active];
    if (selected) {
      this.input.setAttribute('aria-activedescendant', selected.id);
      if (scroll) selected.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  private position() {
    if (this.popup.hidden) return;
    const box = this.input.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, 300), innerWidth - 24);
    const below = innerHeight - box.bottom - 18, above = box.top - 18;
    const upward = below < 180 && above > below;
    const height = Math.max(100, Math.min(360, upward ? above : below));
    Object.assign(this.popup.style, {
      width: `${width}px`, maxHeight: `${height}px`, left: `${Math.max(12, Math.min(box.right - width, innerWidth - width - 12))}px`,
      top: upward ? 'auto' : `${box.bottom + 6}px`, bottom: upward ? `${innerHeight - box.top + 6}px` : 'auto',
    });
  }
}
