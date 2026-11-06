'use strict';

const groups = ['preview-app-instance', 'preview-app-scope'];
/** The App constructor has not registered its listener yet; the only state worth waiting through. */
class AppMissing extends Error {}

async function attach(cdp, requireFrame) {
  const window = await cdp.send('Runtime.evaluate', { expression: 'window', objectGroup: 'preview-app-scope' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: window.result.objectId });
  const listener = listeners.find(entry => entry.type === 'keydown' && entry.handler?.description?.includes('this.onKey('));
  if (!listener) throw new AppMissing('Actual App keyboard listener is unavailable');
  const properties = await cdp.send('Runtime.getProperties', { objectId: listener.handler.objectId, ownProperties: true });
  const scopes = properties.internalProperties.find(entry => entry.name === '[[Scopes]]')?.value;
  if (!scopes) throw new Error('Actual App listener scopes are unavailable');
  const scopeProperties = await cdp.send('Runtime.getProperties', { objectId: scopes.objectId, ownProperties: true });
  const closures = scopeProperties.result.map(entry => entry.value).filter(value => value?.subtype === 'internal#scope' && value.description !== 'Global');
  const names = new Set(closures.map(value => /^Closure \(([^)]+)\)$/.exec(value.description)?.[1]).filter(Boolean));
  let constructor;
  for (const scope of closures) {
    const bindings = await cdp.send('Runtime.getProperties', { objectId: scope.objectId, ownProperties: true });
    constructor = bindings.result.find(entry => names.has(entry.name) && entry.value?.type === 'function'
      && entry.value.description?.startsWith('class ') && entry.value.description.includes('poseTake('));
    if (constructor) break;
  }
  if (!constructor) throw new Error('Actual App constructor is unavailable');
  const prototype = await cdp.send('Runtime.callFunctionOn', { objectId: constructor.value.objectId,
    functionDeclaration: 'function(){return this.prototype}', returnByValue: false, objectGroup: 'preview-app-scope' });
  const instances = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'preview-app-instance' });
  // Expose only the single real App, and only with a first frame when the caller requires Ready.
  const attachment = await cdp.send('Runtime.callFunctionOn', { objectId: instances.objects.objectId,
    functionDeclaration: 'function(requireFrame){const one=this.length===1,frame=one&&!!this[0].lastFrame;if(one&&(frame||!requireFrame))globalThis.__app=this[0];return {instanceCount:this.length,actualLastFrame:frame}}',
    arguments: [{ value: requireFrame }], returnByValue: true });
  if (attachment.exceptionDetails) throw new Error('Actual App could not be attached: ' + attachment.exceptionDetails.text);
  const value = attachment.result.value;
  if (value?.instanceCount !== 1) throw new Error(`Actual page must have one App, found ${value?.instanceCount}`);
  if (requireFrame && !value.actualLastFrame) throw new Error('Actual Ready App has no first frame');
  return value;
}

async function session(context, page, requireFrame) {
  const cdp = await context.newCDPSession(page);
  let value, failed = false, failure;
  try { value = await attach(cdp, requireFrame); } catch (error) { failed = true; failure = error; }
  // Release both groups, then detach; preserve the original attach failure if cleanup also fails.
  const cleanup = [];
  for (const objectGroup of groups) await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(error => cleanup.push(error));
  await cdp.detach().catch(error => cleanup.push(error));
  if (failed) {
    if (cleanup.length && failure instanceof Error) failure.cleanup = cleanup;
    throw failure;
  }
  if (cleanup.length) throw new AggregateError(cleanup, 'Actual App attachment cleanup failed');
  return value;
}

/** Retry only while the App is not constructed yet; every other failure surfaces immediately. */
async function untilConstructed(page, requireFrame, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await session(page.context(), page, requireFrame); }
    catch (error) {
      if (!(error instanceof AppMissing) || error.cleanup?.length) throw error;
      if (Date.now() >= deadline) throw new Error(`${error.message} after ${timeout} ms`, { cause: error });
    }
    await page.waitForTimeout(250);
  }
}

/** After Ready: attach the single real App with its first frame as window.__app; the release chunk is never modified. */
function attachReadyApp(context, page) {
  return session(context, page, true);
}

/**
 * Before Ready (for example while the launch screen offers the Original fallback): attach the single real App
 * as window.__app without requiring a frame. The result reports actualLastFrame truthfully; this is not Ready.
 */
function attachApp(page, { timeout = 120000 } = {}) {
  return untilConstructed(page, false, timeout);
}

/** Wait for Ready, attach the real App with its first frame, then wait for an optional App condition, within one timeout. */
async function readyApp(page, { until, arg, timeout = 120000 } = {}) {
  const deadline = Date.now() + timeout;
  // Playwright treats timeout 0 as unlimited, so a spent budget still gets a 1 ms wait.
  const remaining = () => Math.max(1, deadline - Date.now());
  await page.waitForFunction(() => document.querySelector('#overlay')?.classList.contains('hidden'), null, { timeout });
  await untilConstructed(page, true, remaining());
  if (until) await page.waitForFunction(until, arg, { timeout: remaining() });
}

module.exports = attachReadyApp;
module.exports.readyApp = readyApp;
module.exports.attachApp = attachApp;
