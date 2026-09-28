#!/usr/bin/env python3
"""Import Unitree G1 ai_sport policies into unitree-mujoco-web.

Decodes FMX-encrypted YAML configs, copies .mnn models and motion clips,
converts .mnn to .onnx with verification, classifies policies into families,
and generates runnable eval configs and a registry catalog.

Usage:
  python3 scripts/import_g1_ai_sport.py --src /path/to/module/ai_sport
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "scripts"))
import fmx  # noqa: E402
from mnn_graph_to_onnx import convert as mnn_convert, verify as mnn_verify  # noqa: E402  (shape-faithful)


def _log(m):
    print(m, flush=True)


def _copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
        shutil.copy2(src, dst)
    return dst


def _rel(p):
    return os.path.relpath(p, REPO)


def _mnn_io(path):
    import MNN
    interp = MNN.Interpreter(path)
    sess = interp.createSession({})
    ins = {k: list(v.getShape()) for k, v in interp.getSessionInputAll(sess).items()}
    outs = {k: list(v.getShape()) for k, v in interp.getSessionOutputAll(sess).items()}
    return ins, outs


def _load_cfg(path):
    """Decode (FMX) + parse a policy YAML."""
    try:
        txt = fmx.decrypt_text(path) if fmx.is_fmx(path) else open(path).read()
        return yaml.safe_load(txt)
    except Exception:
        return None


def _resolve_mnn(ref, cfgdir, ai_root):
    ref = ref.strip().strip('"').strip("'")
    for base in (cfgdir, ai_root, os.path.dirname(cfgdir)):
        p = os.path.normpath(os.path.join(base, ref))
        if os.path.exists(p):
            return p
    hits = glob.glob(os.path.join(cfgdir, "**", os.path.basename(ref)), recursive=True)
    return hits[0] if hits else None


LOCO_DIRS = {"normal_walk", "walk_29dofs", "cpy_walk_run_29dofs", "cpy_run_29dofs",
             "cpy_stair_loco", "human_loco", "blind_terrain"}


def _classify(dirname, ins, outs):
    n = dirname.lower()
    innames = set(ins)
    has_split = {"proprioception", "commands", "memory"} <= innames or \
                {"proprioception", "commands"} <= innames
    if "vision" in n or "v_obs" in innames or "hid_in" in innames:
        return "vision"
    if any(k in n for k in ("mimic", "dance", "fight")) or "target_state" in innames:
        return "mimic"
    if any(k in n for k in ("punch", "traj_loco")):
        return "punch"
    if any(k in n for k in ("getup", "squat", "stand", "transis")):
        return "getup"
    if "jump" in n:
        return "jump"
    if has_split or n in LOCO_DIRS or "walk" in n or "run" in n or "loco" in n or "terrain" in n:
        return "locomotion"
    if "encoder" in n or "control" in n:
        return "encoder"
    return "other"


OBS_SCALES = {"ang_vel": 0.25, "dof_pos": 1.0, "dof_vel": 0.05}


def _first(cfg, *keys, default=None):
    for k in keys:
        if k in cfg and cfg[k] is not None:
            return cfg[k]
    return default


def _mnn_refs(cfg):
    out, seen = [], set()

    def walk(v):
        if isinstance(v, str) and v.strip().strip('"').endswith(".mnn"):
            s = v.strip().strip('"')
            if s not in seen:
                seen.add(s)
                out.append(s)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(cfg)
    return out


G1_DEFAULT_29 = [-0.15, 0.0, 0.0, 0.3, -0.15, 0.0, -0.15, 0.0, 0.0, 0.3, -0.15, 0.0,
                 0.0, 0.0, 0.0, 0.26, 0.14, -0.09, 0.96, 0.0, 0.0, 0.0,
                 0.26, -0.14, 0.09, 0.96, 0.0, 0.0, 0.0]

G1_CANON_KP = [100, 100, 100, 150, 40, 40, 100, 100, 100, 150, 40, 40,
               200, 200, 200, 60, 60, 60, 60, 40, 40, 40, 60, 60, 60, 60, 40, 40, 40]
G1_CANON_KD = [4, 4, 4, 5, 3, 3, 4, 4, 4, 5, 3, 3, 6, 6, 6,
               3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]
G1_CANON_TAU = [88, 88, 88, 139, 50, 50, 88, 88, 88, 139, 50, 50, 88, 50, 50,
                25, 25, 25, 25, 25, 5, 5, 25, 25, 25, 25, 25, 5, 5]


def _floor_hold_gains(blk):
    ctrl = set(blk.get("control_joints", []))
    kp = list(blk.get("kp", list(G1_CANON_KP)))
    kd = list(blk.get("kd", list(G1_CANON_KD)))
    tau = list(blk.get("tau", list(G1_CANON_TAU)))
    kp += [0.0] * (29 - len(kp))
    kd += [0.0] * (29 - len(kd))
    tau += [0.0] * (29 - len(tau))
    for j in range(29):
        if j not in ctrl:
            kp[j] = max(float(kp[j]), G1_CANON_KP[j])
            kd[j] = max(float(kd[j]), G1_CANON_KD[j])
            tau[j] = max(float(tau[j]), G1_CANON_TAU[j])
    blk["kp"] = kp[:29]
    blk["kd"] = kd[:29]
    blk["tau"] = tau[:29]
    return blk


def _scatter29(vals, control_joints, held_fill, base=None):
    out = [held_fill] * 29 if base is None else list(base)
    for i, j in enumerate(control_joints):
        if 0 <= j < 29 and i < len(vals):
            out[j] = vals[i]
    return out


def _loco_block(cfg, ins, outs, control_joints, n_act, num_obs, mem):
    split = {"proprioception", "commands"} <= set(ins)
    default = _first(cfg, "default_dof_pos", "default_joint_q", default=[0.0] * 29)
    ascale = _first(cfg, "action_scale", "output_scale", default=0.25)
    kp = _first(cfg, "joint_kp", "kp")
    kd = _first(cfg, "joint_kd", "kd")
    tau = _first(cfg, "joint_tau_limits", "torque_limits")
    dt = float(_first(cfg, "control_dt", "dt", default=0.02))
    blk = {
        "obs_scheme": "split" if split else "concat",
        "control_joints": list(control_joints),
        "num_obs": int(num_obs),
        "num_act": int(n_act),
        "memory_size": int(mem),
        "dof_pos_rel": not split,
        "default_dof_pos": list(default),
        "action_scale": ascale if isinstance(ascale, (int, float)) else list(ascale),
        "action_clip": float(_first(cfg, "action_clip", default=100.0)),
        "obs_clip": float(_first(cfg, "observation_clip", "obs_clip", default=100.0)),
        "ang_vel_scale": float(cfg.get("observation_scale_angular_vel", OBS_SCALES["ang_vel"])),
        "dof_pos_scale": float(cfg.get("observation_scale_dof_pos", OBS_SCALES["dof_pos"])),
        "dof_vel_scale": float(cfg.get("observation_scale_dof_vel", OBS_SCALES["dof_vel"])),
        "dt": dt,
        "cmd_in_obs": not split,
        "has_phase": bool(not split and (num_obs - (9 + 3 * n_act)) == 1),
    }
    if kp is not None:
        blk["kp"] = list(kp)
    if kd is not None:
        blk["kd"] = list(kd)
    if tau is not None:
        blk["tau"] = list(tau)
    vr = _first(cfg, "init_max_cmd")
    if vr:
        blk["vel_range"] = [-vr[0], vr[0], -vr[1], vr[1], -vr[2], vr[2]]
    return blk


def _phase_mimic_block(cfg, control_joints, n_act, num_obs, mem):
    dq = _first(cfg, "default_joint_q", "default_dof_pos", default=[0.0] * n_act)
    kp = _first(cfg, "joint_kp", "kp")
    kd = _first(cfg, "joint_kd", "kd")
    asc = _first(cfg, "action_scale", default=1.0)
    coeff = float(_first(cfg, "action_scale_coeff", default=1.0))
    if not isinstance(asc, (int, float)):
        asc = [a * coeff for a in asc]
    else:
        asc = float(asc) * coeff
    blk = {
        "obs_scheme": "concat",
        "control_joints": list(control_joints),
        "num_obs": int(num_obs),
        "num_act": int(n_act),
        "memory_size": int(mem),
        "dof_pos_rel": True,
        "default_dof_pos": _scatter29(list(dq), control_joints, 0.0, base=G1_DEFAULT_29),
        "action_scale": (_scatter29(asc, control_joints, 0.0) if not isinstance(asc, float) else asc),
        "action_clip": float(_first(cfg, "action_clip", default=4.0)),
        "obs_clip": float(_first(cfg, "observation_clip", "obs_clip", default=100.0)),
        "ang_vel_scale": float(_first(cfg, "observation_scale_ang_vel", default=OBS_SCALES["ang_vel"])),
        "dof_pos_scale": float(_first(cfg, "observation_scale_dof_pos", default=1.0)),
        "dof_vel_scale": float(_first(cfg, "observation_scale_dof_vel", default=OBS_SCALES["dof_vel"])),
        "dt": float(_first(cfg, "control_dt", "dt", default=0.02)),
        "cmd_in_obs": False,
        "has_phase": True,
        "maneuver": True,
        "ground_start": None,
        "maneuver_period": float(_first(cfg, "mimic_trajectory_duration", default=9.35)),
    }
    blk["init_pose"] = list(blk["default_dof_pos"])
    if kp is not None:
        blk["kp"] = _scatter29(list(kp), control_joints, 40.0)
    if kd is not None:
        blk["kd"] = _scatter29(list(kd), control_joints, 2.0)
    return blk


def _find_clip(cfg, dpath):
    df = _first(cfg, "data_file", "dataset_path")
    if df:
        base = os.path.basename(str(df))
        hit = glob.glob(os.path.join(dpath, "**", base), recursive=True)
        if hit:
            return hit[0]
    cands = sorted(glob.glob(os.path.join(dpath, "**", "*end_state.csv"), recursive=True))
    cands = [c for c in cands if "end_trajectory" not in os.path.basename(c)] or cands
    return cands[0] if cands else None


def _mimic_block(cfg, control_joints, n_act, num_obs, mem):
    default = _first(cfg, "default_dof_pos", "default_joint_q", default=[0.0] * 29)
    ascale = _first(cfg, "action_scale", default=0.25)
    kp = _first(cfg, "joint_kp", "kp")
    kd = _first(cfg, "joint_kd", "kd")
    blk = {
        "obs_scheme": "mimic",
        "control_joints": list(control_joints),
        "num_obs": int(num_obs),
        "num_act": int(n_act),
        "memory_size": int(mem),
        "dof_pos_rel": False,
        "default_dof_pos": list(default),
        "action_scale": ascale if isinstance(ascale, (int, float)) else list(ascale),
        "action_clip": float(_first(cfg, "action_clip", default=100.0)),
        "obs_clip": float(_first(cfg, "observation_clip", "obs_clip", default=100.0)),
        "ang_vel_scale": float(cfg.get("observation_scale_angular_vel", OBS_SCALES["ang_vel"])),
        "dof_pos_scale": float(cfg.get("observation_scale_dof_pos", OBS_SCALES["dof_pos"])),
        "dof_vel_scale": float(cfg.get("observation_scale_dof_vel", OBS_SCALES["dof_vel"])),
        "dt": float(_first(cfg, "control_dt", "dt", default=0.02)),
        "cmd_in_obs": False,
        "has_phase": False,
        "maneuver": False,
        "quat_order": "xyzw",
        "root_rel": "xy",
        "clip_loop": False,
    }
    if kp is not None:
        blk["kp"] = list(kp)
    if kd is not None:
        blk["kd"] = list(kd)
    return blk


def _human_loco_block(cfg, n_act, num_obs, mem):
    default = _first(cfg, "default_joint_q", "default_dof_pos", default=[0.0] * 29)
    ascale = _first(cfg, "action_scale", default=0.6)
    kp = _first(cfg, "joint_kp", "kp")
    kd = _first(cfg, "joint_kd", "kd")
    tau = _first(cfg, "joint_tau_limits", "torque_limits")
    control_joints = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] if n_act == 12 else [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]
    if isinstance(ascale, list):
        act_scale = [ascale[i] for i in control_joints]
    else:
        act_scale = [float(ascale)] * n_act
    blk = {
        "obs_scheme": "human_loco",
        "control_joints": control_joints,
        "num_obs": int(num_obs),
        "num_act": int(n_act),
        "memory_size": int(mem),
        "dof_pos_rel": True,
        "default_dof_pos": list(default),
        "action_scale": act_scale,
        "action_clip": float(_first(cfg, "action_clip", default=10.0)),
        "obs_clip": float(_first(cfg, "observation_clip", default=10.0)),
        "ang_vel_scale": float(cfg.get("observation_scale_angular_vel", 0.2)),
        "dof_pos_scale": float(cfg.get("observation_scale_dof_pos", 1.0)),
        "dof_vel_scale": float(cfg.get("observation_scale_dof_vel", 0.05)),
        "dt": float(_first(cfg, "control_dt", default=0.02)),
        "cmd_in_obs": False,
        "has_phase": False,
        "maneuver": False,
        "vel_range": [-1.0, 1.5, -0.6, 0.6, -1.5, 1.5],
    }
    if kp is not None:
        blk["kp"] = list(kp)
    if kd is not None:
        blk["kd"] = list(kd)
    if tau is not None:
        blk["tau"] = list(tau)
    return blk


def _ensure_onnx(mnn_path, onnx_path):
    if not os.path.exists(onnx_path) or os.path.getsize(onnx_path) == 0:
        _log(f"    Converting to ONNX: {os.path.basename(mnn_path)} -> {os.path.basename(onnx_path)}")
        ins, outs = mnn_convert(mnn_path, onnx_path)
        err = mnn_verify(mnn_path, onnx_path, ins, outs)
        _log(f"      Verified max|Δ|={err:.2e}")


def main():
    default_src = ("/home/legion/Documents/reverse_engineer/unitree_ota/G1/EDU/1.5.3/"
                   "package_1.5.3.8_G1_Edu+_1782304538844/package_1.5.3.8_G1_Edu+_upk/module/"
                   "ai_sport/8.7.5.212/file/ai_sport_8.7.5.212/ai_sport/module/ai_sport/file/"
                   "unitree/module/ai_sport")
    ap = argparse.ArgumentParser(description="Import Unitree G1 ai_sport policies")
    ap.add_argument("--src", default=default_src, help="Path to module/ai_sport")
    ap.add_argument("--robot", default="g1")
    a = ap.parse_args()

    ai_root = os.path.abspath(a.src)
    poldir = os.path.join(ai_root, "policies")
    if not os.path.isdir(poldir):
        cand = glob.glob(os.path.join(ai_root, "**", "policies"), recursive=True)
        poldir = cand[0] if cand else poldir
    if not os.path.isdir(poldir):
        sys.exit(f"error: no policies/ dir under {a.src}")
    ai_root = os.path.dirname(poldir)
    _log(f"Importing {a.robot} from {poldir}\n")

    pol_root = os.path.join(REPO, "assets", "policies", a.robot)
    reg = os.path.join(REPO, "registry", a.robot)
    os.makedirs(reg, exist_ok=True)
    catalog = []

    for d in sorted(os.listdir(poldir)):
        dpath = os.path.join(poldir, d)
        if not os.path.isdir(dpath):
            continue
        cfgs = sorted(glob.glob(os.path.join(dpath, "*.yaml")) + glob.glob(os.path.join(dpath, "*.yml")))
        cfg = next((c for c in (_load_cfg(p) for p in cfgs) if c), None)
        if cfg is None:
            _log(f"  ! {d}: no parseable config")
            continue

        refs = _mnn_refs(cfg)
        active = None
        for r in refs:
            p = _resolve_mnn(r, dpath, ai_root)
            if p:
                active = p
                break
        if active is None:
            _log(f"  ! {d}: no resolvable .mnn")
            continue
        try:
            ins, outs = _mnn_io(active)
        except Exception as e:
            _log(f"  ! {d}/{os.path.basename(active)}: MNN read failed: {e}")
            continue

        fam = _classify(d, ins, outs)
        pol_dst = _rel(_copy(active, os.path.join(pol_root, d, os.path.basename(active))))
        onnx_dst = pol_dst[:-4] + ".onnx"

        act_out = next((v for k, v in outs.items() if v and v[-1] in (12, 13, 14, 17, 21, 23, 29)), None)
        n_act = act_out[-1] if act_out else None

        if cfg.get("dof23_or_dof13") == 0 and cfg.get("control_joints_13dofs"):
            control_joints = cfg["control_joints_13dofs"]
            n_act = cfg.get("num_action_13", n_act)
        else:
            cands = [cfg.get(k) for k in ("control_joints", "joint_indices",
                     "client_dof_idx", "client_joint_idx", "action_dof_idx", "action_joint_idx")]
            cands = [c for c in cands if isinstance(c, list)]
            control_joints = next((c for c in cands if n_act and len(c) == n_act),
                                  cands[0] if cands else None)
        if control_joints is None:
            control_joints = list(range(n_act or 29))
        control_joints = [j for j in control_joints if 0 <= j < 29][:n_act or 29]

        entry = {
            "name": f"{d}/{os.path.splitext(os.path.basename(active))[0]}",
            "family": f"g1_{fam}",
            "robot": a.robot,
            "dof": n_act,
            "policy": pol_dst,
            "arch": fam,
            "runnable": False,
            "inputs": ins,
            "outputs": {k: v for k, v in outs.items()},
            "n_models": len(refs),
        }

        obs_in = ins.get("obs") or ins.get("proprioception")
        K = obs_in[-1] if obs_in else 0
        concat = set(ins) == {"obs"} and n_act
        cmd_extra = (K - 6 - 3 * n_act) if (concat and n_act) else -99
        concat_ok = concat and cmd_extra in (0, 1, 3, 4)
        split_base = ins["proprioception"][-1] - 3 * n_act if "proprioception" in ins and n_act else -99
        split_ok = {"proprioception", "commands", "memory"} <= set(ins) and split_base == 6
        mimic_ok = (fam == "mimic" and n_act and
                    {"proprioception", "memory", "quaternion", "target_state"} <= set(ins) and
                    ins["proprioception"][-1] == 6 + 3 * n_act)
        obs_in0 = ins.get("obs")
        phase_mimic_ok = (fam == "mimic" and n_act and set(ins) == {"obs"} and obs_in0 and
                          obs_in0[-1] == 6 + 3 * n_act + 1)

        if phase_mimic_ok:
            try:
                _ensure_onnx(os.path.join(REPO, pol_dst), os.path.join(REPO, onnx_dst))
                num_obs = obs_in0[-1]
                mem = obs_in0[1] if len(obs_in0) == 3 and obs_in0[1] > 1 else 1
                blk = _floor_hold_gains(_phase_mimic_block(cfg, control_joints, n_act, num_obs, mem))
                dur = blk["maneuver_period"]
                eval_cfg = {
                    "name": entry["name"],
                    "robot": a.robot,
                    "family": "g1_locomotion",
                    "control": {"step_dt": 0.02, "sim_dt": 0.0005, "duration": dur + 2.0},
                    "policy": {"path": pol_dst, "arch": "concat", "num_obs": num_obs, "num_act": n_act},
                    "g1": blk,
                }
                out_yaml = os.path.join(reg, f"{entry['name']}.yaml")
                os.makedirs(os.path.dirname(out_yaml), exist_ok=True)
                with open(out_yaml, "w") as f:
                    yaml.safe_dump(eval_cfg, f, sort_keys=False, default_flow_style=None)
                entry["config"] = _rel(out_yaml)
                entry["runnable"] = True
                entry["note"] = f"Phase-driven mimic, {n_act}-DOF"
            except Exception as e:
                _log(f"  ! {entry['name']}: ONNX conversion failed: {e}")
        elif mimic_ok:
            clip = _find_clip(cfg, dpath)
            if clip:
                try:
                    _ensure_onnx(os.path.join(REPO, pol_dst), os.path.join(REPO, onnx_dst))
                    num_obs = ins["proprioception"][-1]
                    mem = ins["memory"][-1] // num_obs
                    clip_dst = _rel(_copy(clip, os.path.join(pol_root, d, "motion_clip.csv")))
                    blk = _floor_hold_gains(_mimic_block(cfg, control_joints, n_act, num_obs, mem))
                    blk["motion_clip"] = clip_dst
                    nframes = sum(1 for _ in open(clip))
                    eval_cfg = {
                        "name": entry["name"],
                        "robot": a.robot,
                        "family": "g1_mimic",
                        "control": {"step_dt": 0.02, "sim_dt": 0.0005,
                                    "duration": min(max(nframes * 0.02 + 1.0, 8.0), 30.0)},
                        "policy": {"path": pol_dst, "arch": "mimic", "num_obs": num_obs, "num_act": n_act},
                        "g1": blk,
                    }
                    out_yaml = os.path.join(reg, f"{entry['name']}.yaml")
                    os.makedirs(os.path.dirname(out_yaml), exist_ok=True)
                    with open(out_yaml, "w") as f:
                        yaml.safe_dump(eval_cfg, f, sort_keys=False, default_flow_style=None)
                    entry["config"] = _rel(out_yaml)
                    entry["runnable"] = True
                    entry["note"] = f"Motion-mimic, {n_act}-DOF ({nframes} frames clip)"
                except Exception as e:
                    _log(f"  ! {entry['name']}: ONNX conversion failed: {e}")
        is_human_loco = {"p_obs", "cmd"} <= set(ins) and "act" in outs
        if is_human_loco:
            try:
                _ensure_onnx(os.path.join(REPO, pol_dst), os.path.join(REPO, onnx_dst))
                n_act = outs["act"][-1]
                num_obs = 48 if n_act == 14 else 42
                p_shape = ins["p_obs"]
                mem = p_shape[1] if len(p_shape) == 3 and p_shape[1] > 1 else (p_shape[-1] // num_obs)
                blk = _floor_hold_gains(_human_loco_block(cfg, n_act, num_obs, mem))
                eval_cfg = {
                    "name": entry["name"],
                    "robot": a.robot,
                    "family": "g1_locomotion",
                    "control": {"step_dt": 0.02, "sim_dt": 0.0005, "duration": 12.0},
                    "policy": {"path": pol_dst, "arch": "human_loco", "num_obs": num_obs, "num_act": n_act},
                    "g1": blk,
                }
                out_yaml = os.path.join(reg, f"{entry['name']}.yaml")
                os.makedirs(os.path.dirname(out_yaml), exist_ok=True)
                with open(out_yaml, "w") as f:
                    yaml.safe_dump(eval_cfg, f, sort_keys=False, default_flow_style=None)
                entry["config"] = _rel(out_yaml)
                entry["runnable"] = True
                entry["note"] = f"HumanLoco (bmlp), {n_act}-DOF"
                entry["fsm_id"] = 500
            except Exception as e:
                _log(f"  ! {entry['name']}: ONNX conversion failed: {e}")
        elif (concat_ok or split_ok) and fam in ("locomotion", "getup", "jump"):
            try:
                _ensure_onnx(os.path.join(REPO, pol_dst), os.path.join(REPO, onnx_dst))
                num_obs = K
                if "memory" in ins:
                    mem = ins["memory"][-1] // num_obs
                elif len(obs_in) == 3 and obs_in[1] > 1:
                    mem = obs_in[1]
                else:
                    mem = 1
                blk = _loco_block(cfg, ins, outs, control_joints, n_act, num_obs, mem)
                maneuver = fam in ("getup", "jump")
                blk["cmd_in_obs"] = not maneuver and cmd_extra in (3, 4)
                blk["has_phase"] = (cmd_extra in (1, 4))
                blk["maneuver"] = maneuver
                if maneuver:
                    gk = _first(cfg, "getup_joint_kp")
                    gd = _first(cfg, "getup_joint_kd")
                    gi = _first(cfg, "getup_init_joint_q", "init_joint_q_squat", "init_joint_q")
                    if gk: blk["kp"] = list(gk)
                    if gd: blk["kd"] = list(gd)
                    if gi: blk["init_pose"] = list(gi)
                    n = d.lower()
                    blk["ground_start"] = ("face_down" if "facedown" in n else
                                           "face_up" if ("faceup" in n or "any2" in n or "getup" in n)
                                           else None)
                    blk["maneuver_period"] = float(_first(cfg, "max_cadence_period", default=1.5))
                    if "squat2stand" in n:
                        blk["spawn_pitch_deg"] = 20.0
                        blk["default_dof_pos"] = list(blk["init_pose"])
                        blk["maneuver_period"] = 1.0
                _floor_hold_gains(blk)
                eval_cfg = {
                    "name": entry["name"],
                    "robot": a.robot,
                    "family": "g1_locomotion",
                    "control": {"step_dt": blk.get("dt", 0.02), "sim_dt": 0.0005,
                                "duration": 6.0 if blk.get("maneuver") else 12.0},
                    "policy": {"path": pol_dst, "arch": blk["obs_scheme"],
                               "num_obs": num_obs, "num_act": n_act},
                    "g1": blk,
                }
                out_yaml = os.path.join(reg, f"{entry['name']}.yaml")
                os.makedirs(os.path.dirname(out_yaml), exist_ok=True)
                with open(out_yaml, "w") as f:
                    yaml.safe_dump(eval_cfg, f, sort_keys=False, default_flow_style=None)
                entry["config"] = _rel(out_yaml)
                entry["runnable"] = True
                entry["note"] = f"{fam} ({blk['obs_scheme']}), {n_act}-DOF"

                # walk_29dofs walk_model & run_model
                if d == "walk_29dofs" and blk["obs_scheme"] == "split":
                    entry["fsm_id"] = 801
                    for key, tag, fsm, vmax, mnote in [
                        ("walk_model", "walk", 501, 0.4, "Walk (waist control, FSM 501)"),
                        ("run_model", "run", 801, 2.0, "Run (high-speed, FSM 801)"),
                    ]:
                        mp = _resolve_mnn(str(cfg.get(key, "")), dpath, ai_root)
                        if not mp:
                            continue
                        mdst = _rel(_copy(mp, os.path.join(pol_root, d, f"{tag}.mnn")))
                        monnx = mdst[:-4] + ".onnx"
                        _ensure_onnx(os.path.join(REPO, mdst), os.path.join(REPO, monnx))
                        mcfg = dict(eval_cfg)
                        mcfg["name"] = f"{d}/{tag}"
                        mcfg["fsm_id"] = fsm
                        mcfg["control"] = dict(eval_cfg["control"], step_dt=0.02)
                        mcfg["policy"] = dict(eval_cfg["policy"], path=mdst)
                        mcfg["g1"] = dict(blk, dt=0.02, vel_range=[-vmax, vmax, -0.6, 0.6, -1.5, 1.5])
                        myaml = os.path.join(reg, d, f"{tag}.yaml")
                        with open(myaml, "w") as f:
                            yaml.safe_dump(mcfg, f, sort_keys=False, default_flow_style=None)
                        catalog.append({**entry, "name": mcfg["name"], "fsm_id": fsm,
                                        "policy": mdst, "config": _rel(myaml), "note": mnote})
                        _log(f"  + {mcfg['name']:42s} [locomotion] FSM {fsm} ({key})")
            except Exception as e:
                _log(f"  ! {entry['name']}: ONNX conversion failed: {e}")

        catalog.append(entry)
        tag = "+" if entry["runnable"] else " "
        _log(f"  {tag} {entry['name']:42s} [{fam}] act={n_act}")

    def _priority(c):
        if not c.get("runnable"): return (99, c["name"])
        name = c["name"]
        if name == "walk_29dofs/walk": return (0, name)
        if name == "walk_29dofs/run": return (1, name)
        if name == "walk_29dofs/actor": return (2, name)
        if "human_loco" in name: return (3, name)
        fam = c.get("family", "")
        if fam == "g1_locomotion": return (4, name)
        if fam == "g1_mimic": return (5, name)
        if fam == "g1_jump": return (6, name)
        if fam == "g1_getup": return (7, name)
        return (8, name)

    catalog.sort(key=_priority)
    with open(os.path.join(reg, "index.json"), "w") as f:
        json.dump({"robot": a.robot, "policies": catalog}, f, indent=2)
    runnable = sum(1 for c in catalog if c.get("runnable"))
    _log(f"\nCatalog: {len(catalog)} policies ({runnable} runnable) -> {_rel(os.path.join(reg, 'index.json'))}")


if __name__ == "__main__":
    main()
