# G1 firmware policies (ai_sport 1.5.4): catalog, switching, observations

Everything here was read from the G1 **1.5.4** ai_sport package or measured on the emulated bench
(EDU identity, machinetype 5, 29-DOF MuJoCo plant) on 2026-09-25:

- the decrypted FMX configs under `/unitree/module/ai_sport/{fsm,policies}`;
- the FSM registration / transition table ai_sport prints at start-up;
- the remote-combo handler, decompiled from `humanoid` (`fsm_scheduler.cpp`, `sub_368B20`);
- the real network inputs and outputs, captured by hooking `MNN::Interpreter::runSession` in the running
  `humanoid` (tools: `orange_pi_workbench/tools/ai_sport_probe/`).

## 1. How the robot switches policies

Three things gate every switch (`fsm/fsm_scheduler.yaml` plus the transition table in the binary):

- **block** — disabled on this firmware, cannot be entered at all:
  `301 mimic_test, 502 human_mimic, 708 jump_forward, 709 jump_up, 800 walk_29dofs, 810 cpy_dance,
  811 cpy_fight, 813 cpy_walk_jump, 900 zjx_walk_jump`.
- **compatibilities** — machine type (4 = Air 23-DOF, 5 = EDU 29-DOF): `500:[4,6]`, `501:[2,5]`, `502/504/505/203:[2,5]`,
  `503:[2,4,5]`, `705/708/709:[1,4]`. Other ids run on any machine type.
- **manual transitions** — an FSM can only be entered from the states listed in §2 ("from").
  `0-4` are unconditional.

### Remote (RF joystick) combos

Decoded from the scheduler. Flags are the remote-state bytes in the order of `button_*` names below.

| Combo | Goes to |
|---|---|
| **L2 + B** | 1 damping (passive) |
| **L2 + Y** | 0 zero torque |
| **L2 + ↑** | 4 locked stand (FixStand, no balance — hoist) |
| **L2 + ←** | 3 sit |
| **L2 + A** (while in damping) | 706 one-key get-up |
| **L2 + X** | 702 face-up get-up |
| **R1 + X** | 500 vision loco (Air) |
| **R1 + Y** | 501 vision loco WBC (EDU) |
| **R1 + A** | 505 punch mode (EDU with robot_type "18", see §4 — the bring-up seeds it) |
| **R1 + B** | 503 human mimic 2 (dances, see §4) |
| **R2 + A** | 801 cpy run, or **802** cpy walk/run on machine type 5 (801 also auto-hands over to 802) |
| **R2 + B** | 812 cpy stair loco |
| L1 + Y | 301 mimic_test (blocked) |
| L1 + L2 + A / + B | 708 jump forward / 709 jump up (blocked) |
| R1 + R2 + ↓ / ↑ / ← / → | 810 dance / 811 fight / 813 walk-jump / 900 zjx jump (all blocked) |
| **R1 + R2 + X** | 1001 wjc get-up (from the floor, then auto → 802) |
| L2 + R2 (in 0/1) | exits ai_sport |
| START / SELECT | switch gaits *inside* an FSM (`gait_button_map` in the FSM config) |
| **R2 + ↑ / ↓** (in 801 / 802) | high / low **speed level** (802: full stick 2.0 / 1.0 m/s; 801: 2.7 / 1.5) |
| **R2 + → / ←** (in 801 / 802) | forward speed limit +0.1 / −0.1 m/s (up to high + 1) |
| **L1 / L2 double press** (in 500 / 501) | high / low speed level (0.9 / 0.6 m/s, gait 1.2 / 1.0 Hz) |

### Run / walk speed from the remote (decompiled, bench-checked 2026-09-25)

The Cpy loco FSMs read the raw remote key word through a per-key state machine (`sub_63E300`: a key must be stable
for 3 samples; states 2 = press edge, 1 = held, 4 = double press < 0.5 s, 5 = long press > 2 s, 3 = release).
A combo = modifier in state **held** + key **press edge**, so on the remote hold R2 first, then press the arrow
(pressing both in the same instant does nothing — that is why the first bench try failed).

- **802 CpyWalkRun29dofs** (`fsm_cpy_walk_run_29dofs.cpp`, run `sub_551370`, level helper `sub_54EA40`):
  R2 + ↓ → low (`low_speed` 1.0), R2 + ↑ → high (`high_speed` 2.0), R2 + → / ← → `command speed limit` ±0.1.
  vx = stick × limit, limit = min(level speed, high_speed + 1) (the + 1 cap is the temperature / low-power limit in
  normal operation); **backwards vx = the raw stick** (at most −1 m/s at any level) and 0 above −0.3 m/s; vy / wz are
  not affected. Entry keeps the level (the process starts in low, "Switch To Low Speed"); the loco API `SpeedMode`
  (0 low, 1 middle, 2 high, 3 ultra) sets it too — middle (1.5) and ultra (3.0) are API-only. Bench capture
  probe7/802speed: full stick 1.0 → R2+↑ 2.0 → R2+→ ×2 2.2 → R2+←, R2+↓ 1.0, full back −1.0 (commands tensor;
  the walk/run net handled 2.2 m/s on the plant). `running_state_` walk slow → fast (> 0.6) → run (> 1.5) switches
  sessions, but all three are the same actor file on 1.5.4.
- **801 CpyRun29dofs** (`sub_516A30`): identical combos, levels from its config: low 1.5, middle 2.0, high 2.7, ultra 3.0.
  On the Air bench (801 stays in 801 there): full stick 1.5 → R2 + ↑ → 2.7 (probe7/801air.bin).
- **812 CpyStairLoco** (`sub_52E5D0`): only R2 + ↓ (back to low, 1.0) — no way up from the remote.
- **800 Walk29dofs** (blocked): R2 + ↓ low 1.0, R2 + ← / → middle 2.0, R2 + ↑ high 2.5.
- **500 / 501 FsmHumanLoco** (`fsm_human_loco.cpp` `sub_441450`): double press L2 → "low speed level", double press
  L1 → "high speed level"; the level picks the `policy_params` row [high speed, low speed, gait_f_range, gait_d_range]:
  low = vx 0.6, gait 1.0 Hz, duty 0.65; high = vx 0.9, gait 1.2 Hz, duty 0.5 (vy 0.2, wz 1.4 both). Bench 501
  (probe7/501speed): cmd vx → 0.6, after L1 ×2 → 0.9 with cmd[4] = −0.1 → 0.0 (1.0 → 1.2 Hz) and duty 0.65 → 0.50.
- 505 PunchMode: double press L1 / L2 steps its walk speed level 1 ↔ 2 (see §4).

### Loco RPC

`LocoClient.SetFsmId(id)` (api 7101) reaches every FSM, including ones with no combo
(200-203, 210, 300, 504, 550, 1000), subject to the same block / compatibility / transition rules.
Motions of 550 are selected by `api_id` (§4).

## 2. FSM catalog

"Bench" = what happened when the FSM was entered on the EDU bench (hoist released, stick forward and turn).
"Web" = state of the unitree-mujoco-web pack.

| id | FSM (class) | From | Networks (in → out) | Bench 1.5.4 EDU | Web pack |
|---|---|---|---|---|---|
| 1 | Passive | any | — | damping | FSM |
| 3 | Sit | 1,2,4,200-203,500,501,801,802,812 | — | | FSM |
| 4 | FixStand | 1,2,3,550 | — | locked stand | FSM (stance) |
| 200 | HybridRun | 4,201-203,210,301,500 | 400 → 12 (legs, 10-step history of 40, 100 Hz) | walks | ✅ hybrid_run |
| 201 | TerrainBlind | 4,200,202,203,500 | encoder 1500 → 96, actor 480 → 12 | walks | ✅ blind_terrain |
| 202 | PlaneEncoder | 4,200,201,203,500 | encoder 1500 → 44, actor 424 → 12 | walks | ✅ plane_encoder |
| 203 | WaistControl | 4,200,301,500 | encoder 1500 → 44, actor 444 → 12 | walks | ✅ waist_control |
| 210 | Shot (kick) | 200,201 | 420 → 12, ~1.4 s, auto → 200 | kicks, back to 200 | ✅ shot (kicks from the hybrid-run stance) |
| 300 | Stand | 1,200 | **no network**: 2 s ramp to a fixed stand posture, then hold (23 joints) | stands up in the hoist; falls when released (EDU: limp waist pitch folds back; Air: rocks and tips forward) | not packed (no balance control — only useful in a hoist; removed from the app) |
| 500 | VisionLoco | 4,200-203,301,501-503,702,801,802,812 | `p_obs` 5×42 + `cmd` 8 → 12 | walks (Air) | ✅ vision_loco / human_loco |
| 501 | VisionLocoWBC | 4,500,502,503,706,801,802,812 | `p_obs` 5×48 + `cmd` 8 → 14 | walks (EDU) | ✅ vision_loco_wbc / human_loco_29 |
| 503 | HumanMimic2 | 4,500-502,504,801,802 | `p_obs` 10×93 + `cmd` 64 (VQ motion latent) → 29 | stands, plays combos | ✅ human_mimic/dance1_s2, lixiaolong, classic_movie |
| 504 | TrajLoco | 801,802 | decoder `p_obs` 10×75 + `cmd` 163 → 23, estimator → 2 | walks | ✅ traj_loco (path-following walker) |
| 505 | PunchMode | 4,801,802,812 | walk decoder `p_obs` 10×75 + `cmd` 163 → 23, estimator → 2, punch / get-up decoders `cmd` 73 → 23 | enters (4 → 802 → 505, robot_type 18, no patch); walks, all modifier combos + L2+↓/↑ get down / up (captured) | ✅ punch_mode (walk + 24 remote moves, get down / up) |
| 550 | HumanMimicGlobal | 4,501,504,801,802 | per-library `decoder.mnn` + stance decoder | refused from 4 on the bench | — |
| 702 | FaceupGetup | 1 | scripted (no net) → post-train `squat2stand_new_decoder` 10×93 + cmd 64 | script runs (captured), emulator plant stops at pitch −0.55 → `squat_safe_check` fail | ✅ faceup_getup + face_down (sim pitch assist during the script) → 802 |
| 703 | Squat2Stand | 203 | 46 (13-DOF + phase clock) → 13 | enters from a released 203 stance and stands (clock 1000); Start → squat down (fell forward on the bench plant); no transition out | ✅ squat2stand (stand → squat → stand on Start) |
| 706 | OneKeyBreak | 1,500,501,504,505,801,802,812 | `p_obs` 10×93 + `cmd` 64 → 29 | ran, ends in damping | ✅ one_key_break (squat → stand) |
| 801 | CpyRun29dofs | 4,500-505,550,708,709,802,812,1000 | auto → 802 on 1.5.4 | = 802 | ✅ cpy_run_29dofs (run net) |
| **802** | CpyWalkRun29dofs | 4,500-503,505,550,708,709,801,812,813,900,1000 | stance + walk/run: `proprioception` 96, `memory` 10×96, `commands` 3 → 29 | walks/runs | ✅ **cpy_walk_run_29dofs (new)** |
| 812 | CpyStairLoco | 4,500-502,505,801,802 | walk 69 + run 69, `memory` 5×69, `commands` 3 → 21 | walks | ✅ cpy_stair_loco (+ run handoff) |
| 810 / 811 | CpyDance / CpyFight | 802 only (blocked) | mimic: `proprioception` 93, `memory` 5×93, `quaternion` 4, `target_state` 71 → 29 | blocked | dance ok, ❌ fight falls |
| 813 | CpyWalkJump | 802 only (blocked) | `proprioception` 93, `memory` 5×93, `future_states` 5×67 → 29 | blocked | ✅ cpy_walk_jump (decompiled; run-up + ~2.1 m leap, → 802) |
| 900 | ZjxWalkJump | 802 only (blocked) | `obs` 3×201 (IsaacLab joint order) → 29 | blocked | ✅ zjx_walk_jump (decompiled; same clip, ~2.35 m leap, → 802) |
| 1000 | UserLowcmd | 1,801,802 | — (arm/low-level SDK) | | — |
| 1001 | WjcGetup | 1 | 121 → 23, then auto → 802 | **gets up from the floor** | ✅ wjc_getup (face-up; face-down net included) |

Registered but unreachable on 1.5.4 (no transitions): 700 facedown_getup, 704 normal_walk, 705 jump_17dofs,
707 any2squat, 710 fsm_transis_test. They can't be checked on the bench.

## 3. Observations measured on the bench

Common: 50 Hz, history stacked **oldest first**, targets are `default + action × action_scale` with the pack's kp/kd.

**500 / 501 (FsmHumanLoco)** — frame = `[gyro×0.2, projected_gravity, q−default, dq×0.05, last_action]`,
`last_action = clip(a, ±2) × action_scale`. `cmd = [sin r0, sin r1, cos r0, cos r1, (f−1.2)×0.5, vx×0.2, vy×0.2, wz×0.2]`;
command low-pass at 0.18 Hz; gait f = 1.0 Hz, legs at φ and φ+0.5 remapped by duty 0.65; start when |cmd| > 0.1
with φ = 0.5, stop only when φ returns to 0.5. Standing feeds f = 0 and both legs at phase 0 (500 → `[0,0,1,1]`)
or 0.25 (501 → `[1,1,0,0]`).

**802** — `proprioception = [ang_vel (raw), rot6d (R00,R01,R10,R11,R20,R21), q (absolute), dq (raw),
last_action × action_scale]`, `memory` = last 10 frames. The stance net runs whenever there's no translation
command (turning in place included), the walk/run net otherwise; all nets share one history.

**812** — same as 802 but `[ang_vel, projected_gravity, q, dq, last_action (raw)]` over 21 joints
(legs, waist yaw, 4 per arm), 5-frame memory; the run net (`cpy_run_29dofs/May21_11-38-11`) takes over at
vx ≥ 0.6 m/s and hands back at ≤ 0.5.

**Command shaping (801/802/812)** — the command leaves standstill with a jump (vx 0.24, vy 0.23, wz 0.72), then ramps
per tick up/down vx 0.02/0.05, vy 0.02/0.01, wz 0.08/0.1, and snaps to 0 under 0.2 / 0.2 / 0.7.
Stick → command at full deflection: vx 1.0, vy 0.6, wz 2.0 (802 at the low speed level; R2 + ↑ raises vx to 2.0, see §1).

Other FSMs: tensor sizes are in §2; the configs state the rest (e.g. `hybrid_run` / `plane_encoder`: 40-dim frame,
10-step history, ang ×0.25, dq ×0.05, angular pos ×3). These haven't been verified term by term yet.

## 4. Dances and tricks in 1.5.4

- **503 human mimic 2** (R1 + B, then combos): VQ-latent tracker. Motions:
  dance1 clips (R1+↑, R1+←, R1+→), "lixiaolong" Bruce-Lee take (R2+↑), "classic_movie" (R2+←).
- **505 punch mode** (R1 + A, or 4 → 802 → SetFsmId 505): 22 moves — R1 / R2 + ↑↓←→ / SELECT, L1 + ↑↓←→ and the
  bare keys ↑↓←→ / A B X Y (double press on the robot) — plus L2 + ↓ get down and L2 + ↑ get up.
- **550 human mimic global** (loco API, by `api_id`): 127 motions in 9 libraries —
  `202605_dance` 601-604 (Groove, Popping5, Hiphop, WarmUp, with music), `202605_dance_xueshan` 605 (traditional dance),
  `202603_official_list` 502-506 (Ballet1, Popping1/3/4), `20260528_interactions` 507-525 (19 gestures),
  `29dof/20260608_teach_files` 526-573 (46), `…_interactions` 574 (Welcome), `0107_simple` 401-403.
- **210 shot** — a kick, entered from hybrid run (200).
- **1001 wjc get-up** (R1 + R2 + X from damping) — gets up from lying and continues in 802.
- Blocked on this firmware: 810 cpy dance, 811 cpy fight, 813 / 900 walk-jumps (sim packs work), 708 / 709 17-DOF jumps.

### Entry details found later (bench + decompile)

- **550 human mimic global**: loco `SetFsmId(550000 + motion_api_id)` (e.g. 550601 = Groove dance) queues the motion
  (FsmApi 7100 `{"fsm_id":550,"api_id":3,"motion_api_id":…}`) and enters 550; plain `SetFsmId(550)` is refused.
  FsmApi 7100 api_ids: 1 list motions, 2 pause, 3 queue motion, 4 goal pose, 5 mask root pos, 6 stop. After the motion
  the robot auto-exits to 802. The Python SDK client segfaults on 7100 (secured RPC); the bench has a native `loco_call`.
  **Odometry:** 550's task terms take the robot pose from `rt/state_estimator/fusion_odom` (ai_odom_node: learned
  leg odometry fused with the lidar SLAM pose `rt/unitree_slam/high_rate_odometry`, initialised by the app's SLAM command
  api 1004/1104/1901 with a JSON pose). Without SLAM the bench has no fusion_odom and the task terms stay ~identity.
  Validated on the bench with a fake SLAM feed of the plant pose (workbench `tools/ai_sport_probe/fake_slam`): with
  fusion_odom live, rot6d = R(q_off q_ref q_robot⁻¹) with q_robot = fusion_odom matches the capture to median
  0.007–0.012 (IMU quaternion instead: 0.15–0.25). The web packs use the sim's true base pose (`motion_task: odom`).
- **505 punch mode** — reachable without any patch. The scheduler gate is two Bridge bytes (+7656 / +7657) the Bridge
  constructor sets from `/unitree/robot/basic/ver` (EDU) and `/unitree/robot/info/robot_type` == "18" ("This is a punch
  machine !"; the EDU store sits in a VM-protected stub, which is why static scans missed it). robot_type_service never
  rewrites an existing robot_type file, so the bench bring-up (g1-up.sh / g1-variant.sh) now seeds "18" for EDU. Enter
  4 → 802 → SetFsmId 505 (allowed from 4 / 801 / 802 / 812) or R1 + A. Decoded (fsm_punch_mode.cpp) and checked on the
  bench captures probe6/505, 505full (stick + every combo), 505b (bare keys, get down / up) — web driver `g1_punch.ts`:
  - obs: frame `[gyro×0.2, projected gravity, q − default, dq×0.05, last action]` over the 23 joints without wrists,
    10 frames oldest first (first frame repeated at entry), one history for every net; target = default +
    clip(a, ±20) (action_scale 1), wrists 0, config kp/kd. Recomputed from rt/lowstate: gyro/gravity/dq ≤ 5e-5 (one
    ambiguous standstill match 9e-3), history shift and last action exact.
  - walking = FSM 504's path follower on the `g1_punch_walk_12500` decoder: cmd 163 = [anchor_motion_latent,
    10 path blocks, block 0]; block = [path − odometry in the robot yaw frame (**no clip**), 0,
    rot6d(Rz(yaw_i)·R_base^T)] (sub_557860; the rot6d fits the capture to 1e-7, R_base^T·Rz does not). Stick → dead zone
    0.1 → EMA 0.3 → rate-limited twist at speed level 1 (0.8 / 0.6 / 2.0 max, accel 1.2 / 1 / 4; a double press of
    L1 / L2 moves the level 1 ↔ 2, level 0 is never used) → reference pose → 10 points 0.1 s apart (EMA 0.3).
    Odometry: estimator(p_obs, [0.5]) body velocity, integrated while the twist is non-zero, else snapped to the
    reference pose. The config's `traj_loco_stand_adjust` gait is a second session of the same decoder file (the
    firmware switches to it for single ticks on a foot-placement check) — numerically the same net.
  - moves: a combo from `motion_string_map` = its first-listed key pressed while the modifier is held; one-key
    entries need a double press within 0.5 s (why bare keys did nothing in 505full/505b). A move starts when nothing
    plays or the current one is within its last 10 rows, only while upright. It plays take-CSV rows
    round(t_start·50)…round(t_end·50) one per tick (bench: latent rows exact, e.g. R1+↑ = rows 195…240), cmd 73 =
    [latent (raw), 0,0,0 (mask_root_pos_error), rot6d(q_off·q_ref·q_robot⁻¹)], q_off = yaw part of
    q_robot·q_ref0⁻¹ at the first row (exact on every captured move), on `punch_29dof_28000` (moves and the entry clip
    `vq_Take_007 clip_70_128`, played at FSM entry) or `punch_29dof_add_getup_46000` (get down / up). Start and end
    reset the twist (v = 0, heading = IMU yaw); after the last row the walker runs in the same tick.
  - fall protection: while walking or in a move with rot_detect 1, projected gravity z > −0.5 drops the move and
    blends all 29 targets from the current q to `front_down_jpos` (gravity x < −0.1, lying on the back) or
    `back_down_jpos` over fall_down_length = 2 s; the net output is zeroed (last action 0 — seen in 505b after the get
    down). L2 + ↑ (`get_up`) is accepted once the blend is complete and plays the face-up (061) or face-down (067)
    get-up; get down / get up have rot_detect 0 and are never interrupted.
  - the FSM only leaves 505 by remote (or low battery → 802); no automatic hand-over.
- **503 on the Air**: one decoder (`ota_dance_23dof_v1`) for stance and dances, cmd 137; after a dance → 801.
  (The web packs deliberately stay in 503's stance after the motion instead of switching to 801.)
  Air bench 2026-09-25: 4 → 503, hold R2 + ← → classic movie plays ~22 s and auto-switches to 801 (the web remote
  pack does the same: 22.6 s, end offset 0.10 / −0.07 m vs bench 0.01 / −0.07 m).
- **300 Stand** (`HX::FsmStand`, `fsm/fsm_stand.yaml`; enter `sub_40A150`, run `sub_40A3D0`, lerp `sub_409E70`):
  no network (the earlier "121 → 23" was wrong). On entry it latches q of the 23 `joint_indices`; every 2 ms tick
  n: target = lerp(q_entry, `desired_joint_q`, min(n / 1000, 1)) — a 2 s linear ramp, then hold — with `joint_kp/kd`;
  waist roll / pitch and the wrist pitch / yaw get kp = kd = 0 (bench rt/lowcmd, probe7/300.npz: alpha 0.50 at 1 s,
  1.00 from 2 s). No balance feedback: entered from damping in the hoist it stands up, but once released the EDU
  plant folds back at the limp waist (−0.56 rad) and falls; on the Air plant (and offline MuJoCo on the Air model)
  the posture rocks on the soft ankles (kd 0.3 / 0.1) and tips forward within ~3 s. No emulator start pose changes
  that — it's a hoist posture, not a stance controller.
- **702 face-up get-up** (decompiled, `src/core/drivers/g1_faceup.ts`): pitch < −1.4 → face-up path; pitch ≥ 0.7
  or ∈ [−1.4, −1.05] (with |hip pitch| ≤ 1.35, |waist yaw| ≤ 1, ≤ 2 tries) → scripted face-down try (joint waypoints,
  mode 1 rolls onto the back, mode 2 curls and rocks the waist), then re-check. Face-up: 2 s interp to
  `getup_init_joint_q` on the float32 FSM clock (201 ticks from entry), the `period_angle_newtest_29` lay-to-squat
  script (7 segments, 6.1 s), `squat_safe_check` pitch ∈ (0, 1), then the post-train VQ decoder
  (`squat2stand_new_decoder`, every 10 ms tick; bench capture 702assist: latent CSV row 0 for 121 ticks while kp
  ramps over 120, then rows 204, 206 … 598, 800 … 898, row 901 for 50 ticks, target = default_test + act) and
802 after 50 more ticks. The 13-DOF net in `policy_file` is loaded but never run. Every captured rt/lowcmd sample of
  the script stages is reproduced (captures_154/probe5). MuJoCo cannot do the script's arm push-off (the pelvis stops
  at pitch ≈ −0.55 — also on the emulator bench, where 702 ends in `squat_safe_check fail`), so the pack adds a
  pelvis pitch assist during script segments 3-7 (`faceup.assist`, 0 = firmware only). Air (machinetype 4) uses the
  23-DOF table and a 137-dim-cmd decoder — not modelled.
- **703 squat2stand** is a squat/stand toggle (bench capture 703start): one 13-DOF net, obs 46 = [gyro EMA 0.2 ×0.25,
  gravity, q − default, dq EMA 0.2 ×0.05, clip(act, ±2)·action_scale, traj_step_count/1600]; target =
  default + clip(act, ±2)·action_scale, limited so the PD torque kp(target − q) − kd·dq_ema stays within
  joint_tau_limits; kp/kd = the config's joint_kp/kd. The clock is 1000 (standing) when entered from a released
  203; Start runs 1000→1400 (squat down), the next Start jumps 1400→200 and runs to 600 (stand up), and so on.
  There is no transition out of 703 (ai_sport must be restarted on the bench).
- The **137-dim cmd** (Air 503, 550) = [VQ latent (128, raw CSV), root position error (3), rot6d (6)];
  CSV rows `round(t_start·fps) … round(t_end·fps)` one per 50 Hz tick.

## 5. Web project status (G1 packs)

The picker lists G1 packs as **G1 Air → G1 Air + EDU → G1 EDU** (config `g1.models`, from the scheduler's machine-type
table and the joints a network drives), each prefixed with its FSM id. Policies the robot leaves automatically set
`done`, and the worker switches to `g1.next_policy` without re-seating, like ai_sport's auto-switch
(810/811 → 802 after 90 % of the clip, 813/900 → 802 at the clip `end`, 1001 → 802 after the get-up).

**810/811 Cpy mimic (decompiled `FsmCpyFight29dofs::run` / `sub_524660`):** proprioception = [raw gyro, projected gravity,
q (absolute), raw dq, raw last action], memory 5; `quaternion` = base orientation **relative to the heading at FSM
entry**, w ≥ 0, xyzw; `target_state` = raw clip row k+1 (first 71 columns); target = default + 0.25·a;
exit after 0.9 × length. The earlier web scheme (ang ×0.25, dq ×0.05, world quaternion, root-xy subtraction) is why
cpy_fight fell.

**813 / 900 walk-jump (decompiled `fsm_cpy_walk_jump.cpp.o` / `fsm_zjx_walk_jump.cpp.o`, which the 1.4.5 build tree
ships with symbols; Run / UpdateRlState are identical in 1.5.4):** both play JUMP_002_YY (a run-up and a ~2.3 m
forward leap). Each tick: counter += 1 (starts at the config `start`), obs → net → target = default + 0.25·a; once
counter > `end` the FSM raises its done flag and the robot returns to 802. On entry (InitRlState) one frame is
built from the entry state (last action 0) and fills the whole history (oldest first, current frame last).
- **813** (start 50, end 250 → 201 ticks): proprioception = the 810/811 frame [raw gyro, gravity, q, raw dq, raw last
  action]; memory 5×93; `future_states` = 5 clip rows `min(counter + 5i, 404)` of the 71-column csv, each
  [gravity of the row quat (xyzw), q 29, row[36:39], row[39:42], dq 29] = 67. No quaternion / root inputs.
- **900** (start 0, end 150 → 151 ticks, own default pose and kp/kd): one net input `obs` = 3 frames × 201 =
  [raw gyro, gravity, 3 × (com_z, com_v, gravity of the ref quat, ref q − default) for rows counter..counter+2 of
  the pinocchio yaml (`frames_gen_q` / `frames_com_p` / `frames_com_v`), q − default, raw dq, last action]; every
  29-vector is in IsaacLab order (slot i = motor `client_joint_idx[i]`, which also maps action i → motor). With motor
  order the net falls at once. The shipped `actor.onnx` is stale (differs from `actor.mnn` by up to 197 on random
  inputs); the pack uses a `mnn_graph_to_onnx.py` conversion.
Python MuJoCo reference and the browser agree: 813 leaps 2.12 / 2.11 m (min base z 0.68 / 0.69), 900 2.34 / 2.36 m
(0.70 / 0.71), both stand in 802 afterwards. The packs seat the robot in 802's stance when picked; the app's
"stance" state holds 900's crouched default with its weak ankle gains and tips over — pick it from 802 (policy state).

Obsolete on 1.5.4 and excluded from the packs: 700, 704, 705, 707, 710 (no transition) and 708, 709 (blocked).

Every G1 policy in the web picker shows the FSM id it runs as on the robot, e.g. `[802] cpy_walk_run_29dofs/actor`
(config key `g1.fsm_id`).

Working, stand/walk or maneuver with the hoist off (drivers verified against bench captures):
- **FsmHumanLoco** (`g1.ts`, human_loco scheme): [500] vision_loco / human_loco, [501] vision_loco_wbc / human_loco_29.
- **Cpy loco** (`g1.ts`, split scheme): [802] cpy_walk_run_29dofs (stance + walk/run nets), [812] cpy_stair_loco
  (+ run-net hand-over), [801] cpy_run_29dofs, [800] walk_29dofs ×3.
- **Legacy 2024 loco** (`g1_legacy.ts`, 100 Hz, encoder + actor): [200] hybrid_run, [201] blind_terrain,
  [202] plane_encoder, [203] waist_control, [210] shot.
- **VQ-latent decoders** (`g1_vq.ts`): [503] human_mimic dance1_s2 / lixiaolong / classic_movie (play the clips
  in turn, then stand), [706] one_key_break squat → stand, [504] traj_loco walker.
- **BeyondMimic get-up** (`g1_getup.ts`): [1001] wjc_getup.
- [813] cpy_walk_jump, [900] zjx_walk_jump (`g1_jump.ts`; hand over to 802).
- [810] cpy_dance, [811] cpy_fight (hand over to 802); [301] mimic_test (was a broken ONNX conversion; stands now, motion not verified).
- **More VQ packs:** [503] human_mimic/fightA1 (EDU); [503] human_mimic/air_dance1, air_lixiaolong, air_classic_movie (Air,
  hand over to 801); [706] one_key_break/stand2squat; [550] human_mimic_global/<library> ×9 — 202605_dance,
  202605_dance_xueshan, 202603_official_list, 20260528_interactions, 0107_simple, 29dof_20260608_interactions,
  29dof_20260608_teach_files (EDU), 23dof_20260608_interactions, 23dof_20260608_teach_files (Air); each plays its
  library's motions then hands over to 802.
- [1001] wjc_getup face-up and face-down packs (hand over to 802).
- **Remote speed** (`g1.speed` + `control_ui.actions` group "Speed", `G1LocoDriver.remote()`): [802] / [801]
  R2 + ↑ / ↓ / → / ← and [500] / [501] L1 / L2 as on the robot (panel buttons or the pad; LB / LT alone = L1 / L2,
  a single press stands for the robot's double press). The level sets the stick's full scale (the status
  `velRange`), 802 / 801 use the firmware backwards rule, 500 / 501 also switch the gait (1.0 Hz / 0.65 ↔ 1.2 Hz / 0.5).
  Browser (2026-09-25): 802 full stick 1.0 → 0.90 m/s avg over 8 s, R2+↑ 2.0 → 1.69 m/s avg (with the 1 m/s² ramp),
  801 1.5 → 2.7 (1.73 m/s avg), 501 0.6 → 0.9 (0.46 → 0.69 m/s avg over 10 s with the 0.18 Hz low-pass); none fell.
- **[503] human_mimic/ota_dance_23dof_v1_32000_decoder** (Air, `g1_vq.ts` task mode with `vq.remote`): the Air 503
  FSM driven from the remote — stance until one of the five `motion_string_map` combos (R1 + ↑ ← →, R2 + ↑ ←), then
  the motion, the blend back and the hand-over to 801. The registry entry was a stray June copy of the decoder at
  `human_mimic/` (no ONNX, no config); it now points at `human_mimic/ota_dance_23dof_v1/` (byte-identical).
- **[505] punch_mode** (`g1_punch.ts`, obs_scheme `punch`): walks on the stick; the 24 remote combos (config
  `control_ui.trigger_keys`) are panel buttons, <kbd>G</kbd> / <kbd>Shift+G</kbd>, or the pad combo itself
  (LB/RB/LT/RT = L1/R1/L2/R2 + dpad / face / Select; it shadows the app combo on the same buttons).

[702] faceup_getup (face up / face down, with the sim pitch assist) and [703] squat2stand work in the app (driver
`g1_faceup.ts`).

### Converting firmware networks

`scripts/mnn_graph_to_onnx.py` is the shape-faithful converter: it runs the MNN graph in numpy with real shapes,
folds shape sub-graphs into constants, recovers compressed conv weights from MNN numerically, and checks the ONNX
against MNN on random inputs; `scripts/import_g1_ai_sport.py` converts with it. The earlier flattening converter
(removed) silently produced wrong models for mimic_test, cpy_walk_jump and the 802 walk net. Always re-check a
conversion with random inputs.
