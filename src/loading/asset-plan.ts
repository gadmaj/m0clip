/** HTTP-decoded asset entities. Explicit .gz files count before application inflation. */
export interface PlannedAsset {
  url: string;
  bytes: number;
  /** Independent worker module reads cannot be credited from the page realm. */
  realm?: 'map-verification';
}

/** Optional module intake state captured before this load starts. */
export interface PriorModuleIntake {
  complete: boolean;
  before: number;
}

/** Generated from the final serving output, never from larger source masters. */
export interface StartupAssetCatalogue {
  version: 1;
  release: string;
  sizes: Record<string, number>;
  dependencies: Record<string, string[]>;
  runtime: {
    page: string[];
    worker: string[];
    inference: string[];
    /** Optional file-intake module graph, not a scene download root. */
    localMap: string[];
    /** Full converted-map verifier, selected only by a Load that uses it. */
    localMapVerification: string[];
  };
  mapVisuals: Record<string, string[]>;
  modelBundles: Record<string, string[]>;
}

export interface WorkerAssetPlan {
  generation: number;
  token: string;
  robot: string;
  policy: string | null;
  pack: string | null;
  inference: boolean;
  urls: string[];
  prepared: PlannedAsset[];
}

export interface VisualAssetSelection {
  terrain: string;
  robot: string;
  body: string;
  head: 'stock' | 'ghost';
}

export interface VisualAssetPlan {
  urls: string[];
  prepared: PlannedAsset[];
}
