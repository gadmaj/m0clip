# m0clip

Put robots and characters into Source maps, move them around, and record clips in
 your browser.

[Open m0clip](https://m0clip.com) · [Development notes](docs/experience-plan.md) ·
[Hosting](docs/hosting.md)

This is a fork of [unitree-mujoco-web](https://github.com/legion1581/unitree-mujoco-web),
with Source-map rendering based on [noclip.website](https://github.com/magcius/noclip.website).
MuJoCo runs the physics in a worker; Three.js renders the scene. The robot policies
run through ONNX Runtime Web.

## Using it

Choose a map, a character and its robot, then **Load scene**. Ghost is the default.
The renderer and simulator load after that choice, not before it. If loading takes
more than 30 seconds, the loading bar turns into Pong. There is no game on the
selection screen.

The bottom dock has the main scene and capture actions. **Controls** opens the
advanced panels; **? Help** in the top right lists the current controls. Visual
choices use pictured, searchable menus.

- Explore the map in Flight, or place a robot on a floor and drive it.
- Change compatible parts, paint, finishes and lighting. Map lighting is the
  default; Studio lighting and robot glow are explicit choices.
- Record a take, scrub it in Timeline, choose a camera and trim the range.
- Use **Edit look** to change a recorded take's appearance or add point, spot and
  directional lights without changing its original motion.
- Find saved takes and PNGs in **Shots**. Download take ZIPs for backup or use on
  another device.

| Key | Action |
| --- | --- |
| `W A S D`, `Q E` | Drive; hold Shift for full speed |
| `N` | Enter or leave Flight |
| `P` in Flight | Place the robot on a surface |
| `V` | Start or stop recording |
| `Space` | Stop movement; play/pause when reviewing a take |
| `R`, `C` | Reset the robot, recenter the camera |
| `?` | Open Help |

Shortcuts do not drive the robot while a text field or modal is active. Gamepad
controls, Flight controls and Timeline shortcuts are listed in Help.

## Maps and characters

The current map collection is NeoTokyo's 24 maps. Other Source BSPs can be
imported, but this is **not** a general loader for every game on noclip.website.
Each game's formats and rendering need their own support.

Robot physics includes R1, G1 and Go2, with their supported variants. The character
menu keeps the original robots and procedural shells alongside imported models:
Gingerbread Man, the PSX sets, Picardia and the other published characters.
Changing the character does not create a new controller. Most humanoids follow
R1; PSX Dog follows Go2. Dragon is a visual character, not a flying simulation.

**Source model search** reads the [pmodels](https://github.com/wootguy/pmodels)
indexes in the browser and fetches only the selected model and its dependencies.
That loader supports GoldSrc `IDST` version 10 models, not arbitrary Source or
Source 2 model files. Search availability is not a license grant.

Character import settings and attribution are in
[`scripts/character-assets/`](scripts/character-assets/). The
[model-intake notes](docs/experience-plan.md#requested-model-intake) distinguish
published models from requests still missing files or permission.

## Recording and saved files

Takes contain the robot motion, inputs and camera track. Completed takes save
locally, with incremental recovery checkpoints during recording. Recovery stops
at the last committed checkpoint; it cannot guarantee the final frames of a
crashed tab.

Timeline has Free, Recorded and Shot camera modes. Exports include:

- PNG screenshots and PNG sequences.
- MP4, MOV and WebM video, using codecs the browser can encode.
- Animated GLB scenes for Blender, including geometry, materials and the camera.
- Motion CSV and portable `.take.zip` files.

Portable GLB materials do not reproduce Source's custom shaders, lightmaps or
final tone mapping. Use the browser's PNG/video export when the rendered Source
appearance is what matters.

Saved shots and imported policies belong to **this browser and site address**.
They are not cloud backups. Clearing site data can delete them, and another
hostname cannot read them. If you used an older address, open it and download your
takes and PNGs before moving. Take ZIPs can be reopened with **Open take**.

On a return visit, **Keep files on this device** can ask the browser to protect
saved site data from automatic cleanup. **Help → Browser storage** shows the
result and lets you retry. This does not grant access to the Downloads folder.

## Local development

Node 24 is used on the development machine. Chrome/Chromium is the tested browser.

```sh
git clone https://github.com/gadmaj/m0clip.git
cd m0clip
npm install
npm run dev
```

A fresh clone includes the robot models, but not converted game maps, imported
characters or policy weights. Start with a built-in terrain and Original robot.
Import a policy ZIP to use its learned motions. Without one, the driverless
physics path still runs; it does not invent a walking controller.

The hosted site provides the R1 policy catalog and downloads the selected weights.
For a separate deployment, prepare your own hosted packs:

```sh
node scripts/host-default-packs.mjs /path/to/r1-all.zip
```

Alternatively, use **Controls → Play → Packs → Import .zip…**. Imported packs stay
in IndexedDB. See [pack format](policy-packs/README.md) and the existing
[R1](docs/R1_FIRMWARE_POLICIES.md), [G1](docs/G1_FIRMWARE_POLICIES.md) and
[Go2](docs/GO2_FIRMWARE_POLICIES.md) policy notes.

### Importing maps

Python dependencies are listed in
[`deploy/development/requirements.txt`](deploy/development/requirements.txt).
Use a virtual environment rather than installing into the system Python.

```sh
python3 -m venv .venv
.venv/bin/pip install -r deploy/development/requirements.txt
.venv/bin/python scripts/import_source_bsp.py --game neotokyo --maps nt_ghost_ctg
```

To upgrade existing converted maps with props and native materials:

```sh
.venv/bin/python scripts/upgrade_source_maps.py --maps nt_ghost_ctg
```

A local BSP can also be imported with
`--bsp /path/to/map.bsp --name "Map name"`. LZMA-compressed BSP lumps are not
supported. Converted maps and third-party assets stay outside Git; get them from
sources you are allowed to use.

When changing a robot's scene dependencies, regenerate its asset index:

```sh
node scripts/index_model_assets.mjs public/assets/models/r1 scene.xml
```

### Build and checks

```sh
npm run typecheck
node scripts/test_goldsrc_character.cjs
node scripts/test_character_joints.cjs
PYTHON="$PWD/.venv/bin/python" npm run build
npm run preview
```

The production build needs NumPy and Pillow with WebP support. It generates
lossless compressed robot meshes and native-backed Ghost visuals when those map
assets are present. These reduce transferred/decoded asset data; they do not
make Ghost a small scene or guarantee a short cold start.

Production must send these headers for MuJoCo's `SharedArrayBuffer`:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Vite development/preview servers and checked-in Caddy configuration set them.
On the hosting VM, **do not build into the serving `dist/`**. Build elsewhere,
verify it, then promote it as described in [hosting](docs/hosting.md).

## Development

The main areas are `src/render` for scene/character rendering, `src/worker` and
`src/sim` for physics, `src/packs` for policies, and `src/record` for capture and
storage. UI code is in `src/ui`; BSP and character importers are in `scripts`.

Recent work has focused on loading only the selected robot/policy data, keeping
Source textures and authored lighting intact, reducing repeated data in takes,
and making saved shots and post edits usable. Startup is still heavy on detailed
maps. Source gameplay, moving doors, prop physics, particles and HDR bloom are
not reproduced. The [renderer comparison](docs/source-renderer-comparison.md)
records the remaining visual differences; the [development notes](docs/experience-plan.md)
record what was actually checked and what is still blocked.

## Credits and licensing

- **Konstantin Severov** — the original
  [unitree-mujoco-web](https://github.com/legion1581/unitree-mujoco-web) simulator.
- **Jasper St. Pierre and noclip.website contributors** — Source format and
  rendering work used by this project. See [LICENSE.noclip](LICENSE.noclip).
- **MuJoCo, Three.js, ONNX Runtime and Mediabunny contributors** — physics,
  rendering, inference and media export.
- The game and character creators credited in their asset/import records.

The application code's MIT notice is in [LICENSE](LICENSE). Game maps, robot
assets, character models and policy weights have their own terms; that notice
does not relicense them.
