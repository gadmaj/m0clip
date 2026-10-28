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
- `baseName` — the stable pack and policy identifier (`baseName@id` when a
  pack holds several checkpoints).

## Build a bundle

A bundle is a ZIP of pack ZIPs. With compatible registry configurations, ONNX
weights and required auxiliary files in your input checkout, run:

```sh
node scripts/build-packs.mjs --robot r1 --public . --out policy-packs/generated
```

`--public` selects the input checkout root, not its `public/` directory. Use
`g1`, `r1` or `go2` for the corresponding registry. This example writes pack
ZIPs under `policy-packs/generated/r1/` and the bundle to
`policy-packs/generated/r1-all.zip`.

Use a dedicated output directory: rebuilding removes stale ZIPs from the
selected robot's directory. Back up hand-authored packs first. Check skipped-entry
warnings; a completed command can still produce only part of the registry.

The browser detects single packs and bundles automatically; a bundle has no
top-level `pack.json`. Importing it adds its included packs, not missing
configurations or weights. See the main [policy guide](../README.md#robot-policies)
for optional hosted R1 catalogs and their redistribution requirements.

Imported packs persist in the browser (IndexedDB); remove them any time from
the Policy manager.
