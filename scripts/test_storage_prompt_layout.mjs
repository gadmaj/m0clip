/** Issue #119: the storage prompt sits at the workspace top and windows sharing its columns start
 * below it, so it never covers the Play window (policy picker), the dock or the Flight HUD.
 * Exercises the real FloatingWorkspace layout functions; browser QA still owns actual geometry. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import buildFixture from './build-fixture.cjs';

const dir = await mkdtemp(join(tmpdir(), 'm0clip-storage-prompt-'));
const file = join(dir, 'layout.mjs');
let noticeRoom, windowTop;
try {
  await writeFile(file, (await buildFixture({ root: process.cwd(), source: "export { noticeRoom, windowTop } from './src/ui/floating-workspace';",
    platform: 'node', format: 'es', externalPackages: true })).code);
  ({ noticeRoom, windowTop } = await import(file));
} finally { await rm(dir, { recursive: true, force: true }); }

const BAR = 46, PADDING = 26; // title bar incl. border; prompt padding + border (border-box minimum)
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Composes the workspace the way FloatingWorkspace.apply/placeNotice do for one window. */
function layout({ width, height, workspaceTop, dock, hudHeight = 0, natural, windowX, windowWidth }) {
  const floor = height - dock - 24;
  const hud = hudHeight ? { left: 12, right: width - 12, bottom: height - dock - 62, top: height - dock - 62 - hudHeight } : null;
  const room = noticeRoom(workspaceTop, floor, BAR, hud ? hud.top : null);
  const right = 12 + Math.min(340, width - 24);
  const notice = { left: 12, right, top: workspaceTop, bottom: workspaceTop + Math.max(PADDING, Math.min(natural, room)) };
  const top = windowTop(workspaceTop, floor, BAR, { left: windowX, right: windowX + windowWidth }, notice);
  return { floor, hud, room, notice, title: { left: windowX, right: windowX + windowWidth, top, bottom: top + BAR },
    dock: { left: 12, right: width - 12, top: height - 12 - dock, bottom: height - 12 } };
}

// Room: a title bar and both 12 px gaps always fit; a visible HUD lowers the end; never negative.
assert.equal(noticeRoom(114, 620, BAR, null), 620 - 114 - BAR - 12);
assert.equal(noticeRoom(114, 620, BAR, 422), 422 - 12 - 114 - BAR - 12);
assert.equal(noticeRoom(114, 620, BAR, 700), 620 - 114 - BAR - 12, 'A HUD below the floor does not shrink the room');
assert.equal(noticeRoom(300, 320, BAR, null), 0);

// Without a visible prompt, or outside its columns, windows keep the existing workspace top clamp.
assert.equal(windowTop(84, 678, BAR, { left: 20, right: 324 }, null), 84);
assert.equal(windowTop(84, 678, BAR, { left: 956, right: 1260 }, { left: 12, right: 352, bottom: 288 }), 84, 'Scene on desktop is not moved');
assert.equal(windowTop(84, 100, BAR, { left: 20, right: 324 }, null), Math.max(12, 100 - BAR), 'Dock floor still wins on short screens');

// Return visit, 390 px: the compact Play window (policy picker) starts below the prompt.
const phone = layout({ width: 390, height: 844, workspaceTop: 114, dock: 200, natural: 204, windowX: 12, windowWidth: 366 });
assert.equal(phone.notice.bottom, 318);
assert.equal(phone.title.top, 330);
assert.ok(!intersects(phone.notice, phone.title) && phone.title.bottom <= phone.floor);
// Flight on: the prompt also ends a title bar above the HUD.
const flight = layout({ width: 390, height: 844, workspaceTop: 114, dock: 200, hudHeight: 160, natural: 204, windowX: 12, windowWidth: 366 });
assert.ok(!intersects(flight.notice, flight.title) && !intersects(flight.notice, flight.hud));
assert.ok(flight.title.bottom <= flight.hud.top - 12, 'Play title stays above the Flight HUD');
// 320 px, short: the prompt scrolls inside its room instead of covering Play.
const small = layout({ width: 320, height: 568, workspaceTop: 162, dock: 230, natural: 222, windowX: 12, windowWidth: 296 });
assert.equal(small.room, 314 - 162 - BAR - 12);
assert.equal(small.notice.bottom - small.notice.top, small.room);
assert.equal(small.title.top, small.notice.bottom + 12);
assert.ok(small.title.bottom <= small.floor);
// Desktop: the Play window at its home x moves below the prompt instead of under it.
const desktop = layout({ width: 1279, height: 812, workspaceTop: 84, dock: 110, natural: 204, windowX: 20, windowWidth: 304 });
assert.equal(desktop.title.top, desktop.notice.bottom + 12);

// Property: whenever the room holds the prompt's padding, nothing it shares columns with is covered.
let cases = 0;
for (const width of [320, 360, 390, 414, 768, 1280]) {
  for (const height of [568, 640, 667, 740, 844, 900]) {
    for (const hudHeight of [0, 110, 160]) {
      for (const natural of [150, 204, 260]) {
        const workspaceTop = width <= 360 ? 162 : width <= 760 ? 114 : 84, dock = width <= 760 ? 200 : 110;
        const actual = layout({ width, height, workspaceTop, dock, hudHeight, natural, windowX: 12, windowWidth: Math.min(304, width - 24) });
        if (actual.room < PADDING || (actual.hud && actual.hud.top < workspaceTop + BAR + 24)) continue;
        cases++;
        const label = JSON.stringify({ width, height, hudHeight, natural });
        assert.ok(actual.notice.bottom - actual.notice.top <= actual.room, label);
        assert.ok(!intersects(actual.notice, actual.title), `Prompt covers the window title ${label}`);
        assert.ok(!intersects(actual.notice, actual.dock), `Prompt covers the dock ${label}`);
        if (actual.hud) assert.ok(!intersects(actual.notice, actual.hud) && actual.title.bottom <= actual.hud.top - 12, `Prompt or title meets the HUD ${label}`);
        assert.ok(actual.title.bottom <= actual.floor, `Window title passes the floor ${label}`);
      }
    }
  }
}
assert.ok(cases > 200, `Property cases exercised: ${cases}`);
console.log(`storage prompt layout: ok (${cases} property cases)`);
