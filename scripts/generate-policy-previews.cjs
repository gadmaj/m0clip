'use strict';
/** Sole browser owner runs this job against the gallery-enabled candidate.
 * BASE_URL=... PREVIEW_OUTPUT=/private/new-directory node scripts/generate-policy-previews.cjs /private/job.json
 * Explicit approved pack only. Captures real worker frames and their simulation clocks;
 * does not synthesize poses, patch physics or fetch the remote player-model database.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launch, capture } = require('./generate-previews.cjs');
const { unzipSync, strFromU8 } = require('fflate');
const { chooseVisual } = require('./choose-visual.cjs');
const run = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

(async () => {
  const job = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  if (!job.approvedRuntimeAsset || !job.attribution || !job.packSHA256 || !job.policy || !job.robot) throw new Error('Explicit approved policy, pack hash and source attribution required');
  const count = job.frames ?? 48, fps = job.fps ?? 12;
  if (!Number.isInteger(count) || count < 12 || count > 120 || fps < 1 || fps > 30) throw new Error('Use 12–120 frames and 1–30 fps');
  const pack = await fs.readFile(job.pack);
  if (hash(pack) !== job.packSHA256) throw new Error('Approved pack hash changed');
  const files = unzipSync(pack, { filter: file => file.name === 'pack.json' });
  if (!files['pack.json']) throw new Error('Approved pack has no pack.json');
  const manifest = JSON.parse(strFromU8(files['pack.json']));
  const policies = manifest.checkpoints.map(checkpoint => manifest.checkpoints.length > 1
    ? `${manifest.baseName}@${checkpoint.id}` : manifest.baseName);
  if (!policies.includes(job.policy)) throw new Error('Requested canonical policy is not declared by the approved pack');
  const output = path.resolve(process.env.PREVIEW_OUTPUT);
  await fs.mkdir(output, { recursive: false });
  const scene = await launch(job.robot, 'flat');
  const frames = [], captures = [], clocks = [];
  try {
    await scene.page.evaluate(bytes => {
      const state = window.__previewPolicy = { clock: null, status: null, errors: [], target: null };
      window.__app.worker.addEventListener('message', event => {
        const message = event.data;
        if (message.t === 'status') state.status = message;
        if (message.t === 'error') state.errors.push(message.msg);
        if (message.t === 'frame') {
          state.clock = message.clock;
          state.qpos = Array.from(message.qpos);
          if (state.target !== null && message.clock >= state.target) {
            state.target = null;
            window.__app.worker.postMessage({ t: 'pause', on: true });
          }
        }
      });
      const zip = Uint8Array.from(bytes).buffer;
      window.__app.worker.postMessage({ t: 'importPack', zip }, [zip]);
    }, Array.from(pack));
    await scene.page.waitForFunction(policy => Array.from(document.querySelector('#sel-policy').options).some(option => option.value === policy), job.policy, { timeout: 300000 });
    const declared = await scene.page.evaluate(policy => {
      const status = window.__previewPolicy.status;
      const entry = status?.policies.find(entry => entry.name === policy);
      return { entry, pack: status?.packs.find(pack => pack.id === entry?.packId) };
    }, job.policy);
    // The worker resolves variants through specFor; shared compiled model identity is not sufficient.
    if (declared.entry?.packId !== manifest.baseName || declared.pack?.robot !== manifest.robot ||
        declared.entry?.previewRobot !== job.robot) {
      throw new Error('Requested robot/policy does not match approved pack and worker variant: ' + JSON.stringify(declared));
    }
    if (await scene.page.locator('#toggle-menu').getAttribute('aria-expanded') === 'false') await scene.page.locator('#toggle-menu').click();
    await chooseVisual(scene.page, 'policy', job.policy);
    await scene.page.waitForFunction(policy => window.__previewPolicy.status?.policy === policy, job.policy, { timeout: 300000 });
    await scene.page.evaluate(command => {
      const worker = window.__app.worker;
      worker.postMessage({ t: 'state', state: 'policy' });
      worker.postMessage({ t: 'command', cmd: command });
    }, job.command ?? [0, 0, 0]);
    await scene.page.waitForFunction(() => window.__previewPolicy.status?.state === 'policy' && window.__previewPolicy.clock !== null, null, { timeout: 300000 });
    for (let index = 0; index < count; index++) {
      await scene.page.evaluate(step => {
        const state = window.__previewPolicy;
        state.target = state.clock + step;
        window.__app.worker.postMessage({ t: 'pause', on: false });
      }, 1 / fps);
      await scene.page.waitForFunction(() => window.__previewPolicy.target === null, null, { timeout: 300000 });
      // Let already-posted real frames settle after the worker receives pause.
      await scene.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const state = await scene.page.evaluate(() => ({ clock: window.__previewPolicy.clock, qpos: window.__previewPolicy.qpos,
        status: window.__previewPolicy.status, errors: window.__previewPolicy.errors }));
      if (state.errors.length || state.status.policy !== job.policy || state.status.state !== 'policy' || state.status.robotSpec !== job.robot) throw new Error('Policy identity/state changed: ' + JSON.stringify(state));
      const filename = `${String(index).padStart(4, '0')}.png`;
      captures.push({ ...(await capture(scene, { kind: 'policy', format: 'png', filename,
        angle: -Math.PI / 3 + index * Math.PI * 2 / count })), clock: state.clock, qposSHA256: hash(JSON.stringify(state.qpos)) });
      frames.push(path.join(output, filename)); clocks.push(state.clock);
    }
  } finally { await scene.browser.close(); }
  const clockFile = path.join(output, 'clocks.json');
  await fs.writeFile(clockFile, JSON.stringify(clocks));
  const { stdout } = await run(process.env.PYTHON || 'python3', [path.join(__dirname, 'encode_character_previews.py'),
    '--animation-output', path.join(output, 'encoded'), '--timestamps', clockFile, '--fps', String(fps), ...frames]);
  await fs.writeFile(path.join(output, 'inventory.json'), JSON.stringify({ job, captures, encoding: JSON.parse(stdout),
    description: 'Actual policy simulation frames; camera makes one full orbit; GIF timing follows captured simulation clocks.' }, null, 2) + '\n');
  const slug = `${job.robot}-${hash(job.policy).slice(0, 12)}`;
  const prefix = `/assets/previews/animated/policies/${slug}`;
  await fs.writeFile(path.join(output, 'encoded', 'attribution.json'), JSON.stringify(job.attribution, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'catalog.json'), JSON.stringify({ characters: {}, policies: {
    [`${job.robot}:${job.policy}`]: { still: `${prefix}/still.min.png`, animation: `${prefix}/turntable.gif`,
      caption: 'Policy playback · 360° view' },
  } }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
