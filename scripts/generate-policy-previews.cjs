'use strict';
/** Sole browser owner runs this job against the gallery-enabled candidate.
 * BASE_URL=... PREVIEW_OUTPUT=/private/new-directory node scripts/generate-policy-previews.cjs /private/job.json
 * Retains bounded raw qpos, actual controlled-joint addresses and exact selected
 * worker identity for every frame; rejects finite handovers and frozen joints.
 * Does not synthesize poses, patch physics or fetch remote player models.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launch, capture } = require('./generate-previews.cjs');
const { unzipSync, strFromU8 } = require('fflate');
const { load: yamlLoad } = require('js-yaml');
const { chooseVisual } = require('./choose-visual.cjs');
const run = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Optional shared private-artwork admission, including retained failed attempts.
const budgetRoot = process.env.PREVIEW_BUDGET_ROOT && path.resolve(process.env.PREVIEW_BUDGET_ROOT);
async function retainedBytes(directory) {
  let bytes = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Artwork budget roots must not contain borrowed links');
    bytes += entry.isDirectory() ? await retainedBytes(filename) : (await fs.stat(filename)).size;
  }
  return bytes;
}
async function admit(additional = 0) {
  if (!budgetRoot) return;
  const cap = Number(process.env.PREVIEW_BUDGET_BYTES), floor = Number(process.env.PREVIEW_MIN_FREE_BYTES),
    reserve = Number(process.env.PREVIEW_RESERVE_BYTES);
  if (![cap, floor, reserve, additional].every(value => Number.isSafeInteger(value) && value >= 0) || !cap) {
    throw new Error('Artwork admission requires explicit byte cap, free-space floor and closure reserve');
  }
  const usage = await retainedBytes(budgetRoot), disk = await fs.statfs(budgetRoot);
  if (usage + additional + reserve > cap || disk.bavail * disk.bsize - additional - reserve < floor) {
    throw new Error(`Artwork budget/floor reached: retained=${usage}, next=${additional}, reserve=${reserve}, free=${disk.bavail * disk.bsize}`);
  }
}
async function receipt(filename, value, append = false) {
  const bytes = JSON.stringify(value, null, append ? undefined : 2) + '\n';
  await admit(Buffer.byteLength(bytes));
  await fs[append ? 'appendFile' : 'writeFile'](filename, bytes);
}

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
  const configFiles = unzipSync(pack, { filter: file => file.name === manifest.config });
  if (!configFiles[manifest.config]) throw new Error('Approved pack has no declared config');
  const config = yamlLoad(strFromU8(configFiles[manifest.config]));
  // G1VqDriver retains control_joints order in inspect.actions; only task mode
  // applies the authored model-slot mask. Unknown unmasked names remain errors.
  const g = config.g1, maskedJoints = g?.obs_scheme === 'vq' && g.vq?.mode === 'task'
    ? g.vq.masked_joints ?? [] : [];
  const controlJoints = g?.control_joints;
  if (maskedJoints.length && (!Array.isArray(maskedJoints) || !Array.isArray(controlJoints) ||
      !controlJoints.every(slot => Number.isInteger(slot) && slot >= 0 && slot < g.default_dof_pos.length) ||
      !maskedJoints.every(slot => Number.isInteger(slot) && controlJoints.includes(slot)))) {
    throw new Error('Invalid authored masked-joint mapping');
  }
  const maskedActionSlots = maskedJoints.length
    ? controlJoints.flatMap((slot, index) => maskedJoints.includes(slot) ? [index] : []) : [];
  const policies = manifest.checkpoints.map(checkpoint => manifest.checkpoints.length > 1
    ? `${manifest.baseName}@${checkpoint.id}` : manifest.baseName);
  if (!policies.includes(job.policy)) throw new Error('Requested canonical policy is not declared by the approved pack');
  const output = path.resolve(process.env.PREVIEW_OUTPUT);
  if (budgetRoot && !output.startsWith(budgetRoot + path.sep)) throw new Error('Capture output must be within shared artwork budget root');
  await admit();
  await fs.mkdir(output, { recursive: false });
  const scene = await launch(job.robot, 'flat');
  scene.beforeWrite = admit;
  const frames = [], captures = [], clocks = [];
  try {
    await scene.page.evaluate(bytes => {
      const state = window.__previewPolicy = { clock: null, status: null, errors: [], finished: [], target: null, inspect: null };
      window.__app.worker.addEventListener('message', event => {
        const message = event.data;
        if (message.t === 'status') state.status = message;
        if (message.t === 'error' && state.errors.length < 16) state.errors.push(String(message.msg).slice(0, 2000));
        if (message.t === 'policyFinished' && state.finished.length < 16) state.finished.push({ policy: message.policy, active: message.active });
        if (message.t === 'inspect') state.inspect = { policy: message.policy,
          names: message.actions.slice(0, 256).map(action => action.name) };
        if (message.t === 'frame') {
          state.clock = message.clock;
          if (message.qpos.length > 4096) {
            if (!state.errors.length) state.errors.push('Raw qpos exceeds bounded capture receipt');
            window.__app.worker.postMessage({ t: 'pause', on: true });
            return;
          }
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
      const pack = status?.packs.find(pack => pack.id === entry?.packId);
      return { entry: entry && { name: entry.name, packId: entry.packId, previewRobot: entry.previewRobot,
        dof: entry.dof, family: entry.family, group: entry.group, models: entry.models },
        pack: pack && { id: pack.id, robot: pack.robot, group: pack.group } };
    }, job.policy);
    // The worker resolves variants through specFor; shared compiled model identity is not sufficient.
    if (declared.entry?.packId !== manifest.baseName || declared.pack?.robot !== manifest.robot ||
        declared.entry?.previewRobot !== job.robot) {
      throw new Error('Requested robot/policy does not match approved pack and worker variant: ' + JSON.stringify(declared));
    }
    await receipt(path.join(output, 'actual-approved-pack-worker-identity.json'),
      { actualPackSHA256: hash(pack), manifest, declared, maskedJoints, maskedActionSlots });
    if (await scene.page.locator('#toggle-menu').getAttribute('aria-expanded') === 'false') await scene.page.locator('#toggle-menu').click();
    await chooseVisual(scene.page, 'policy', job.policy);
    await scene.page.waitForFunction(policy => window.__previewPolicy.status?.policy === policy, job.policy, { timeout: 300000 });
    await scene.page.evaluate(command => {
      const worker = window.__app.worker;
      worker.postMessage({ t: 'state', state: 'policy' });
      worker.postMessage({ t: 'command', cmd: command });
      worker.postMessage({ t: 'inspect', on: true });
    }, job.command ?? [0, 0, 0]);
    await scene.page.waitForFunction(policy => window.__previewPolicy.status?.state === 'policy' &&
      window.__previewPolicy.clock !== null && window.__previewPolicy.inspect?.policy === policy,
    job.policy, { timeout: 300000 });
    const readState = () => scene.page.evaluate(({ maskedActionSlots, actionCount }) => {
      const state = window.__previewPolicy, status = state.status;
      const entry = status?.policies.find(entry => entry.name === status.policy);
      const names = state.inspect?.policy === status?.policy ? state.inspect.names : [];
      const controlledJoints = names.map((name, index) => {
        const joint = window.__app.model.hinges.find(joint => joint.name === name);
        return { name, qadr: joint?.qadr ?? -1, value: joint ? state.qpos?.[joint.qadr] : null,
          intentionallyUnbound: !joint && names.length === actionCount && maskedActionSlots.includes(index) };
      });
      return { clock: state.clock, qpos: state.qpos, controlledJoints,
        status: status && { policy: status.policy, state: status.state, robotSpec: status.robotSpec,
          previewRobot: entry?.previewRobot, packId: entry?.packId, command: status.command },
        errors: state.errors, finished: state.finished };
    }, { maskedActionSlots, actionCount: controlJoints?.length });
    const requireIdentity = state => {
      if (state.errors.length || state.finished.length || !Number.isFinite(state.clock) ||
          !Array.isArray(state.qpos) || !state.qpos.every(Number.isFinite) ||
          state.status?.policy !== job.policy || state.status.state !== 'policy' ||
          state.status.robotSpec !== job.robot || state.status.previewRobot !== job.robot ||
          state.status.packId !== manifest.baseName || !state.controlledJoints.some(joint => joint.qadr >= 0) ||
          state.controlledJoints.some(joint => joint.intentionallyUnbound
            ? joint.qadr !== -1 || joint.value !== null
            : !Number.isInteger(joint.qadr) || joint.qadr < 0 || joint.qadr >= state.qpos.length || !Number.isFinite(joint.value))) {
        throw new Error('Policy identity/state changed: ' + JSON.stringify(state));
      }
    };
    const initial = await readState();
    requireIdentity(initial);
    const jointRanges = initial.controlledJoints.filter(joint => !joint.intentionallyUnbound)
      .map(joint => ({ name: joint.name, qadr: joint.qadr, min: Infinity, max: -Infinity }));
    for (let index = 0; index < count; index++) {
      await scene.page.evaluate(step => {
        const state = window.__previewPolicy;
        state.target = state.clock + step;
        window.__app.worker.postMessage({ t: 'pause', on: false });
      }, 1 / fps);
      await scene.page.waitForFunction(() => window.__previewPolicy.target === null, null, { timeout: 300000 });
      // Let already-posted real frames settle after the worker receives pause.
      await scene.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const state = await readState();
      requireIdentity(state);
      if (clocks.length && state.clock <= clocks[clocks.length - 1]) throw new Error('Worker clock did not advance');
      if (state.controlledJoints.length !== initial.controlledJoints.length || state.controlledJoints.some((joint, index) =>
        joint.name !== initial.controlledJoints[index].name || joint.qadr !== initial.controlledJoints[index].qadr ||
        joint.intentionallyUnbound !== initial.controlledJoints[index].intentionallyUnbound)) throw new Error('Controlled-joint identity changed');
      await receipt(path.join(output, 'actual-worker-frame-states.jsonl'),
        { index, packSHA256: job.packSHA256, ...state }, true);
      state.controlledJoints.filter(joint => !joint.intentionallyUnbound).forEach((joint, index) => {
        jointRanges[index].min = Math.min(jointRanges[index].min, joint.value);
        jointRanges[index].max = Math.max(jointRanges[index].max, joint.value);
      });
      const filename = `${String(index).padStart(4, '0')}.png`;
      captures.push({ ...(await capture(scene, { kind: 'policy', format: 'png', filename,
        angle: -Math.PI / 3 + index * Math.PI * 2 / count })), clock: state.clock, qposSHA256: hash(JSON.stringify(state.qpos)) });
      const after = await readState();
      requireIdentity(after);
      if (after.clock !== state.clock || hash(JSON.stringify(after.qpos)) !== hash(JSON.stringify(state.qpos))) {
        throw new Error('Worker advanced during paused artwork render');
      }
      frames.push(path.join(output, filename)); clocks.push(state.clock);
    }
    const movingJoints = jointRanges.filter(joint => joint.max - joint.min > 1e-6);
    await receipt(path.join(output, 'controlled-joint-motion.json'),
      { initialClock: initial.clock, clocks, jointRanges, movingJoints: movingJoints.length });
    if (!movingJoints.length) throw new Error('No actual controlled-joint motion in policy capture');
  } finally { await scene.browser.close(); }
  const clockFile = path.join(output, 'clocks.json');
  await receipt(clockFile, clocks);
  await admit();
  const { stdout } = await run(process.env.PYTHON || 'python3', [path.join(__dirname, 'encode_character_previews.py'),
    '--animation-output', path.join(output, 'encoded'), '--timestamps', clockFile, '--fps', String(fps), ...frames]);
  await receipt(path.join(output, 'inventory.json'), { job, captures, encoding: JSON.parse(stdout),
    description: 'Actual policy simulation frames; camera makes one full orbit; GIF timing follows captured simulation clocks.' });
  const slug = `${job.robot}-${hash(job.policy).slice(0, 12)}`;
  const prefix = `/assets/previews/animated/policies/${slug}`;
  await receipt(path.join(output, 'encoded', 'attribution.json'), job.attribution);
  await receipt(path.join(output, 'catalog.json'), { characters: {}, policies: {
    [`${job.robot}:${job.policy}`]: { still: `${prefix}/still.min.png`, animation: `${prefix}/turntable.gif`,
      caption: 'Policy playback · 360° view' },
  } });
})().catch(error => { console.error(error); process.exitCode = 1; });
