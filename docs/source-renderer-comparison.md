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

The exact camera matrices and raw before/after captures are retained for the
development session in `/tmp/unitree-normal-v8.json` and `/tmp/unitree-normal-v9.json`.
The session's per-view metrics are in `/tmp/unitree-normal-scene-metrics.json`.
