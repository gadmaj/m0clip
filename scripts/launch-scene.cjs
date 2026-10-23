/** Drive the real launch flow; advanced-feature fixtures can explicitly open Controls. */
const { chooseVisual } = require('./choose-visual.cjs');

async function launchScene(page, { terrain, controls = false } = {}) {
  const timeout = 240000;
  await page.locator('#launch-screen').waitFor({ state: 'visible', timeout });
  await page.locator('#launch-map-trigger').waitFor({ state: 'visible', timeout });
  if (terrain !== undefined) await chooseVisual(page, 'launch-map', terrain);
  await page.locator('#launch-next').click({ timeout });
  await page.locator('#launch-load').click({ timeout });
  try {
    await page.waitForFunction(() => {
      const enter = document.querySelector('#launch-enter');
      return enter && !enter.hidden && !enter.disabled && enter.getClientRects().length > 0;
    }, null, { timeout });
  } catch (error) {
    console.error('Launch readiness failed:', await page.locator('#launch-screen').innerText({ timeout: 5000 }).catch(String));
    throw error;
  }
  await page.locator('#launch-enter').click({ timeout });
  await page.waitForFunction(() => document.querySelector('#launch-screen')?.hidden === true, null, { timeout });
  if (controls && await page.locator('#toggle-menu').getAttribute('aria-expanded') === 'false') {
    await page.locator('#toggle-menu').click({ timeout });
  }
}

module.exports = { launchScene };
