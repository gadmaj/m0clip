# unitree-mujoco-web

Run Unitree RL control policies **entirely in the browser**. MuJoCo compiled to
WebAssembly runs the physics, onnxruntime-web runs the policies, and Three.js
renders the scene.

![Unitree MuJoCo web — R1 walking on the park terrain](docs/media/hero.png)

**Supported robots:** R1 (24 and 20 DOF), Go2, and G1 (29 and 23 DOF). Per-policy notes:
[G1](docs/G1_FIRMWARE_POLICIES.md) · [R1](docs/R1_FIRMWARE_POLICIES.md) · [Go2](docs/GO2_FIRMWARE_POLICIES.md).

## Gallery

Recorded in the browser app, flat terrain, hoist off, real time. The number is the FSM id the policy runs as on the robot.

### R1

<table>
<tr><td align="center" width="33%"><img src="docs/media/r1_walk.gif" alt="Walk · 811 amp_locomotion"><br><sub>Walk · 811 amp_locomotion</sub></td><td align="center" width="33%"><img src="docs/media/r1_flip.gif" alt="Somersault · 804 actor (Take 125)"><br><sub>Somersault · 804 actor (Take 125)</sub></td><td align="center" width="33%"><img src="docs/media/r1_kick.gif" alt="Side kicks · 805 fight mode"><br><sub>Side kicks · 805 fight mode</sub></td></tr>
<tr><td align="center" width="33%"><img src="docs/media/r1_dance.gif" alt="Dance · 608 jiequandao"><br><sub>Dance · 608 jiequandao</sub></td><td align="center" width="33%"><img src="docs/media/r1_getup.gif" alt="Lie down and rise · qishen1 floor routine"><br><sub>Lie down and rise · qishen1 floor routine</sub></td><td align="center" width="33%"><img src="docs/media/r1_dance2.gif" alt="Dance · 603 dance1 segment 3"><br><sub>Dance · 603 dance1 segment 3</sub></td></tr>
</table>

### Go2

<table>
<tr><td align="center" width="33%"><img src="docs/media/go2_walk.gif" alt="Walk · 1003 FreeWalk"><br><sub>Walk · 1003 FreeWalk</sub></td><td align="center" width="33%"><img src="docs/media/go2_backflip.gif" alt="Back flip · 2013"><br><sub>Back flip · 2013</sub></td><td align="center" width="33%"><img src="docs/media/go2_leftflip.gif" alt="Left flip · 2014"><br><sub>Left flip · 2014</sub></td></tr>
<tr><td align="center" width="33%"><img src="docs/media/go2_tripleflip.gif" alt="Triple flip · ContinuousFlipX3"><br><sub>Triple flip · ContinuousFlipX3</sub></td><td align="center" width="33%"><img src="docs/media/go2_handstand.gif" alt="Hand stand · 2011"><br><sub>Hand stand · 2011</sub></td><td align="center" width="33%"><img src="docs/media/go2_backstand.gif" alt="Walk on hind legs · 2017 back stand"><br><sub>Walk on hind legs · 2017 back stand</sub></td></tr>
</table>

### G1

<table>
<tr><td align="center" width="33%"><img src="docs/media/g1_run.gif" alt="Run · 802 CpyWalkRun (high speed)"><br><sub>Run · 802 CpyWalkRun (high speed)</sub></td><td align="center" width="33%"><img src="docs/media/g1_kick.gif" alt="Kicks · 505 punch mode"><br><sub>Kicks · 505 punch mode</sub></td><td align="center" width="33%"><img src="docs/media/g1_leap.gif" alt="Walk-jump leap · 813"><br><sub>Walk-jump leap · 813</sub></td></tr>
<tr><td align="center" width="33%"><img src="docs/media/g1_dance.gif" alt="Bruce Lee take · 503 human mimic"><br><sub>Bruce Lee take · 503 human mimic</sub></td><td align="center" width="33%"><img src="docs/media/g1_getup.gif" alt="Get up from the floor · 1001"><br><sub>Get up from the floor · 1001</sub></td><td align="center" width="33%"><img src="docs/media/g1_dance2.gif" alt="Dance · 503 human mimic"><br><sub>Dance · 503 human mimic</sub></td></tr>
</table>

## Quick start

```bash
npm install     # also copies the mujoco wasm runtime into public/
npm run dev     # open the printed URL (Chrome recommended)
```

The robot models are included in the repo. The policies are not, so download
them separately:

1. Get the policy packs from <https://disk.yandex.com/d/TDS0JYh1GSjXow>
   (`g1-all.zip`, `r1-all.zip`, `go2-all.zip`, or individual packs).
2. In the app, open **Packs** (panel header) → **Import .zip…** and pick the files.

Imported policies are stored in your browser (IndexedDB) and survive reloads.
Pack format: [policy-packs/README.md](policy-packs/README.md).

## Features

- **Safety FSM** — ZeroTorque / Damping / Lock / Stance / Policy, like the on-robot controller.
- **Live policy switching** without reloading the page.
- **Gamepad and keyboard teleop**, including the robot remote's button combos.
- **Terrains** — flat, rough, slope, stairs, park.
- **Policy inspector** — live observations and action → joint targets.
- **Reference-clip playback** — preview a retargeted mocap CSV kinematically.
- **Record → timeline → export** — record the robot's motion and your inputs, scrub the take on a
  timeline, then render video (MP4 / MOV / WebM / PNG sequence) through a camera with a real lens,
  or export a Blender scene (glTF) or motion CSV. See [Recording and export](#recording-and-export).
- **Screenshot** — PNG of the viewport.

## Controls

| Input | Action |
|---|---|
| `0`–`4` | FSM state (ZeroTorque, Damping, Lock, Stance, Policy) |
| `[` / `]` | previous / next policy |
| `W A S D` / `Q E` | move: vx / yaw / vy (hold Shift for full speed) |
| `R` / `C` / `Space` | reset pose / recenter / stop |
| `V` | start / stop recording a take |
| `H` | hoist on / off |
| `G` / `Shift+G` | next / previous move |
| left stick, right stick | vx+vy, yaw |
| LT+dpad-up, LT+B, LT+Y, LT+X | Stance, Damping, ZeroTorque, Lock |
| RT+A, RT+B, RT+dpad ◀▶ | Policy, reset, switch policy |
| LB / RB / LT / RT + buttons | the active policy's remote combos |

## Game maps as terrain

Source-engine maps from the [noclip.website](https://noclip.website) catalogue can be converted
into terrains with real collision. Neo Tokyo (all 24 maps) is wired up:

```bash
python3 scripts/import_source_bsp.py --game neotokyo            # every map (~300 MB of BSPs, cached)
python3 scripts/import_source_bsp.py --game neotokyo --maps nt_rise_ctg nt_dawn_ctg
python3 scripts/import_source_bsp.py --bsp some_map.bsp --name "Some map"   # any Source BSP
```

The maps then appear in the **Terrain** list, grouped by game. Each one becomes
`public/assets/maps/<id>/` (`map.xml`, a few `vis_*.stl`, `manifest.json`), listed in
`public/assets/maps/index.json`. These are third-party game assets, so they stay out of git
(`public/assets/*` is ignored); the BSP downloads are cached in `assets/bsp-cache/`.

- **Collision:** the world model's player-solid brushes (solid, window, grate, player clip),
  found by walking the BSP tree, so triggers and brush entities never become invisible walls.
  Axis-aligned brushes become box geoms and the rest convex meshes. Displacement terrain becomes
  one heightfield per displacement, with convex prisms for the few on non-rectangular bases.
- **Visuals:** the world's drawn faces and displacements, coloured by each texture's average
  colour from the BSP (not the textures themselves).
- **Placement:** 1 Source unit = 1 inch. The map is centred on a team spawn that has a floor
  under it and headroom above, with that floor at z = 0, facing +x. The default ground plane is
  removed while a map is loaded.

Checked across all 24 Neo Tokyo maps: each compiles in under 0.3 s natively (about 25 s in a
software-rendered browser), the robot lands on the floor at spawn, and under 1% of sampled
visible surfaces lack collision directly beneath them (Isolation is the worst at 9%).

Not converted yet: static props (cars, crates and other placed models have their own model and
physics formats), the skybox, and textures. Other noclip games use their own formats; Source
games (Half-Life 2, Portal, TF2, …) can go through `--bsp`, though BSPs with LZMA-compressed
lumps (newer Source branches) are not supported yet.

## Recording and export

**Record.** Press **Record** (or `V`) and drive the robot as usual: keyboard, gamepad, panel moves,
FSM states, policy switches, the hoist, a reference clip. Every frame the simulation produces is
kept: each part's world pose, the full `qpos`, the commanded velocity, and the viewport camera. The
time base is simulated time, so a take recorded while the sim ran slower than real time still plays
back at true speed. Discrete inputs (state, policy, move, reset, hoist, clip) are stamped at the frame
you saw when you made them. Press `V` again to stop. A robot or terrain change ends the take there.

**Timeline.** When recording stops, the sim pauses and a timeline opens under the viewport. It is
laid out like Emote Studio's (`teaching-creator.html`): a transport row, then lanes for a ruler,
your inputs as diamonds, the commanded vx / vy / wz, and joint curves (most active joints, a limb
group, or the base position).

| | |
|---|---|
| `Space` | play / pause (loops the range) |
| `←` `→`, `Shift+←` `→` | step one frame, one second |
| `↑` `↓` | previous / next input |
| `Home` / `End` | range start / end |
| `I` / `O` / `X` | set range in / out at the playhead, clear the range |
| `L`, `F` | loop on / off, fit the view |
| wheel, `Shift`+wheel, drag | zoom at the cursor, pan, scrub (drag the In / Out flags on the ruler) |
| `Esc` | close the timeline, back to the live sim |

The viewport camera can be **Free** (orbit, following the robot), **Recorded** (the camera as it
moved while you recorded), or **Shot** (through the export camera, letterboxed to the output frame).
The inspector column lists the take's inputs; click one to jump to it.

**Export video.** Frames are rendered offline, one by one, at the exact take time of each output
frame, then encoded with WebCodecs ([mediabunny](https://mediabunny.dev) muxes). The file is smooth
at any resolution or frame rate however fast the machine is.

- Camera: **Viewport** (the recorded camera), **Follow** (a fixed offset that tracks the robot),
  **Orbit** (follow while circling), **Fixed** (locked off where the robot stood at the range start).
  Set distance, azimuth, elevation, look-at height and path smoothing, or use a preset (Front, ¾,
  Side, Back, High). While the export panel is open the viewport looks through the shot, so you
  can also frame it by orbiting the viewport with the mouse.
- Lens: focal length in mm on a sensor (full frame 36 mm, Super 35, APS-C, Micro Four Thirds,
  1-inch, phone). The sensor covers the frame's longer side, like Blender's *Auto* sensor fit, so
  35 mm here frames like 35 mm in Blender.
- Output: 720p to 4K UHD / DCI 4K, vertical, square or custom size; 24 / 25 / 30 / 50 / 60 fps;
  0.25×–2× speed; the timeline's In / Out range.
- Format: **MP4** (H.264, HEVC, AV1, VP9), **MOV** (H.264, HEVC), **WebM** (VP9, AV1, VP8),
  or a **PNG sequence** (.zip). Codecs the browser cannot encode are greyed out. PNG and WebM VP9
  can have a transparent background; the ground plane can be hidden.

**Blender & data.**

- **Blender scene (.glb).** Every robot part and terrain piece is its own named object with its
  materials, keyed in world space at the rate you pick. The shot camera comes along, animated, with
  its field of view (focal length and sensor are in its custom properties). Poses are converted to
  glTF's Y-up, and Blender's importer converts them back. In Blender: *File › Import › glTF 2.0*,
  then play. Keys are in seconds, so the motion runs at true speed at any scene frame rate.
- **Motion CSV.** One row per frame: base position (3), base quaternion `x y z w` (4), joint angles
  in radians (the robot's joint order, listed in the panel). No header. It loads back here as a
  **Reference clip**, at the same fps.
- **Take file (.take.zip).** The whole recording, to reopen on the timeline later with
  **Recording › Open…**. The same robot model and terrain must be loaded.

Takes live in memory, up to 20 minutes each (about 100 MB for the R1).

## Architecture

The whole simulation (MuJoCo, onnxruntime, drivers, FSM) runs in a **Web
Worker**, because MuJoCo's pthread-enabled wasm deadlocks on the main thread.
The main thread only renders and handles input. The two sides talk through
`src/sim/protocol.ts`.

```
src/
  worker/      sim worker: engine, FSM, drivers, control loop
  core/        math, onnx wrappers, per-robot policy drivers
  packs/       policy-pack parsing and IndexedDB store
  sim/         mujoco engine, FSM, terrain presets, protocol
  render/      Three.js scene
  record/      takes, the timeline, shot cameras, video / glTF / CSV export
  input/       gamepad → commands
  robots/      per-robot specs
  ui/          control panel
public/assets/models/<robot>/   MJCF + meshes + manifest.json
```

## Notes

- A production build must be served with **COOP/COEP headers** (the mujoco wasm
  uses SharedArrayBuffer): `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. The dev and preview servers already set them.
- Browsers: current Chrome, Edge and Firefox. Safari 16.4+ is untested.
