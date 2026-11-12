// Version 1.5 browser check: live cell edits and new rows across two browsers, viewer read-only, hidden Budget.
// Targets the test stack (tests/run.sh --keep). Run from a dir with playwright (npm install playwright).
const { chromium } = require('playwright');
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Sheets")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const olive = await open('Olive Organizer'); const alex = await open('Alex (test admin)', true);
  for (const p of [olive, alex]) { await p.getByRole('button', { name: 'Porches', exact: true }).click(); await p.waitForSelector('.ag-row'); await p.waitForTimeout(800); }
  console.log('rows shown:', await olive.locator('.ag-row').count(), '(grid renders visible rows)');
  const colId = await olive.locator('.ag-header-cell', { hasText: 'Rain plan' }).first().getAttribute('col-id');
  const cell = (p) => p.locator(`.ag-row[row-index="0"] [col-id="${colId}"]`);
  console.log('before:', await cell(olive).innerText());
  await cell(olive).click(); await olive.keyboard.press('Control+a'); await olive.keyboard.type('Garage, edited live'); await olive.keyboard.press('Enter');
  const t0 = Date.now();
  await alex.waitForFunction(([id]) => document.querySelector(`.ag-row[row-index="0"] [col-id="${id}"]`)?.innerText.includes('edited live'), [colId], { timeout: 6000 });
  console.log(`Alex saw Olive's cell edit live: ${Date.now() - t0} ms`);
  await alex.screenshot({ path: '/tmp/pw/tables-alex-dark.png' });
  await olive.getByRole('button', { name: 'Add row' }).click(); await olive.waitForTimeout(1500);
  console.log('Alex row count after Olive adds a row:', await alex.locator('.ag-row').count());
  const pat = await open('Pat Public');
  console.log('Pat sees tables:', (await pat.locator('.doc-link').allInnerTexts()).join(', '));
  await pat.getByRole('button', { name: 'Porches', exact: true }).click(); await pat.waitForSelector('.ag-row');
  await pat.locator(`.ag-row[row-index="0"] [col-id="${colId}"]`).dblclick(); await pat.waitForTimeout(400);
  console.log('Pat editing a cell opens an editor:', await pat.locator('.ag-cell-inline-editing, .ag-cell-edit-wrapper').count(), '| Add row button:', await pat.getByRole('button', { name: 'Add row' }).count());
  console.log('errors:', errs); await b.close();
})();
