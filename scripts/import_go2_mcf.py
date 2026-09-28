#!/usr/bin/env python3
"""Import every Unitree Go2 firmware policy (OTA 1.1.15, mcf AI module) into unitree-mujoco-web as firmware-faithful
packs for ONE bundle (go2-all.zip).

Driver: src/core/drivers/go2_fw.ts (config block `go2:` with `firmware: true`). Behaviour decoded from
libgo2_ai_module.so (mcf 1.0.0.75 — shipped by OTA 1.1.11 and unchanged through 1.1.15) and checked against bench
MNN-I/O captures; see docs/GO2_FIRMWARE_POLICIES.md and orange_pi_workbench/docs/HANDOFF_GO2_POLICIES.md.

What gets packed (registry/go2/<group>/<name>.yaml + registry/go2/index.json, nets -> assets/policies/go2/*.onnx):
  * every FSM the 1.1.15 AI module instantiates: 1003 FreeWalk (+ the payload variants the config service's
    sport_payload_json mass selects), 2021 Rage, 2016 CrossStep, 2017 BackStand (+2018 end), 2008 FreeBound,
    2009 FreeJump, 2007 FreeAvoid, 2019 ForceFollow, 2010 ClassicWalk, 2011 HandStand, 2005 AutoRecovery,
    2012 / 2013 / 2014 forward / back / left flip;
  * the ai_sport 1.0.4.x ContinuousFlip / ContinuousFlipX3 (StateMachine 12 / 14: implemented in 1.1.1-1.1.4 but
    never entered by any API or remote combo) when --ai-sport is given;
  * orphaned configs / nets (no FSM loads them) are listed runnable:false.

Usage:
  python3 scripts/import_go2_mcf.py --src <.../unitree/module/mcf> [--ai-sport <.../unitree/module/ai_sport>]
  node scripts/build-packs.mjs --robot go2 --public .           # -> policy-packs/go2-all.zip
Nets are converted with scripts/mnn_graph_to_onnx.py (checked against MNN on random inputs).
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys
import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET = "assets/policies/go2"
REG = "registry/go2"
SRC_TAG = "Go2 OTA 1.1.15 mcf 1.0.0.75 libgo2_ai_module.so"

# fsm id -> pack name (handover targets)
PACKS = {
    1003: "free_walk/1003_free_walk", 2021: "rage_mode/2021_rage_mode", 2016: "cross_step/2016_cross_step",
    2017: "back_stand/2017_back_stand", 2008: "free_bound/2008_free_bound", 2009: "free_jump/2009_free_jump",
    2007: "free_avoid/2007_free_avoid", 2019: "force_follow/2019_force_follow", 2010: "classic_walk/2010_classic_walk",
    2011: "hand_stand/2011_hand_stand", 2005: "auto_recovery/2005_auto_recovery", 2012: "flips/2012_forward_flip",
    2013: "flips/2013_back_flip", 2014: "flips/2014_left_flip",
}

# Buttons act on the RUNNING policy only; other policies are picked from the policy list (the firmware's
# FSM-switch combos / sport-API calls are documented in docs/GO2_FIRMWARE_POLICIES.md, not duplicated as buttons).
SPEED = [{"group": "Speed", "items": [{"combo": "L1 L1", "label": "High speed (L1 ×2)"},
                                      {"combo": "L2 L2", "label": "Low speed (L2 ×2)"}]}]



def load(src, name):
    return json.load(open(os.path.join(src, "config", name)))


def norm_of(cfg, prefix=""):
    n = cfg["normalization"]
    out = {"ob_mean": n[prefix + "ob_mean"], "ob_scale": n[prefix + "ob_scale"], "act_mean": n[prefix + "act_mean"],
           "act_scale": n[prefix + "act_scale"]}
    if "kp" in cfg: out["kp"] = cfg["kp"]
    if "kd" in cfg: out["kd"] = cfg["kd"]
    if "clip_obs" in cfg: out["clip_obs"] = cfg["clip_obs"]
    if "clip_act" in cfg: out["clip_act"] = cfg["clip_act"]
    return out


def flip_norm(cfg):
    n = cfg["normalization"]
    return {"ob_mean": n["ob_mean"], "ob_scale": n["ob_scale"], "act_mean": n["act_mean"], "act_scale": n["act_scale"]}


def convert(src_mnn, dst_onnx):
    os.makedirs(os.path.dirname(dst_onnx), exist_ok=True)
    if os.path.exists(dst_onnx) and os.path.getmtime(dst_onnx) >= os.path.getmtime(src_mnn):
        return
    r = subprocess.run([sys.executable, os.path.join(REPO, "scripts", "mnn_graph_to_onnx.py"), src_mnn, "--out",
                        dst_onnx], capture_output=True, text=True)
    ok = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("OK")]
    if r.returncode or not ok or not os.path.exists(dst_onnx):
        raise SystemExit(f"conversion failed: {src_mnn}\n{r.stdout}\n{r.stderr}")
    print("  " + ok[0].strip()[:110])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help=".../unitree/module/mcf (holds module/ai/config)")
    ap.add_argument("--ai-sport", help=".../unitree/module/ai_sport of 1.1.3/1.1.4 (config/payload_0): continuous flips")
    a = ap.parse_args()
    ai = os.path.join(a.src, "module", "ai")
    cfgdir = os.path.join(ai, "config")
    need: dict[str, str] = {}                           # onnx asset rel path -> source .mnn

    def net(name, src_dir=cfgdir, sub=""):
        rel = f"{ASSET}/{sub}{name.replace('.mnn', '')}.onnx"
        need[rel] = os.path.join(src_dir, name if name.endswith(".mnn") else name + ".mnn")
        return rel

    fw = load(ai, "free_walk_export_cfg.json")
    ar = load(ai, "auto_recovery_export_cfg.json")
    common_aux = {"walk": net(fw["free_walk_model_name_0_1"]), "rotate": net(fw["only_rotate_model_name"]),
                  "stair": net(fw["free_walk_hight_stair_model_name"]), "recovery": net(ar["recovery_model_name"])}
    common_norms = {"walk": norm_of(fw), "recovery": norm_of(ar)}
    walk_scales = {"walk_low": [fw["low_vx"], fw["low_vy"], fw["low_vyaw"]],
                   "walk_up": [fw["up_vx"], fw["up_vy"], fw["up_vyaw"]]}

    entries = []

    def pack(name, fsm, scheme, main_rel, norms, aux=None, note="", extra=None, runnable=True, notice=None,
             actions=None, source=SRC_TAG, ideal=False):
        g = {"firmware": True, "fsm_id": fsm, "scheme": scheme, "packs": {str(k): v for k, v in PACKS.items()},
             "norms": norms, **walk_scales, "aux_models": {**common_aux, **(aux or {})}}
        if extra: g.update(extra)
        cfg = {"name": name, "robot": "go2", "family": "go2_fw", "source": source,
               # 1 kHz plant like the bench; cmd_delay = the bench's effective lowcmd → motor latency (flips are
               # latency-chaotic: with it the web reproduces the bench flips). The continuous flips run ideal (0).
               "control": {"step_dt": 0.02, "sim_dt": 0.001, **({} if ideal else {"cmd_delay": 0.010})},
               "policy": {"path": main_rel, "num_act": 12}, "go2": g,
               "control_ui": {"actions": actions if actions is not None else SPEED,
                              }}  # no popup notices on Go2 packs (the notice text only documents the policy in this script)
        path = f"{REG}/{name}.yaml"
        os.makedirs(os.path.dirname(os.path.join(REPO, path)), exist_ok=True)
        with open(os.path.join(REPO, path), "w") as f:
            f.write(f"# Go2 FSM {fsm}: {note}\n")
            yaml.safe_dump(cfg, f, sort_keys=False, width=120, default_flow_style=None)
        entries.append({"name": name, "family": "go2_fw", "robot": "go2", "dof": 12, "policy": main_rel,
                        "runnable": runnable, "config": path, "note": note, "fsm_id": fsm})

    # 1003 FreeWalk (+ payload nets)
    lv = lambda c: {"low": [c["low_vx"], c["low_vy"], c["low_vyaw"]], "up": [c["up_vx"], c["up_vy"], c["up_vyaw"]]}
    pack(PACKS[1003], 1003, "free_walk", common_aux["walk"], {"main": norm_of(fw), **common_norms},
         note="FreeWalk: Aug13 walk net, Apr25 in-place-rotation net when |vx| < 0.05 and vy < 0.05 (signed), Mar25 "
              "stair net at low speed (double L2) — one shared 6-frame history", extra=lv(fw),
         notice="FreeWalk (Start). Up/high speed (default on entry): 1.3 m/s × stick; double L2 = low speed = the stair net.")
    for key, lbl in (("free_walk_model_name_1_5", "1_5kg"), ("free_walk_model_name_5_10", "5_20kg")):
        pack(f"free_walk/1003_free_walk_payload_{lbl}", 1003, "free_walk", net(fw[key]),
             {"main": norm_of(fw), **common_norms}, note=f"FreeWalk with a {lbl.replace('_', '-')} payload "
             f"(sport_payload_json mass): {fw[key]} always, up_vx 1.0, falls → Damping", extra={**lv(fw), "payload": "heavy"},
             notice="Payload variant: the firmware picks this net instead of Aug13 when the app's payload mass is set.")
    rg = load(ai, "rage_mode_export_cfg.json")
    pack(PACKS[2021], 2021, "rage", net(rg["rage_model_name"]), {"main": norm_of(rg), **common_norms},
         note="RageMode (API 2059 only): asymmetric stick filters, vx 2.5 × stick", extra=lv(rg),
         notice="Rage mode: entered from the app / SDK only (API 2059 {data:true}).")
    cs = load(ai, "cross_step_export_cfg.json")
    pack(PACKS[2016], 2016, "cross_step", net(cs["cross_step_model_name"]), {"main": norm_of(cs), **common_norms},
         note="CrossStep (double B)", extra=lv(cs))
    bs, bse = load(ai, "back_stand_export_cfg.json"), load(ai, "back_stand_end_export_cfg.json")
    pack(PACKS[2017], 2017, "back_stand", net(bs["back_stand_model_name"]),
         {"main": norm_of(bs), "end": norm_of(bse), **common_norms}, aux={"end": net(bse["back_stand_end_model_name"])},
         note="BackStand (double R2; again = BackStandEnd 0.5 s → FreeWalk)", extra=lv(bs),
         actions=SPEED + [{"group": "Back stand", "items": [{"combo": "R2 R2", "label": "Land (back on four legs)"}]}],
         notice="Back stand: double R2 rears up on the hind legs; sticks walk / turn; double R2 again (or Start) lands via "
                "BackStandEnd (Dec23 net, 0.5 s) and returns to FreeWalk.")
    for fsm, fn, key, scheme, lbl in ((2008, "free_bound_export_cfg.json", "free_bound_model_name", "bound", "FreeBound (double X)"),
                                      (2009, "free_jump_export_cfg.json", "free_jump_model_name", "jump", "FreeJump (double Y)")):
        c = load(ai, fn)
        pack(PACKS[fsm], fsm, scheme, net(c[key]), {"main": norm_of(c), "zero": norm_of(c, "zero_"), **common_norms},
             aux={"zero": net(c["zero_walk_model_name"])}, note=lbl + ": the zero-walk net (Aug13) whenever the "
             "filtered forward / side stick is < 0.05", extra=lv(c))
    av = load(ai, "free_avoid_export_cfg.json")
    pack(PACKS[2007], 2007, "avoid", net(av["free_walk_model_name"]), {"main": norm_of(av), **common_norms},
         aux={"obstacle": net(av["obstacle_model_name"]), "zero_planner": net(av["zero_model_name"])},
         note="FreeAvoid (double A): obstacle / zero planner nets on a 41×21 5 cm height-map grid → walker velocity",
         extra={**lv(av), "avoid": {k: av[k] for k in ("vel_filter", "avoid_min_vel", "o_vel_x", "o_vel_y", "o_vel_w",
                                                         "z_vel_x", "z_vel_y", "z_vel_w", "back_index", "right_index")}},
         notice="Free avoid: the planner nets see the lidar height map (here: the terrain under a 41×21, 5 cm grid); "
                "on flat ground the grid is empty, like the lidar-less bench.")
    dr = load(ai, "drag_export_cfg.json")
    pack(PACKS[2019], 2019, "drag", net(dr["drag_base_model_name"]),
         {"main": norm_of(dr), **common_norms}, aux={"est": net(dr["drag_model_name"])},
         note="ForceFollow / drag (API 2056 only): the Apr10 net estimates the pull velocity from the history",
         extra={"drag": {k: dr[k] for k in ("cmd_limits", "filter_params", "cmd_rate")}}, actions=[],
         notice="Force follow: entered from the app / SDK only (API 2056). Pull the dog with the leash (drag in the "
                "view): with the sticks centred the estimator net turns the pull into the walking command.")
    gw = load(ai, "gait_walk_export_cfg.json")
    pack(PACKS[2010], 2010, "gait_walk", net(gw["gait_walk_model_name"]), {"main": norm_of(gw), **common_norms},
         note="ClassicWalk (Right+Start): gait-clock net, stands still when the command is ~0",
         notice="Classic walk (Right+Start): starts at LOW speed (0.6 m/s × stick, 1.4 Hz); double L1 = 1.2 m/s, 1.8 Hz.")
    hs = load(ai, "hand_stand_export_cfg.json")
    pack(PACKS[2011], 2011, "hand_stand", net(hs["hand_stand_model_name"]), {"main": norm_of(hs), **common_norms},
         note="HandStand (double R1; again = back on four legs, 0.5 s → FreeWalk)",
         actions=SPEED + [{"group": "Hand stand", "items": [{"combo": "R1 R1", "label": "Leave hand stand"}]}],
         notice="Hand stand: 0.5 s on four legs, then the net's hand-stand mode (cmd[6] = −1); double R1 again leaves.")
    pack(PACKS[2005], 2005, "auto_recovery", common_aux["recovery"], {"main": norm_of(ar), **common_norms},
         note="AutoRecovery (re_v2): what every FSM falls back to after a fall; starts here on the back", actions=[],
         notice="Auto recovery: the firmware runs it after any fall (auto-recovery on) until upright, then FreeWalk.")
    for fsm, fn, key, scheme, lbl in ((2012, "forward_flip_export_cfg.json", "forward_flip_model_name", "forward_flip", "ForwardFlip (API 1030)"),
                                      (2013, "back_flip_export_cfg.json", "back_flip_model_name", "back_flip", "BackFlip (API 2043)"),
                                      (2014, "left_flip_export_cfg.json", "left_flip_model_name", "left_flip", "LeftFlip (API 2041)")):
        c = load(ai, fn)
        n = c["normalization"]
        fl = {k: v for k, v in {**c, **n}.items() if k not in ("normalization", "ob_mean", "ob_scale", "act_mean", "act_scale")
              and not k.endswith("model_name")}
        api = {2012: "api:1030 forward flip", 2013: "api:2043 back flip", 2014: "api:2041 left flip"}[fsm]
        acts = [{"group": "Flip", "items": [{"combo": api, "label": "Flip again"},
                                            {"combo": "repeat:on", "label": "Repeat flip ON"},
                                            {"combo": "repeat:off", "label": "Repeat flip OFF"}]}]
        pack(PACKS[fsm], fsm, scheme, net(c[key]), {"main": flip_norm(c), **common_norms},
             note=lbl + ": ready → 0.3 s hold → NN → scripted landing → FreeWalk", extra={"flip": fl}, actions=acts,
             notice=f"{lbl}: sport API only (no remote combo on 1.1.15). The pack starts with the flip; afterwards it "
                    "is in FreeWalk; 'Flip again' flips once more (sticks centred) and 'Repeat' re-triggers it every time "
                    "the dog is back in FreeWalk, i.e. back-to-back flips as repeated app/SDK requests would do.")
    if a.ai_sport:
        p0 = os.path.join(a.ai_sport, "config", "payload_0")
        for scheme, fn, nm, lbl in (("cflip", "continuous_flip_export_cfg.json", "continuous_flip", "ContinuousFlip"),
                                    ("cflip_x3", "continuous_flip_export_cfg_x.json", "continuous_flip_x3", "ContinuousFlipX3")):
            c = json.load(open(os.path.join(p0, fn)))
            acts = [{"group": "Flip", "items": [{"combo": "force:flip", "label": f"Run {lbl} again"},
                                                         {"combo": "repeat:on", "label": "Repeat ON"},
                                                         {"combo": "repeat:off", "label": "Repeat OFF"}]}]
            pack(f"flips/{nm}", 12 if scheme == "cflip" else 14, scheme,
                 net(c["continuous_flip_model_name"], src_dir=p0, sub="ai_sport_1.0.4/"), {"main": flip_norm(c), **common_norms},
                 note=f"ai_sport 1.0.4.x {lbl} (StateMachine {12 if scheme == 'cflip' else 14}): implemented in Go2 1.1.1-1.1.4 "
                      "but never entered by any API or remote combo; forced on the bench with gdb",
                 source="Go2 ai_sport 1.0.4.46 sport_runner (OTA 1.1.3 / 1.1.4)", actions=acts, ideal=True,
                 notice=None)

    # orphans: configs / nets no 1.1.15 FSM loads
    orphan = [("double_walk/Oct17_18-26-54_1", "double_walk_export_cfg.json: no FSM class"),
              ("fly_bound/Oct10_15-54-09_", "fly_bound_export_cfg(_1).json: no FSM class (same net as FreeJump)"),
              ("right_flip/right_flip_v0", "right_flip_export_cfg.json: no FSM (API 2042 unhandled on 1.1.15)"),
              ("side_flip/side_flip_v0", "side_flip_export_cfg.json: no FSM"),
              ("flip/flip_v0", "flip_export_cfg.json: never loaded (ForwardFlip reads forward_flip_export_cfg.json)"),
              ("free_walk/Mar23_06-31-55_57400", "unreferenced checkpoint"),
              ("back_stand/Dec02_19-59-54_5", "unreferenced checkpoint"), ("cross_step/Dec12_11-38-32_3", "unreferenced checkpoint"),
              ("auto_recovery/o_v2", "auto_recovery obstacle_model_name: never loaded"),
              ("auto_recovery/z_v1", "auto_recovery zero_model_name: never loaded"),
              ("auto_recovery/b_v2", "auto_recovery blind_model_name: never loaded (b_v2 runs as ClassicWalk)")]
    for nm, why in orphan:
        entries.append({"name": "obsolete/" + nm, "family": "go2_fw", "robot": "go2", "dof": 12, "runnable": False,
                        "note": "1.1.15: " + why})
    with open(os.path.join(REPO, REG, "index.json"), "w") as f:
        json.dump({"robot": "go2", "source": SRC_TAG, "policies": entries}, f, indent=2)
    print(f"registry: {sum(e['runnable'] for e in entries)} runnable, {sum(not e['runnable'] for e in entries)} obsolete")
    for rel, mnn in sorted(need.items()):
        convert(mnn, os.path.join(REPO, rel))


if __name__ == "__main__":
    main()
