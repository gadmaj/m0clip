# policy-packs

Distributable **policy packs** (`.zip`) live here. Import them in the app via
**📦 Policy manager → Import pack / bundle (.zip)**. The repo ships none — the
actual `.zip` files are gitignored, because the weights are yours (extracted
from your own robot); this project is a neutral evaluator, not a policy
distributor.

This deployment also serves the user's R1 catalog at
`public/assets/packs/r1-default-v1.json`, generated with
`node scripts/host-default-packs.mjs /path/to/r1-all.zip`. It is imported automatically once per
browser, without replacing existing packs with the same identifier. Weights are
downloaded and saved only when a policy is selected. Deleting a
pack does not cause it to be imported again on reload. Additional bundles still
use the manual import below; the G1 bundle is not downloaded automatically.

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

- `robot` — `g1`, `r1`, `r1_air` or `go2`. Air and EDU variants share one robot
  slot; the app adopts the right model from the selected policy automatically.
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
