# Source robot visuals on R1

The conveyor body in `nt_ghost_ctg.bsp` is NeoTokyo's girlbot. Original files:

| Model | Triangles | Native articulation |
| --- | ---: | --- |
| `models/nt/props_tech/girlbot_body.mdl` | 1,704 | One `static_prop` bone; connected torso and both legs |
| `models/nt/props_tech/girlbot_head.mdl` | 366 | One `static_prop` bone; independently authored head |
| `models/nt/props_tech/girlbot_leftarm.mdl` | 332 | One bone; connected upper and lower arm |
| `models/nt/props_tech/girlbot_rightarm.mdl` | 332 | One bone; connected upper and lower arm |
| `models/nt/props_tech/girlbot_full.mdl` | 2,734 | Static complete assembly |

All use the native `models/props_tech/girlbot` material. The extraction preserves
original indices, UVs, normals and textures; it neither cuts the limbs nor invents
an articulated skeleton. Reproduce the assets and machine-readable report with:

```sh
python scripts/analyze_source_robot.py
```

The app's **Robot appearance → Head visual** selector offers the original head as
an optional R1 cosmetic. Its shape is uniformly fitted to the R1 head envelope;
R1's joint transforms, physics, observations, controls and geom indices are kept.
Stock remains the default. Recording waits for the asset, locks the choice during
the take, and saves it for review and export. The cosmetic retains native base and
normal maps while using the existing robot material path; it is not a claim of
complete original Source Phong rendering on the replacement head.

Supported models are R1 and R1 Air EDU, which have `head_yaw_link`. Plain R1 Air
has no head visual, so the selector is omitted. Stock visuals can be restored.

Replacing every R1 part with this girlbot requires new joint segmentation,
interior caps or skin weights at elbows/knees, rest-pose alignment, and explicit
R1 attachment transforms. A nearest-joint cut would change the original surface
and can leave holes, so it has not been substituted for a real articulated skin.

**Dog (Half-Life 2)** is now an optional full-body R1 visual under **Robot appearance →
Robot model**. Reproduce the original asset with:

```sh
python scripts/import_source_dog.py
```

The importer preserves all 5,855 triangles, 58 bones, native skin weights, inverse
bind matrices, UVs and original textures. It also derives a standard emissive map
from Source's base-alpha illumination mask. The viewer retains the native normal
and metal-detail maps. This cosmetic uses the robot's editable physical materials;
it does not replace them with Source's full Phong shader.

R1's compiled body and geom frames drive the native skeleton, including separate
hips, knees, ankles, shoulders, elbows, wrists, spine and available head motion.
Unmapped fingers and mechanisms retain their native local bind transforms. The
fit uses a uniform scale and keeps the original limb proportions. A sole-plane
offset anchors the visual to R1's recorded feet, including placement and replay.
R1's collision geometry, mass, joint limits, policy and observations stay intact.

Per-part tints and finishes, picking, brightness, dull mode, hide/fade, recording,
review, PNG/video and Blender exports support the full body. Recording waits for
its asset and locks appearance. Exported skeletal keys are resampled from the take;
tests compare the loaded GLB bone transforms to replay. Original texture channels,
including RGB stored under zero alpha, survive the lossless PNG export path.
Stock R1 can be restored, and older takes use stock visuals. The selection is saved
per robot; `?map=nt_ghost_ctg&body=dog` opens Ghost with Dog selected.

The Combine scanner (11 bones) and floor turret (5 bones) remain header-only
candidates; no articulated replacements have been inferred for them.

Generated game assets and detailed JSON reports live in
`public/assets/source-robots/neotokyo-girlbot/` and
`public/assets/source-robots/halflife2-dog/`, outside Git like the map assets.
