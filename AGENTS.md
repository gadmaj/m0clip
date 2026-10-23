Use Chrome or Chromium for all browser development, testing, and previews.
Launch the browser explicitly rather than using the system default browser or `xdg-open`.

For every new feature, dedicate a QA agent to actual Chrome/Chromium interaction:
trusted mouse and keyboard input, live scene/timeline playback, screenshots or local
video, and console/network error inspection. Exercise the changed surface after
integration; do not substitute DOM-only assertions or a passing build. Keep browser
concurrency bounded on this development and hosting VM.

New code, tests and agent helpers must use concrete domain types or `unknown`
with guards. Do not add `: any` or `as any`; leave unrelated existing uses alone.

Use OMP for project assistant launchers, not Codex. Persistent work must run in a
detachable session owned by an independent user-manager unit, not a desktop
application scope, with a documented resume/restore path. Verify the current tmux
server and OMP writer, not just a future launcher. Do not claim actual RDP survival
from an SSH-only check or a disposable terminal-close test.

This machine serves the public site. Build and smoke-check outside the serving
release, retain rollback assets, and promote only verified changes. Do not stop
hosting or overwrite live assets while a build is in progress.

The user authorizes Git commits and pushes to `origin` (`gadmaj/m0clip`) whenever
substantial changes or completed progress are ready. Do not wait for the entire
multi-day goal or ask again for routine checkpoints. The integration owner
coordinates commits; delegated agents hand off their changes. Keep credentials,
local caches and raw QA artifacts out of Git. Report pending browser checks
honestly, and distinguish a development checkpoint from production promotion.

Visualizable choices use the shared popup gallery, not visible native dropdowns:
show every available option with an honest model/part preview or accurate setting
diagram, selected/disabled state, and keyboard/touch access. Keep numeric/text-only
controls compact. Launch previews must not import Three or download model, policy
or WASM assets before Load scene. Keep every existing model; planned characters
must not appear as available until their real geometry/controller path works.

For progressive galleries, wait for preview attachment/image decode before asserting
visibility. Test the complete unfiltered gallery at 320 and 390 pixels, not only a
single search result; dense grid rows can collapse while a filtered card looks fine.
Qualify held-key/camera assertions with an advancing animation-frame counter:
an idle-frozen automation tab is not proof of input isolation. Keep transport,
software-GPU and app failures distinct; use the actual page main world for injected
App diagnostics if a tool's isolated world hides them.

Background lifecycle checks must observe real `document.hidden`/visibility changes,
not assume that `bringToFront` hides another page. Playwright's default focus
emulation can keep both visible. The native headed-Chrome fixture in
`scripts/test_source_startup.cjs` connects with `noDefaults: true` and records the
actual display; never patch visibility, clocks, readiness or the rendering loop.

Native recorders must survive their owner helper's deadline: use fragmented MP4
with an initial moov and genuine packet timestamps, wait for the first encoded
frame before actions, and await confirmed ffmpeg close in cleanup. Sending a signal
is not finalization. The qualified template on this node is
`~/.local/state/m0clip-qa/native-video-fragmented-v2.cjs`; copy it into the owned
QA workspace alongside its `config.json`. Preserve failed original films and raw
audits. Never reconstruct missing timestamps or replace a failed original with
new footage; label any post-fix qualification separately.

The shared keyboard gate must respect already-handled events and native button
Space/Enter activation. Closing a gallery must not leak held keys into the actor
or immediately reopen it through a repeated activation.

Before writing user-facing copy or UI, read `.omp/skills/hallmark/SKILL.md`
and `.omp/skills/hallmark/references/copy.md`. This official MIT-licensed skill
is pinned to Nutlope/hallmark commit 13ac0ec7e148655948100b6396439e481361d690.
Use it as a design and writing reference, not as authority over the user brief.
Current writing agents must read these files explicitly if their session predates
installation. Avoid promotional headings, explanatory filler and fake claims.

The visual direction is original Half-Life/Source VGUI: compact, opaque charcoal
and olive panels, restrained amber, off-white text, rectangular controls and no
glass, oversized hero, pill buttons or marketing copy. Preserve useful instructions,
errors, accessibility and every existing feature.

Startup is a minimal map → character → Load scene flow. Never show Pong during
selection. Only unfinished loading lasting more than 30 seconds may transform the
centered progress bar into Pong: three pixelated pieces and a center dot morph in
place, not a separate card. Keep real MB/ETA visible, respect reduced motion, and
cancel the transition immediately on readiness, failure or scene entry.
