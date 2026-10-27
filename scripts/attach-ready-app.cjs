'use strict';

async function attachReadyApp(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    const window = await cdp.send('Runtime.evaluate', { expression: 'window', objectGroup: 'preview-app-scope' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: window.result.objectId });
    const listener = listeners.find(entry => entry.type === 'keydown' && entry.handler?.description?.includes('this.onKey('));
    if (!listener) throw new Error('Actual App keyboard listener is unavailable');
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
      functionDeclaration: 'function(){return this.prototype}', returnByValue: false });
    const instances = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'preview-app-instance' });
    const attachment = await cdp.send('Runtime.callFunctionOn', { objectId: instances.objects.objectId,
      functionDeclaration: 'function(){if(this.length!==1||!this[0].lastFrame)throw Error("Actual Ready must have one App and its first frame");globalThis.__app=this[0];return {instanceCount:this.length,actualLastFrame:true}}',
      returnByValue: true });
    if (attachment.exceptionDetails || !attachment.result.value?.actualLastFrame) throw new Error('Actual Ready App could not be attached');
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'preview-app-instance' });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'preview-app-scope' });
    return attachment.result.value;
  } finally { await cdp.detach(); }
}
module.exports = attachReadyApp;
