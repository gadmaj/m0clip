import { registerPreviewAsset } from '../loading/preview-assets';

/** Image-only gallery media. No model, renderer, physics or policy imports. */
export interface PreviewMedia {
  still: string;
  animation?: string;
  caption?: string;
}
interface MediaEntry {
  root: HTMLElement;
  image: HTMLImageElement;
  media: PreviewMedia;
  visible: boolean;
  source: string;
  failedAnimation: boolean;
  loading: boolean;
  cancel?: () => void;
}
const entries = new Map<Element, MediaEntry>();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const maximumRequests = 4;
const maximumAnimations = 4;
let requests = 0;
let observer: IntersectionObserver | undefined;
let removals: MutationObserver | undefined;

function refresh(): void {
  let animations = 0;
  for (const entry of entries.values()) {
    if (!entry.root.isConnected) {
      observer?.unobserve(entry.root);
      entry.cancel?.();
      entry.image.removeAttribute('src');
      entries.delete(entry.root);
      continue;
    }
    const animate = entry.visible && !document.hidden && !reduced.matches
      && !!entry.media.animation && !entry.failedAnimation && animations < maximumAnimations;
    if (animate) animations++;
    const source = animate ? entry.media.animation! : entry.media.still;
    if (!entry.visible || document.hidden) {
      // GIF playback cannot be paused. Drop offscreen sources (stills too) so
      // scrolling a full catalogue does not retain every decoded image.
      if (entry.source) {
        entry.cancel?.();
        entry.image.removeAttribute('src');
        entry.source = '';
      }
      continue;
    }
    if (entry.source === source || entry.loading || requests >= maximumRequests) continue;
    requests++;
    entry.loading = true;
    entry.source = source;
    entry.image.hidden = false;
    let pending = true;
    entry.cancel = () => {
      if (!pending) return;
      pending = false;
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.loading = false;
      requests--;
    };
    const settled = () => {
      if (!pending) return;
      entry.cancel?.();
      refresh();
    };
    entry.image.onload = () => { void entry.image.decode().catch(() => undefined).then(settled); };
    entry.image.onerror = () => {
      if (source === entry.media.animation) { entry.failedAnimation = true; entry.source = ''; }
      else {
        entry.root.setAttribute('role', 'status');
        entry.image.hidden = true;
        entry.root.title = 'Preview unavailable';
        const message = entry.root.querySelector('small');
        if (message) message.textContent = 'Preview unavailable';
        if (message) message.hidden = false;
      }
      settled();
    };
    entry.image.src = source;
  }
  if (!entries.size) { removals?.disconnect(); removals = undefined; }
}

export function previewMedia(media: PreviewMedia): HTMLElement {
  registerPreviewAsset(media.still);
  if (media.animation) registerPreviewAsset(media.animation);
  const root = document.createElement('span'); root.className = 'static-preview';
  const image = document.createElement('img'); image.alt = ''; image.decoding = 'async';
  image.crossOrigin = 'anonymous'; image.width = 320; image.height = 240;
  const caption = document.createElement('small'); caption.textContent = media.caption ?? '';
  caption.hidden = !media.caption;
  root.append(image, caption);
  const entry: MediaEntry = { root, image, media, visible: false, source: '', failedAnimation: false, loading: false };
  entries.set(root, entry);
  if (!observer) {
    observer = new IntersectionObserver(changes => {
      for (const change of changes) {
        const entry = entries.get(change.target);
        if (entry) entry.visible = change.isIntersecting && entry.root.getClientRects().length > 0;
      }
      refresh();
    });
    document.addEventListener('visibilitychange', refresh);
    reduced.addEventListener('change', refresh);
  }
  if (!removals) {
    removals = new MutationObserver(refresh);
    removals.observe(document.body, { childList: true, subtree: true });
  }
  // VisualPicker attaches returned media after resolving its preview promise.
  queueMicrotask(() => { if (entries.has(root)) observer!.observe(root); });
  return root;
}
