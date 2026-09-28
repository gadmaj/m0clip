# Go2 firmware policies (OTA 1.1.15 EDU) in the browser sim

Every policy the Go2 1.1.15 firmware can run, driven the way the firmware drives it, checked against the emulated-MCU
bench (bench = ground truth). Driver `src/core/drivers/go2_fw.ts`, importer `scripts/import_go2_mcf.py`, registry
`registry/go2` (18 runnable packs + 11 obsolete entries), bundle `policy-packs/go2-all.zip`. Bench method, tools and
captures: `orange_pi_workbench/docs/HANDOFF_GO2_POLICIES.md`.

```
python3 scripts/import_go2_mcf.py --src <1.1.11+ …/unitree/module/mcf> --ai-sport <1.1.4 …/unitree/module/ai_sport>
node scripts/build-packs.mjs --robot go2                   # -> policy-packs/go2-all.zip (18 packs, 75 MB)
```
The 29 eval-derived Go2 packs (and their drivers) are gone; this suite replaces them.

## Where the policies live
OTA 1.1.15 itself only ships network_manager / webrtc_bridge / programming_actuator. Locomotion on a 1.1.15 robot is
**mcf 1.0.0.75** (from OTA 1.1.11; motion_switcher has the single mode "mcf"), AI module
`/unitree/module/mcf/module/ai/libgo2_ai_module.so` + `module/ai/config/*.json|*.mnn`. The pre-1.1.6 `ai_sport`
(`sport_runner`, with the continuous flips) is still on disk but disabled.

## Policy table
| FSM | web pack | net(s) | how the firmware enters it | notes |
|---|---|---|---|---|
| 1003 FreeWalk | `free_walk/1003_free_walk` | Aug13_20-48-41_v1, Apr25_12-51-28_32000 (only-rotate), Mar25_16-40-35_53500 (low speed) | Start, Left+Start; after stand-up; every trick exit | one shared 6×45 history; rotate net when \|vx\|<0.05 and vy<0.05 (signed, firmware quirk) |
| 1003 FreeWalk, payload | `free_walk/1003_free_walk_payload_{1_5kg,5_20kg}` | Mar23_06-45-23_60000 / Mar23_06-49-36_51000 | app payload mass (config sport_payload_json) 1–5 / 5–20 kg | up_vx 1.0; falls → Damping |
| 2010 ClassicWalk | `classic_walk/2010_classic_walk` | b_v2 (p_obs 5×42 + cmd 6) | Right+Start | gait clock, stands still at zero cmd; starts at LOW speed |
| 2008 FreeBound | `free_bound/2008_free_bound` | Oct10_14-47-34_ + zero-walk Aug13 | double X | zero net when filtered stick < 0.05 |
| 2009 FreeJump | `free_jump/2009_free_jump` | Oct10_15-54-09_ + Aug13 | double Y | same scheme, other filters/clamps |
| 2007 FreeAvoid | `free_avoid/2007_free_avoid` | walker Aug13, planners Sep27_16-53-41_2 / Sep27_17-32-57_1 | double A | 41×21 5 cm height-map grid → planner velocity |
| 2016 CrossStep | `cross_step/2016_cross_step` | Dec12_11-38-32_ | double B | wz ±1 |
| 2017 BackStand (+2018 end) | `back_stand/2017_back_stand` | Dec02_19-59-54_2, Dec23_19-52-15_ | double R2 (again = off) | end net 0.5 s → FreeWalk |
| 2011 HandStand | `hand_stand/2011_hand_stand` | stand_d48v1 (cmd 7) | double R1 (again = off) | 0.5 s on four legs, then cmd[6]=−1 |
| 2021 RageMode | `rage_mode/2021_rage_mode` | Sep18_13-11-47_8200 | **API 2059 only** | vx 2.5×stick, asymmetric stick filters, no Move API |
| 2019 ForceFollow | `force_follow/2019_force_follow` | Apr09_14-12-16_ (walker) + Apr10_20-42-43_ (pull estimator) | **API 2056 only** | leash pull in the web view; 5×45 oldest-first |
| 2005 AutoRecovery | `auto_recovery/2005_auto_recovery` | re_v2 | automatic after a fall | starts on the back; → FreeWalk when upright |
| 2004 Recovery / 1002 StandUp / 2006 StandDown / 1001 Damping | (in every pack) | scripted | L2+X / L2+A / L2+A / L2+B | firmware tables |
| 2012 ForwardFlip | `flips/2012_forward_flip` | flip_v0 | **API 1030 only** | ready 0.6 s, 16 NN ticks, scripted flight |
| 2013 BackFlip | `flips/2013_back_flip` | back_flip_v0 | **API 2043 only** | 49 NN ticks |
| 2014 LeftFlip | `flips/2014_left_flip` | left_flip_v0 | **API 2041 only** | 34 NN ticks |
| (ai_sport 12) ContinuousFlip | `flips/continuous_flip` | continuous_flip_v0 | **none** (dead code in 1.1.1–1.1.4) | see below |
| (ai_sport 14) ContinuousFlipX3 | `flips/continuous_flip_x3` | continuous_flip_x_v0 | **none** | see below |

Obsolete (in `registry/go2/index.json`, `runnable: false`): double_walk, fly_bound (no FSM class), right_flip /
side_flip (config + net, no FSM; API 2042 is unhandled), flip_export_cfg.json (never loaded), unreferenced
checkpoints Mar23_06-31-55, Dec02_…_5, Dec12_…_3, and auto_recovery's o_v2 / z_v1 / b_v2 names.
Compared with the old 29 eval packs: the old free_walk alternatives, back/left/right/side flip variants were the same
nets with guessed drivers; new here are the payload walkers, the firmware-accurate multi-net FreeWalk / Bound / Jump /
Avoid / BackStand, the scripted stand/recovery FSMs in every pack, and the X3 continuous flip.

## Remote bindings (mcf JEvent, what the robot's RF remote does)
| remote | event | from |
|---|---|---|
| Start, Left+Start | FreeWalk | tricks, stand-up |
| Right+Start | ClassicWalk | FreeWalk, Rage |
| L2+A | stand up ↔ stand down | Damping/StandDown → StandUp; StandUp → StandDown; walking (sticks < 0.5) → StandUp |
| L2+B | Damping | any |
| L2+X | Recovery | Damping / StandDown / fallen |
| L1 ×2 / L2 ×2 | speed level high / low | walking FSMs |
| A ×2 / X ×2 / Y ×2 / B ×2 | FreeAvoid / FreeBound / FreeJump / CrossStep | **only if not Air and app config greeting_gear ∈ (−1, 1]** |
| R1 ×2 / R2 ×2 | HandStand / BackStand toggle | same gate |
| — | flips, rage, force follow | sport API only (1030, 2043, 2041, 2059, 2056) |

In the web every policy is its own entry in the policy list — pick it there. A pack's buttons only control the running
policy: speed levels (L1 / L2 ×2), leaving hand stand / back stand, and for the flips "Flip again" / Repeat. The same
controls work from the pad (LB/RB/LT/RT = L1/R1/L2/R2; single keys need the double press within 0.5 s, like the robot).

## Driving details (all decoded from the AI module, confirmed by bench MNN captures)
- 50 Hz; q/dq in policy order FL, FR, RL, RR (firmware maps SDK FR, FL, RR, RL with [3,4,5,0,1,2,9,10,11,6,7,8]);
  obs = clip((raw − ob_mean)·ob_scale, ±10); target = clip(act, ±clip_act)·act_scale + act_mean; plain PD with the
  config kp/kd — the configs' torque / velocity limits are never read.
- Sticks: dead zone 0.1, f = 0.94 f + 0.06 s per tick (Bound 0.8/0.2 and yaw 0.9/0.1; Rage asymmetric), × speed-level
  scale (level 1 = up_* on every entry, except ClassicWalk which starts at level 0). Verified in the captured obs:
  command term median error 0.0000 (fw_high).
- Timing: web plant 1 kHz (`sim_dt` 0.001, the bench's) + `control.cmd_delay` 0.010 s (the bench's effective
  command latency; new worker option: the previous target/gains stay on the motors for the first substeps). Without
  it the flips diverge from the bench (forward flip 358° vs 495°); loco is insensitive.

## Bench vs web (same stimulus replayed; body-frame m/s, rad/s; bench = 1.1.15 EDU on the MuJoCo plant)
| policy | stimulus | bench | web |
|---|---|---|---|
| FreeWalk high | ly 0.5 / 1.0 / −0.5 | 0.54 / 1.19 / −0.52 | 0.55 / 1.22 / −0.50 |
|  | lx 0.5, rx 0.5 | vy −0.35, wz −1.00 | vy −0.35, wz −1.01 |
| FreeWalk low (stair net) | ly 0.5 / 1.0, rx 0.5 | 0.33 / 0.71, −0.76 | 0.34 / 0.73, −0.76 |
| ClassicWalk | ly 0.5 / 1.0, lx, rx | 0.18 / 0.41, −0.13, −0.52 | 0.18 / 0.42, −0.12, −0.52 |
| FreeBound | ly 0.5 / 1.0, rx | 0.66 / 1.27, −1.27 | 0.67 / 1.28, −1.27 |
| FreeJump | ly 0.5 / 1.0, rx | 0.68 / 1.34, −1.26 | 0.70 / 1.38, −1.26 |
| FreeAvoid | ly 0.5 / 1.0, rx | 0.46 / 0.87, −0.65 | 0.47 / 0.90, −0.67 |
| CrossStep | ly 0.5 / 1.0, rx | 0.54 / 1.03, −0.71 | 0.55 / 1.02, −0.71 |
| Rage | ly 0.5 / 1.0, rx | 1.08 / 2.22, −2.19 | 1.08 / 2.16, −2.19 |
| BackStand | ly 0.5, rx 0.5 (tilt 85°) | 0.24, −0.44 | 0.26, −0.57 |
| HandStand | ly 0.5, rx 0.5 (tilt 75–77°) | 0.24, −0.27 | 0.28, −0.16 (yaw in hand stand is weak in both) |
| ForwardFlip (API 1030) | net pitch | +495°, lands twisted → AutoRecovery → FreeWalk | +490…+519°, same hand-over (roll chaotic) |
| BackFlip (API 2043) | net pitch | −360°, lands | −360°, lands |
| LeftFlip (API 2041) | net roll | −361°, lands | −361°, lands |
| payload 1–5 / 5–20 kg | ly 1.0 | 0.89 / 0.90 | 0.91 / 0.92 |
| AutoRecovery (after the forward flip) | time to FreeWalk | 0.94 s | 1.4 s |
| Recovery (L2+X from damping) | time to FreeWalk | 1.44 s | 1.4 s |
| FSM timing | back stand end, flips → FreeWalk, stand down → damping | 0.5 s / immediate / 1.9 s | same |
Base height: the bench reports the IMU site (+0.042 m); after that correction heights agree within ~5 mm.

## Continuous / triple flip
The "triple flip" exists only in the old ai_sport `sport_runner` (Go2 1.1.1 – 1.1.4): `ContinuousFlip` (StateMachine
12, continuous_flip_v0, 52 NN ticks) and `ContinuousFlipX3` (14, continuous_flip_x_v0, 81 NN ticks) are fully
implemented, but **no sport API, remote combo or other code path ever enters states 12 / 14** in any of the three
builds (1.0.3.4, 1.0.4.27, 1.0.4.46); mcf (1.1.6+) dropped them. So on real robots the remote never triggered it.
On the 1.1.4 bench it was forced with gdb: ContinuousFlip ≈ 1.5 forward turns then a crash on the back, X3 ≈ one
forward flip + landing (bench latency). In the web the two packs run on an ideal plant (no latency), where the nets
do what they were trained for: ContinuousFlip = 2 chained forward flips (+722°), X3 = 3 (+1081°). Each pack starts
with the flip; "Run again" re-runs it, "Repeat ON" chains it every time the dog is back up in FreeWalk. The mcf flip
packs (2012–2014) have the same Repeat toggle (chained API requests).

## Open issues
- ForwardFlip lands twisted on the bench as in the web (bench +202° roll); both recover via AutoRecovery. The flip
  outcome is latency-chaotic, the web matches the bench only with `cmd_delay` 0.010.
- BackStand / HandStand yaw rate: web −0.57 / −0.16 vs bench −0.44 / −0.27 rad/s at rx 0.5 (speeds match).
- FreeAvoid is only checked on flat ground (the bench has no lidar → the firmware never gets a height map; the web
  samples an empty grid there too). Obstacle behaviour is the eval-era height-map sampler (`src/core/lidar.ts`: 41×21 @ 5 cm, 0.15–2 m, 1-cell dilation).
- ForceFollow on the bench was entered and left via the API only (no one pulls the bench robot); the web leash path
  is untested against hardware.
