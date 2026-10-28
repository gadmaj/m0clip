# m0clip

Put robots and characters into Source maps, move them around, and record clips in
your browser.

[Open the public demo](https://m0clip.com)

m0clip builds on [unitree-mujoco-web](https://github.com/legion1581/unitree-mujoco-web)
and Source-map rendering from [noclip.website](https://github.com/magcius/noclip.website).
MuJoCo runs physics in a worker, Three.js renders the scene, and ONNX Runtime Web
runs compatible robot policies. A production build is a static site.

## Before you build

| Requirement | Used for |
| --- | --- |
| Git, Node.js and npm | Installing dependencies and running Vite. Use a current Node.js LTS release, such as 22 or 24. |
| Python 3.12+ with `venv` | Asset processing during production builds and map conversion. |
| NumPy, Pillow with WebP support, PyYAML | The Python asset tools; installation is shown below. |
| Chrome or Chromium | The supported development browser; WebGL, WebAssembly and cross-origin isolation are required. |
| Blender, optional | Converting supported third-party character sources. |

**A clone is not the demo's asset collection.** The repository includes the R1,
G1 and Go2 robot model bundles. Converted maps, imported character assets and
policy weights are ignored by Git and must be supplied separately, under terms
that permit your intended use and redistribution.

There is also a **build-time character prerequisite**: the current
[`character catalog`](src/characters/catalog.ts) imports generated attribution,
rig and definition JSON from `public/assets/characters/`. Those files are not
included in a fresh clone. Supply the metadata and assets for its configured
characters, or adapt that catalog to the characters you can provide, before
running development or build commands. Selecting Original at runtime does not
remove these build-time imports.

## Install and develop

```sh
git clone https://github.com/gadmaj/m0clip.git
cd m0clip
npm ci

python3 -m venv .venv
.venv/bin/python -m pip install numpy==2.4.6 Pillow==12.3.0 PyYAML==6.0.3
```

`npm ci` runs the postinstall script that copies MuJoCo's JavaScript and WASM
runtime into `public/wasm/`. Do not skip install scripts unless you perform that
copy yourself with `node scripts/copy-ort-wasm.mjs`.

After preparing the character inputs above:

```sh
npm run dev
```

Open the URL printed by Vite in Chrome or Chromium. Vite sets the isolation
headers required by the simulator. Use the development server rather than
opening `index.html` with `file://`.

Built-in terrains do not require converted game maps. Choose one and the
Original robot to avoid runtime dependencies on imported map and character
binaries. Without a compatible policy pack, physics can run without a learned
walking controller; character appearance does not supply one.

## Supply your own assets

Only import assets you are allowed to use. Permission to download a file is not
necessarily permission to redistribute it from a public host. Prepare assets
before building: Vite copies `public/` into the output, including any third-party
files you place there.

### Source maps

Map conversion is a **command-line preparation step**, not a browser BSP upload
feature. For a local Source BSP, replace `asset-sources/map.bsp` with your file:

```sh
.venv/bin/python scripts/import_source_bsp.py \
  --bsp asset-sources/map.bsp --name "My map"
```

The importer writes `public/assets/maps/<map-id>/` and updates
`public/assets/maps/index.json`, which populates the map picker. The map ID comes
from the BSP filename. The input must be a supported `VBSP` map; LZMA-compressed
BSP lumps are not supported.

A local BSP may not contain all of its materials or models. The importer can
read embedded assets, but external game dependencies need a compatible asset
mount. The `--game neotokyo --maps <map-id>` mode uses the importer's configured
remote catalog and mounts; it is not a general adapter for every Source game.
Consult [`import_source_bsp.py`](scripts/import_source_bsp.py) for its arguments
and mount definitions before selecting a source. Do not assume a converted map
reproduces every prop, material or gameplay entity.

### Local map bundles

Package a converted map directory without adding it to your hosted catalog:

```sh
node scripts/package_map.mjs public/assets/maps/my_map \
  --output my_map.map.zip --name "My map" --game "Source"
```

The packager requires Linux with `/proc/self/fd` and rejects symlinked input
directories or files. It includes the selected world and props models, textures and physics,
checks their contents, and never overwrites an existing ZIP. The resulting
bundle is portable; the browser does not need Linux. Truncated compressed entries
and entries with trailing compressed data are rejected.
Inline physics data, repeated file references and uppercase GLB/glTF/XML extensions
are supported without changing resource filenames.
Unsafe paths and excessively complex dependency metadata are rejected before
the map becomes active.

Choose **Open map bundle…** in the map gallery. Files are checked locally in a
dedicated worker, not uploaded. Cancel verification before installation to keep
the current scene; archive bytes are separate from download progress.
Local maps last for the tab's session. Saved takes and views remember
the map's identity, not its files: after reloading, reattach the same bundle.
Finish a map or saved-view load before opening Timeline or another take.
Raw BSP, GMA and VPK files are not browser import formats yet.

### Characters

Imported characters need geometry, textures, attribution and a compatible rig
mapping. They are visual bodies attached to supported robot physics, not new
controllers. Adding an arbitrary GLB to `public/` does not register a character.

[`import_character_assets.py`](scripts/import_character_assets.py) runs inside
Blender and accepts a JSON configuration through `--config`, plus an optional
`--source-root`. It supports Blender, FBX and glTF inputs and writes a GLB and
preview. Its configuration declares source/output paths, source-file hashes and
attribution. Public output requires an explicit redistribution approval and
license evidence. Register the resulting definition and rig in the
[`character catalog`](src/characters/catalog.ts); the importer does not do that
integration automatically.

The in-app Source model search uses the
[pmodels index](https://github.com/wootguy/pmodels). Its loader supports GoldSrc
`IDST` version 10 models, not arbitrary Source or Source 2 model files. Individual
models retain their own authorship and terms; search results are not a license
grant. Remote search also depends on its upstream services and CORS support.

Compatible biped imports align named left/right limbs to the robot and keep the
model's reference pose separate from animated bone controllers. Custom skeletons
may require an explicit rig mapping.

Character and policy galleries browse image previews without loading models or
policy weights. Available turntables use prebuilt GIFs; reduced-motion mode uses
separate PNG stills. A rest-pose turntable is not a motion or controller demo.
Remote player models keep their upstream still pictures; browsing does not
download unselected models or imply permission to publish new animations.

To prepare previews for assets you already have permission to publish,
[`generate-character-turntables.py`](scripts/generate-character-turntables.py)
runs in Blender with an explicit `--job` JSON. The job supplies a new output
directory, frame count/rate, and `characters` entries containing `id`, `input`,
`sha256`, `approvedRuntimeAsset` and `attribution`. It renders a full camera orbit
around each GLB's native rest pose. The encoder emits `turntable.gif` and
`still.min.png`; GIF palette reduction is lossy, while PNG recompression preserves
decoded pixels. Keep generation receipts private; add only approved image URLs
and captions to [`animated-preview-catalog.json`](src/ui/animated-preview-catalog.json).

Policy animations require captures from the exact robot and checkpoint, not
motion inferred from a policy name. Where no such capture exists, the gallery
labels the robot-only picture rather than implying policy playback.

[`generate-policy-previews.cjs`](scripts/generate-policy-previews.cjs) captures
controller motion from your running build. Set `BASE_URL` and a private
`PREVIEW_OUTPUT`; supply an approved pack job with its SHA-256, exact robot and
policy, frame count/rate and attribution. The helper retains actual joint states
and simulation timestamps and checks the robot, checkpoint and joint identity.
Publish only the approved GIF, still and attribution—not its receipts.

For bounded artwork jobs, set `PREVIEW_BUDGET_ROOT` and byte values for
`PREVIEW_BUDGET_BYTES`, `PREVIEW_MIN_FREE_BYTES` and `PREVIEW_RESERVE_BYTES`.
Keep `PREVIEW_OUTPUT` inside that root; the encoder rejects output paths outside
it. This budget covers retained job files, not browser memory.

### Robot policies

Import your compatible policy ZIP through **Controls → Play → Packs →
Import .zip…**. Packs are stored in this browser's IndexedDB. A pack contains
`pack.json`, its YAML policy configuration and ONNX checkpoints, plus any
auxiliary networks or reference data required by the driver. A bundle is a ZIP
of pack ZIPs. The manifest and parser are defined in
[`src/packs/index.ts`](src/packs/index.ts); the runtime is not a general-purpose
loader for arbitrary neural networks.

Some motion clips run once, then switch to their configured next policy.
Re-select a clip to play it again.

For an optional hosted R1 catalog, provide your own compatible R1 bundle before
building, replacing the example input path with your file:

```sh
node scripts/host-default-packs.mjs asset-sources/r1-all.zip
```

This writes `public/assets/packs/r1-default-v1.json` and the individual pack ZIPs
under `public/assets/packs/r1/`. The browser installs the catalog metadata and
downloads weights when a policy is selected. Publishing these files distributes
the weights: confirm you have permission first.

## Build

The following commands use the Python virtual environment created above:

```sh
npm run typecheck
PYTHON="$PWD/.venv/bin/python" npm run build
npm run preview
```

These are POSIX-shell examples. On another shell, set `PYTHON` to your virtual
environment's Python executable before invoking `npm run build`.

The build typechecks the application, writes `dist/`, then generates compressed
robot meshes and processes native map visuals when the corresponding map inputs
are present. It writes a release-specific startup asset catalogue **after** those
steps, using the final file sizes and dependencies. Keep the complete output,
including `assets/`, `wasm/`, manifests, the startup catalogue and `.gz` files.
`npm run preview` serves it locally with the required isolation headers; it is a
preview server, not a production hosting service.

Map, character and Source-robot conversion records are omitted from public builds
and the startup catalogue. Keep source analysis, candidate comparisons, conversion
recipes and rig-mapping notes with your local asset sources, not on the static host.
Runtime rig definitions, embedded model rig data and attribution remain included.

If you change assets in an already-built output directory, regenerate its
catalogue before serving that output:

```sh
node scripts/build_startup_catalogue.mjs dist
```

This keeps the catalogue URL compiled into that build. Prepare character previews
and model conversions before the final catalogue pass; do not mix a catalogue
from one output with files from another.

## Host the static build

Serve the contents of `dist/` at the **root of an HTTPS origin**. Several asset
URLs are root-relative; putting the site under a URL subdirectory requires code
and asset-path changes, not just a Vite base option. Localhost is suitable for
local development, but a remote plain-HTTP origin cannot provide the secure
context the simulator needs.

Configure your static host or reverse proxy to send:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers enable cross-origin isolation for MuJoCo's `SharedArrayBuffer`.
Serve workers and runtime files from the same origin where possible. Resources
fetched from another origin must satisfy CORS or the relevant cross-origin
resource policy; do not disable isolation to work around a blocked asset.

| Resource | Serving requirement |
| --- | --- |
| JavaScript modules and workers | A JavaScript MIME type; preserve the generated paths. |
| `.wasm` | `Content-Type: application/wasm`; preserve binary bytes. |
| `.json` manifests | `Content-Type: application/json`; missing assets must not become an HTML fallback. |
| GLB, ONNX, meshes and ZIPs | Serve the actual binary files, with an appropriate binary MIME type. Do not apply text conversion. |
| Explicit `.gz` mesh or lightstyle files | Keep their filenames and bytes. Serve as `application/gzip` without `Content-Encoding`; the application inflates them. |

HTTP compression is separate from an explicit `.gz` asset. For ordinary resources,
if your host sends `Content-Encoding: gzip` or `br`, the response body must actually
use that encoding. The browser decodes it before the application receives it.
Do not label an explicit `.gz` file as HTTP gzip: its compressed file bytes are
part of the generated scene payload budget. Do not strip the generated `.gz`
files as redundant precompression artifacts or replace missing files with HTML.

Deploy HTML, scripts, asset manifests and their referenced files together. Avoid
long-lived caching for `index.html` and mutable catalog/manifest URLs; reserve
immutable caching for files whose URLs change with their contents.

## Use and limitations

Choose a map and character, then **Load scene**. The scene controls and **? Help**
list movement, camera and capture actions. Record takes, review them in Timeline
and download saved files for backup.

Loading first resolves the selected scene, model, appearance and policy. Selected
external player models may need to finish downloading during this planning step;
their prepared data is reused. Before the remaining scene downloads begin, the
loader fixes its **scene asset payload** maximum. **MB LEFT** and download ETA use
unique HTTP-decoded resources, including bytes read from browser cache—not billed
network traffic or inflated texture/mesh memory. Transport compression can reduce
wire bytes without changing this maximum. A full byte meter does not mean physics
compilation or material preparation has finished; **Enter scene** waits for the
simulation, visuals and a rendered frame. Expand **Details** for actual transfers
and readiness. Pong appears only if an unfinished load lasts more than 30 seconds.
Local-map verification is listed separately from downloads. Local file bytes and
optional reader code already loaded during file selection do not increase the
later scene download total.

Open **Camera / output** before recording to set the static camera, lens and output
format. **Scene** remains available above setup for look, parts, lighting and
display controls. Motion/video/data exports require an open recorded take; static
setup does not create one. Press **Escape** to close setup. Starting a recording
also closes it and restores the live camera without losing the output recipe;
setup cannot open while a recording is starting or active. In review, appearance,
display, flashlight, added lights and camera edits belong to that shot, not live
preferences. Robot, map, policy and other simulation controls are LIVE-only.
Controls lock while encoding, not merely while setup is open.

Finished motion clips report completion in **Play** without opening a dialog.
The flashlight’s **F** shortcut is LIVE-only; use its button while reviewing a take.

Open **Reference clip** to load a motion CSV and set its playback FPS. It starts
collapsed; your panel layout and open/closed choices are remembered. **Stop**
returns control to the selected policy.

In **Render controls**, enable **Character wireframe** and leave **Map wireframe**
off to keep the map solid. Keep **Textures** and **Map geometry** enabled to see
the textured environment.
On Flat, the camera flashlight keeps the floor and its reflection visible.

- Detailed maps can require substantial downloads, memory and startup time.
- Source gameplay, moving doors, prop physics, particles and HDR bloom are not
  reproduced. This is not a general loader for every game on noclip.website.
- Video export depends on the codecs the browser can encode.
- GLB exports use solid triangle geometry, not viewport wireframe lines. **Textures**
  also controls the optional exported ground plane. Source's custom shaders,
  lightmaps and final tone mapping are not reproduced in GLB.
- Saved takes, screenshots and imported policies are local to the browser and
  site origin, not cloud backups. Clearing site data can remove them; another
  hostname cannot read them. Download backups before changing origins.
- Simulation compatibility depends on the robot model, policy observation/action
  scheme and supported driver. A different visual character does not change that
  contract, and this browser application is not a real-robot safety controller.

## Credits and licenses

- **Konstantin Severov** — the original
  [unitree-mujoco-web](https://github.com/legion1581/unitree-mujoco-web) simulator.
- **Jasper St. Pierre and noclip.website contributors** — Source format and
  rendering work; see [LICENSE.noclip](LICENSE.noclip).
- **MuJoCo, Three.js, ONNX Runtime and Mediabunny contributors** — physics,
  rendering, inference and media export.
- Game, robot and character creators — retain each asset's notices and attribution
  when preparing or redistributing a build.

Application code is covered by [LICENSE](LICENSE), with the separate noclip
notice above. Those notices do **not** relicense game maps, robot assets,
character models or policy weights. Check their individual terms, including
attribution and redistribution requirements, independently of the code license.
