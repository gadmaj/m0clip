# R1 policies — one bundle, firmware-faithful (`r1-all.zip`)

Every policy of the Unitree R1 `ai_sport` module (`r1_controller`), driven the way the firmware drives it, in one
bundle. Driver: `src/core/drivers/r1_fw.ts` (config block `r1:` with `firmware: true`); registry `registry/r1/`
(generated), weights / CSVs in `assets/policies/r1/` (gitignored, from your own module tree).

    python3 scripts/import_r1_ai_sport.py --src <ai_sport 1.0.2.154>/ --src223 <ai_sport 1.0.2.223>/
    node scripts/build-packs.mjs --robot r1          # -> policy-packs/r1-all.zip (87 packs, ~205 MB)

`--src` is the OTA 1.4.2.8 module (`.../module/ai_sport`, the dir holding `config/` and `net/`); `--src223` (optional)
the one of package 1.0.0.4. FMX-wrapped configs are decrypted on the fly with `scripts/fmx.py`. This bundle replaces
the earlier eval-derived `r1-all.zip` (97 policies).

## Sources

| build | where | use |
|---|---|---|
| 1.0.2.154 (OTA 1.4.2.8, shipping) | `unitree_ota/R1/1.4.2/…` | configs + nets of every pack; Virbox-protected, decoded from a process-memory dump; the bench runs this build |
| 1.0.2.181 (Apr 2026) | R1 eMMC dump, `/unitree/ota/backup/module/ai_sport/1.0.2.154/` (sic) | **unprotected, DWARF** — the build right before 154 (same nets/configs minus 832/833); reference for the cores the bench cannot reach |
| 1.0.2.223 (Mar 2026, package 1.0.0.4) | `unitree_ota/R1/temp/package_1.0.0.4_R1_Edu_Pro_*` | unprotected, DWARF; registers 804 MimicActor / 805 MimicPunch; its own nets (amp_locomotion 10k/34.5k, cwdata 830 nets, armsdk 23000 …) run under its own (simpler) cores |

**R1_DUMP** (`/mnt/truenas-work/backup/Unitree/R1_DUMP`, per-partition images of a real R1; rootfs p7 read with
debugfs): OTA 1.4.2 with ai_sport 1.0.2.154 live, the previous 1.0.2.181 in the OTA backup, an "mcf" test build in
`/home/unitree/2testartifacts` (`fsm_r1_air_ck_walk.yaml` — the pose/gains the `r1_20dofs_loco*` nets need). **No
new motion assets**: every net and clip equals 154 or 223 by sha256. The app/LLM agent
(`chat_go/g1/action_thread_r1.py`) names FSM 804 "cheering" (actor), 805 "box" (punch), 806 simple motion, and the
SET_PUNCH_API 7108 move ids (0 straight punch … 201 get down) — used for the fight-mode labels.

## Per policy

Status = web behaviour (browser regression, `r1_webrun.py`); "bench" = compared against the 1.0.2.154 bench
(firmware driving the emulated MuJoCo plant) with the same stimulus, bench / web.

### Walk / stand (EDU 24-DOF)

| pack | FSM | reach | status |
|---|---|---|---|
| amp_locomotion/amp_locomotion | 811 | Start / Stance R2+A | ✅ bench match: 0.35/0.35 m/s (ly .5), 0.71/0.73 (ly 1), turn −1.34/−1.40 rad/s, R2+Up high profile 1.70/1.75 m/s (1.87 before the ankle-damping fix); run/turn nets switch as on the bench; remote → dances / Tangxia |
| amp_locomotion/811_main_policy_{17k,36k,40k} | 811 | commented `model:` lines | ✅ walk (0.29–0.36 m/s at ly .5). The eval packs of 17k/40k fell: they ran with the wrong obs |
| amp_locomotion/223_policy_{10k,34.5k} | (815 in 223) | 1.0.2.223 | ✅ walk; 223 core: cmd = sticks × (2.5, 1.0, 1.57), no profiles, one net |
| amp_motion/amp_motion | 812 | SetFsmId | ✅ bench match (0.42/0.43 fwd, −0.33/−0.35 back, strafe −0.22/−0.23) |
| amp_motion_22dof/amp_motion_22dof | 815 | SetFsmId | ✅ bench match (stance net → walk net at the first step; 0.47/0.48 fwd, turn −1.16/−1.23) |
| locomotion_24dof/813_straight_knee, 814_walk | 813 / 814 | registered, no transition | ✅ walk (0.68 / 0.64 m/s); Locomotion24DofCore: AmpMotion command path, frame [gyro, rep6d, q, dq, scaled act]; R1/R2 + arrows step the maxima |
| arm_sdk_locomotion/816_arm_sdk | 816 | SetFsmId (+ rt/arm_sdk app) | ✅ balances; **the command is forced to 0 in 154** (bench `t816stick`: cmd slot 0 with the stick held, = the 181 code); arms from an emulated arm-SDK client at the default pose (the firmware returns to 811 after 1 s without one) |
| arm_sdk_locomotion/223_816_policy_32.5k | 816 | 1.0.2.223 | ✅ 223 core (decoded: cmd = sticks × 0.5/0.4/0.8, no ramp) → web 0.02 m/s at ly .5 (cmd 0.25), 0.49 at ly 1 (0.5), −0.23 back: the net has a command dead zone (like the 223 830 `_015` nets, bench-confirmed there); not bench-checkable (154 forces 816's command to 0) |
| locomotion_gait/locomotion_gait, locomotion_armsdk_gait/… | 832 / 833 | Stance R2+X / R2+Y | ✅ bench match EDU (832 0.17/0.17 at ly .6, turn −0.35/−0.36; 833 0.14/0.14, −0.25/−0.27) and **Air body** (832 0.17/0.17, −0.36/−0.35; 833 0.14/0.14, −0.27/−0.26, Start random arms). Air + EDU packs now run on the body currently loaded (Air after an Air pack, as on an Air robot) |

### Walk (Air 20-DOF)

| pack | FSM | status |
|---|---|---|
| locomotion_20dofs/locomotion_20dofs | 830 | ✅ bench match (Air bench 2026-09-26: 0.52/0.48 at ly .5, −0.67/−0.67 back, turn −1.31/−1.34, strafe −0.48/−0.46; R2+Up ly 1: 1.32/1.26 over the 5 s window, steady 1.76/1.73 m/s — was 2.10 before the ankle fix, see *Plant*); dances_air + Tangxia from the remote |
| locomotion_20dofs/830_* (16 nets) | 830 | **Air bench, each net swapped in for the configured one** (same stimulus: ly .5 / 1.0, back, turn, R2+Up ly 1): 13 nets ✅ match within ~0.05 m/s (e.g. 29000 0.49/0.48, 1.49/1.48 high; amp3_hardrough 0.42/0.41, 0.77/0.73; r1air_locomotion_rough 0.36/0.36, 1.03/1.01; turn −1.2…−1.3 both). `amp6_26to20_r1air_locomotion_new` ⚠️ falls on the bench at the Stance → 830 hand-over (twice) while the web (starting at the 830 pose) walks it (0.42–0.48, 1.11 high). The two `*walkrun_indelay` nets use the **plain joint order** (the yaml's commented identity `action_joint_idx` / `action_dof_idx`): run on the bench with that config (re-encrypted FMX) they walk (0.51/0.55, 0.42/0.46 at ly .5) and **fall on both** at R2+Up full stick (bench and web within the same second for 22500) — faithful |
| locomotion_20dofs/223_* (11 nets) | 830 (223) | 223 config (vx 1.1 / 2.7, coupling 0.7, its slew defaults; the 223 core = the 181/154 core minus the walk/run net split, same obs). **Air bench with the net + the 223 yaml values** (154 binary, so its own slew constants): `25000amp6_cwdata_011` 0.51/0.47, 0.99/0.96, 1.41/1.25 high; `61000amp5` 0.50/0.52, 0.93/0.95, 1.67/1.50; ck_walk `r1_20dofs_loco{,_reset,_stair}` with the mcf pose/gains 0.47/0.50, 1.03/1.03, 1.36/1.28 (reset/stair alike). The `*_015` / `amp3_cwdata_025` / `walkrun10000` nets **barely walk forward on the bench too** (walkrun10000 0.01/0.01 at ly .5, 0.00/−0.00 at ly 1; amp2_olddata 0.01/0.02, 0.46/−0.01; amp3 0.01/0.01, 0.46/0.43; 25500 0.14/0.21, 0.35/0.46) but walk backwards (−0.46…−0.71 both) — a property of these nets (command dead zone), not a web mismatch; `22500amp6_cwdata_015` falls on both (bench at entry, web after ~10 s) |
| locomotion_armsdk/831_alljoint | 831 | ✅ balances (154/181 core: command 0, arms from the net; Start = random-arm demo). Air bench SetFsmId 831: the alljoint net runs ~3 s after entry, then the firmware drops back to 830 (no rt/arm_sdk); the web keeps it (emulated arm client) |
| locomotion_armsdk/831_legs_{new,old}, 223_r1air_armsdk_loco23000, 223_r1_armsdk_loco | 831 (223 core) | ✅ walk (0.45–0.63 m/s); legs-only nets (12 actions), arms at default / random demo; `r1_armsdk_loco` with the ck_walk pose. (The eval "armsdk_loco_new walks unreliably" came from running it under the all-joint config.) |

### Dances (DanceCore, obs 129 EDU / 109 Air)

All ✅: upright to the end, back to 811 / 830. **Air bench 2026-09-26** (after the restart, entered from 830 by the combo): 602 13.18/12.78 s, tilt 30.4/29.7°; 604 29.7/29.0 s; 607 8.2/8.0 s, tilt 42.3/39.6°; the commented Air entries enabled on the bench by re-encrypting `dances_air.yaml`: 601 (R1+Up) 18.2/17.8 s, tilt 34.7/34.4°; 603 (R1+Right) 21.3/20.8 s, 50.9/50.7°; 608 (R1+Down) 23.1/22.4 s, 70.4/70.4°; an added Air 605 weibosite entry (L1+A, policy_new_10k) 4.6/4.4 s, the flip (tilt 166/164°); alternative nets edu_fix_20k (602), edu_fix_15k (607, 608), policy_12k (605) — same durations, tilt 31.6/30.9, 40.7/39.3, 67.8/69.4, 166/161. Earlier bench (EDU 602/603/604/607/608, Air 602/604/607, entered from the loco
FSM by the remote combo): entry and hand-over times within 0.1–0.9 s (602: 3.65 → 17.05 bench vs 3.70 → 16.6 web),
same z / tilt profile (603 z-min 0.556/0.557, tilt 51.4°/51.0°; 608 tilt 72.7°/72.1°; Air 604 29.8/29.0 s). Packs:
every entry of dances.yaml / dances_air.yaml (602 603 604 607 608 / 602 604 607), the commented entries (601, Air
601/603/608, the 0602 re-trains with their 50 Hz clips), commented alternative nets (new_urdf_25k, edu_fix), the
1.0.2.223 entries 605 weibosite / 606 weibosite_CJJ (L1+A / L1+B from 811), unreferenced checkpoints (policy_37k,
hard_80k-110k, new_urdf_50k, niuniu 0602). The 154/181 **safety** is implemented (|up_z(robot torso) − up_z(ref
torso)| > 0.8 for 3 ticks → Damping).

**Floor routines** (nets + clips ship, no build wires them): `dances/gunfanqishen` (+ `-hard_80k-100k`) — a 185 s
floor routine: rolls, crawls, spins, several get-ups (the "roll over and rise"); `dances/qishen1` — sit down, lie
back, stand up (14 s). Run the DanceCore way they fail: its ±10 action clamp keeps them from pushing off the floor
(qishen1: 0/3 rises with the clamp, 2/2 without) and its up-z safety cuts them when the robot lags a fast rise. The
packs run them **as trained** (no clamp, no safety) — plausibly why Unitree never wired them. Result: ✅ qishen1
rises (z 0.73); ✅ gunfanqishen-hard_80k-100k performs the whole 185 s routine (every get-up, ends standing, back to
811); ⚠️ gunfanqishen (policy_80k) tracks to ~155 s, then lies flat in the last floor section and misses the final
rise.

### Get-ups

| pack | FSM | status |
|---|---|---|
| tangxia/tangxia_air → qishen/qishen_air | 702 → 701 | ✅ bench match (re-confirmed after the restart): Air 830 L2+X long → Tangxia 5.64/5.66 s, lies down (z 0.041/0.055), L2+X → Qishen 21.22/21.24, back in 830 24.81/24.72 (z mean 0.61/0.61 while rising) |
| qishen/qishen_edu, tangxia/tangxia_edu | 701 / 702 | **Kept, labelled "aborts on EDU, as on the robot"** (pack note + notice). The firmware offers both on every edition — `white_list.yaml` lists Qishen/Tangxia, 811/815/832's `state_change_map` has Tangxia (L2+X long), Stance has Qishen (L2+X long), and QishenCore/TangxiaCore have no entryGuard or edition check (DWARF 181) — but the nets are Air-trained: EDU bench Qishen face-down 2.6 s → Damping, Tangxia 1.2 s → falls. Web: Tangxia lies down, Qishen (from the web's face-down seat pose, not the bench's Stance-pushed start) now rises after the ankle fix — see open issues. Working EDU get-down / get-up: the fight pack (L2+Down / L2+Up), `dances/qishen1`, gunfanqishen |

### Fight, actor, hello (states the shipping firmware does not register)

| pack | FSM | status |
|---|---|---|
| mimic_punch/805_fight | 805 (1.0.2.223) | ✅ one remote-driven pack (like G1 505): boxing-guard walk on the twist net (0.38 m/s at ly .5), 21 moves on the VQ net, grouped — hand strikes (R1+arrows/Select, R2+Select), kicks (R2+arrows), footwork/defence (arrows ×2, X), gestures (A/B/Y), get down front/back (L2+Down/Left), get up (L2+Up), Start = stop; chaining in the last 10 frames, fall detection → fall pose → Get up (regression: punch, kick, block, get down z 0.05, get up z 0.67) |
| mimic_actor/804_actor | 804 (1.0.2.223) | ✅ X / B / A = Take 111 / 125 (full **flips** — body inverted, tilt 180°, lands upright) / 142, then back to 811 |
| mimic_actor/804_actor-actor2_resume | 804 | ✅ earlier checkpoint; its graph lacks the in-graph L2 normalisation of the latent (the configured nets have ReduceL2→Div) → the pack normalises it |
| simple_motion/hello | — | ✅ left-arm wave (3.5 s). **No build implements SimpleMotion** (223 has only the enum 806): layout reconstructed from the net's first-layer weights + a MuJoCo sweep (5×78 frames oldest first [gyro·.25, grav, q−def, dq·.05, act] + the clip row; arm RMS 0.049 rad; every other layout falls) |

MimicCore (181 = 223; not bench-checkable): frame [gyro·0.2, gravity, q−def, dq·0.05, last act] clamped ±100, 10
frames oldest first; a playing clip feeds its 64-d VQ row per tick on net[1], idle = net[0] with the twist (sticks →
low-pass → TwistDecay → +5° trim → offset); act clamp ±10; arm limits; fall check (gravity z > −0.5) when idle or in a
rot_detect clip → policy ignored, 1 s blend to the fall pose until Get up. Details in `r1_fw.ts`.

### Excluded

`mimic_punch/2025-07-21_18-11-48_punch_resume_new_usd_0717` (ships, no build references it): same obs interface as
the configured move net (input sensitivity r 0.99) but its latent input belongs to another VQ encoder (cmd weights
r 0.30 vs the configured net; 0 % of the shipped clip rows keep it upright, raw or normalised) — its clips are not in
the firmware. Falls at the first frame.

## Dedup vs the old bundles

Eval `r1-all.zip` → this bundle: mimic_punch (26 checkpoint/clip packs, one net) → `805_fight`; mimic_actor (5) →
`804_actor` (+ actor2 variant); `mimic_punch/twist` → the idle net inside 805; `amp_motion_22dof/…68000_actor` → the
stance net inside 815; `qishen/facedown|faceup`, `tangxia` → the 701/702 Air + EDU packs; everything else 1:1 with FSM
ids. The firmware cores fixed the eval failures (811 alt nets, walkrun_indelay, simple_motion, actor2_resume).

## Plant: motor-space ankles, Air torque limits (2026-09-26)

The R1 ankles are parallel linkages driven by two motors each; basic_service converts the joint-space PD of
rt/lowcmd into motor commands (read from the live wire of the bench MCU emulator): motor target = q_m + Mᵀ·kp·(q_des −
q)/kp_m, so the **stiffness stays the joint kp**, but the motors' own gain is kp_m / kd_m = Σ_j kp_j / kd_j · M[j][m]²
(30 / 3 → ~14 / ~1.4), so the **damping is motor-space**: D = M⁻ᵀ·diag(kd_m)·M⁻¹ ≈ pitch 1.7·kd, roll 0.7·kd
(M = joint ← motor, L [−0.3663 0.3658; 0.5716 0.5710], R mirrored). Joint-space PD on the ankles made the web walk
10–20 % too fast at high speed (830 R2+Up steady 2.10 vs 1.76 m/s; 811 R2+Up 1.87 vs 1.70); one-step physics against
the bench halves the ankle-velocity error with the motor damping, and rollouts started from bench states stay at 1.77
m/s with it (2.1 without). Implemented as `RobotSpec.ankle_pairs` + `BaseDriver.pairPD` (all R1 specs). The Air model
now uses the Air URDF torque limits (hips/knees/shoulder pitch+roll 60, ankles 50, shoulder yaw/elbow 33 N·m, = the
bench plant; before: the EDU 88/139/25). All EDU captures still match after the change (811 0.35/0.35, 0.71/0.73; 812,
815, 832, 833, dances 603/608 unchanged within 0.03 m/s).

## Bench comparison method

`orange_pi_workbench/tools/ai_sport_probe/`: `r1_mkspec.py` turns a bench capture's stimulus (sticks, key masks with
their timing) into a web replay; `r1_webrun.py` sends it to the sim worker as one `{t:"script"}` message (applied on
SIM time, combos at the key edge, L2+X after the 2 s long press) and logs position / orientation / active policy;
`r1_compare.py` prints both per stimulus segment. The web starts on the ground, the bench drops from the gantry, so
the first ~2 s differ by design.

## Open issues

- `830_amp6_26to20_r1air_locomotion_new` falls on the Air bench at the Stance → 830 hand-over (2/2), walks in the web
  (which starts at the 830 default pose; the web has no Stance → 830 transient).
- EDU Qishen: the bench aborts (Stance-pushed start, face-down 2.6 s → Damping); the web, started from its face-down
  seat pose, now rises (it stayed down before the ankle fix). Faithful start conditions would need the bench's lying
  pose + Stance phase.
- 1.0.2.223 nets (`*_015`, `amp3_cwdata_025`, `walkrun10000`, `223_816_policy_32.5k`): barely forward at small
  commands — bench-confirmed for the 830 ones (a net property); `amp6_cwdata_015` walks somewhat faster on the bench
  (0.28 / 0.70 vs 0.01 / 0.40 at ly .5 / 1).
- 831 on the robot returns to 830 ~3 s after entry without an arm-SDK app; the web keeps it running (emulated client).
