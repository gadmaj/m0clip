import { assetUrl } from './assets';
import type { EvalConfig } from './types';

export interface DriverAssets {
  policy: string;
  models: Record<string, string>;
  files: Record<string, string>;
  clip?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function paths(value: unknown, network: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [role, path] of Object.entries(record(value))) {
    if (typeof path === 'string' && path) {
      const url = assetUrl(path);
      result[role] = network ? url.replace(/\.mnn$/, '.onnx') : url;
    }
  }
  return result;
}

/** The factory and planner share this exact selected network/data closure. */
export function selectedDriverAssets(cfg: EvalConfig): DriverAssets {
  const result: DriverAssets = {
    policy: assetUrl(cfg.policy.path).replace(/\.mnn$/, '.onnx'), models: {}, files: {},
  };
  if (cfg.r1?.firmware) {
    result.models = paths(cfg.r1.aux_models, true);
    if (['mimic', 'simple', 'track'].includes(String(cfg.r1.obs_scheme)))
      result.files = paths(cfg.r1.aux_files, false);
    return result;
  }
  if (cfg.go2?.firmware) {
    result.models = paths(cfg.go2.aux_models, true);
    return result;
  }
  if (!(cfg.family.startsWith('g1_') || cfg.robot === 'g1' || cfg.g1)) return result;
  const g = cfg.g1;
  const scheme = g?.obs_scheme;
  if (scheme === 'cpy_jump' || scheme === 'zjx_jump' || cfg.family === 'g1_mimic' || scheme === 'mimic') {
    if (g?.motion_clip) result.clip = assetUrl(g.motion_clip);
    return result;
  }
  if (scheme === 'squat2stand') return result;
  result.models = paths(g?.aux_models, true);
  const files = paths(g?.aux_files, false);
  let roles: string[] = [];
  if (scheme === 'bm_getup') roles = ['faceup_motion', 'facedown_motion'];
  else if (scheme === 'faceup') {
    const faceup = record(g?.faceup);
    roles = [typeof faceup.latent === 'string' ? faceup.latent : 'latent'];
  } else if (scheme === 'punch') {
    roles = Object.values(record(record(g?.punch).trajs)).flatMap(value => {
      const file = record(value).file;
      return typeof file === 'string' ? [file] : [];
    });
  } else if (scheme === 'vq') {
    const v = record(g?.vq);
    const mode = v.mode ?? (g?.fsm_id === 706 ? 'getup' : g?.fsm_id === 504 ? 'traj' : 'dance');
    const stance = typeof v.stance_latent === 'string' ? v.stance_latent : 'stance';
    if (mode === 'getup') roles = [typeof v.latent === 'string' ? v.latent : 'latent'];
    else if (mode === 'dance') {
      const clips = Array.isArray(v.clips) ? v.clips.filter((role): role is string => typeof role === 'string')
        : Object.keys(files).filter(role => role !== stance).sort();
      roles = [stance, ...clips];
    } else if (mode === 'task') {
      roles = [stance, ...(Array.isArray(v.motions) ? v.motions.flatMap(value => {
        const file = record(value).file;
        return typeof file === 'string' ? [file] : [];
      }) : [])];
    }
  }
  for (const role of roles) if (files[role]) result.files[role] = files[role];
  return result;
}

export function driverAssetUrls(assets: DriverAssets): string[] {
  return [...new Set([assets.policy, ...Object.values(assets.models), ...Object.values(assets.files),
    ...(assets.clip ? [assets.clip] : [])])];
}
