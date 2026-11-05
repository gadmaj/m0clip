'use strict';

// Test-only: keep software-GL runs responsive by never scheduling the App's live render tick.
// The release chunk stays byte-identical. The tick is identified by its gamepad poll, so frames
// are drawn only when the App renders on its own (launch, restores, screenshots).
module.exports = function renderOnDemand(page) {
  return page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => String(callback).includes('.pad.poll(') ? 0 : request(callback);
  });
};
