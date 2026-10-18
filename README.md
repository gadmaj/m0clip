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

The hosted build automatically adds the R1 policy catalog on your first visit and
starts with **Walk and run**. Only the selected policy's weights download (about
6 MB for the starting policy), then stay in your browser for subsequent visits.
Removed packs stay removed after a reload. Policy
choices are grouped by activity, with readable names and descriptions followed
by the full original identifiers in parentheses. Every checkpoint stays available.
The policy picker searches friendly names, original identifiers, activity/robot-variant groups,
descriptions and robot state numbers where available. Use ↑/↓ and Enter to select;
Escape keeps the current policy. Searches remain open during automatic policy transitions.

Weights remain outside Git. For a local deployment, run
`node scripts/host-default-packs.mjs /path/to/r1-all.zip` to prepare the hosted
catalog and individual packs under `public/assets/packs/`.
You can also add G1, Go2, or other packs manually:

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
- **Screenshot** — PNG of the viewport, captured after map and robot visuals finish loading.

## Controls

| Input | Action |
|---|---|
| Top-row `0`–`4` | FSM state (ZeroTorque, Damping, Lock, Stance, Policy) |
| `[` / `]` | previous / next policy |
| `W A S D` / `Q E` | move: vx / yaw / vy (hold Shift for full speed) |
| `R` / `C` / `Space` | reset pose / recenter / stop |
| `V` | start / stop recording a take |
| `H` | hoist on / off |
| `N` | noclip on / off: WASD flies relative to the camera, Q / E up / down, Shift faster; physics resumes where you stop |
| Arrows | start camera flight; forward/back and strafe left/right |
| Numpad `8/2`, `4/6`, `9/3` | start camera flight; forward/back, left/right, up/down (Num Lock on or off) |
| Numpad `5` / `0`, `+` / `−` | stop camera motion / adjust flight speed |
| `F` | camera flashlight on / off (outside timeline review) |
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
`public/assets/maps/<id>/` (`map.xml`, collision meshes, textured `visual.glb`, `lighting.json`, `manifest.json`), listed in
`public/assets/maps/index.json`. These are third-party game assets, so they stay out of git
(`public/assets/*` is ignored); the BSP downloads are cached in `assets/bsp-cache/`.

- **Collision:** the world model's player-solid brushes (solid, window, grate, player clip),
  found by walking the BSP tree, so triggers and brush entities never become invisible walls.
  Axis-aligned brushes become box geoms and the rest convex meshes. Displacement terrain becomes
  one heightfield per displacement, with convex prisms for the few on non-rectangular bases.
- **Visuals:** the world's drawn faces and displacements with embedded Source textures;
  unresolved materials fall back to their average colour.
- **Lighting:** Auto and Map use the original BSP diffuse lightmaps, decoded and sampled using
  noclip.website's RGBExp32 / RGBM6 path and gamma 2.2 output. Moving robots use the BSP leaf's
  ambient cubes and four strongest world lights, with Source attenuation. Other presets re-light
  the scene. The original-lighting path disables added sun/fill lights, environment illumination,
  soft sun shadows and studio tone mapping, and keeps exposure at 1. Source's 10 Hz light styles
  reproduce flicker, strobes, and lights that start off.
  There is no distance fog. Re-run the importer to upgrade older bundles.
  Ghost's material pilot additionally restores directional bump lightmaps, authored cubemap
  reflections, Phong highlights and self-illumination. Ghost now blends surfaces in a linear-light
  sRGB scene buffer, then uses noclip.website's final gamma 2.2 and 32³ identity color lookup.
  Its BSP is LDR and contains no color-correction entities, so the reference uses neither bloom
  nor automatic exposure for this map. No additional softening or color grade is applied.
  Existing pre-Source lighting preferences migrate to Auto once; later explicit choices persist.
- **Noclip:** press N for noclip.website-style free flight through walls and floors. Drag either
  mouse button to look (pointer lock, with drag fallback), WASD / arrows fly along the view.
  Arrows and numpad movement also enter flight directly from the live robot view.
  Numpad 8/2 moves forward/back, 4/6 strafes, 9/3 rises/descends (7/1 also rises/descends);
  5 or 0 stops immediately, and +/− changes speed. Num Lock may be on or off.
  The top-row number keys retain the robot state shortcuts.
  E / Space / Page Up rises, Q / C / Page Down descends. Ctrl+Space also descends. Shift is 5× speed;
  Backslash is 0.1× precision. Scroll changes speed; X toggles level flight. IJKL looks and U/O rolls.
  Acceleration / release drag remain consistent across refresh rates, and camera movement runs
  directly on render frames. Flight uses noclip.website's default 60° perspective and restores
  the previous lens when you leave. The robot receives the same displacement without physics.
  Escape, loss of focus and Stop clear movement. Press N again to resume physics there.
  Entering noclip fades the robot out. Use **Place robot** (P), then click a floor
  or upward-facing world surface to reset its pose there and fade it back in.
  Escape cancels placement; invalid sky/wall clicks do not place it. Placement
  clears momentum and commands, updates the reset home, and turns off the hoist.
  The flight toolbar also shows speed and provides level-flight and exit controls.
  Takes replay the fade; Blender exports keep complete robot geometry and carry
  the fade events as metadata rather than an unsupported material-opacity track.
- **Viewport:** toggle Inspector and Menu independently using the viewport buttons. Hide panels
  (or Tab while the canvas is focused) hides both and restores your previous combination. The
  layout persists after reload. Use Full screen for an unobstructed map view.
  `?map=nt_ghost_ctg` opens Ghost directly. Use Chrome or Chromium for development and previews.
  Download progress stays visible until map models and materials are ready; failed loads can retry.
- **Map picker:** search map filenames or game names, use ↑/↓ and Enter to choose,
  or Escape to cancel. Converted maps display their `.bsp` filenames; the built-in
  simulation terrains remain available in the same picker.
- **Robot lighting:** Robot appearance offers brightness (0–100), light colour and reach
  (1–30 m). The shell glows and lights nearby map surfaces. Completely dull removes
  emission, metalness, glossy coating and reflections across the entire robot.
  The light follows the robot and fades away with it during noclip. Recordings and
  video exports retain these settings; GLB exports retain emissive materials and
  light settings in scene metadata. The optional robot light is unshadowed.
- **Source robot cosmetics:** Robot appearance → Robot model offers Half-Life 2’s original
  Dog as a full-body R1 visual, with its native 58-bone skin and 5,855 triangles.
  The normal preview uses the neutral R1 shell. Dog remains optional; earlier saved Dog
  preview preferences return to R1 once, while explicit selections and shared views still work.
  It follows R1’s movement, supports per-part paint and robot lighting, and stays
  grounded to the recorded feet. Physics and policy remain R1. Recording, review,
  PNG/video and Blender exports preserve the selection; Stock R1 remains the default.
  `?map=nt_ghost_ctg&body=dog` opens a preview.
  Robot appearance → Head visual can fit Ghost's original
  girlbot head to compatible R1 models. Stock is the default; recordings preserve
  the selected head. The connected girlbot body and arms need additional rigging
  for a full articulated replacement. See [model analysis](docs/source-robot-models.md).
- **Flashlight:** press F or use the Flashlight button. Uses Source's `effects/flashlight001`
  projected beam, a 90° field of view, 25.4 m range, camera-follow smoothing, and a shadow depth
  pass so walls block the beam. Cutout textures also mask the depth pass; sky and light glows
  do not occlude it. The importer extracts its texture with the map assets.
  Ghost's beam follows authored normal maps and Source Phong exponents, masks and tints.
  Projected diffuse lighting is applied before self-illumination, preserving the native glow masks.
- **Render controls:** toggle base textures, wireframe, map geometry, and robot visibility.
  Source surfaces use noclip's neutral gray diffuse sampling with textures off; alpha cutouts,
  normal maps, reflection/glow masks and animation timing stay active. The sky keeps its native colors.
  Gray GLB exports retain the original alpha bytes using temporary image copies; live textures are unchanged.
  Decals and markings can be toggled separately.
  These choices persist in the browser; older saved view links still work.
- **Saved views:** save named views in the browser, restore them, or copy a shareable URL.
  Search by name, `.bsp` filename or robot; rename a view inline, or undo the most recent deletion.
  Press Enter in the name field to save. Each entry shows its map and robot. Failed storage writes
  retain existing views and typed names. Finish restoring a view before saving or sharing it.
  A link carries the map, robot, native body/head choice, paint, robot illumination,
  camera pose (including roll), field of view, flight mode/speed, lighting, flashlight and render settings.
  Restoring waits for the robot and map to load before applying their appearance; selecting
  another view supersedes an earlier restore. Recording and timeline review protect the current take.
  Older camera-only links remain usable and keep the receiver's robot appearance.
  Restoring a view holds the camera at that position; C follows the robot again.
  Receiving servers need the same converted map assets; links do not embed game files or policy packs.
- **Placement:** 1 Source unit = 1 inch. The map is centred on a team spawn that has a floor
  under it and headroom above, with that floor at z = 0, facing +x. The default ground plane is
  removed while a map is loaded.

Checked across all 24 Neo Tokyo maps: each compiles in under 0.3 s natively (about 25 s in a
software-rendered browser), the robot lands on the floor at spawn, and under 1% of sampled
visible surfaces lack collision directly beneath them (Isolation is the worst at 9%).

Ghost has a prop-import pilot. After importing its BSP, run:

```sh
python3 scripts/import_source_materials.py --map nt_ghost_ctg
python3 scripts/import_source_props.py --map nt_ghost_ctg
```

Ghost's world keeps its original geometry and collision while the material upgrade restores native,
lossless textures, directional lightmaps and displacement texture blending. Native detail
textures restore the fine grain on 43 world materials and three brush materials,
using their authored repeat scale, blend strength and linear texture sampling.
Ghost's eight bump-lit brush faces also retain all three directional lightmap layers.
Their RGBM bytes match noclip's accumulator and packer, including its float32 accumulation
and double-precision packing. Bump-light weights use Source's 0–1 saturation range.
To upgrade an existing bundle, run
`python3 scripts/refresh_source_brush_lightmaps.py --map nt_ghost_ctg` after the surface-frame
refresh below. `brush-lightmaps-report.json` records the restored layers.
The world and nine brush entities retain Source's authored corner normals and tangent
frames, including its displacement-normal calculation and mirrored texture handedness.
This preserves the intended curves, normal-map reflections and flashlight highlights.
Brush reflections also use the map's original coordinate frame. Positions, triangle
indices, UVs, texture images and model animation remain unchanged.
Existing Ghost bundles can update these attributes with
`python3 scripts/refresh_source_surface_frames.py --map nt_ghost_ctg`.
`surface-frames-report.json` records the updated surface counts;
`python3 scripts/test_source_surface_frames.py` compares every world corner with the
local noclip reference builder when its dependencies are installed.
The six sky faces face inward and retain their authored UV transforms, including
Ghost’s scaled side faces, so the sky is visible and its horizon and cloud proportions
match the original materials. Ghost also uses its authored 16× 3D sky camera and native BSP
visibility: 83 city surfaces and 10 skyline props form a separate background pass.
The main world renders after a depth clear, so the skyline stays behind foreground geometry.
Both camera views retain native materials; fog remains disabled. `visibility.json` stores
the BSP visibility data, and the importers preserve every original geometry and texture buffer.
The main view uses the camera’s native visibility set for world faces, static props and
markings, with noclip’s all-clusters fallback when flying outside a valid map region.
Visibility applies only during rendering; robot placement and Blender exports retain the complete map.
It also restores all
319 visible authored surface overlays: signs, stripes, stains and other markings, clipped to
their receiving faces and lit with the same lightmap UVs. The remaining three BSP entries also
produce no geometry in noclip.website. `props.glb` adds all
1,750 static props and 303 model entities (219 distinct models), nine visible brush entities,
the six original sky faces, 150 authored glow sprites and 52 detail/grass sprites. All 261 prop
materials have base textures; normal maps, reflection masks, Phong exponent maps and animated
texture frames are preserved at their native resolution. Source tangent conventions and skin
families are retained. The 11 robot arms play their authored `loop1` skeletal animation.
Phong-lit props use noclip's interpolated vertex attenuation for diffuse point and spot
lighting, while specular highlights keep per-pixel attenuation. This also follows animated
vertices as they move; the flashlight retains its separate projected-light calculation.
Interpolated surface normals and sampled normal-map vectors keep their native magnitude,
matching noclip's ambient weights, Fresnel response and reflection calculation. Phong and
flashlight specular terms use Source's saturated dot products. The Chromium check
`node scripts/test_source_normal_reference.cjs` compares the imported-material shader with
GLSL functions read directly from the sibling noclip checkout (`NOCLIP_REFERENCE` overrides it).
The [Ghost comparison notes](docs/source-renderer-comparison.md) record the full-scene
camera samples, measured differences and remaining fidelity gaps.
Reflection, Phong and glow masks use the original primary-texture alpha, independently of
secondary-texture and detail blending. Detail color and cutout alpha keep their authored behavior.
`props-report.json` and `materials-report.json` record resolved and missing assets.
Glow tints use the reference renderer's direct RGB modulation, with valid four-component
glTF colors even where the BSP appends an extra `rendercolor` value. Their opacity follows
noclip.website's distance fade; the original entity `renderamt` stays in node metadata.
To update an existing Ghost bundle without reimporting models or textures, run
`python3 scripts/refresh_source_sprites.py --map nt_ghost_ctg`.

Auto uses the original lighting data and material parameters, including hard-edged spotlights;
this is checked against the same viewpoint in noclip.website. Map animation clocks are captured
with new robot takes, replayed while scrubbing, and used by video export. The sky and billboards
also follow the video export camera; transparent exports hide the sky. Blender exports retain
model geometry and bones; the camera-dependent sky and additive light glows are omitted. Native textures make Ghost's
PNG masters approximately 220 MiB in total; the optimized production build downloads
approximately 163 MiB, 26% less, with identical decoded texture pixels. The UI reports loading progress.

Ghost uses noclip's five-Source-unit near plane (0.127 m) and an infinite far plane, so distant
map geometry is retained during flight. Live, recorded, shot and PNG/video cameras share that
projection; glTF cameras omit `zfar` to preserve the infinite range. Lens and view offsets remain
supported. Leaving Ghost restores the regular robot scene's clipping range.

Build the optimized Ghost assets with `npm run build:optimized`, then serve them with
`npm run preview`. This requires Python 3 and Pillow with WebP support. The build uses
`EXT_texture_webp` only when lossless WebP is smaller and checks every decoded RGBA byte
before accepting it. Original PNG masters stay in `public/`; cached conversions stay under
`node_modules/.cache/ghost-lossless-textures`. `texture-optimization.json` records the
actual file sizes. Run `python3 scripts/test_optimized_textures.py` to independently verify
the built assets against their masters, including all geometry, animation and material data.
Blender exports convert these textures to PNG using temporary copies, preserving their quality
and leaving the live viewer intact.

This remains a fidelity pilot: Source gameplay entity I/O, moving doors, prop physics/collision,
particles, HDR bloom and authored color-grading layers are not reproduced. Ghost needs neither
of the latter two in noclip.website; its final gamma and identity color lookup are reproduced.
It does not claim full pixel
parity across every map. The additional importers accept only Ghost until its review is approved.
Other maps still omit placed model props and skyboxes. Other noclip games use their own formats; Source
games (Half-Life 2, Portal, TF2, …) can go through `--bsp`, though BSPs with LZMA-compressed
lumps (newer Source branches) are not supported yet.

## Recording and export

New takes preserve the camera's full orientation, including noclip roll. Recorded playback,
Viewport shots, PNG/video rendering and Blender camera animation retain that banking.
Viewport smoothing also smooths orientation along the shortest quaternion arc. Existing
take files remain compatible: the original camera track is unchanged, and the new orientation
track is optional. The shot's lens controls continue to apply to Viewport exports.

Reopening an earlier take restores its recorded map visuals and lighting, even after switching
the live scene. Closing review returns to the live map. Recording and scene/video exports wait
for map and robot visuals; changing scenes while recording is preparing cancels that start.
Late map requests cannot overwrite the current scene's loading status or lighting, including
switching away from a map and returning while its first load is still preparing textures.
Each map load owns its materials, animation clock and textures; cancelled loads release their
resources without disturbing the active map. Retrying a map download keeps the robot pose
and appearance.

**Screenshot.** Save a fresh frame from the current live, recorded or shot camera. The button
shows preparation progress while map and robot visuals load, then saves a PNG named for
the displayed map and robot. Changing the scene or review camera during preparation or
encoding cancels the capture; loading and encoding failures leave the button ready to retry.

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
