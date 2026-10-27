# policy-packs

Import policy packs through **Controls → Play → Packs → Import .zip…**.
Policy weights are not included in the repository. Supply weights you are
allowed to use, and check their terms before distributing a hosted build.

## Pack format

A pack is a `.zip` containing:

```
pack.json                 manifest (see below)
config.yaml               the policy config (obs scheme, gains, family, robot)
checkpoints/<id>.onnx …   one or more weight checkpoints (SAME obs scheme)
aux/<role>.onnx …         optional extra networks the driver runs (manifest `aux`)
aux/<role>.csv|… …        optional data files: motion / latent clips, tables (manifest `auxFiles`)
motion_clip.csv           optional reference clip (G1 mimic, manifest `clip`)
```

All checkpoints in a pack share `config.yaml`; only the weights differ. Each
checkpoint shows up as its own selectable policy, and the whole pack is grouped
under `manifest.group` in the picker. The web runtime is ONNX-only — `.mnn`
weights must be converted to `.onnx` before packing.

`pack.json`:

```json
{
  "schemaVersion": 1,
  "group": "cpy_walk_run_29dofs",
  "robot": "g1",
  "family": "g1_locomotion",
  "baseName": "cpy_walk_run_29dofs/actor",
  "config": "config.yaml",
  "checkpoints": [
    { "id": "actor", "file": "checkpoints/actor.onnx" }
  ],
  "aux": { "stance": "aux/stance.onnx" }
}
```

- `robot` — the robot or variant the pack was built for. Use a supported
  identifier; changing this label does not make a policy compatible with another robot.
- `group` — the obs-scheme label the picker clusters policies under.
- `baseName` — the pack id and policy display name (`baseName@id` when a pack
  holds several checkpoints).

## Bundles (share a whole set)

A **bundle** is simply a `.zip` whose entries are pack `.zip`s — one file per
robot model (`g1-all.zip`, `r1-all.zip`, `go2-all.zip`, built by
`node scripts/build-packs.mjs --robot <g1|r1|go2>`). Upload it to any file host;
whoever downloads it imports the **one** file and gets every pack at once. The
importer auto-detects single pack vs bundle (a bundle has no top-level
`pack.json`).

Imported packs persist in the browser (IndexedDB); remove them any time from
the Policy manager.
