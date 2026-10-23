async function chooseVisual(page, id, value) {
  const trigger = page.locator(`[id=${JSON.stringify(`${id}-trigger`)}]`);
  await trigger.click();
  const dialog = page.locator(`dialog[data-visual-picker=${JSON.stringify(id)}]`);
  await dialog.waitFor({ state: 'visible' });
  const card = dialog.locator(`button[data-value=${JSON.stringify(String(value))}]`);
  await card.waitFor({ state: 'visible' });
  if (await card.isDisabled()) throw new Error(`Unavailable ${id} choice: ${value}`);
  await card.click();
  await dialog.waitFor({ state: 'hidden' });
}

module.exports = { chooseVisual };
