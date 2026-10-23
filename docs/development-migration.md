# Development move to 192.168.20.156

## Current operations (2026-10-23)

The canonical site is <https://m0clip.com/>. The old
<https://gadmaj.org/mowat/> page is now a fixed redirect to that address.
The named `m0clip-tunnel.service` connects to the existing Caddy origin without
restarting it. The old Quick Tunnel remains running for old-origin file recovery;
its automatic link publisher has been retired. See [hosting](hosting.md) and
[entry-point operations](mowat-hosting.md) for the actual cutover evidence.

OMP is the active assistant. The verified tmux server and OMP process both belong
to `m0clip-omp.scope` under the persistent user manager, with lingering enabled
and no attached tmux clients. They are not children of the SSH terminal. Closing
SSH does not stop this run; exit/kill, VM shutdown, reboot or OOM can still stop it.
Reattach with `tmux attach -t m0clip-omp`. Inspect the current process cgroup rather
than assuming the future launcher's `.service` is the active unit.

The VM exposes 12 vCPUs and 30.6 GiB RAM. `m0clip-vitals.service` samples guest
CPU steal, quota throttling, pressure, paging and free disk every ten seconds,
with bounded logs. Host-side Proxmox reservations and thermal limits remain
outside guest visibility.

Development checkpoint `9201ebc` was pushed to `gadmaj/m0clip` `master`.
The user authorizes further substantial-progress commits/pushes without another
confirmation. Browser verification and production promotion are separate gates;
a pushed development checkpoint is not a claim that its private candidate is live.

## Release record (2026-10-19; historical)

The requested release is live at <https://gadmaj.org/mowat>. The repository is
<https://github.com/gadmaj/m0clip>, with the same GitHub repository ID and
history. The source workspace is `/home/g/m0clip-ts`; the former
`/home/g/unitree-mo-joco--wat` path is a compatibility symlink for existing
Codex, SSH and terminal sessions. Origin, package names, service paths, desktop
launchers and access helpers use the new name/path. Upstream attribution and the
existing take-file format identifier remain compatible.

The site is named `welcome 2mowats little playpen`, with transparent draggable
panels and the first-session IBM Plex Mono greeting. Tinbot, Orbit and Prism
have interchangeable heads, torsos, arms, hands, legs and feet. All 24 NeoTokyo
maps use the expanded native-material pipeline, with 25,724 props. The 23-map
expansion reports no missing models, textures or animation failures. Its GLBs
shrink from 6,452,108,044 to 5,218,657,388 bytes with identical decoded images
and preserved collision. Ghost's separate optimized GLBs total 273,335,164 bytes.

Dawn, Dusk, Rise and Saitama retain authored color correction. Detail batching
reduces Dawn's 8,806 sprites to nine draws and Decom's 33,749 to eight; Blender
exports retain ordinary named meshes. Inference WASM shrinks from 26.83 MB to
13.48 MB, with identical outputs across the 87 hosted R1 policies. The final
worker is 283.67 KB. Policy sessions are reused across map rebuilds and released
when replaced or removed: the real R1 test now keeps three sessions across five
terrain switches, versus 18 unreleased sessions before, with identical outputs.

The live entry is `dist/assets/main-CYmTJ1YW.js`. Type checking, production build,
all 24 consecutive Chromium map selections/renders and map-resource cleanup
passed. Earlier long runs failed on Saitama; the final run passes after control
periods were serialized with messages, native lookups stopped allocating accessor
handles, and policy-session lifetime was corrected. The native lookup comparison
preserves all six robot variants' joint addresses, body names and torque limits.
Production character mixing, recording, take save/load, camera controls and
GLB/PNG exports passed. The four Ghost reference captures retain their measured
errors; the first 15 map PNGs are byte-identical before/after the worker fixes.
Full pixel equality everywhere is not claimed.

Evidence is under `~/.local/state/unitree-renderer/`: `final-session-maps.log`,
`map-expansion/browser-final-sessions/report.json`, `comparison-final/`,
`engine-names.log`, `policy-session-before.log`, `policy-session-after.log`,
`final-sessions-*.log`, `public-release-check.json` and `public-browser-check.log`.
Public Chromium verified the redirect, query/fragment forwarding, exact greeting,
local font, draggable controls, character selection, 24-map index and isolation.
Public ZIP and both Ghost GLB range checks passed too.

Caddy was reloaded in place, retaining the existing public tunnel address and
visitor storage. Its live and saved configuration use the new workspace, with
GLB compression and required isolation headers. Hosting, development, public
tunnel and link timer remain active. The separate website's `exp` commit
`a16d2598a0410e85729508e5c8bf23597eefb62e` updates the redirect page's name;
GitHub Pages deployed it. `/home/g/website` was fast-forwarded to that commit.

The original v9 release is retained at
`~/.local/state/unitree-renderer/stable-v9-before-m0clip/`. Temporary preview
servers have stopped. The source changes remain uncommitted for review; the
published build comes from this working tree. Recovery source snapshots are in
`~/.local/state/unitree-renderer/rename-backup/`.

The sections below retain migration and development history, including older
candidate locations and intermediate map counts. Use the current release and
paths above for ongoing work.

The user requested moving hosting and all development to `g@192.168.20.156`.
The user installed SSH after the initial refused connections, then authenticated
through a local masked dialog. Access now works through the `m0clip` SSH alias
and a dedicated project SSH key. The destination is Ubuntu 24.04.5, x86_64, with
12 CPUs, 16 GiB RAM, about 40 GB free, and user lingering already enabled.
Codex 0.163.0 is installed and signed in with ChatGPT; Google Chrome is installed.
No preexisting project/reference directory was found at the intended paths.

The transfer completed and SHA-256 verification passed for all 7,442 copied files
(5,709,477,185 bytes) across the three workspace directories. New deployment helpers
were then added directly on the destination. Node 24.18.0, npm 11.16.0, Python's
virtual environment tools, the pinned Python packages, Playwright 1.63.0 and its
Chromium browsers are installed. The existing signed-in Codex was retained.

The earlier Claude project transcripts were also copied and independently verified
under `/home/g/.local/share/unitree-dev/claude-reference/`. They are outside Git and
do not include global account/login configuration. The current chat's live history
has not been silently imported into the destination Codex. Use the app's chat
handoff, or start there by reading this note and `docs/hosting.md`.

Hosting and development services are running under the persistent user manager.
See `docs/hosting.md` for the actual URLs and service names. Both the stable release and development-source Ghost browser checks passed on the
remote device. The development check restored 1061 native texture objects
and 8741 authored mip levels, with no missing restored bindings,
77 cubemaps, no fog and no shader errors. Its output is visible in the remote
`m0clip:checks` terminal window and saved under
`~/.local/state/unitree-migration/`. Type checking, 162 reference mip comparisons,
126 native/fallback GPU samples and 12 lossless export checks also passed there.

## What must move

Keep these as sibling directories under the remote user's chosen development root:

- `m0clip-ts/` (originally `unitree-mo-joco--wat/`): the entire working tree and Git history, including
  ignored `public/` maps, policy packs, robot assets and WASM files; `assets/` contains
  the cached native BSP/VPK/model data. Preserve the existing `dist/` stable release.
- `noclip.website/`: the local reference checkout and its native Rust build artifacts.
  Several comparison scripts resolve this sibling path by default.
- `unitree-ghost-before-native-vtf/`: the original Ghost PNG-master GLBs retained
  before the native mipmap changes, for independent preservation comparisons.

`deploy/development/rsync.exclude` omits reinstallable JavaScript dependencies and
Python/build caches. It does not omit Git-ignored game data or the stable release.
Global login credentials and browser profiles are outside these transfer roots.

Before transfer, create the integrity manifest outside those roots:

```sh
python3 scripts/development_manifest.py write ../unitree-development-transfer.json
```

Use rsync over the confirmed SSH connection into a new remote directory, preserving
the sibling names. Use `--exclude-from=deploy/development/rsync.exclude`, retain
symlinks, and use `--no-owner --no-group` for the destination user's ownership.
Do not delete or overwrite an unrelated existing workspace. Copy the manifest
beside the remote roots and run its `verify` action there after transfer. Then
install dependencies on the destination; do not reuse the current machine's
`node_modules` or browser binaries.

## Remote development workflow

Inspect the guest OS, CPU/RAM/disk, existing Node/Python versions, Codex login and
available Chrome/Chromium before installing anything. The original local toolchain
is Node 24.18.0, npm 11.16.0 and Python 3.14.8; the destination uses Python 3.12.3
with the same NumPy, Pillow and PyYAML versions in its dedicated environment. Python Source importers need NumPy
and Pillow with WebP support; policy importer scripts also use PyYAML. `npm ci`
installs the app dependencies and copies the WASM runtime.

All browser development, tests and previews must explicitly launch Chrome or
Chromium, as required by the root `AGENTS.md`. Current browser scripts use
Playwright 1.63.0 through `PLAYWRIGHT_MODULE`; install the matching Chromium with
Playwright's CLI. Set `PLAYWRIGHT_MODULE` to the absolute installed package path.
Headed scripts need Xvfb or a desktop display. A graphics-free guest can run
Chromium's software WebGL rendering; its performance and WebGL features must be
verified on that device. See the official [Playwright browser setup](https://playwright.dev/docs/browsers)
and [Chromium software renderer](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).

Run Vite on loopback port 5176 for development, accessed through SSH port
forwarding. The project's isolation headers must remain present. For persistent
hosting, reuse the tested release with `deploy/home/`; a browser on the visitor's
device handles rendering, physics and inference. Validate the remote OS service
and its startup behavior, HTTP headers and policy-pack byte-range loading. A
temporary quick tunnel or an SSH session on the original computer is insufficient
to make the hosted site independent of that computer.

For the app's remote project connection, add a concrete SSH alias, verify it, and
ensure the existing remote `codex` executable is on the login shell's PATH and is
authenticated. Add the SSH host and project in the app's Connections settings.
The app's chat handoff transfers chat and Git state; copy ignored map/policy data
separately first. Handoff is selected from the chat's run-location control. A chat
cannot hand itself off through its own agent request. See [OpenAI remote connections](https://learn.chatgpt.com/docs/remote-connections)
and [headless authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).
If handoff creates a separate worktree, verify that its ignored game assets, cached
native data and reference checkout are accessible there too. A successful Git/chat
handoff alone does not establish that browser tests can load the complete map.

## Preserve the distinction between stable and unfinished work

The stable `dist/index.html` references `assets/main-C7Ii0RBv.js` (Source effects v9).
The source working tree includes newer native VTF/mip support. Its 449 world and
612 prop texture bindings retain 8,741 authored mip levels alongside lossless
export images. This newer work has not been released. The previous session ran
parser/reference checks, compressed and RGBA-fallback GPU tests, and export tests,
but its `/tmp` logs and comparison harness did not survive the machine restart.
Re-run the checks on the destination and complete full staged-production testing
before changing the stable build. Do not build directly into the serving `dist/`.

The original renderer-improvement goal is paused. This move does not authorize
discarding the current work or claiming complete visual parity. Retain the Ghost-only
fidelity pilot, R1 default, optional Dog and all existing recording/export controls.
After the environment is moved, the user can resume development on the remote host.

## Starting work on the destination

Open `/home/g/m0clip-ts` in the destination's signed-in Codex.
Read this handoff, `docs/hosting.md`, `AGENTS.md` and the Ghost renderer comparison
notes before resuming. The desktop shortcuts open the persistent development
terminal and the Chrome development preview. From an ordinary terminal:

```sh
cd /home/g/m0clip-ts
source deploy/development/env.sh
bash deploy/development/terminal.sh
```

The terminal session has `workspace`, `logs` and `checks` windows. Use Ctrl+B then
W to choose a window. The app runs independently of this terminal and the original
computer. No new autonomous renderer-development run was started during migration;
the user can resume that goal from Codex on this destination.

The original objective is to match the visuals and movement of noclip.website,
preserve all existing capabilities, and simplify the interface with useful quality
of life improvements. Ghost is the fidelity pilot until the user approves expanding
placed-model work to other maps. Retain the harsh native lighting default, no fog,
R1 as default, optional Dog, model/head alternatives, flashlight, robot placement
and fading, robot illumination, searchable filenames and policy descriptions,
hideable panels, arrows/numpad camera input, recording, saved views and exports.

The next renderer step is to finish staged-production verification of the native
VTF/mip work before publishing it. The live stable release remains v9. Full scene
parity, including antialiasing differences, remains unproven. Run the actual
reference tests and source comparisons; do not substitute generic ambient lighting.
The original computer retains a backup copy of the workspace; the destination is
now the active development location. Do not maintain parallel source edits on both.

## Development resumed (2026-10-19)

The user resumed the original development objective and requested the site name
`welcome 2mowats little playpen`, with transparent draggable UI elements. The
development source now has independent Play, Scene, Capture, Inspector, policy
pack, timeline and export panels over a full-window scene. Dragging, keyboard
positioning, collapse/expand, saved positions and Reset layout are implemented.
Small screens start secondary panels collapsed. Existing control objects and
callbacks are retained.

The optimized production candidate is staged outside the serving release at
`~/.local/state/unitree-renderer/playpen-final/`. The current serving `dist/`
was not replaced. The Chromium workspace checks and camera recording/review,
take save/load, animated GLB camera export and PNG export checks passed against
this candidate. The original native texture and Ghost integration checks passed
as well. See `docs/source-renderer-comparison.md` for the newly restored,
reproducible full-scene reference harness and measured native-mipmap improvements.
Full visual and movement parity remains ongoing work; the goal is active.

The next candidate, `~/.local/state/unitree-renderer/culling-staged/`, also restores
authored `$nocull` values instead of retaining legacy double-sided cutout flags.
The fresh reference run in `comparison-culling/` reduces the overhead-grating
mean pixel error from 1.2589 to 0.0526, with the other saved views unchanged or
slightly improved. Dedicated front/back GPU tests and the production Ghost check
passed. Reflective-wall differences remain the largest of the four measured
views; see the latest comparison notes before continuing. The stable `dist/`
remains untouched.

## Expanded user scope and rename order

The user subsequently requested a first-session black boot screen, typing the
exact message `welcome2 mowats fuunhouse.. Just you wait...` in IBM Plex Mono,
then fading into the UI. Source implementation and Chromium checks cover typing,
asset readiness, fade, session persistence, reduced motion, keyboard isolation,
Escape skip and visible errors. The font is a locally bundled 17.5 KB official
Latin1 subset with its OFL license. The separate production candidate in
`~/.local/state/unitree-renderer/boot-intro-staged/` passed these checks, including
phone bounds, along with type checking and a production build. Camera recording,
take save/load and GLB/PNG camera exports passed sequentially. One concurrent
recording run failed its timing-sensitive bank threshold; its assertion now
includes the sampled values for future diagnosis. No threshold was weakened.

Keep the user's requested order for the larger goal:

1. Finish the current interface and renderer/movement fidelity work.
2. Expand the finished pipeline to all available maps. The earlier Ghost-only
   limit is lifted for that later phase; Ghost remains the current pilot.
3. Add more robots/characters and interchangeable parts, preserving existing
   model, head, appearance, recording, placement and export capabilities.
4. Reduce loading cost, asset transfers and bundle/runtime overhead while
   preserving fidelity and those features. Record measured improvements.
5. Rename the repository to **m0clip-ts**, the user's selected TypeScript name.
   The user also considered m0clip-wasm; the primary application is TypeScript.
6. Update and verify affected remotes, paths, services, launchers, documentation
   and website integration, including `https://gadmaj.org/mowat`.

Before the rename, read-only inspection found the origin was
`https://github.com/gadmaj/unitree-mo-joco--wat.git`. The public entry page reads
`mowat/current.json` from the separate `gadmaj/website` repository's `exp` branch
(with a same-origin fallback), then redirects to the active Cloudflare tunnel.
The local publisher is `deploy/development/publish-mowat-link.py`; its service
and several development/access service paths contain the current workspace
directory name. Audit them together during the rename rather than changing the
workspace or public entry point ahead of the requested development sequence.
Those were the pre-release repository and hosting states; see the current release above.

The subsequent renderer investigation corrected world/brush triangle connectivity:
reversing the polygon's corner list had changed its fan diagonal and ignored
authored BSP primitive indices. Native triangles reduce the saved reflection
sample's mean error by about 91%. All 13,476 exported flat faces match the actual
upstream index builder, and every byte outside those index buffers is preserved.
The default FXAA path now also follows noclip. Its four native scene comparisons
have mean RGB errors 0.0857, 0.0339, 0.0793 and 0.1163, with no browser errors.
See `docs/source-renderer-comparison.md` for measurements and reproduction.
`~/.local/state/unitree-renderer/triangulation-fxaa-staged/` is the current separate
candidate. Its native-texture integration and optimized-data preservation checks
passed. The production boot intro, floating panels, keyboard navigation, camera
recording, take save/load, animated GLB camera export, PNG/video export and final
color cleanup checks passed. Saved-view checks include antialiasing restoration,
fresh share links and legacy views. The current interface/renderer pass is ready
for the next phase; the original stable `dist/` remains separate.

Map expansion has begun with `scripts/upgrade_source_maps.py`. All 24 listed
NeoTokyo maps have cached, compatible BSP v20 data and LDR lightmaps. The first
additional map is Bullet: 452 props and six sky faces are restored; its GLBs shrink
from 52.8 MB to 42.6 MB with identical decoded images. Its real-worker Chromium
selection/render check passed, including native mips, FXAA, 3D sky, visibility,
infinite projection and resource cleanup. The resumable pipeline preserves original bundles and
PNG masters outside public, verifies unchanged collision/positions/UVs and all
lossless texture pixels, then installs each successful development bundle.
Its state and logs are under `~/.local/state/unitree-renderer/map-expansion/`.
No claim that all maps are upgraded is made yet. `source-upgrade.json` identifies
successful maps, and `scripts/test_all_source_maps.cjs` checks real browser
selection, rendering and resource cleanup. Character/part expansion, broader
loading optimization, repository rename and public-link audit remain ahead.

Three lightweight modular characters are now implemented in source: Tinbot,
Orbit and Prism. `src/render/robot-kit.ts` generates their shapes without model
downloads, retaining the selected robot's joint frames. Head, torso, arms, hands,
legs and feet can be mixed independently in Robot appearance. Paint, saved views,
take metadata, playback and animated GLB geometry include the selected modules.
The original shell restores its exact geometry and materials. Chromium checks
passed on R1, G1 and Go2, including mixing, persistence, recorded settings,
animated GLB export, cleanup and zero additional character asset requests.
Screenshots and logs are in `~/.local/state/unitree-renderer/robot-modules/`
and `robot-modules-runtime.log`. The production code build and the same real
R1/G1/Go2 character/recording/export checks passed (`robot-modules-production.log`).
The added character code costs 3.34 KB gzipped and requires no model requests.

Ballistrade also converted successfully: 937 props, 19 brush entities, six sky
faces and 84 sprites, with 10,075 native mip levels in its GLBs. Lossless
optimization reduces those GLBs from 366.4 MB to 302.3 MB. Its Chromium check is
running. The original batch stopped at its checkpoint, and the remaining batch
is now running with the new shared texture cache (`map-expansion-cached.log`). The
content cache is in `node_modules/.cache/source-texture-payloads`; it was seeded
from validated Ghost and Bullet PNG/native payloads. It reuses exact encoded
bytes keyed by native content, frame and face. The cache regression and all
13 source-asset checks passed. Completed maps are skipped on a later resume, and
original assets remain recoverable. `report.json` currently records Bullet and
Ballistrade as converted; Ghost was already finished and is outside that batch.
The staged-production Bullet check passed too, including all expected restored
native texture identities. All other maps still require conversion/browser
verification before the final complete build and repository rename.

The inference import now uses `onnxruntime-web/wasm`, matching the app's existing
WASM-only execution-provider choice. The staged worker falls from 614.81 KB to
282.42 KB; its inference WASM falls from 26,827,540 to 13,479,978 bytes. An actual
Chromium comparison ran all 87 hosted R1 policies with three input sets through
the old general and dedicated WASM bundles; every output value was identical.
`scripts/test_ort_wasm_reference.cjs` and `ort-comparison/report.json` reproduce
that evidence. The new production policy picker and boot-intro checks passed.
The real policy/physics worker check passed in development; its production
counterpart is being checked separately. This changes no policy data or provider.

Dawn also completed conversion and its Chromium check passed: 761 props, six sky
faces, 82 sprites and 8,806 detail sprites, with all expected native textures
restored. Current conversion state is Bullet, Ballistrade and Dawn, plus the
previously completed Ghost. The cached batch is processing Decom next. Read the
live report rather than treating these counts as a finished catalog.
