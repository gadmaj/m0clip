# Hosting status

## Canonical domain (2026-10-23)

The application is served at **https://m0clip.com/** through a named Cloudflare
tunnel to the existing Caddy origin on `127.0.0.1:4173`. The repository is
<https://github.com/gadmaj/m0clip>; the workspace remains `/home/g/m0clip-ts`.
Porkbun remains the registrar. The user integrated the domain with Cloudflare
and explicitly skipped further Porkbun CLI configuration.

Wrangler 4.152.0 is installed. The named connector uses the official
`cloudflared` 2026.10.3 Linux binary, checked against its published SHA256.
The old Quick Tunnel keeps its original executable and remains available for
old-origin saved-file recovery.

`m0clip-tunnel.service` is enabled under the lingering user manager. Its
configuration is `deploy/development/cloudflared.yml`; the actual named tunnel
is `m0clip`, ID `a8e4f4f9-5031-4253-84d7-ee6886062361`. The private account
certificate and tunnel JSON stay in `~/.cloudflared/`, mode 0600, outside Git.
The connector established four edge connections with no service restart.

Cloudflare nameservers are `alaric.ns.cloudflare.com` and
`tina.ns.cloudflare.com`. Three conflicting apex A records were backed up
privately and replaced with the proxied tunnel CNAME; both apex MX records
were preserved exactly. No unrelated DNS records were changed.

Real public-DNS HTTPS checks returned the exact current cycle-16 HTML,
COOP/COEP headers, and HTTP 206 with `PK\\x03\\x04` for policy bytes 0–3 of
214854099. Public resolvers return `104.21.54.122` and `172.67.138.134`.
The node's router resolver (`192.168.20.1`) still returned NOERROR with no A
answer after a guest-cache flush. A live public-DNS DoH request verified the
hostname with normal TLS validation; no application or publisher API was patched.
This transport proof is not yet the dedicated new-domain Chrome/capture proof.

The canonical redirect was pushed to `gadmaj/website` `exp` in
`232647aac977e5216d8394bf7d88380dcbbf648a`, changing only `mowat/index.html`
and `mowat/current.json`. Pages deployment and native redirect checks are
still pending. See [entry-point operations](mowat-hosting.md).

The node must remain online. Browser storage is origin-local: old-origin
policies, preferences, saved views, takes, PNGs and recovery checkpoints do not
automatically transfer to `m0clip.com`. Open the old address and download
`.take.zip` files and PNGs for backup. A permanent hostname or storage permission
does not migrate them.

## Published cycle 16: native-backed Ghost

The current immutable release is
`~/.local/state/m0clip-releases/models-native-textures-20261022-r1/`, with matching
`-source` snapshot. Ghost selects `visual-native.glb` and `props-native.glb` through
the optional `native_textures` manifest field. The required `M0CLIP_texture_vtf`
extension supplies native texture resources; exact top-level RGBA is decoded lazily
when an export needs it. Original VTF data, authored mips, sampling, geometry and
lighting remain unchanged. Shared ordinary image storage and original fallback
GLB URLs remain available. The decoded GLB payload drops by 34,320,044 bytes;
see the [native-backed Ghost notes](experience-plan.md) for its scope, not a wall-time promise.

HTML SHA-256:
`2f9de4debce5860e8c00548cdb5b2f29fdb7b2dc57f05a257bc5355316f2e2c7`.
Shell `main-CQHm4S1j.js` loads `main-B23AJOz9.js`; exporter is
`GLTFExporter-DUuYDnZ1.js`. Worker `sim.worker-7ROzdAF9.js` remains byte-identical
to cycle 15. Five new assets preceded the atomic Ghost declaration and HTML last.
All 417 unchanged canonical files, older client assets and original map bodies
remain. No Caddy/tunnel/service reload or restart.

Actual public HTTPS passes all 424 frozen body SHA/length/isolation checks,
both native GLB gzip decodes, twelve native/entity encoding cases and three policy
ZIP ranges. All 103 explicit mesh gzip files remain entities without HTTP
Content-Encoding; keep the original plain `file_server` configuration.

Private actual Chrome verifies all 1,061 native texture variants against original
RGBA and authored mip evidence. A genuine 308-frame Ronin take keeps seven tracks
and compact geometry through post, explicit point light, camera/range, normal
Shots reopen and visibly advancing Recorded/Shot. Its committed 775,266-byte PNG
survives ordinary idle reload/native Save PNG exactly. Go2/Dog passive physics and
ordinary Bullet Source GLBs also pass. The actual map-inclusive UI download imports
in Blender 4.5.14; all 436 embedded PNGs decode, including 434 pixel-exact Source
images and the unchanged Ronin texture. Native runtime lighting is not replaced.

The portable exporter still does not reproduce Source custom shaders, lightmaps
or tone mapping. Two auxiliary normal/mask DCC-role assertions remain FAIL because
that capability did not exist; this release adds no such claim. Original helper
failures and three invalid converted-map-query preview 404s remain recorded.
All nine original native movies fully decode, 19,211 frames, with verified native
timestamps. One timed-out helper movie lacks its close-callback acknowledgment;
it remains a lifecycle FAIL, separate from the finalized consumer-proof movies.

Separate public native acceptance and independent parent review pass. A genuine
copy of the closed cycle-15 profile retains all 207 prior policyDB2/ShotsDB3
records and five new records exactly through capture, reload and Go2. The real
299-frame Ronin take preserves seven tracks/compact geometry, post/range/camera,
explicit point light and visibly advancing Recorded/Shot. Its committed
775,018-byte PNG survives ordinary idle reload/native Save PNG byte-exact.
Natural unfinished loading at 32.336 seconds exercises native Pong input and
Space pause/resume, separately from the first no-input timing.

All six original public pointer films fully decode, 3,224 frames, with native
timestamps and actual clean-close acknowledgments. The first bounded metadata
owner's whole-snapshot invariant remains FAIL: all 12 sampled pixels and all
2,207 texture metadata objects match; 140 map-binding UUID changes are consistent
with nine authored-frame transitions, without exact time-causality proof.
An auxiliary favicon404 belongs to the pre-app static-JSON navigation; it and
rendering warnings remain recorded. Private full-map/Blender proof is separate.

The first public Load-to-Ready observation is 63.358 seconds with HTTP caches
cleared but genuine policy/shot data retained. It is still a long wait, not a
paired/general speedup claim. PolicyDB2 and ShotsDB3 are unchanged; never clear
browser data to deploy this release.

## Published cycle 15: edge-safe native mesh delivery (previous)

The previous immutable release is
`~/.local/state/m0clip-releases/models-explicit-mesh-20261022-r1/`, with matching
`-source` snapshot. Three production files implement explicit compressed mesh
entities: the engine, compression generator and Vite build hook. Compiler-derived
scene indexes keep their original `files` and add selected `gzipFiles`; the worker
inflates those files into the original MEMFS names. All native originals, model
geometry, textures, lighting, policy behavior, storage and 304 character files remain.

HTML SHA-256:
`0847d0f74689804ffc070713e30501b6e6f47472b1564d0b54ab64fffa277c1a`.
Shell `main-DdzW0gEU.js` loads `main-Bg4-vwv1.js`; worker
`sim.worker-7ROzdAF9.js` SHA-256:
`cbfe5e993e877e1cb86e0efd0b18abbcaea8a5461873163e43fb862279c7e419`.
Four new JS files preceded five atomic scene-index declarations and HTML last.
All 411 matching files and every older client asset remain. This explicit cutover
does not reload Caddy or restart hosting/tunnel.

Actual public HTTPS passes all 421 frozen SHA/length/isolation checks, twelve
original/entity identity, `gzip;q=0` and gzip cases, and three policy ZIP ranges.
The `.gz` files are `application/gzip` entities **without** HTTP Content-Encoding.
Keep the original plain `file_server` configuration. A rejected negotiated-gzip
prototype passed origin checks but failed public quality-zero fallback; its
original failure, graceful rollback and unsuccessful no-transform probe remain
recorded. It is not the published transport.

Private native Chrome separately qualifies all five plants and 103 actual worker
entities, real HTTP auto-decoding and an exact prior raw Go2 index. A genuine
328-frame R1/Ronin take retains seven tracks/compact IDs through post, range,
camera, normal Shots reopen and visible Recorded/Shot playback. The committed
566,934-byte PNG survives ordinary reload/native Save PNG exactly.
Nine original pointer films fully decode, 3,101 frames, with real packet timestamps
and confirmed recorder close. The original chunked-header helper FAIL and later
post-completion helper deadline remain classified; no blanket zero-error claim.
Separate actual public native acceptance and independent parent review now pass.
The genuine copied prior-public profile preserves all 202 original DB2/DB3 records,
including buffers/blobs, and the new take/photo remain exact after Go2.
Actual public R1/Go2 workers use 58 selected gzip entities with exact compressed
and original decoded hashes. A genuine 323-frame Ronin take preserves seven tracks,
compact IDs, post/range/camera and normal Recorded/Shot playback. The committed
568,087-byte original PNG survives ordinary reload/native Save PNG exactly.
Current-public Pong input/pause/resume passes at two genuine unfinished gates
over 30 seconds; the short Go2 load does not exercise positive Pong.
Three original pointer films fully decode, 3,561 frames, with actual native timing.
One auxiliary `/favicon.ico` 404 from the pre-app static-JSON snapshot navigation
and rendering warnings remain recorded; the actual app supplies a data-SVG icon.
This is scoped public R1/Go2 proof, not borrowed private all-five/all-103 coverage
or a blanket zero-error/general wall-time speedup claim.

PolicyDB2 and ShotsDB3 remain unchanged. A compatible cycle-14 rollback client
ignores `gzipFiles` and uses the retained raw models; never clear browser data.
See [cycle 15](experience-plan.md#published-cycle-15-edge-safe-native-mesh-delivery).

## Published cycle 14: capture safety and uninterrupted galleries (previous)

The previous immutable release is
`~/.local/state/m0clip-releases/models-capture-ui-20261022-r1/`, with matching
`-source` snapshot. Six production files change from cycle 13: pending-capture
navigation protection and picture-gallery synchronization/copy. All 96 choices,
90 authored bodies, physics/policy worker, original PNG ownership and storage
schemas remain unchanged.

HTML SHA-256:
`df3aa785a7684a03cc9936a665b7766b7d35ee548efff242bf242f708f4e5fdd`.
Shell `main-Df0mgkB-.js` loads `main-D6psVABY.js` after Load scene;
`sim.worker-CUgEHibF.js` remains byte-identical to cycle 13.
Three new JS files preceded atomic index replacement. All 314 matching files
and every older asset remain. No hosting/tunnel restart or reload.
Actual public HTTPS verifies all 318 frozen SHA/length/isolation results and
three policy ZIP ranges. Dedicated bounded public native acceptance and independent
parent review now pass, separately from the private qualification below.

The copied genuine prior-public policyDB2/ShotsDB3 profile preserves all 197
original records, including cached payloads, six takes and three photos.
New public native map/Source selection, a real 315-frame Ronin take, seven-track
and compact-ID preservation, post/range/camera, normal Shots reopen and visibly
advancing Recorded/Shot playback pass. An actual Chrome pending-photo reload
warning followed by Cancel, real commit ACK, guard removal and idle reload
retains the original 565,818-byte PNG exactly. Both genuine unfinished long loads
exercise Pong input/pause/resume after the 30-second gate. Three finalized pointer
films fully decode, 2,392 frames; the parent inspected the real native dialog.
Expected cancelled-navigation timeout and rendering warnings remain explicit.
This is not force-kill/crash proof or an all-rig/export regression claim.

Policy database 2 and Shots database 3 remain required for rollback clients.
Never clear user data or replace the index with an older policy-database-1 client.
See [cycle 14](experience-plan.md#published-cycle-14-capture-safety-and-uninterrupted-galleries).

## Published cycle 13: selected policy cache and Source previews (previous)

The previous immutable release is
`~/.local/state/m0clip-releases/models-policy-preview-20261022-r1/`, with matching
`-source` snapshot. It preserves all 96 choices/90 authored bodies, compact
capture, original assets and authored Source lighting. Only four production
files changed from cycle 12: policy storage/defaults/worker and the generic
remote preview URL. No model, rendering, physics or Pong change.

Public HTML SHA-256:
`66a5f1583acbe8263110dc2a01add6fccb9f347477546ee7fbb989aec5b85aee`.
Worker `sim.worker-CUgEHibF.js` SHA-256:
`2622caeef7aa141632b1900c726e3cf0d5f4d9b2bcd6e52259b83284f981df95`.
Four new JS assets preceded atomic index replacement. All 313 matching files
and every older client asset remain; hosting/tunnel were not restarted.
Actual public HTTPS verifies all 318 frozen file hashes/lengths/isolation and
three ZIP ranges. Dedicated public native core acceptance is complete with the
two workflow failures below retained; it is not a blanket zero-error result.

Private native Chrome qualified genuine prior-code UI imports and blocked-tab
recovery, exact migration of all 87 metadata records/six cached files and every
existing Shots store, zero unused Go2 payload reads, selected-only R1 hydration,
real import/switch/delete/recovery and abort-preservation boundaries. The parent
matched cached files to the actual ZIP bytes, checked captures and inspected
native footage. Four retained consumer paths preserve seven tracks/PNGs,
Recorded/Shot playback, actual GLB and sampled Blender/all-bone results.
Twelve native-pointer films fully decode; this is not exhaustive all-rig or
all-controller public GUI coverage.

Public native Chrome separately verifies a genuine old-public profile upgrade:
87 metadata records, one cached R1 pack's three files, four takes and two PNGs
remain exact. Source's default 40 previews/Picardia, real controller import/switch,
282-frame Ronin capture/post/reopen/playback, Help and passive Go2 pass.
Cycle-13 public Pong paddle/keyboard/pause/resume passes during natural long loads;
seven native-pointer films fully decode. No public GLB/video-export claim.

One PNG test reloaded while the UI still said saving, before any commit ACK.
The downloaded file and earlier data remained; no post-commit corruption was
observed. A separate acknowledged capture survived normal reload/native PNG
download exactly. A later map-picker timeout exposed a possible asynchronous
catalog/dialog ownership issue. Both original FAIL artifacts remain unchanged.
Their safety and menu fixes are now published in cycle 14.

Policy storage is version 2, Shots version 3 and portable takes format 2.
After upgrade, rollback must understand both databases or fix forward.
The old cycle-12 index alone is not a rollback client. Never clear user data.
See [cycle 13](experience-plan.md#published-cycle-13-selected-policy-payloads).

## Capture and gallery safety qualification

Private port 4235 serves the exact cycle-14 runtime and matching source snapshot.
Six production files differ from the previous public 4232.
Pending capture/photo/take writes register a native navigation warning; settled
success, failure or cancellation removes it. Original PNG ownership, storage,
downloads and policy/physics code are unchanged. Source result cards lose repeated
generic instructions, while incompatible cards retain the R1 requirement.
Map metadata refresh preserves open galleries, typed search and keyboard focus,
with newly bound canonical options. Startup metadata can arrive while open;
the workspace caller currently awaits the catalog before scene initialization.

TypeScript and two actual Chrome consumer regressions pass: a real queued photo
write blocks navigation until Cancel/release/commit, then original PNG bytes
survive an idle reload without a prompt; genuine delayed map metadata preserves
390px search/Bullet selection and 320px keyboard/Ghost selection with decoded
previews, no overflow and no heavy pre-Load requests. The older incidental
saving-versus-saved assertion was deleted, not repinned.
All 318 private and public HTTP bytes/hashes/isolation and three ZIP ranges pass.
Dedicated private native Chrome passed actual motion-save, photo-save and
screenshot-preparation beforeunload warnings. Cancel retained the same document;
commit, cancellation and a real photo transaction abort removed the guard.
The 355-frame take retained all seven tracks/compact IDs; native post, normal
reopen and moving Recorded/Shot playback pass. The 567,275-byte original PNG
survived normal reload/native Save PNG exactly. Correct live G1-disabled/R1-restored
Source cards, genuine Picardia/Help and driverless Go2 also pass.

Ten finalized pointer films fully decode, 3,186 frames. The raw eleven-file audit
remains FAIL for an original zero-byte recorder-init artifact. Original custom
Enter and wrong-startup-compatibility expectation failures remain separately
classified, not rewritten as passes. Private normal loads stayed below 30 seconds,
so positive private Pong input is unexercised. No after-entry workspace metadata
arrival or export/all-rig claims. Separate bounded public cycle-14 verification passes.
Standalone 4233/4234 snapshots remain private and were not promoted.

## Published integrated cycle: 96 choices and compact capture (previous)

The previous release was
`~/.local/state/m0clip-releases/models-driverless-20261022-r1/`, with matching
`-source` snapshot. It offers 96 pictured choices/90 authored bodies, adding
Horror Entity, Bot 02, Ronin 01, Male PSX and PSX Dog. Selected-scene asset indexes,
fixed-world capture, lossless PNG previews and genuine driverless physics are
included. The separate policy-database-2 refinement is not included.

Public HTML SHA-256:
`ced9ce2f79e5e1b5df085f5eb45ca1dcf89c8dfb15c35dcf135ea2fe7e3dc308`.
Worker `sim.worker-DIPwZOhp.js` SHA-256:
`8541909a2a867068e277613d3c2860dd280fbc97c4e53687fc0f417543ef3a9c`.
The frozen whitelist has 318 files: nine application assets, 304 character files
and five scene indexes. Actual public HTTPS verifies every byte length/hash and
isolation header, plus the three retained ZIP ranges.

Promotion installed 120 new files and five preview-only JSON updates. Images
preceded JSON, the index was atomically replaced last, and all older assets remain
for in-flight clients. Hosting/tunnel were not restarted; mutable working TS was
not deployed. Complete private native qualification covers actual compact Ghost
capture, legacy import/library migration, interrupted recovery, new models,
playback, original PNGs, GLB/VP9 and unchanged-quality whole-frame profiling.
Dedicated public native Chrome also passes the bridge, all 96 pictures at 320/390px,
actual Ghost capture, Ronin/Dog/Picardia motion, preserved tracks/PNGs, normal Shots
reopen, Recorded/Shot playback and Help. Seven native-pointer videos decode fully.
A natural 84.312-second public load revealed Pong after 30 seconds; game input
was not exercised. Two upstream preview 404s remain recorded: the search used
optional original BMPs, not the generated PNGs used by the upstream browser.
Cycle 13 above publishes the correction; the original failures remain recorded.

This release uses portable take format 2 and Shots database 3; policy storage
remains version 1. After a browser upgrade, old PSX/Solus index-only rollback is
invalid. Keep a Shots-3-capable client or fix forward; never clear a user's data.
See [cycle 12](experience-plan.md#published-cycle-12-integrated-characters-and-compact-capture).

## Published PSX cycle (previous)

The previous release was
`~/.local/state/m0clip-releases/models-psx-20261021-r1/`,
with shell `main-Cdsums-J.js` and app `main-Zli-btBx.js`. It offers 91 pictured
choices, adding all 79 original Characters PSX members. Later extras, Horror
Entity and the selected-scene asset-loading change are not in this release.
The frozen character runtime whitelist has 193 files, 75,830,870 bytes.

All 79 members passed private native Chrome motion, post editing, exact PNG
retention, animated GLB and normal Shots reopen/playback. All seven tracks stayed
intact; four real video exports cover rig/skin/packed-texture boundaries.
Parent inspected all anatomy contacts and actual decoded videos.

Promotion installed 165 new assets, preserved 36 matching assets and every older
client asset, and atomically replaced the index without restarting hosting.
Historical pre-DB3 rollback was `~/.local/state/m0clip-releases/models-solus-20261021-r2/index.html`; it is not a rollback client for current upgraded libraries.
Public HTML SHA-256:
`ef6f95a4ef13e9f976d0299aafd7d06f6d7a3e7be87540261853a2a52eeaf663`.

Actual public HTTPS verifies all 202 frozen files with required isolation.
Catalog/AMP/AMP-811 ranges retain HTTP 206 and ZIP prefixes with exact totals
214,854,099 / 6,549,053 / 6,549,587. Dedicated public Chrome also passed the portal,
all 91 pictures, real eight-weight Monster motion, a 178-frame take, exact PNG
retention and normal Shots reopen with all seven tracks and identity intact.
Recorded and Shot playback advanced with visible frames; native-pointer video
finalized and owned Chrome/display/CDP closed. Public GLB/video/quota and
all-map/all-controller suites were not repeated; private scopes remain distinct.
See [cycle 11](experience-plan.md#published-cycle-11-79-original-psx-characters).

## Published compact capture migration

The published integrated release uses portable take format 2 and Shots database
3. Earlier private candidates 4227/4228 remain unpromoted: native testing exposed
their driverless early return, which advanced clocks without physics. Fixed 4229
passed actual source-worker and native Dog/Go2 motion, hoist/manual controls,
capture/reopen/playback, real GLB/VP9 and original-PNG retention.
Complete private Ghost/legacy migration/recovery/export/profile qualification also
passes, including 1,009 recovered committed compact frames and exact old data.
Old static-take failures remain failures. Public post-promotion native smoke also
passes the scoped consumer paths above; migration/recovery proof remains private.
After the database upgrade, rollback must retain a version-3-capable client
or fix forward. Do not use an old version-2 index-only rollback against upgraded
browser data, and never clear a user's library as a rollback procedure.

## Published policy cache migration

Published cycle 13 upgrades `r1-policy-packs` to version
2: catalog metadata and network/motion payloads are stored separately and migrated
atomically. Actual Chrome legacy/abort/blocked-upgrade/offline/deletion regressions,
source-worker scenarios and dedicated native import/switch/delete/driverless
qualification pass. Genuine old-code UI data and existing Shots survive exactly.

Close older m0clip tabs if they block the upgrade. After upgrade, rollback must
retain a policy-database-2-capable client or fix forward, in addition to the
existing Shots-database-3 requirement. An old 4229 index-only rollback cannot
open an upgraded policy library. Never delete a user's data to force rollback.

The published immutable runtime is also available privately on port 4232:
`~/.local/state/m0clip-releases/models-policy-preview-20261022-r1/`, with matching
`-source` snapshot. All 318 public HTTP hashes/lengths/isolation and three ZIP
ranges pass. The worker is byte-identical to unopened 4231 plus the separate
generated-preview correction in the shell. All character/scene-index bytes
remain exact 4229. Separate public native core acceptance is complete with the
pending-save interruption and map-picker timeout retained above.

### Published Source search preview correction

The upstream name index includes valid models with no original BMP. Their
generated `{name}_small.png` files are present and used by the upstream browser.
The client now uses that format for every remote preview; no name-specific skips,
speculative failed-BMP fallback, extra metadata API or model downloads.
Actual isolated Chrome decodes the default 40 results plus two Picardia results:
42 images, including `!` and `!b`, with zero HTTP/page/network failures and no
BMP or heavy-model requests. Separate native UI also verifies these pictures,
selected Picardia and capture/reopen/playback; public native Source acceptance also passes.
Proof: `~/.local/state/m0clip-qa/2026-10-21-readability/pmodel-generated-previews-smoke/`.

## Published Solus cycle (previous)

The previous release was
`~/.local/state/m0clip-releases/models-solus-20261021-r2/`,
with shell `main-C3IuSzKl.js` and app `main-EfzfQjrd.js`. It adds the real
Solus character and removes repeated explanatory text from character cards.
The original 27 character runtime files remain exact; four Solus files bring
the frozen runtime whitelist to 31 files, 33,451,110 bytes. Private intake
archives, Blender scenes and conversion diagnostics are not public runtime files.

Seven new assets were installed before atomically replacing `dist/index.html`;
32 matching assets and all older client assets were preserved. Hosting was not
restarted. Rollback: `~/.local/state/m0clip-releases/shots-20261021-r7/index.html`.
Public HTML SHA-256:
`deb8d02091e7afeab690d69dfd4a4f09a58dfec101797de0608745041de32ea7`.

Actual HTTPS verified all 40 frozen bodies with required isolation. The catalog,
AMP and AMP-811 ZIP ranges retained HTTP 206, ZIP prefixes and exact totals
214,854,099 / 6,549,053 / 6,549,587. Private native Chrome qualified Solus motion,
post edits, reload, exact PNG retention, animated GLB and decoded video; copy-only
R2 also passed exact 320/390 pictured galleries and a bounded motion/capture path.
Dedicated public Chrome also passed the real portal, fresh Ghost/all 12 pictures,
native Solus movement, a 124-frame take, exact PNG retention, normal reload/reopen
with all seven tracks intact and advancing Recorded/Shot playback. Its native
pointer video finalized and owned Chrome/display/CDP closed. Public GLB/video/quota
and exact mobile layouts were not repeated; private qualification remains scoped.
See [cycle 10](experience-plan.md#published-cycle-10-solus-and-quiet-character-cards).

## Published characters and automatic Shots cycle (previous)

The previous 2026-10-21 release is
`~/.local/state/m0clip-releases/shots-20261021-r7/`.
It adds Gingerbread Man, The Wrapped, Skeleton, Ralph, Dragon Wyvern, the supplied
Picardia and client-side pmodels search, while retaining the existing choices.
Automatic browser-local Shots now keep completed takes, original PNGs, per-shot
edits/camera/range and committed interrupted-recording prefixes.

New application assets include `main-DZARv3Pu.js`, `main-BDeKQKZd.js`,
`GLTFExporter-CZgbBdPo.js`, `sim.worker-BPWPolxY.js` and the two
`main-DSpIPHmA.css` / `main-Dhhj2JnJ.css` stylesheets. Only 27 whitelisted
character runtime files were installed; private source archives and conversion
reports were not copied to the public tree.

Thirty-three new assets were installed before atomically replacing
`dist/index.html`; two matching assets and all older client assets were preserved.
Caddy and the tunnel were not restarted. Immediate rollback:
`~/.local/state/m0clip-releases/post-edit-20261021-r1/index.html`.
Public HTML SHA-256:
`f975a0db99cbaf6f9f3dce7f170dc7db97020cc71711c08b144f6d328393ba5b`.

Actual public HTTPS verified the HTML and all 35 asset bodies against the frozen
release, with COOP `same-origin` and COEP `require-corp`. The catalog and two
selected-policy ZIP endpoints retained HTTP 206, exact byte-range totals and the
ZIP prefix. Dedicated private Chrome qualified each new character, non-destructive
post edits, PNG/video/GLB, local library/recovery/quota paths and all six existing
physical variants. R7's matched ground-plane-On video removed the observed black
bands without removing the mirror or changing scene detail.

Dedicated public Chrome followed the real portal, matched the R7 HTML and
isolation, decoded all 11 pictured choices and exercised native Gingerbread
motion, Help, a 135-frame recording, edits, normal reload and advancing playback.
Both captured PNGs matched their stored/gallery-original bytes exactly. Native
pointer recordings finalized; collected app exceptions, console errors and
network/HTTP failures were empty. SwiftShader readback warnings and the corrected
private observer error remain recorded. See
[cycle 9](experience-plan.md#published-cycle-9-characters-and-automatic-shots)
for source permissions and software-rendering limits.
`m0clip.com` still requires the provider authorization described above.

## Published post-capture editing cycle (previous)

The previous 2026-10-21 release is
`~/.local/state/m0clip-releases/post-edit-20261021-r1/`.
New immutable assets are `main-DqEfb4HB.js`, `main-CDu4z1pG.js`,
`GLTFExporter-Bm7J5Oy_.js` and `main-CAPxsC4F.css`. Base CSS and the simulation
worker are unchanged; the selection shell remains 15.42 kB gzipped.

Those assets were installed before atomically replacing `dist/index.html`.
Older assets remain available; Caddy and the public tunnel were not restarted.
Immediate rollback:
`~/.local/state/m0clip-releases/native-lighting-20261021-r1/index.html`.
Public HTML SHA-256:
`76ca3d8a13028c77e51062602dba48832e1b5e76692cc182b4d51afa326e6e06`.

Public HTML and all four new asset bodies matched the immutable release.
COOP `same-origin`, COEP `require-corp`, and both policy ZIP range responses
remain intact: bytes 0–3 returned HTTP 206 with ZIP signature and exact totals
214,854,099 / 6,549,053.

Dedicated private headed Chrome qualified non-destructive per-take parts and
lighting, original/reset behavior, two-take isolation, actual ZIP reopen, replay,
PNG, VP9 video and animated GLB. Explicit lights relit Ghost without changing
strict-native defaults. See [cycle 8](experience-plan.md#published-cycle-8-post-capture-editing)
for the full qualification. The dedicated public walkthrough also passed real
portal entry, recording, all three light types, edited ZIP save/reopen with exact
motion hashes, advancing replay, a decoded PNG and live-preference restoration.
Its finalized native video and retained Chrome ReadPixels performance warnings
are recorded with that cycle. No new-character public availability is claimed.

At that publication, authored characters, pmodels and automatic shot storage were
working-tree additions and were excluded from the release. They are included in
the newer cycle above; the `m0clip.com` domain cutover remains unfinished.

## Published native actor-lighting cycle (previous)

The previous 2026-10-21 release is
`~/.local/state/m0clip-releases/native-lighting-20261021-r1/`.
New immutable assets are `main-CyQtQZmW.js`, `main-B7Hus8Xl.js` and
`GLTFExporter-CUZ-nmEG.js`; stylesheets and worker are unchanged.
The shell remains 15.42 kB gzipped.

Only those assets and an atomic `dist/index.html` replacement were installed.
No Caddy/tunnel restart occurred, and older client assets remain available.
Immediate rollback:
`~/.local/state/m0clip-releases/source-startup-20261020-r5/index.html`.
Public HTML SHA-256:
`f8121773de8df5cd8556011199932513d0da0a9b782e8324d2b716917328d839`.

Public HTML and all three new asset bodies match the immutable release.
COOP `same-origin` and COEP `require-corp` remain enabled. Catalog and selected
R1-policy bytes 0–3 returned HTTP 206, ZIP signature and exact totals
214,854,099 / 6,549,053. Dedicated public Chrome qualified entry, Help, actual
Go2/Flat recording, advancing replay and a downloaded/decoded PNG.

Strict-native Ghost remains dark. Native material-response and replay-cache
proof, existing Dawn/Studio warnings, and disk-exhaustion fixture limits are
recorded in [cycle 7](experience-plan.md#published-cycle-7-native-actor-lighting).
That release excluded post-editing tools and licensed character conversion work.
It did not cut over `m0clip.com`.


## Published Source-style startup and workspace cycle (previous)

The previous 2026-10-20 release is
`~/.local/state/m0clip-releases/source-startup-20261020-r5/`.
Launch shell `main-nhREu7_b.js` is 15.42 kB gzipped; lazy app
`main-DOd9Pj8X.js`, exporter `GLTFExporter-IcQEAG9A.js` and stylesheets
`main-C0Q_xXqg.css` / `main-BXFjYOd9.css` are the other new assets.
Worker `sim.worker-CUbb1E9U.js` is unchanged.

Five immutable assets were installed before atomically replacing only
`dist/index.html`. Older clients' assets and the frozen gallery-r6 preview
symlink remain intact. No Caddy or tunnel restart occurred. Immediate rollback:
`~/.local/state/m0clip-releases/startup-overlap-20261020-r2/index.html`.

Public HTML SHA-256:
`442e17308247863498ddc5b20727164ba4728f08aa001e1992358aeac48a9d3a`.
HTML and all five new asset bodies matched the immutable release. COOP
`same-origin` and COEP `require-corp` remain enabled. Catalog and selected-policy
ZIP bytes 0–3 returned HTTP 206 with ZIP signature and correct totals
214,854,099 / 6,549,053.

The public portal still follows its JavaScript bridge to the same Quick Tunnel.
Owner Chrome verified the new shell without heavy assets before Load, actual
Go2/Flat readiness, Help, explicit entry, recording and advancing playback.
Independent headed Chrome verified fresh Ghost selection, the quiet workspace,
Help/Escape, a 4.10-second/42-frame take, advancing timeline, a real 640 × 400 PNG
and return to the live scene. Its finalized 76.6-second video was inspected;
page/network/HTTP/console errors and warnings were empty.

Detailed timing, native background visibility, reduced-motion, mobile, failure,
retained-feature proof and fixture limits are recorded in
[cycle 6](experience-plan.md#published-cycle-6-minimal-source-style-startup).
This does not cut over `m0clip.com`, benchmark a cold full-Ghost WAN load or
resolve software-GPU responsiveness.

## Published startup-overlap cycle (previous)

The previous 2026-10-20 release is
`~/.local/state/m0clip-releases/startup-overlap-20261020-r2/`.
Launch shell `main-Bcr0e1re.js` remains 15.45 kB gzipped. Lazy app
`main-DDiU4_Ic.js`, worker `sim.worker-CUbb1E9U.js` and exporter
`GLTFExporter-fi3SqzCY.js` are the other new immutable assets;
`main-inOV1Kct.css` is unchanged.

All four assets were installed before atomically replacing only `dist/index.html`.
Old assets and the frozen gallery-r6 preview symlink remain intact. No Caddy or
tunnel restart occurred. Immediate rollback:
`~/.local/state/m0clip-releases/loading-20261020-r1/index.html`.

Public HTML SHA-256:
`1f2b2d3f172162448f70383b80c3eb76e180e3de4b2a05419f85c7c86f7e576c`.
HTML and all four new asset bodies matched the staged release. COOP `same-origin`
and COEP `require-corp` remained enabled. Actual catalog and selected-policy
bytes 0–3 returned HTTP 206, ZIP signature and totals 214,854,099 / 6,549,053.

Actual public Chrome followed the JavaScript bridge and loaded the new shell
without heavy assets before explicit Load. Its retained Flat/native Ghost-head
preference, measured bar, Pong, explicit entry, recording and advancing timeline
passed. The public SDK recording did not finalize; screenshot/runtime evidence
and complete dedicated local Chrome videos are retained. Internal browser and
owner-fixture diagnostics are preserved, not suppressed.
See [cycle 5 evidence and limits](experience-plan.md#published-cycle-5-overlap-real-selected-scene-work).
No custom-domain cutover or universal speedup is claimed.

## Published loading-metrics cycle (previous)

The previous 2026-10-20 release is
`~/.local/state/m0clip-releases/loading-20261020-r1/`.
It uses launch shell `main-Ctg4rNlP.js` (15.45 kB gzipped), lazy app
`main-DYk1zqzE.js`, worker `sim.worker-lteTGs49.js`, exporter
`GLTFExporter-C4g06uwK.js` and stylesheet `main-inOV1Kct.css`.

Promotion installed those five immutable assets before atomically replacing only
`dist/index.html`. Older client assets and the frozen gallery-r6 preview pointer
remain unchanged. No host or tunnel restart occurred. Immediate rollback:
`~/.local/state/m0clip-releases/head-preferences-20261020-r3/index.html`.

Public scene HTML SHA-256:
`bd2ed8c6645c17b73b974660067136ee885ef2bd1071e241cf967f50eb62ee69`.
Public HTML and all five new asset bodies matched the release. Isolation headers
remained enabled; the policy ZIP returned the correct HTTP 206 four-byte prefix
and `bytes 0-3/214854099` total.

Actual public Chrome showed Ghost selected without heavy requests before Load,
then loaded a bounded scene with the retained native Ghost head and paint.
The measured bar completed only at actual readiness. Trusted Pong input, explicit
entry, recording and live timeline playback passed without page errors.
Default full-Ghost rendering was separately exercised locally; the public smoke
does not claim a cold-WAN full-Ghost speed measurement or a domain cutover.

## Published appearance-preference cycle (previous)

The previous 2026-10-20 release is
`~/.local/state/m0clip-releases/head-preferences-20261020-r3/`.
Its launch shell is `assets/main-C0qw27vK.js` (12.29 kB gzipped); the heavy app
`assets/main-BcdTO2kM.js` loads only after Load scene. The other new hashed assets
are `GLTFExporter-DKoeu69S.js` and `main-xLHaL3C-.css`.

Promotion installed those four immutable assets before atomically replacing
`dist/index.html`. The frozen gallery-r6 preview pointer and all older hashed
assets remain unchanged. No host or tunnel restart occurred. Rollback is the
previous verified index at
`~/.local/state/m0clip-releases/visual-galleries-20261020-r6/index.html`.

Public scene HTML SHA-256:
`545894f66b3c682e63966448cbcc90286c6d121456770b58445219504365e778`.
The public HTML and all four new asset bodies matched the release; COOP/COEP
remained enabled, and the policy ZIP returned HTTP 206 with
`bytes 0-3/214854099` and the correct ZIP prefix.

Public Chrome followed the JavaScript bridge, loaded a small scene, deliberately
selected the native Ghost head, then reloaded and entered again without choosing
a new Character preset. The head preference and fitted native visual survived;
no heavy-app, WASM, GLB or ZIP request occurred before Load scene. The expanded
appearance panel left Record topmost at its actual mouse click point. No page
errors were recorded. This does not cut over `m0clip.com`, promise instantaneous
bridge navigation or establish full-Ghost software-GPU export performance.

## Published visual-gallery cycle (previous)

The previous 2026-10-20 release used `assets/main-UtFn85it.js` for the 12.10 kB
gzipped launch shell and lazily imported `assets/main-CnX0m470.js` after Load scene.
Its immutable release remains at
`~/.local/state/m0clip-releases/visual-galleries-20261020-r6/`.
`dist/assets/previews` points to that candidate's frozen preview directory, not
the mutable generator output in `public/`. All 63 real preview files and their
manifest are retained with the release.

Promotion added four new hashed assets without overwriting old clients' assets,
verified the preview pointer through Caddy, then atomically replaced only
`dist/index.html`. The previous verified launch release remains at
`~/.local/state/m0clip-releases/launch-20261020-r2/`; its index can be restored
atomically without deleting any assets. No host or tunnel restart occurred.

Public scene HTML SHA-256:
`0354be3052651d439bf22113b12a171476e088d1441d80c2e5cf336fa53d6b21`.
The existing `gadmaj.org/mowat/` bridge is a JavaScript redirect page, not the
scene HTML. Chrome followed it to the new release, exercised pictured choices,
explicit Tinbot entry, native Space/Escape, real recording and timeline playback.
The public preview manifest, cross-origin isolation and policy ZIP byte ranges
passed. This does not change `m0clip.com` or claim a hardware-GPU benchmark.

## Published launch cycle (previous)

The 2026-10-20 release uses `assets/main-Dm3yAkUU.js` as its small launch shell,
then dynamically loads `assets/main-_vkL1Brn.js` after the scene choice. The
blocking typed intro is gone; Ghost is the fresh default, Pong is immediately
available, and a top-right Help dialog owns keyboard input while open.

The candidate was typechecked, built outside `dist/`, exercised by a dedicated
headed Chrome QA worker, and promoted by installing immutable hashed assets
before atomically replacing `dist/index.html`. Old hashed assets remain available
for open clients. The original release is retained as hardlinks at
`~/.local/state/m0clip-releases/before-launch-20261020/`; the verified candidate
is `~/.local/state/m0clip-releases/launch-20261020-r2/`.

No service or tunnel restart occurred. Public HTML matched the candidate, the
existing redirect reached its launch screen, isolation headers and policy ZIP
ranges remained correct, and the actual public R1/Tinbot scene and held-key Help
interaction passed. Detailed checks and remaining goals are in
[the experience plan](experience-plan.md).

## Persistent VM vitals

`m0clip-vitals.service` is enabled under the lingering user manager, independently
of SSH and OMP. It samples every ten seconds; it does not change resource limits,
kill jobs, restart hosting, or require Proxmox credentials.

```sh
python3 scripts/monitor_vm_vitals.py --status
systemctl --user status m0clip-vitals.service
journalctl --user -u m0clip-vitals.service
```

Latest structured counters are in `~/.local/state/m0clip-vitals/current.json`.
`samples.jsonl` rotates at 8 MiB with seven backups, bounded to approximately
64 MiB. The service is low-priority (`Nice=10`) and capped at 64 MiB RAM.
The first persistent smoke used about 10 MiB, with no restarts. Counter-reset
intervals and unavailable cgroup counters are reported as unknown, not zero.

Recorded metrics include CPU work, idle, I/O wait and hypervisor steal; CPU,
memory and I/O pressure; available RAM; swap capacity and actual paging; guest
cgroup quota throttles and OOM kills; and root/shared-memory free space.
Warnings distinguish nearly full swap from active swapping.

The 2026-10-23 startup check saw 12 vCPUs and 30.6 GiB guest RAM. Its first
persistent sample had 97.9% CPU idle, 0.008% steal, no new guest cgroup quota
throttles, 10.7 GiB available RAM, no active swap I/O, and zero ten-second memory
or I/O pressure. The 512 MiB swap was full. These observations do not establish
Proxmox reservations, physical-host thermal limits, or the absence of future
contention; those require host-side evidence.

## Previous deployment verification

Hosting now runs on the user's Ubuntu device `gdev-kubu`, `g@192.168.20.156`.
The source workspace is `/home/g/m0clip-ts`; `/home/g/noclip.website`
contains the native reference and `/home/g/unitree-ghost-before-native-vtf` retains
original Ghost masters. The local SSH alias is `unitree-dev`.

Before the launch cycle, the live entry was `assets/main-CYmTJ1YW.js`, named
`welcome 2mowats little playpen`. All 24 NeoTokyo maps passed consecutive Chromium
selection/render and resource-cleanup checks. The release includes transparent
draggable panels, the typed IBM Plex Mono intro, modular characters and corrected
native rendering. Rootless Caddy 2.11.7 serves `dist/` on `127.0.0.1:4173`, with
cross-origin isolation, GLB compression and policy-pack byte-range loading.
The public URL returned the exact new release HTML;
a request for bytes 0-3 of `assets/packs/r1-default-v1.zip` returned HTTP 206 and the
correct ZIP signature with the total size 214854099 bytes.
Public Chromium also passed the redirect, intro, font, panel dragging, character
selection and 24-map catalog checks. See `docs/development-migration.md` for logs.

The previous v9 release (`assets/main-C7Ii0RBv.js`) is retained at
`~/.local/state/unitree-renderer/stable-v9-before-m0clip/`. Its migration check
recorded 77 cubemap bindings, native tone mapping, no fog, 71 shader programs and
no shader errors. The old workspace path remains a compatibility symlink; current
service templates and installed units use `/home/g/m0clip-ts`. Caddy was reloaded
without rotating the public tunnel address.

The stable public entry point is <https://gadmaj.org/mowat>. The page resolves
and opens the active Cloudflare tunnel. The node checks for a new address every
30 seconds and publishes a healthy destination to the website repository's exp
branch. The current address is published in
<https://gadmaj.org/mowat/current.json>.
See [MoWAT link operations](mowat-hosting.md) for checks and recovery.
Hosting and link updates continue without the original computer staying online.

These are user systemd services on the destination, enabled for automatic startup:

- `unitree-host.service`: Caddy and the stable release.
- `unitree-public.service`: the public Cloudflare tunnel.
- `unitree-dev.service`: Vite development on `127.0.0.1:5176`.
- `unitree-mowat-link.timer` / `unitree-mowat-link.service`: update the public entry point.

User lingering is enabled. Service processes belong to the persistent user manager,
not the migration SSH session. Templates and helpers are in `deploy/development/`.
Open the `Unitree development terminal` desktop shortcut or run
`bash deploy/development/terminal.sh` to attach the persistent `unitree` terminal.
Its `workspace`, `logs` and `checks` windows provide the shell, live service output
and browser verification respectively. `Unitree Chrome preview` explicitly opens
Google Chrome at the development URL on that device.

`deploy/home/` remains available for a Docker/Caddy deployment with a stable domain.
The current device uses the rootless services above; Docker was not required.

A managed Sites draft was created before the user selected the home server. It was
not published. Its ID is `appgprj_6ad536e65300819188f80a912bf5f3fc`; do not create a
duplicate if managed hosting is requested later. The unused draft checkouts on the
original computer were not used for this deployment. No application assets were
uploaded to managed storage, and temporary managed-upload secrets were removed.

The native VTF/mip work is part of this release. Future changes should still be
built and validated outside the serving `dist/`, then promoted with a retained
rollback copy. Source changes for this release remain uncommitted in the renamed
workspace.
