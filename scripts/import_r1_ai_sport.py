#!/usr/bin/env python3
"""Import EVERY Unitree R1 ai_sport policy into unitree-mujoco-web as firmware-faithful packs, for ONE bundle.

Driver: src/core/drivers/r1_fw.ts (config block `r1:` with `firmware: true`). Obs / command / target details come
from the decompiled r1_controller (1.0.2.154 in-memory dump; the unprotected DWARF builds 1.0.2.181 and 1.0.2.223)
and bench ONNX-I/O captures.

What gets packed (registry/r1/<group>/<name>.yaml + registry/r1/index.json, nets / CSVs → assets/policies/r1/):
  * every FSM the shipping firmware (OTA 1.4.2.8, ai_sport 1.0.2.154) wires up — 811/812/815/830/832/833, dances
    602-608 (EDU) / 602/604/607 (Air), 701 Qishen, 702 Tangxia — exactly as configured;
  * the motions its configs carry commented out or that only other builds wire up (dances 601/603/605/606/608 …,
    their 0602 re-trains), and alternative checkpoints that ship next to the configured nets (same core, the
    net swapped — what uncommenting the config line does);
  * the cores the 1.0.2.154 FSM never registers (MimicPunch / MimicActor / SimpleMotion, 813 / 814), decoded from
    the unprotected builds.

Usage:
  python3 scripts/import_r1_ai_sport.py --src <1.0.2.154 .../module/ai_sport> [--src223 <1.0.2.223 ai_sport>]
  node scripts/build-packs.mjs --robot r1                    # -> policy-packs/r1-all.zip
`--src` / `--src223` are the dirs holding config/ and net/; configs may be plaintext or FMX-wrapped (decrypted on
the fly with scripts/fmx.py).
"""
from __future__ import annotations
import argparse, json, os, re, shutil, sys
import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = "assets/policies/r1"
REG = "registry/r1"
SRC_TAG = "ai_sport 1.0.2.154 r1_controller (OTA 1.4.2.8)"

EDU = ["left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint", "left_knee_joint",
       "left_ankle_pitch_joint", "left_ankle_roll_joint", "right_hip_pitch_joint", "right_hip_roll_joint",
       "right_hip_yaw_joint", "right_knee_joint", "right_ankle_pitch_joint", "right_ankle_roll_joint",
       "waist_roll_joint", "waist_yaw_joint",
       "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint", "left_elbow_joint",
       "left_wrist_roll_joint",
       "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint", "right_elbow_joint",
       "right_wrist_roll_joint"]
AIR = EDU[:12] + EDU[14:18] + EDU[19:23]            # 20-DOF policy / Air model order
# rt/lowcmd slot (29 body motors + 2 head) -> joint name (None = motor the models don't have)
SLOT = EDU[:14] + [None] + EDU[14:19] + [None, None] + EDU[19:24] + [None, None, None, None]

EDU_LOCO = "amp_locomotion/amp_locomotion"
AIR_LOCO = "locomotion_20dofs/locomotion_20dofs"


def read_cfg(path):
    """config bytes, FMX-decrypted when needed (scripts/fmx.py)"""
    raw = open(path, "rb").read()
    if raw[:3] == b"FMX":
        sys.path.insert(0, os.path.join(REPO, "scripts"))
        import fmx  # noqa: E402
        raw = fmx.decrypt_file(path)
    return raw


def load_yaml_file(path):
    return yaml.safe_load(read_cfg(path))


def cfg(src, rel):
    return load_yaml_file(os.path.join(src, "config", rel))


def commented_entries(src, rel):
    """dance entries Unitree disabled by commenting the whole list item (`# - name: ...` + `#   key: ...`)"""
    raw = read_cfg(os.path.join(src, "config", rel))
    out, cur = [], None
    for line in raw.decode().splitlines():
        m = re.match(r"^\s*#\s?(\s*)- name:(.*)$", line)
        if m:
            cur = [f"- name:{m.group(2)}"]; out.append(cur); continue
        if cur is not None and re.match(r"^\s*#\s+#", line): continue      # nested comment inside the entry
        m = re.match(r"^\s*#\s?(\s{2,})(\w+:.*)$", line)
        if cur is not None and m:
            cur.append("  " + m.group(2)); continue
        cur = None
    res = []
    for blk in out:
        try:
            d = yaml.safe_load("\n".join(blk))[0]
            if isinstance(d, dict) and "policy_file" in d: res.append(d)
        except yaml.YAMLError:
            pass
    return res


def commented_policy_files(src, rel):
    """`# policy_file: ...` alternatives written inside an active entry: {entry name: [policy_file, ...]}"""
    raw = read_cfg(os.path.join(src, "config", rel))
    out, name = {}, None
    for line in raw.decode().splitlines():
        m = re.match(r"^\s*- name:\s*\"?([^\"]+)\"?", line)
        if m: name = m.group(1).strip(); continue
        m = re.match(r"^\s+#\s*policy_file:\s*\"([^\"]+)\"", line)
        if m and name: out.setdefault(name, []).append(m.group(1))
        if re.match(r"^\s*#\s*- name:", line): name = None
    return out


class Assets:
    def __init__(self):
        self.srcs = {}

    def copy(self, src, rel_from_ai_sport, tag=""):
        """copy net/... or config/trajs/... into assets (sub-dir `tag` for another build), return repo-relative"""
        s = os.path.join(src, rel_from_ai_sport)
        if not os.path.exists(s):
            raise FileNotFoundError(s)
        sub = rel_from_ai_sport.split("/", 1)[1]
        d = os.path.join(REPO, ASSET, tag, sub) if tag else os.path.join(REPO, ASSET, sub)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        if not os.path.exists(d) or os.path.getsize(d) != os.path.getsize(s):
            shutil.copy2(s, d)
        return os.path.relpath(d, REPO)


A = Assets()


def copy(src, rel, tag=""):
    return A.copy(src, rel, tag)


def ranges(v):
    """firmware CommandRange: [a, b] or a list of them"""
    return [v] if isinstance(v[0], (int, float)) else v


class Out:
    def __init__(self):
        self.entries = []

    def add(self, name, robot, models, fsm, policy, r1, note, family="r1_fw", extra=None, source=SRC_TAG,
            label=None, reachable=True):
        doc = {"name": name, "robot": robot, "family": family, "source": source,
               "control": {"step_dt": 0.02, "sim_dt": 0.002},
               "policy": {"path": policy, "num_act": len(r1["joint_names"])},
               "r1": {"firmware": True, "fsm_id": fsm, "models": models, **r1}}
        if extra: doc.update(extra)
        p = os.path.join(REPO, REG, name + ".yaml")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(f"# R1 {'FSM ' + str(fsm) if fsm else '(no FSM id)'}: {note}\n")
            # only the fight modes explain themselves in a popup; other policies need no how-to message
            cu = doc.get("control_ui") or {}
            if "Fight mode" not in (cu.get("notice") or {}).get("title", ""):
                cu.pop("notice", None)
            yaml.safe_dump(doc, f, sort_keys=False, width=120, default_flow_style=None, allow_unicode=True)
        self.entries.append({"name": name, "family": family, "robot": robot, "dof": len(r1["joint_names"]),
                             "policy": policy, "runnable": True, "config": os.path.relpath(p, REPO),
                             "note": note, "fsm_id": fsm, "models": models, "reachable_on_1_0_2_154": reachable})


# ---------------------------------------------------------------------------------------------- 811
def amp_loco(src, o, dances):
    c = cfg(src, "fsm/motions/amp_locomotion.yaml")
    rng = lambda m: {k: ranges(m[k]) for k in ("vx", "vy", "wz")}
    base = {"obs_scheme": "amp_loco", "joint_names": [EDU[i] for i in c["dof_idx"]], "memory": c["memory_size"],
            "action_idx": c["action_idx"], "default_joint_pos": c["default_joint_pos"],
            "action_scale": c["action_scale"], "stiffness": c["stiffness"], "damping": c["damping"],
            "cmd": {"low": c["low_speed_forward_vx_limit"], "high": c["high_speed_forward_vx_limit"],
                    "rev": c["reverse_vx_limit"], "vy": c["vy_limit"], "pure_wz": c["pure_wz_limit"],
                    "loco_wz": c["loco_wz_limit"], "lat_ratio": c["lateral_vy_zero_vx_ratio"],
                    "lon_ratio": c["longitudinal_vx_zero_vy_ratio"],
                    "yaw_up": c["yaw_acc_up_delta"], "yaw_down": c["yaw_acc_down_delta"],
                    "fwd_up": c["forward_vx_acc_up_delta"], "fwd_down": c["forward_vx_acc_down_delta"],
                    "rev_up": c["reverse_vx_acc_up_delta"], "rev_down": c["reverse_vx_acc_down_delta"],
                    "vy_up": c["vy_acc_up_delta"], "vy_down": c["vy_acc_down_delta"]},
            "run_model": rng(c["run_model"]), "turn_model": rng(c["turn_model"]),
            "aux_models": {"run": copy(src, c["run_model"]["model"]), "turn": copy(src, c["turn_model"]["model"])}}
    ui = {"control_ui": {"actions": [
        {"group": "Speed", "items": [{"combo": "R2+Up", "label": "High (2.3 m/s)"},
                                     {"combo": "R2+Down", "label": "Low (0.9 m/s)"}]},
        # dances / lie-down are separate policies in the list; buttons only act on this walker
    ]}}
    combos = {k: v for k, (v, _) in dances.items()}
    o.add(EDU_LOCO, "r1", ["edu"], 811, copy(src, c["model"]),
          {**base, "switch_combos": {**combos, "L2+X": "tangxia/tangxia_edu"}},
          "AmpLocomotion — EDU default walk/run (Start / R2+A); turn + run nets switch by command", extra=ui)
    # alternative main nets listed (commented) in amp_locomotion.yaml, run / turn nets as configured
    for alt in re.findall(r"^#\s*model:\s*\"([^\"]+)\"", open(os.path.join(src, "config/fsm/motions/amp_locomotion.yaml")).read(), re.M):
        tag = os.path.splitext(os.path.basename(alt))[0]
        role = ("run net" if alt == c["run_model"]["model"] else "turn net" if alt == c["turn_model"]["model"] else "")
        o.add(f"amp_locomotion/811_main_{tag}", "r1", ["edu"], 811, copy(src, alt), dict(base),
              f"811 AmpLocomotion with {tag} as the main net (a commented `model:` line of amp_locomotion.yaml"
              f"{'; the firmware uses it as the ' + role if role else ''}), run / turn nets as configured",
              reachable=False)


# ---------------------------------------------------------------------------------------------- 812 / 815 / 813 / 814
def amp_motion(src, o, fname, fsm, name, note, reachable=True, label=None):
    c = cfg(src, f"fsm/motions/{fname}.yaml")
    r1 = {"obs_scheme": "amp_motion", "joint_names": EDU, "memory": c["memory_size"],
          "dof_activated_idx": c["dof_activated_idx"], "default_dof_pos": c["default_dof_pos"],
          "action_scale": c["action_scale"], "kp": c["kp"], "kd": c["kd"],
          "limits_joint_idx": c["limits_joint_idx"], "dof_lower_limits": c["dof_lower_limits"],
          "dof_upper_limits": c["dof_upper_limits"],
          "cmd": {"max": c["init_max_cmd"], "high_vx": 2.5, "yaw_up": c["yaw_acc_up_delta"],
                  "yaw_down": c["yaw_acc_down_delta"], "vx_up": c["vx_acc_up_delta"],
                  "vx_down": c["vx_acc_down_delta"], "vy_up": c["vy_acc_up_delta"], "vy_down": c["vy_acc_down_delta"]}}
    if c["stance_model"] != c["walk_slow_model"]:
        r1["aux_models"] = {"stance": copy(src, c["stance_model"])}
    o.add(name, "r1", ["edu"], fsm, copy(src, c["walk_slow_model"]), r1, note, reachable=reachable)
    return c


# ---------------------------------------------------------------------------------------------- 830 / 832 / 833
def gait(src, o, fname, fsm, name, models, note, clock, arms=False, perm=None, model=None, reachable=True,
         combos=None, extra=None):
    c = cfg(src, f"fsm/motions/{fname}.yaml")
    model = model or c.get("model") or c.get("r1_20dofs_walk_model")
    r1 = {"obs_scheme": "gait", "joint_names": AIR, "memory": c["memory_size"],
          "default_dof_pos": c["default_dof_pos"], "action_scale": c["action_scale"], "kp": c["kp"], "kd": c["kd"],
          "vel_range": c["vel_range"], "default_vx_forward_limit": c["default_vx_forward_limit"],
          "angular_coupling_strength": c["angular_coupling_strength"],
          "joystick_deadband": c.get("joystick_deadband", 0.08),
          "acc": [c.get("vx_acc_up_delta", 0.03), c.get("vx_acc_down_delta", 0.06), c.get("vy_acc_up_delta", 0.03),
                  c.get("vy_acc_down_delta", 0.06), c.get("wz_acc_up_delta", 0.05), c.get("wz_acc_down_delta", 0.13)]}
    if perm: r1["action_joint_idx"] = perm
    if clock:
        r1["gait"] = {k: c[k] for k in ("walk_air_ratio", "run_air_ratio", "walk_cycle", "run_cycle",
                                        "transition_speed_min", "transition_speed_max")}
    if arms:
        r1["arms"] = {"arm_dof_idx": c["arm_dof_idx"], "arm_low_limit": c["arm_low_limit"],
                      "arm_high_limit": c["arm_high_limit"], "arm_resample_s": c["arm_resample_s"],
                      "arm_soft_limit": c["arm_soft_limit"], "arm_policy_ratio": c["arm_policy_ratio"],
                      "arm_random_ratio": c["arm_random_ratio"]}
    if combos: r1["switch_combos"] = combos
    ui = dict(extra or {})
    if arms:
        ui["control_ui"] = {"notice": {"title": f"FSM {fsm} LocomotionArmsdkGait",
            "text": "Walks like 832 with the arms from the net. Start toggles the firmware's random-arm demo "
                    "(new arm targets every 2 s, 0.9 random + 0.1 policy)."}}
    o.add(name, "r1_air", models, fsm, copy(src, model), r1, note, extra=ui or None, reachable=reachable)


# ---------------------------------------------------------------------------------------------- dances
def dance_pack(src, o, variant, d, sc, name, fsm, note, next_policy, reachable, as_trained=False):
    jim = sc["joint_ids_map"]
    names = EDU if variant == "edu" else AIR
    mot = copy(src, "config/" + d["motion_file"])
    nrows = sum(1 for _ in open(os.path.join(REPO, mot)))
    fps = d.get("fps", sc.get("fps", 30))
    seg = {"motion": "motion", "fps": fps, "start": d.get("time_start", 0.0),
           "end": d.get("time_end", round((nrows - 1) / fps - 0.02, 4))}
    a = sc["actions"]["JointPositionAction"]
    r1 = {"obs_scheme": "track", "anchor": "ori6", "joint_names": [names[j] for j in jim], "csv_joint_perm": jim,
          "default_joint_pos": sc["default_joint_pos"], "action_scale": a["scale"], "action_offset": a["offset"],
          "stiffness": [sc["stiffness"][j] for j in jim], "damping": [sc["damping"][j] for j in jim],
          "action_clip": 10.0, "segments": [seg], "aux_files": {"motion": mot}, "next_policy": next_policy,
          "upz_safety": [0.8, sc.get("safety_fail_frame_threshold", 3)]}
    if variant == "edu": r1["ref_waist"] = [12, 13]
    if as_trained:
        # floor routines no build wires: DanceCore's ±10 action clamp keeps them on the floor (their get-up pushes
        # need larger actions; bench-free A/B in the sim: 0/3 vs 2/2 rises for qishen1) and its up-z safety cuts them
        # the moment the robot lags a fast rise — run them as trained instead (no clamp, no safety)
        r1["action_clip"] = 1000.0; r1.pop("upz_safety")
        note += " — run as trained (no ±10 clamp / up-z safety, see docs)"
    robot = "r1" if variant == "edu" else "r1_air"
    o.add(name, robot, [variant], fsm, copy(src, "net/" + d["policy_file"]), r1,
          f"{note} ({seg['start']}-{seg['end']:.2f} s of the clip @ {fps} fps)", reachable=reachable)
    return seg


def ckpt_tag(alt, ref):
    """short label of an alternative checkpoint: its path below the configured net's dir, 'policy_' dropped
    (dances/dance1_subject2/new_urdf/policy_25k.onnx -> new_urdf_25k; .../0602/gongfu.20.5k.onnx -> 0602_20_5k)"""
    base = os.path.dirname(ref)
    rel = os.path.relpath(alt, base) if base and alt.startswith(base + "/") else "/".join(alt.split("/")[-2:])
    rel = os.path.splitext(rel)[0].replace("policy_", "")
    m = re.match(r"^(.*/)?(0602)/[^/]*?\.(\d+(?:\.\d+)?k)$", rel)
    if m: rel = f"0602_{m.group(3)}"
    rel = rel.split("/", 1)[1] if rel.split("/")[0] in ("dance1_subject2", "gongfu", "jiequandao") and "/" in rel else rel
    return re.sub(r"[/.]", "_", rel)


def combo_of(keys):
    return "+".join(k.split("_")[0].capitalize() for k in keys)


def dances(src, o, variant, extra_entries):
    """EDU dances.yaml / Air dances_air.yaml: active entries (as wired), commented entries, commented alternative
    policy_files, then `extra_entries` [(name, fsm, entry, note)] (other builds' entries, unreferenced nets)."""
    fname = "dances.yaml" if variant == "edu" else "dances_air.yaml"
    grp = "dances" if variant == "edu" else "dances_air"
    loco, lbl = (EDU_LOCO, "811") if variant == "edu" else (AIR_LOCO, "830")
    c = cfg(src, f"fsm/motions/{fname}"); sc = c["shared_config"]
    combos, seen = {}, set()
    for d in c["dances"]:
        name = f"{grp}/{d['id']}_{d['name']}"
        key = combo_of(d["trigger_keys"]); combos[key] = (name, f"{d['id']} {d['name']}")
        dance_pack(src, o, variant, d, sc, name, d["id"], f"Dance {d['name']}, from {lbl} via {key}", loco, True)
        seen.add((d["policy_file"], d["motion_file"], d.get("time_start", 0)))
        for alt in commented_policy_files(src, f"fsm/motions/{fname}").get(d["name"], []):
            if not os.path.exists(os.path.join(src, "net", alt)): continue
            tag = ckpt_tag(alt, d["policy_file"])
            dance_pack(src, o, variant, {**d, "policy_file": alt}, sc, f"{name}-{tag}", d["id"],
                       f"Dance {d['name']} with the alternative net {alt.split('/', 1)[1]} (commented in {fname})",
                       loco, False)
            seen.add((alt, d["motion_file"], d.get("time_start", 0)))
    for d in commented_entries(src, f"fsm/motions/{fname}"):
        if (d["policy_file"], d["motion_file"], d.get("time_start", 0)) in seen: continue
        if not (os.path.exists(os.path.join(src, "net", d["policy_file"]))
                and os.path.exists(os.path.join(src, "config", d["motion_file"]))): continue
        tag = "" if "0602" not in d["policy_file"] else "-" + ckpt_tag(d["policy_file"], "")
        name = f"{grp}/{d['id']}_{d['name']}{tag}"
        if any(e["name"] == name for e in o.entries): name += "-b"
        key = combo_of(d["trigger_keys"]) if d.get("trigger_keys") else None
        dance_pack(src, o, variant, d, sc, name, d["id"],
                   f"Dance {d['name']} (entry commented out in {fname}{'; ' + key if key else ''})", loco, False)
        seen.add((d["policy_file"], d["motion_file"], d.get("time_start", 0)))
        if key and key not in combos: combos[key] = (name, f"{d['id']} {d['name']} (disabled)")
    for name, fsm, d, note in extra_entries:
        if (d["policy_file"], d["motion_file"], d.get("time_start", 0)) in seen: continue
        if not os.path.exists(os.path.join(src, "net", d["policy_file"])): continue
        full = f"{grp}/{name}"
        key = combo_of(d["trigger_keys"]) if d.get("trigger_keys") else None
        dance_pack(src, o, variant, d, sc, full, fsm, note, loco, False, as_trained=d.get("as_trained", False))
        seen.add((d["policy_file"], d["motion_file"], d.get("time_start", 0)))
        if key and key not in combos: combos[key] = (full, f"{fsm} {name} (not in 1.0.2.154)")
    return combos


EDU_EXTRA = [
    # 1.0.2.223 (package 1.0.0.4) wires these two; 1.0.2.154 ships the nets + clips but not the entries
    ("605_weibosite", 605, {"policy_file": "motions/dance_weibosite/policy.onnx",
                            "motion_file": "trajs/dance_weibosite/R1_2026_0204_145157_WEIBOSITE_014_LSR.bvh_50hz.csv",
                            "trigger_keys": ["L1_hold", "A_pressed"], "time_start": 3.02, "time_end": 7.50, "fps": 50},
     "Dance weibosite — wired in 1.0.2.223 (L1+A), assets only in 1.0.2.154"),
    ("606_weibosite_CJJ", 606, {"policy_file": "motions/dances/weibosite/policy_23k.onnx",
                                "motion_file": "trajs/dances/weibosite/R1_edu_lh_WEIBOSITE_014_LSR.bvh_50hz.csv",
                                "trigger_keys": ["L1_hold", "B_pressed"], "time_start": 3.02, "time_end": 7.50,
                                "fps": 50},
     "Dance weibosite (CJJ retarget) — commented entry of 1.0.2.223 (L1+B)"),
    # unreferenced checkpoints that ship next to the configured nets (same clip / window as the entry they belong to)
    ("602_dance1_subject2_segment2-policy_37k", 602,
     {"policy_file": "motions/dances/dance1_subject2/policy_37k.onnx",
      "motion_file": "trajs/dances/dance1_subject2/R1_edu_lh_dance1_subject2.bvh_30hz.csv",
      "time_start": 48.56, "time_end": 61.50, "fps": 30},
     "Dance 602 with the earlier policy_37k checkpoint (unreferenced, ships next to the hard net)"),
    ("607_gongfu-hard_80k-110k", 607,
     {"policy_file": "motions/dances/gongfu_jiequandao/gongfu_jiequandao_hard_80k-110k.onnx",
      "motion_file": "trajs/dances/gongfu_2/R1_edu_lh_fightAndSports1_subject1.bvh_30hz.csv",
      "time_start": 17.47, "time_end": 25.54, "fps": 30},
     "Dance 607 gongfu with the gongfu_jiequandao hard_80k-110k checkpoint (unreferenced)"),
    ("607_gongfu-new_urdf_50k", 607,
     {"policy_file": "motions/dances/gongfu_jiequandao/new_urdf/policy_50k.onnx",
      "motion_file": "trajs/dances/gongfu_2/R1_edu_lh_fightAndSports1_subject1.bvh_30hz.csv",
      "time_start": 17.47, "time_end": 25.54, "fps": 30},
     "Dance 607 gongfu with the new_urdf policy_50k checkpoint (unreferenced)"),
    ("608_jiequandao-hard_80k-110k", 608,
     {"policy_file": "motions/dances/gongfu_jiequandao/gongfu_jiequandao_hard_80k-110k.onnx",
      "motion_file": "trajs/dances/jiequandao/R1_edu_lh_Take_056_Skeleton0.bvh_60hz.csv",
      "time_start": 3.39, "time_end": 26.40, "fps": 60},
     "Dance 608 jiequandao with the gongfu_jiequandao hard_80k-110k checkpoint (unreferenced)"),
    ("604_niuniuwu-0602_15k", 604,
     {"policy_file": "motions/dances/niuniu/0602/niuniu.15k.onnx",
      "motion_file": "trajs/dances/niuniuwu/0602/r1_Take_102_Skeleton0_d369d4dc_50hz.csv", "fps": 50},
     "Dance niuniuwu, 0602 re-train (niuniu.15k) on its 50 Hz clip (unreferenced; the 0602 pairing of the "
     "other commented entries)"),
    # ground motions: nets + clips ship, no build wires them — the whole clip
    ("gunfanqishen", None, {"policy_file": "motions/dances/gunfanqishen/policy_80k.onnx",
                            "motion_file": "trajs/dances/gunfanqishen/R1_edu_lh_ground2_subject3.bvh_30hz.csv",
                            "fps": 30, "as_trained": True},
     "Gunfanqishen (滚翻起身, roll over + get up): 185 s floor routine — rolls, crawls, spins, get-ups; no build "
     "wires it"),
    ("gunfanqishen-hard_80k-100k", None,
     {"policy_file": "motions/dances/gunfanqishen/gunfanqishen_hard_80k-100k.onnx",
      "motion_file": "trajs/dances/gunfanqishen/R1_edu_lh_ground2_subject3.bvh_30hz.csv", "fps": 30, "as_trained": True},
     "Gunfanqishen with the hard_80k-100k checkpoint"),
    ("qishen1", None, {"policy_file": "motions/dances/qishen1/qishen1_25k.onnx",
                       "motion_file": "trajs/dances/qishen1/R1_edu_lh_Y-qishen-001_Skeleton0.bvh_60hz.csv",
                       "fps": 60, "as_trained": True},
     "Qishen1: sit down to the floor, lie back and stand up again (14 s clip); no build wires it"),
]
AIR_EXTRA = [
    ("605_weibosite", 605, {"policy_file": "motions/dances_air/weibosite/policy_new_10k.onnx",
                            "motion_file": "trajs/dances_air/weibosite/R1_air_WEIBOSITE_014_LSR.bvh_50hz.csv",
                            "trigger_keys": ["L1_hold", "A_pressed"], "time_start": 3.02, "time_end": 7.50, "fps": 50},
     "Air weibosite (policy_new_10k) — no dances_air entry; window of the EDU 605 entry"),
    ("605_weibosite-policy_12k", 605, {"policy_file": "motions/dances_air/weibosite/policy_12k.onnx",
                                       "motion_file": "trajs/dances_air/weibosite/R1_air_WEIBOSITE_014_LSR.bvh_50hz.csv",
                                       "time_start": 3.02, "time_end": 7.50, "fps": 50},
     "Air weibosite, policy_12k checkpoint"),
    ("608_jiequandao-edu_fix_15k", 608, {"policy_file": "motions/dances_air/jiequandao/edu_fix_15k.onnx",
                                         "motion_file": "trajs/dances_air/jiequandao/R1_air_Take_056_Skeleton0_new_50hz.csv",
                                         "time_start": 3.39, "time_end": 26.0, "fps": 50},
     "Air jiequandao, edu_fix_15k checkpoint (the entry names a new_edu_fix_20k that does not ship)"),
]


# ---------------------------------------------------------------------------------------------- 701 / 702
def stance_hold(src):
    """rt/lowcmd the get-ups inherit for joints they don't command (EDU waist / wrist roll): Stance's"""
    st = cfg(src, "fsm/statics/stance.yaml"); out = {}
    for j, q, p, d in zip(st["joint_idx"], st["stance_joint_pos"], st["kp"], st["kd"]):
        if j < len(SLOT) and SLOT[j] in ("waist_roll_joint", "waist_yaw_joint", "left_wrist_roll_joint", "right_wrist_roll_joint"):
            out[SLOT[j]] = [q, p, d]
    return out


def tangxia_hold(src):
    """TangxiaCore::processed_and_send_action (1.0.2.181) writes the waist motors 12/13 itself (q 0, kp 150, kd 3);
    the EDU wrist rolls keep what the loco FSM it came from (811) commanded"""
    a = cfg(src, "fsm/motions/amp_locomotion.yaml"); out = {"waist_roll_joint": [0.0, 150.0, 3.0],
                                                           "waist_yaw_joint": [0.0, 150.0, 3.0]}
    for d, i in enumerate(a["action_idx"]):
        n = EDU[a["dof_idx"][d]]
        if n in ("left_wrist_roll_joint", "right_wrist_roll_joint"):
            out[n] = [a["default_joint_pos"][i], a["stiffness"][i], a["damping"][i]]
    return out


def getups(src, o, variant, next_policy):
    """701 Qishen (face-down → face-up get up) and 702 Tangxia (lie down); Air-trained 20-joint nets,
    joints addressed by rt/lowcmd slot (joint_ids_map) so they run on Air and EDU alike."""
    models = [variant]
    q = cfg(src, "fsm/motions/qishen.yaml"); jim = q["joint_ids_map"]; names = [SLOT[s] for s in jim]
    sl = lambda v: [v[s] for s in jim]
    a = q["actions"]["JointPositionAction"]
    segs = [{"motion": "facedown", "net": "facedown", "fps": q["fps"], "start": q["time_start"],
             "end": q["time_end_facedown"], "switch_at": q["facedown_to_faceup"],
             "stiffness": sl(q["stiffness_facedown"]), "damping": sl(q["damping_facedown"]),
             "action_scale": sl(a["scale_facedown"])},
            {"motion": "faceup", "fps": q["fps"], "start": q["time_start"], "end": q["time_end_faceup"],
             "stiffness": sl(q["stiffness_faceup"]), "damping": sl(q["damping_faceup"]),
             "action_scale": sl(a["scale_faceup"])}]
    r1 = {"obs_scheme": "track", "anchor": "gravity", "joint_names": names,
          "default_joint_pos": sl(q["default_joint_pos"]), "action_scale": sl(a["scale_faceup"]),
          "stiffness": sl(q["stiffness_faceup"]), "damping": sl(q["damping_faceup"]),
          "action_clip": 100.0, "blend_s": 0.5, "safety_rad": 1.0, "segments": segs, "start_pose": "facedown",
          "hold_joints": stance_hold(src),
          "aux_models": {"facedown": copy(src, "net/" + q["policy_file_facedown"])},
          "aux_files": {"facedown": copy(src, "config/" + q["motion_file_facedown"]),
                        "faceup": copy(src, "config/" + q["motion_file_faceup"])},
          "next_policy": next_policy}
    robot = "r1_air" if variant == "air" else "r1"
    # EDU: the firmware offers 701/702 on every edition (white_list + state_change_map, no entryGuard / edition
    # check), but the nets are Air-trained: on the EDU body both abort by the tilt safety — bench-verified
    # (EDU 1.4.2.8: Qishen face-down → Damping at 2.6 s, Tangxia falls at 1.2 s). Kept as the robot behaves.
    edu = variant == "edu"
    edu_note = (" — EDU: Air-trained nets, the firmware offers it but it aborts on the EDU body (as on the robot)"
                if edu else "")
    edu_ui = lambda title: ({"control_ui": {"notice": {"title": title, "text":
        "The firmware offers this state on the EDU too (no edition gate), but its nets are trained for the Air: on "
        "the EDU body it aborts by the tilt safety (Damping) — the same on the robot / bench. Faithful, not a bug."}}}
        if edu else None)
    o.add(f"qishen/qishen_{variant}", robot, models, 701, copy(src, "net/" + q["policy_file_faceup"]), r1,
          "Qishen get-up (lying: face-down clip then face-up clip), Stance + L2+X long" + edu_note,
          extra=edu_ui("FSM 701 Qishen on the EDU"))
    t = cfg(src, "fsm/motions/tangxia.yaml"); jim = t["joint_ids_map"]
    a = t["actions"]["JointPositionAction"]
    r1 = {"obs_scheme": "track", "anchor": "gravity", "joint_names": [SLOT[s] for s in jim],
          "default_joint_pos": sl(t["default_joint_pos"]), "action_scale": sl(a["scale"]),
          "stiffness": sl(t["stiffness"]), "damping": sl(t["damping"]), "action_clip": 100.0, "blend_s": 0.5,
          "safety_rad": 1.0, "hold_joints": tangxia_hold(src),
          "segments": [{"motion": "motion", "fps": t["fps"], "start": t["time_start"], "end": t["time_end"]}],
          "aux_files": {"motion": copy(src, "config/" + t["motion_file"])}, "on_end": "damping",
          "switch_combos": {"L2+X": f"qishen/qishen_{variant}"}}
    ui = {"control_ui": {"notice": {"title": "FSM 702 Tangxia", "text":
          "Lies down on its back (clip 3.5-9.7 s), then the firmware drops to Damping. Get up with Qishen "
          "(on the robot: L2+Up for Stance, then L2+X long) — here the L2+X button." + (
          " EDU: the firmware offers it on the EDU too, but the Air-trained net aborts on the EDU body (tilt "
          "safety → Damping) — the same on the robot / bench." if edu else "")}}}
    o.add(f"tangxia/tangxia_{variant}", robot, models, 702, copy(src, "net/" + t["policy_file"]), r1,
          "Tangxia: lie down on the back (from loco: L2+X long), ends in Damping" + edu_note, extra=ui)


# ---------------------------------------------------------------------------------------------- 813 / 814
def loco24(src, o, fname, fsm, name, note):
    """Locomotion24DofCore (1.0.2.181 = .223): AmpMotion's command path, frame [gyro, rep6d, q, dq, scaled act]"""
    c = cfg(src, f"fsm/motions/{fname}.yaml")
    assert c["policy_joint_names"] == EDU
    r1 = {"obs_scheme": "amp_motion", "frame": "loco24", "joint_names": EDU, "memory": c["memory_size"],
          "dof_activated_idx": list(range(24)), "default_dof_pos": c["default_dof_pos"],
          "action_scale": c["action_scale"], "kp": c["kp"], "kd": c["kd"], "limits_joint_idx": [],
          "cmd": {"max": c["init_max_cmd"], "high_vx": c["init_max_cmd"][0], "yaw_up": c["yaw_acc_up_delta"],
                  "yaw_down": c["yaw_acc_down_delta"], "vx_up": c["vx_acc_up_delta"],
                  "vx_down": c["vx_acc_down_delta"], "vy_up": c["vy_acc_up_delta"], "vy_down": c["vy_acc_down_delta"]}}
    ui = {"control_ui": {"actions": [{"group": "Speed limits", "items": [
        {"combo": "R1+Up", "label": "vx max +0.5"}, {"combo": "R1+Down", "label": "vx max −0.5"},
        {"combo": "R1+Left", "label": "vy max +0.3"}, {"combo": "R1+Right", "label": "vy max −0.3"},
        {"combo": "R2+Up", "label": "yaw max +0.5"}, {"combo": "R2+Down", "label": "yaw max −0.5"}]}]}}
    o.add(name, "r1", ["edu"], fsm, copy(src, c["walk_slow_model"]), r1, note, extra=ui, reachable=False)


# ---------------------------------------------------------------------------------------------- 816 / 831
def armsdk816(src, o, name, note, cmd_scale=None, tag="", source=SRC_TAG, reachable=True):
    c = cfg(src, "fsm/motions/arm_sdk_locomotion.yaml")
    r1 = {"obs_scheme": "amp_loco", "joint_names": [EDU[i] for i in c["dof_idx"]], "memory": c["memory_size"],
          "action_idx": c["action_idx"], "default_joint_pos": c["default_joint_pos"],
          "action_scale": c["action_scale"], "stiffness": c["stiffness"], "damping": c["damping"],
          "cmd": {}, "control": {"dof": c["control_dof_idx"], "act": c["control_action_idx"]}}
    if cmd_scale: r1["control"]["cmd_scale"] = cmd_scale
    ui = {"control_ui": {"notice": {"title": "FSM 816 ArmSdkLocomotion", "text":
          "Legs + waist from the net, arms from an rt/arm_sdk client (here: an emulated client holding the default "
          "arm pose — on the robot the FSM returns to 811 after 1 s when no arm SDK app streams). "
          + ("The walking command is forced to 0 in this build (bench-verified), so it balances in place."
             if not cmd_scale else "This 1.0.2.223 build walks with the sticks (0.5 / 0.4 / 0.8 max).")}}}
    o.add(name, "r1", ["edu"], 816, copy(src, c["model"], tag), r1, note, extra=ui, source=source, reachable=reachable)


def armsdk831(src, o, name, note, model=None, legs_only=False, tag="", source=SRC_TAG, reachable=True, cfg_src=None,
              override=None):
    c = cfg(cfg_src or src, "fsm/motions/locomotion_armsdk.yaml")
    vr = c["vel_range"]
    r1 = {"obs_scheme": "gait", "joint_names": AIR, "memory": c["memory_size"],
          "default_dof_pos": c["default_dof_pos"], "action_scale": c["action_scale"], "kp": c["kp"], "kd": c["kd"],
          "vel_range": vr, "default_vx_forward_limit": vr[1],
          "angular_coupling_strength": c["angular_coupling_strength"], "joystick_deadband": 0.0,
          "acc": [1e9] * 6, "obs_joint_idx": c["action_dof_idx"], "action_joint_idx": c["action_joint_idx"],
          "arms": {"arm_dof_idx": c["arm_dof_idx"], "arm_low_limit": c["arm_low_limit"],
                   "arm_high_limit": c["arm_high_limit"], "arm_resample_s": c["arm_resample_s"],
                   "arm_soft_limit": c["arm_soft_limit"], "arm_policy_ratio": 0.0 if legs_only else 0.1,
                   "arm_random_ratio": 1.0 if legs_only else 0.9, "arm_return_s": 2.0}}
    if not legs_only: r1["zero_cmd"] = True
    if override: r1.update(override)
    ui = {"control_ui": {"notice": {"title": "FSM 831 LocomotionArmsdk (Air)", "text":
          ("Legs from the net, arms held at the default pose (the arm SDK's); walks with the sticks (1.0.2.223 core). "
           if legs_only else "All 20 joints from the net; the stick command is forced to 0 in this build (as 816), so "
           "it balances in place. ") + "Start toggles the firmware's random-arm demo (new arm targets every 2 s). On "
          "the robot the FSM returns to 830 after 1 s when no arm SDK app streams; here an emulated client keeps it."}}}
    o.add(name, "r1_air", ["air"], 831, copy(src, model or c["r1_armsdk_loco_model"], tag), r1, note, extra=ui,
          source=source, reachable=reachable)


# ---------------------------------------------------------------------------------------------- 804 / 805 mimic
PUNCH_NAMES = {0: "Straight punch", 1: "Left hook", 2: "Right hook", 3: "Low hook", 20: "Front kick",
               21: "Left side kick", 22: "Right side kick", 23: "Knee kick", 40: "Straight-punch combo",
               41: "Attack combo", 60: "Turn around", 61: "Dodge left", 62: "Dodge right", 63: "Dodge back",
               64: "Block", 80: "Boxing stance", 81: "Taunt 3", 82: "Taunt 2 (ready)", 201: "Get down (front)"}
PUNCH_GROUPS = [("Hand strikes", [0, 1, 2, 3, 40, 41]), ("Kicks", [20, 21, 22, 23]),
                ("Footwork / defence", [60, 61, 62, 63, 64]), ("Gestures", [80, 81, 82])]
KEY = {"UP": "Up", "DOWN": "Down", "LEFT": "Left", "RIGHT": "Right", "SELECT": "Select", "START": "Start",
       "A": "A", "B": "B", "X": "X", "Y": "Y", "R1": "R1", "R2": "R2", "L1": "L1", "L2": "L2"}


def mimic(src, o, fname, fsm, name, note, nets, next_policy, tag_note="", cmd_norm=False):
    c = cfg(src, f"fsm/motions/{fname}.yaml")
    ident = list(range(24))
    assert c["client_joint_idx"] == [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26]
    assert c["dof_activated_idx"] == ident and c["dof_observed_idx"] == ident
    clips, files = {}, {}
    for ent in c["offline_trajs"]:
        (path, prm), = ent.items()
        stem = os.path.splitext(os.path.basename(path))[0]
        files[stem] = copy(src, "config/" + path)
        clips[stem] = {"file": stem, "rot_detect": int(prm[1]), "cool": float(prm[2])}
        if len(prm) >= 4: clips[stem]["api"] = int(prm[3])
    buttons = {}
    for ent in c["motion_button_map"]:
        (clip_name, keys), = ent.items()
        ks = [KEY[k.replace("button_", "").strip("_")] for k in keys]
        combo = ks[0] if len(ks) == 1 else "+".join(ks[1:] + ks[:1])     # [UP, R1] = press UP holding R1
        buttons[combo] = clip_name
    m = {"mimic_name": c["mimic_name"], "default_dof_pos": c["default_dof_pos"], "kp": c["kp"], "kd": c["kd"],
         "action_scale": c["action_scale"], "limits_joint_idx": c["limits_joint_idx"],
         "dof_lower_limits": c["dof_lower_limits"], "dof_upper_limits": c["dof_upper_limits"],
         "obs_scale": [c["observation_scale_angular_vel"], 1.0, c["observation_scale_dof_pos"],
                       c["observation_scale_dof_vel"], 1.0],
         "twist": {"scale": c["twist_scale"], "offset": c["twist_offset"], "min": c["min_twist"],
                   "decay": c["twist_decay_step"], "fc": c["remote_command_cut_off_frequency"],
                   "fs": c["remote_command_sampling_frequency"]},
         "clips": clips, "default_traj": c["default_traj_name"],
         "front_get_up": c["front_get_up_traj_name"] or None, "back_get_up": c["back_get_up_traj_name"] or None,
         "fall_down_length": c["fall_down_length"], "front_down_jpos": c["front_down_jpos"],
         "back_down_jpos": c["back_down_jpos"], "transit_length": c["transit_length"], "buttons": buttons}
    if cmd_norm: m["cmd_norm"] = True
    r1 = {"obs_scheme": "mimic", "joint_names": EDU, "mimic": m, "aux_files": files,
          "switch_combos": {"R2+A": next_policy}}
    main = nets[0]
    if len(nets) > 1: r1["aux_models"] = {"clip": copy(src, "net/" + nets[1])}
    if c["mimic_name"] == "actor": r1["next_policy"] = next_policy
    by_clip = {v: k for k, v in buttons.items()}
    if c["mimic_name"] == "punch":
        api = {cl["api"]: n for n, cl in clips.items() if "api" in cl}
        groups = [{"group": g, "items": [{"combo": by_clip[api[i]], "label": PUNCH_NAMES[i]} for i in ids
                                         if api.get(i) in by_clip]} for g, ids in PUNCH_GROUPS]
        groups.append({"group": "Get down / up", "items": [
            {"combo": by_clip[c["front_get_down_traj_name"]], "label": "Get down (front)"},
            {"combo": by_clip[c["back_get_down_traj_name"]], "label": "Get down (back)"},
            {"combo": "L2+Up", "label": "Get up (after a fall / get down)"}]})
        groups.append({"group": "Mode", "items": [{"combo": "Start", "label": "Stop move (Start ×2)"}]})
        notice = {"title": "Fight mode", "text": "This policy is a fight mode. The robot stands in a boxing guard and walks with the stick (W A S D / Q E or the left / right stick).\n\nTo fight, choose a move from the Moves list in the panel: hand strikes, kicks, footwork and defence, gestures and get down / get up. G / Shift+G steps through the moves; hover a button to see its remote-controller shortcut (on a gamepad LB/RB/LT/RT = L1/R1/L2/R2).\n\nAfter a fall or Get down the robot stays down until you pick Get up. Start stops a move."}
    else:
        what = {"Take_111": "Flip / somersault", "Take_125": "Flip / somersault 2", "Take_142": "Show move"}
        lbl = lambda v: next((f"{w} ({t.replace('_', ' ')})" for t, w in what.items() if t in v), v)
        groups = [{"group": "Moves", "items": [{"combo": k, "label": lbl(v)} for k, v in buttons.items()]},
                  {"group": "Mode", "items": [{"combo": "Start", "label": "Stop move (Start ×2)"}]}]
        notice = {"title": "Actor (MimicActor)", "text":
                  "Stands in place; X / B / A (double press on the robot) play one mocap take — Take 111 and 125 are "
                  "full flips (the body turns upside down in the air), 142 a standing show move — then the firmware "
                  "returns to the 811 walk. Registered as FSM 804 in 1.0.2.223 only; decoded from r1_controller, not "
                  "bench-checked."}
    o.add(name, "r1", ["edu"], fsm, copy(src, "net/" + main), r1, note + tag_note,
          extra={"control_ui": {"notice": notice, "actions": groups}}, reachable=False)


def simple(src, o):
    c = cfg(src, "fsm/motions/simple_motion.yaml")
    r1 = {"obs_scheme": "simple", "joint_names": EDU, "default_dof_pos": c["default_dof_pos"], "kp": c["kp"],
          "kd": c["kd"], "ang_vel_scale": c["ang_vel_scale"], "dof_vel_scale": c["dof_vel_scale"],
          "action_scale": c["action_scale"], "lower_index": c["lower_index"], "upper_index": c["upper_index"],
          "memory": c["memory_size"], "aux_files": {"motion": copy(src, "net/" + c["traj_file"])}}
    o.add("simple_motion/hello", "r1", ["edu"], None, copy(src, "net/" + c["simple_motion_model"]), r1,
          "SimpleMotion 'hello' — left-arm wave (3.5 s); no r1_controller build implements it: obs reconstructed "
          "from the net weights + a layout sweep (the only layout that tracks), unverifiable on the robot",
          extra={"control_ui": {"notice": {"title": "SimpleMotion hello (reconstructed)", "text":
                 "Waves the left arm once, then holds the default pose. No firmware build contains this state; the "
                 "observation layout is reconstructed (see r1_fw.ts R1SimpleDriver)."}}}, reachable=False)


# ---------------------------------------------------------------------------------------------- 1.0.2.223 nets
SRC223 = "ai_sport 1.0.2.223 r1_controller (package 1.0.0.4 R1 Edu Pro)"
CK_WALK = {"default_dof_pos": [-0.2, 0.0, 0.0, 0.42, -0.23, 0.0, -0.2, 0.0, 0.0, 0.42, -0.23, 0.0,
                               0.35, 0.18, -0.0, 0.87, 0.35, -0.18, 0.0, 0.87],
           "kp": [120, 100, 80, 120, 20, 20, 120, 100, 80, 120, 20, 20, 80, 80, 50, 50, 80, 80, 50, 50],
           "kd": [4, 4, 4, 4, 2, 2, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
           "vel_range": [-1.1, 1.8, -0.6, 0.6, -2.0, 2.0], "angular_coupling_strength": 0.7,
           "default_vx_forward_limit": 1.1}


def extra_223(s2, o, air_combos):
    """nets only the 1.0.2.223 build ships, each under that build's core + config (r1dec 223 vs 181 diff)"""
    T = "1.0.2.223"
    c = cfg(s2, "fsm/motions/amp_locomotion.yaml")
    d = os.path.join(s2, "net/motions/amp_locomotion")
    for sub in sorted(os.listdir(d)):
        for f in sorted(os.listdir(os.path.join(d, sub))):
            r1 = {"obs_scheme": "amp_loco", "joint_names": [EDU[i] for i in c["dof_idx"]], "memory": c["memory_size"],
                  "action_idx": c["action_idx"], "default_joint_pos": c["default_joint_pos"],
                  "action_scale": c["action_scale"], "stiffness": c["stiffness"], "damping": c["damping"],
                  "cmd": {}, "raw_max": [2.5, 1.0, 1.57]}
            tag = os.path.splitext(f)[0]
            used = "configured" if f in c["model"] else "alternative"
            o.add(f"amp_locomotion/{tag}", "r1", ["edu"], 815, copy(s2, f"net/motions/amp_locomotion/{sub}/{f}", T),
                  r1, f"1.0.2.223 AmpLocomotion ({used} net {sub}/{f}): the simpler 223 core — cmd = sticks × "
                  f"(2.5, 1.0, 1.57), one net, no speed profiles (FSM id 815 in that build)", source=SRC223,
                  reachable=False)
    c = cfg(s2, "fsm/motions/locomotion_20dofs.yaml")
    txt = read_cfg(os.path.join(s2, "config/fsm/motions/locomotion_20dofs.yaml")).decode()
    for f in sorted(os.listdir(os.path.join(s2, "net/motions/locomotion_20dofs"))):
        rel = f"net/motions/locomotion_20dofs/{f}"
        tag = os.path.splitext(f)[0]
        r1 = {"obs_scheme": "gait", "joint_names": AIR, "memory": c["memory_size"],
              "default_dof_pos": c["default_dof_pos"], "action_scale": c["action_scale"], "kp": c["kp"],
              "kd": c["kd"], "vel_range": c["vel_range"], "default_vx_forward_limit": c["default_vx_forward_limit"],
              "angular_coupling_strength": c["angular_coupling_strength"], "joystick_deadband": 0.08,
              "acc": [0.02, 0.05, 0.02, 0.01, 0.03, 0.10], "action_joint_idx": c["action_joint_idx"]}
        used = ("configured" if rel == c["r1_20dofs_loco_model"] else "commented" if f in txt else "unreferenced")
        if tag.startswith("r1_20dofs_loco"):
            # these three come from Unitree's "mcf" test build (R1 eMMC /home/unitree/2testartifacts, config
            # fsm_r1_air_ck_walk.yaml): same obs / perm, but their own pose + gains; with 223's they fall at once
            r1.update(CK_WALK)
            used += "; pose / gains / vel_range from the mcf fsm_r1_air_ck_walk.yaml they ship with"
        o.add(f"locomotion_20dofs/{tag}", "r1_air", ["air"], 830, copy(s2, rel, T), r1,
              f"1.0.2.223 Locomotion20Dofs ({used} net {f}) with that build's config (vx 1.1 / R2+Up 2.7 m/s, "
              f"coupling 0.7, its slew defaults)", source=SRC223, reachable=False)
    armsdk816(s2, o, "arm_sdk_locomotion/816_policy_32.5k", "1.0.2.223 ArmSdkLocomotion (policy_32.5k): walks "
              "with the sticks in that build", cmd_scale=[0.5, 0.4, 0.8], tag=T, source=SRC223, reachable=False)
    for f in sorted(os.listdir(os.path.join(s2, "net/motions/locomotion_armsdk"))):
        tag = os.path.splitext(f)[0]
        ck = tag == "r1_armsdk_loco"      # same "r1_" test-build family as r1_20dofs_loco: its pose / gains
        armsdk831(s2, o, f"locomotion_armsdk/{tag}", f"1.0.2.223 LocomotionArmsdk legs-only net {f}"
                  + (" (with the mcf ck_walk pose / gains)" if ck else ""),
                  model=f"net/motions/locomotion_armsdk/{f}", legs_only=True, tag=T, source=SRC223, reachable=False,
                  override={k: CK_WALK[k] for k in ("default_dof_pos", "kp", "kd")} if ck else None)


# ---------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="ai_sport 1.0.2.154 (OTA 1.4.2.8) dir holding config/ and net/")
    ap.add_argument("--src223", help="ai_sport 1.0.2.223 (package 1.0.0.4) dir: its extra nets")
    a = ap.parse_args()
    src = a.src
    o = Out()
    # fresh registry (assets are content-addressed by path and kept)
    if os.path.isdir(os.path.join(REPO, REG)): shutil.rmtree(os.path.join(REPO, REG))

    edu_d = dances(src, o, "edu", EDU_EXTRA)
    air_d = dances(src, o, "air", AIR_EXTRA)
    amp_loco(src, o, edu_d)
    amp_motion(src, o, "amp_motion", 812, "amp_motion/amp_motion", "AmpMotion 18-joint walk (SetFsmId 812, EDU)")
    amp_motion(src, o, "amp_motion_22dof", 815, "amp_motion_22dof/amp_motion_22dof",
               "AmpMotion22Dof (SetFsmId 815, EDU): stance net until the first step, then the walk net")
    l20 = cfg(src, "fsm/motions/locomotion_20dofs.yaml")
    air_combos = {k: v for k, (v, _) in air_d.items()}
    air_ui = {"control_ui": {"actions": [
        {"group": "Speed", "items": [{"combo": "R2+Up", "label": "High (2.4 m/s)"},
                                     {"combo": "R2+Down", "label": "Low (1.0 m/s)"}]},
        # dances / lie-down are separate policies in the list; buttons only act on this walker
    ]}}
    gait(src, o, "locomotion_20dofs", 830, AIR_LOCO, ["air"],
         "Locomotion20Dofs — Air default walk (Start; 811 redirects here on Air)", clock=False,
         perm=l20["action_joint_idx"], combos={**air_combos, "L2+X": "tangxia/tangxia_air"}, extra=air_ui)
    main_net = l20["r1_20dofs_walk_model"]
    for f in sorted(os.listdir(os.path.join(src, "net/motions/locomotion_20dofs"))):
        rel = f"net/motions/locomotion_20dofs/{f}"
        if not f.endswith(".onnx") or rel == main_net: continue
        tag = os.path.splitext(f)[0]
        # the two walkrun_indelay nets use the plain joint order (the yaml's commented identity action_joint_idx):
        # first-layer weights repeat per leg/arm block in that order, and they fall with the perm / walk without it
        ident = "indelay" in tag
        gait(src, o, "locomotion_20dofs", 830, f"locomotion_20dofs/830_{tag}", ["air"],
             f"830 Locomotion20Dofs with the {tag} net (ships in net/motions/locomotion_20dofs; "
             f"{'commented in' if tag in open(os.path.join(src, 'config/fsm/motions/locomotion_20dofs.yaml')).read() else 'not referenced by'}"
             f" locomotion_20dofs.yaml){'; identity joint order — note: drifts forward at zero command' if ident else ''}",
             clock=False, perm=list(range(20)) if ident else l20["action_joint_idx"], model=rel, reachable=False)
    gait(src, o, "locomotion_gait", 832, "locomotion_gait/locomotion_gait", ["air", "edu"],
         "LocomotionGait (Stance R2+X), gait-clock walk", clock=True)
    gait(src, o, "locomotion_armsdk_gait", 833, "locomotion_armsdk_gait/locomotion_armsdk_gait", ["air", "edu"],
         "LocomotionArmsdkGait (Stance R2+Y), gait walk + random-arm demo on Start", clock=True, arms=True)
    getups(src, o, "edu", EDU_LOCO)
    getups(src, o, "air", AIR_LOCO)
    # cores 1.0.2.154 does not reach: decoded from the unprotected 1.0.2.181 / 1.0.2.223 builds
    loco24(src, o, "locomotion_24dof_straight_knee", 813, "locomotion_24dof/813_straight_knee",
           "Locomotion24DofStraightKnee: 24-joint walk, straight-knee gait (registered, but no transition reaches it)")
    loco24(src, o, "locomotion_24dof_walk", 814, "locomotion_24dof/814_walk",
           "Locomotion24DofWalk: 24-joint walk (registered, but no transition reaches it)")
    armsdk816(src, o, "arm_sdk_locomotion/816_arm_sdk", "ArmSdkLocomotion (SetFsmId 816, EDU): legs + waist net, "
              "arms from rt/arm_sdk")
    armsdk831(src, o, "locomotion_armsdk/831_alljoint", "LocomotionArmsdk (Air; 816 on Air): all-joint net, arm SDK")
    mimic(src, o, "mimic_punch", 805, "mimic_punch/805_fight",
          "MimicPunch fight mode: twist-net guard walk + 21 VQ-latent moves on one net, remote/API driven",
          ["motions/mimic_punch/2025-07-30_08-26-56_norm_adapt_l_speed/exported/model.onnx",
           "motions/mimic_punch/2025-07-27_15-55-47_mu_p_resume/exported/model.onnx"], EDU_LOCO)
    # NOT packed: mimic_punch/2025-07-21_18-11-48_punch_resume_new_usd_0717 (ships, referenced by no build). Same obs
    # interface as mu_p_resume (input sensitivity r 0.99) but its cmd path reads a different VQ latent (cmd weights
    # r 0.30 vs the configured net; 0 % of the shipped clip rows keep it upright, with raw or unit cmd) — it belongs
    # to another VQ encoder whose clips are not in the firmware.
    mimic(src, o, "mimic_actor", 804, "mimic_actor/804_actor",
          "MimicActor: three mocap takes (X / B / A), then back to the walk",
          ["motions/mimic_actor/2025-08-04_20-57-13_actor_new/exported/model.onnx"], EDU_LOCO)
    mimic(src, o, "mimic_actor", 804, "mimic_actor/804_actor-actor2_resume",
          "MimicActor with the earlier actor2_resume net (ships, not referenced). Its graph lacks the cmd L2-normalisation"
          " the configured nets carry (ReduceL2 → Div), so the pack normalises the clip row before feeding it",
          ["motions/mimic_actor/2025-07-08_17-33-53_actor2_resume/exported/model.onnx"], EDU_LOCO, cmd_norm=True)
    simple(src, o)
    # 831 legs-only nets of the older core (1.0.2.223 semantics: 12 actions, arms at default, walks)
    if a.src223:
        s2 = a.src223
        for net in ("r1air_armsdk_loco_new", "r1air_armsdk_loco_old"):
            armsdk831(src, o, f"locomotion_armsdk/831_{net.replace('r1air_armsdk_loco_', 'legs_')}",
                      f"LocomotionArmsdk legs-only net {net} (1.0.2.154 ships it; runs under the 1.0.2.223 core + "
                      f"config)", model=f"net/motions/locomotion_armsdk/{net}.onnx", legs_only=True, cfg_src=s2,
                      reachable=False)
        extra_223(s2, o, air_combos)

    json.dump({"robot": "r1", "policies": o.entries}, open(os.path.join(REPO, REG, "index.json"), "w"), indent=2)
    print(f"{len(o.entries)} packs -> {REG}")


if __name__ == "__main__":
    main()
