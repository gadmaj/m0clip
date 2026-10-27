import type { PlannedAsset, PriorModuleIntake, StartupAssetCatalogue } from './asset-plan';

/** One key per HTTP entity, regardless of relative spelling or URL fragment. */
export function catalogueAssetKey(value: string): string {
  const url = new URL(value, globalThis.location.href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Not an HTTP asset: ${value}`);
  url.hash = '';
  return url.origin === globalThis.location.origin ? `${url.pathname}${url.search}` : url.href;
}

export function expandAssetUrls(catalogue: StartupAssetCatalogue, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (value: string) => {
    const key = catalogueAssetKey(value);
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of catalogue.dependencies[key] ?? []) visit(dependency);
  };
  for (const root of roots) visit(root);
  return [...seen];
}

let startupCatalogue: Promise<StartupAssetCatalogue> | undefined;
export function loadStartupCatalogue(): Promise<StartupAssetCatalogue> {
  return startupCatalogue ??= fetch(__STARTUP_CATALOGUE_URL__).then(async response => {
    if (!response.ok) throw new Error(`Scene asset catalogue could not load (HTTP ${response.status}). Reload to try again.`);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') throw new Error('The scene asset catalogue is invalid. Reload to try again.');
    const catalogue = value as Partial<StartupAssetCatalogue>;
    if (catalogue.version !== 1 || typeof catalogue.release !== 'string'
      || !catalogue.sizes || !catalogue.dependencies || !catalogue.runtime
      || !Array.isArray(catalogue.runtime.page) || !Array.isArray(catalogue.runtime.worker)
      || !Array.isArray(catalogue.runtime.inference) || !Array.isArray(catalogue.runtime.localMap)
      || !catalogue.mapVisuals || !catalogue.modelBundles) {
      throw new Error('The scene asset catalogue is incomplete. Reload to try again.');
    }
    for (const [url, bytes] of Object.entries(catalogue.sizes)) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`The asset size is invalid: ${url}`);
    }
    return catalogue as StartupAssetCatalogue;
  });
}

/** Prior optional module reads are outside this scene's page-download scope.
 * A failed/pending entry cannot hide unfinished dependencies or hold Load hostage. */
export function priorIntakeAssets(catalogue: StartupAssetCatalogue, intake: PriorModuleIntake | undefined,
  entries: readonly (Pick<PerformanceResourceTiming, 'name' | 'startTime' | 'responseEnd' | 'decodedBodySize'>
    & { responseStatus?: number })[]): string[] {
  if (!intake) return [];
  if (intake.complete) return catalogue.runtime.localMap;
  const graph = new Set(catalogue.runtime.localMap.map(catalogueAssetKey));
  const completed = new Set<string>();
  for (const entry of entries) {
    if (entry.startTime >= intake.before || entry.responseEnd <= 0 || !/^https?:/i.test(entry.name)
      || entry.responseStatus === undefined || entry.responseStatus < 200 || entry.responseStatus >= 300) continue;
    const key = catalogueAssetKey(entry.name);
    if (graph.has(key) && entry.decodedBodySize === catalogue.sizes[key]) completed.add(key);
  }
  return [...completed];
}

/** Prior bodies are excluded from this scope, never credited as later downloads.
 * Unknown selected external bodies must already have been retained by their planner. */
export function plannedAssets(catalogue: StartupAssetCatalogue, roots: readonly string[], prepared: readonly PlannedAsset[],
  priorAssets: readonly string[] = []): PlannedAsset[] {
  const sizes = new Map<string, number>();
  for (const asset of prepared) {
    const key = catalogueAssetKey(asset.url), expected = catalogue.sizes[key], previous = sizes.get(key);
    if ((expected !== undefined && expected !== asset.bytes) || (previous !== undefined && previous !== asset.bytes))
      throw new Error(`Prepared asset payload does not match this release's catalogue: ${key}`);
    sizes.set(key, asset.bytes);
  }
  const prior = new Set(priorAssets.map(catalogueAssetKey));
  return expandAssetUrls(catalogue, roots).filter(url => !prior.has(url)).map(url => {
    const bytes = sizes.get(url) ?? catalogue.sizes[url];
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`The selected asset has no exact payload size: ${url}`);
    return { url, bytes };
  });
}
