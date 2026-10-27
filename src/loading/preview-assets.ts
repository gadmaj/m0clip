/** Preview images are browsing media, not selected-scene loading dependencies. */
const previewAssets = new Set<string>();
function normalized(url: string): string {
  const parsed = new URL(url, globalThis.location.href);
  parsed.hash = '';
  return parsed.href;
}
export function registerPreviewAsset(url: string): void {
  previewAssets.add(normalized(url));
}
export function isPreviewAsset(url: string): boolean {
  return previewAssets.has(normalized(url));
}
