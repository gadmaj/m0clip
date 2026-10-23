# Ghost renderer comparison

Measured on 2026-10-18 in Chromium against the sibling noclip.website checkout,
commit `fd973ff240233c63883750a557c62baf6ff2a6c7`. The compared Source shader files
were unmodified in that checkout.

The reference runs noclip's actual `Viewer`, `SourceRenderer`, BSP/model loaders and
Source materials on Ghost's native BSP/VTF/model data. A local HTTP adapter serves
the cached game files. It replaces asset transport, without replacing renderer code.
Both renderers use matching camera transforms, time zero, 320×240 pixels, a 60°
vertical field of view, a five-Source-unit near plane, infinite far plane and four-sample
MSAA. Fog and the robot are hidden for this comparison. MSAA is selected explicitly
in noclip to match this app; these captures do not compare noclip's default FXAA.

## Native normal-vector correction

The app previously normalized the interpolated surface normal and transformed bump
vector in the fragment shader. noclip preserves their magnitude. This changed ambient
cube weights, Fresnel and Phong highlights, including flashlight highlights. The app
now preserves those vectors and uses noclip's reflection formula for nonunit normals.
Specular dot products and projected-light angular attenuation use Source's saturation.
Phong's authored Fresnel ranges also apply to reflections.

`scripts/test_source_normal_reference.cjs` renders seven controlled material cases,
each with the flashlight off and on. It executes GLSL functions read directly from
the local noclip material files in a separate WebGL2 context. All fourteen RGBA
samples match exactly. The cases cover short bump vectors, smooth interpolated
normals, their combination, ordinary and Phong reflection Fresnel, and long-vector
specular saturation. Before the correction, the original five cases all differed.

The existing thirty projected-light/material checks also pass, including shadows,
directional bump lightmaps, skinned attenuation, emission, texture masks and detail.
The staged production Ghost scene compiles 71 shader programs without errors and
retains its 77 cubemap bindings, native tone mapping, detail textures and fog setting.
All 1,069 optimized image views retain exact RGBA data; the world, prop and optional
Dog GLB files remain byte-identical to the preceding release.

## Full-scene samples

Mean absolute RGB difference uses the 0–255 channel scale over every pixel. Repeated
native reference captures were identical. Before/after refers only to this correction.

| View | Before | After | After, 95th percentile |
| --- | ---: | ---: | ---: |
| Spawn hallway | 0.7856 | 0.7854 | 3 |
| Overhead grating | 2.0978 | 2.0978 | 18 |
| Reflective wall | 0.9403 | 0.9406 | 3 |
| Workbench and conveyor models | 1.7197 | 1.4110 | 6 |

The workbench sample improves by about 18%; the other views change very little.
These samples demonstrate a specific material improvement. Full pixel parity across
Ghost remains unproven. Fine texture and cutout differences remain visible, especially
at the overhead grating. Authored VTF mip levels are not yet retained by the PNG-based
import path, and antialiasing defaults still differ from noclip's.

The app-space cameras below use meters, Z up. Positions and targets are kept to make
future comparisons repeatable; the reference camera also applies Ghost's spawn origin
and 255° spawn yaw, the Source-unit conversion and noclip's coordinate conversion.

| View | Position | Target |
| --- | --- | --- |
| Spawn hallway | `(2, -4, 2)` | `(0, 0, 1)` |
| Overhead grating | `(74.089302, 4.960490, 3.499000)` | `(74.089302, 4.960490, 4.699000)` |
| Reflective wall | `(-4.613978, 0.797870, 3.224413)` | `(-5.675760, 0.513366, 3.183467)` |
| Workbench and conveyor models | `(17.462813, -11.670310, 1.967519)` | `(18.523958, -11.531636, 1.713076)` |

The original `/tmp` captures did not survive the migration. The comparison is now
reproducible using the checked-in harness below, with results outside `/tmp`.

## Native VTF/mip staging on the destination (2026-10-19)

The optimized staged production bundle restores authored native VTF mip chains.
The full Ghost Chromium check found 1,061 native texture objects, 8,741 mip levels,
77 cubemap bindings and 77 compiled programs, with no missing native bindings or
shader errors. All optimized image pixels and non-image buffer data matched the
source GLBs. The parser matched 162 upstream frame/face/mip samples; 126 native
S3TC/RGBA-fallback GPU samples and 12 lossless export cases passed.

The restored full-scene harness uses noclip's actual Viewer, SourceRenderer,
BSP/model loaders and materials from the same reference commit above. A loopback
Python adapter reuses the importer's native BSP/pak/loose/VPK mounts. No shader or
renderer replacement is involved. Each reference view is captured twice and must
repeat exactly. The Viewer camera's clip-space convention is initialized from the
device, as in upstream Viewer.update, before rendering on demand.

| View | Stable v9 mean | Native mip staging mean | Staging 95th percentile |
| --- | ---: | ---: | ---: |
| Spawn hallway | 0.7854 | 0.1516 | 1 |
| Overhead grating | 2.0978 | 1.2589 | 10 |
| Reflective wall | 0.9381 | 0.8251 | 3 |
| Workbench and conveyor models | 1.4115 | 0.1371 | 0 |

These use the four cameras and matched MSAA settings above, with time zero, no
robot and no fog. They demonstrate improved sampled scene fidelity; the grating
and reflection views still have differences. They do not establish full scene
parity or equivalence with noclip's default FXAA.

Run against a separately staged production server, keeping the serving `dist/`
intact:

```sh
source deploy/development/env.sh
BASE_URL=http://127.0.0.1:4174 xvfb-run -a node scripts/compare_ghost_reference.cjs
```

The reference checkout needs its generated `rust/pkg/index.js` and
`index_bg.wasm` from its pinned wasm-bindgen 0.2.100. On this destination those
were generated from the transferred debug WASM artifact. The reference source
files were not modified. `NOCLIP_REFERENCE`, `STABLE_URL` and
`GHOST_COMPARISON_OUTPUT` can override the reference checkout, baseline server and
results directory. Results default to
`~/.local/state/unitree-renderer/comparison/`: `report.json`, both production
captures, native reference captures, and difference images amplified eightfold.

The subsequent playpen UI changes retain the native renderer and add transparent
draggable panels over the full viewport. Their production workspace, recording,
saved-view and screenshot regressions are checked separately; this table records
the renderer comparison before that interface change.

## Authored face culling (2026-10-19)

The earlier cutout importer marked masked materials double-sided. The native
material exporter subsequently set `doubleSided` when `$nocull` was enabled but
did not clear the inherited flag when it was disabled. This made the backs of
grating surfaces visible, unlike noclip's `MaterialBase.setCullMode`.

The exporter now writes both values of the authored flag. Runtime restoration
also applies explicit `sourceMaterial.nocull` metadata to both the Source and
Studio materials, so existing Ghost assets benefit without a destructive
reimport. Materials without that metadata retain their original culling.

A fresh full-scene comparison used the development source and repeated native
captures at the same reference commit, time, cameras and MSAA settings:

| View | Native mips before culling fix | With authored culling | After, 95th percentile |
| --- | ---: | ---: | ---: |
| Spawn hallway | 0.1516 | 0.1509 | 1 |
| Overhead grating | 1.2589 | 0.0526 | 0 |
| Reflective wall | 0.8251 | 0.8251 | 3 |
| Workbench and conveyor models | 0.1371 | 0.1340 | 0 |

The grating sample improves by about 96%. Its remaining differences are sparse;
the reflective-wall sample is now the largest measured gap in these four views.
This does not establish parity over all viewpoints or noclip's default FXAA.
The fresh report and captures are in
`~/.local/state/unitree-renderer/comparison-culling/`.

`node scripts/test_source_culling.cjs` checks actual front/back GPU visibility for
world and prop materials with `$nocull` enabled and disabled, retaining alpha
cutoffs and updating both material variants. The Python importer regression starts
with the opposite legacy flag and verifies replacement in both directions. Type
checking, all 12 asset tests, diffuse-toggle/export and projected-light regressions
passed. The production candidate in `~/.local/state/unitree-renderer/culling-staged/`
passed the full Ghost integration check with 1,061 native textures, 8,741 authored
mip levels, 77 cubemaps, no missing bindings and no shader errors. The live release
was not replaced.

## Reflective-wall isolation

The saved reflective camera hits
`maps/nt_ghost_ctg/wall/stealgirderwall04_ivy_-434_4198_55`, with the native
`wall/stealgirderwall01normal_ivy` bump texture and
`maps/nt_ghost_ctg/c-434_4198_55` cubemap. Its native VMT has no authored UV
transform and uses an envmap tint of `[.09 .09 .09]`.

The comparison harness now supports diagnostic material parameters in both the
application and the actual native renderer. Setting only this material's envmap
tint to zero reduces its mean error from 0.8251 to 0.0403 (95th percentile zero).
The fresh diagnostic run modified one native material, required a matching app
material, and repeated native captures exactly. This isolates the main remaining
gap to the reflection path; it is not a proposed change to the map's lighting or
its authored reflections.

```sh
source deploy/development/env.sh
BASE_URL=http://127.0.0.1:5176 \
GHOST_COMPARISON_VIEWS=reflection \
GHOST_DIAGNOSTIC_NO_ENVMAPS=1 \
GHOST_DIAGNOSTIC_MATERIAL=maps/nt_ghost_ctg/wall/stealgirderwall04_ivy_-434_4198_55 \
GHOST_COMPARISON_OUTPUT="$HOME/.local/state/unitree-renderer/reflection-isolated-verified" \
xvfb-run -a node scripts/compare_ghost_reference.cjs
```

This diagnostic restores native material parameters after each capture. Normal
runs omit these flags and retain authored reflections. Reports now record the
candidate and baseline URLs as well as any diagnostic parameters. The following
checks completed that isolation.

## Native triangle connectivity (2026-10-19)

Actual VTF uploads through noclip and Three matched byte-for-byte in 36 GPU cases:
the wall's normal map and cubemap, linear/sRGB interpretations, explicit mip levels,
implicit sampling and anisotropic UV scales (`test_source_vtf_reference_gpu.cjs`).
Corner positions, UVs, normals and tangents also matched. Constant bump-vector
diagnostics still differed across a face, identifying interpolation as the problem.

The importer reversed Source's clockwise corner list, then built a fan from its
new first corner. This changed quad diagonals and ignored authored BSP primitive
indices. Smooth normals therefore interpolated across different triangles. Both
world and brush importers now preserve native triangle membership and reverse only
its glTF winding. Material refresh also restores indices when starting from an
older base GLB. Displacement grid indices retain their existing topology.

The existing Ghost assets were refreshed in place: 12,734 flat world faces,
including 1,776 authored primitive faces, and 742 brush faces. All JSON metadata
and every binary byte outside the relevant index buffers matched the retained
pre-refresh files. Displacement indices matched too. Independent tests execute
the static-face builder and topology helper read directly from the reference
checkout, covering every exported flat face, both primitive record layouts,
ordinary fans, high-bit count flags and dynamic-primitive skipping.

| View | Before triangle correction | Native triangles | After, 95th percentile |
| --- | ---: | ---: | ---: |
| Spawn hallway | 0.1509 | 0.0887 | 0 |
| Overhead grating | 0.0526 | 0.0198 | 0 |
| Reflective wall | 0.8251 | 0.0725 | 1 |
| Workbench and conveyor models | 0.1340 | 0.1262 | 0 |

The regular full-scene run retained authored reflections and matched four-sample
MSAA. Repeated native captures were identical, with no browser errors. Results
are in `~/.local/state/unitree-renderer/comparison-triangulation/`. The reflective
wall improves by about 91%. These samples do not establish equality at every
viewpoint; default FXAA comparison is the next step.

```sh
source deploy/development/env.sh
SOURCE_TRIANGULATION_BASELINE_DIRECTORY="$HOME/.local/state/unitree-renderer/before-triangulation" \
python3 -m unittest discover -s scripts -p test_source_triangulation.py -v
```

## Default FXAA comparison (2026-10-19)

Source maps now default to noclip's FXAA v2 after gamma and color correction.
The scene attachment has no MSAA in this mode. An intermediate 8-bit gamma target
and the reference's point/repeat sampler preserve its filtering behavior. The
Lighting fold offers FXAA, four-sample MSAA and Off; the choice persists and
travels with saved views. Legacy views without the setting use FXAA.

The actual native renderer and development source were compared with FXAA in
both, retaining the same cameras, time, authored lighting and reflections:

| View | Mean absolute RGB difference | 95th percentile |
| --- | ---: | ---: |
| Spawn hallway | 0.0857 | 0 |
| Overhead grating | 0.0339 | 0 |
| Reflective wall | 0.0793 | 1 |
| Workbench and conveyor models | 0.1163 | 0 |

Repeated native captures matched exactly and there were no browser errors.
Reports and images are in `~/.local/state/unitree-renderer/comparison-fxaa/`.
The legacy stable comparison still uses its original MSAA, recorded separately
in the report. Use `GHOST_ANTIALIASING=fxaa` for this comparison, `msaa4` for the
earlier matched-MSAA run, or `none` to compare without antialiasing.

The dedicated color GPU regression passed with FXAA enabled, including linear
transparency, premultiplied export alpha, LUT values, letterbox/scissor bounds,
target restoration and exceptions. The production candidate is
`~/.local/state/unitree-renderer/triangulation-fxaa-staged/`. Its lossless image
and complete non-image preservation check passed; its Ghost integration check
retained 1,061 native textures, 8,741 authored mip levels and 77 cubemaps with no
missing bindings or shader errors. These four samples support the completed
Ghost renderer changes without asserting pixel equality at every viewpoint.

## Expanded maps, color correction and sprite batches

The importer applies the same native-material path to the NeoTokyo catalog.
Dawn, Dusk, Rise and Saitama also contain authored 32³ color-correction tables.
Their raw RGB tables and controller positions/falloff are retained. Initial
`logic_auto` OnMapSpawn outputs resolve enabled state, including duplicate output
keys; OnNewGame is not fired by the reference. Later gameplay I/O is not simulated.

`test_source_grading_reference.cjs` runs the actual reference color-correction
class and entity falloff method: ten complete 131,072-byte LUT comparisons and
30 distance-weight comparisons match. A real Dawn spawn capture has mean RGB
error 1.3513 and 95th-percentile error 8. Its layer weight is 0.04496539249 versus
the native 0.04496539341. This proves the grading path and records a remaining
full-scene difference; the Ghost measurements are not generalized to every map.
Evidence is in `comparison-dawn-grading/` and `comparison-grading-ghost/` under
`~/.local/state/unitree-renderer/`. Set `SOURCE_MAP_ID=nt_dawn_ctg` to use the
native scene comparison harness for that map.

Upright opaque cutout detail sprites now use GPU instance batches, grouped by
shape and texture with separate position/tint per sprite. Camera-facing rotation
also applies during the flashlight depth pass. Camera-independent bounding spheres
keep offset pivots inside frustum bounds. DCC export expands the instances into
ordinary named meshes with their original double-precision position/tint values.

The Chromium fixture compares 12 sprites in two shapes across three camera
positions, textures on/off and flashlight on/off. Main-pass differences affect
at most three pixels (mean RGBA error at most 0.0104 / 255); GPU rotation rounding
changes flashlight shadow edges (mean at most 0.1526 / 255, under 2% of channels).
All shader, tint, export-position and cleanup assertions pass. Real map checks
retain Dawn's 8,806 sprites in nine draws and Decom's 33,749 in eight draws,
including their native textures, sky, PVS and map-switch disposal.

## Released validation (2026-10-19)

The final build is live as `assets/main-CYmTJ1YW.js` from `/home/g/m0clip-ts`.
All 24 NeoTokyo maps passed consecutive real-worker selection, native-texture
restoration, rendering and resource cleanup in Chromium. The report is
`~/.local/state/unitree-renderer/map-expansion/browser-final-sessions/report.json`.
The first 15 map PNGs are byte-identical to the captures before the worker changes.

Long-session checks also prompted worker resource fixes. Control periods now
share the message queue, native ID lookups avoid temporary accessor handles, and
policy builds reuse their current ONNX sessions instead of leaving old sessions
allocated after every map change. A real R1 test drops five terrain switches from
18 unreleased sessions to three reused sessions, preserves its probe outputs and
releases all three when packs close. Native joint addresses, body names and torque
limits match the original accessors for all six robot variants. Production
character mixing, camera controls, recording/save-load and GLB/PNG checks passed;
public Chromium verified the live redirect, boot intro, draggable UI and character
selection. This validation retains the scene-comparison limits stated above.
