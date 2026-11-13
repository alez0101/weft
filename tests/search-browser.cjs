// Search box in real browsers, on the test stack (tests/run.sh --keep): / to focus, grouped results with
// highlights, arrows + Enter to open, a message result jumping to the message, and a viewer's results.
const { chromium } = require('playwright'); const os = require('os');
const SHOTS = process.env.WEFT_SHOTS || os.tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a);
  const open = async (who) => { const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title'); return p; };
  const olive = await open('Olive Organizer');
  await olive.locator('body').click({ position: { x: 5, y: 880 } });
  await olive.keyboard.press('/');
  out('/ focuses the box:', await olive.evaluate(() => document.activeElement?.getAttribute('role')) === 'combobox');
  await olive.keyboard.type('host contac');
  await olive.waitForSelector('.search-row');
  out('groups:', (await olive.locator('.search-group').allInnerTexts()).join(', '));
  out('highlights:', (await olive.locator('.search-snippet mark').allInnerTexts()).slice(0, 4).join(', '));
  await olive.screenshot({ path: `${SHOTS}/search-olive.png` });
  // keyboard to the first document result
  const firstDocIdx = await olive.locator('.search-row').evaluateAll((rows) => rows.findIndex((r) => /Host contacts/.test(r.querySelector('.search-title')?.textContent || '')));
  await olive.mouse.move(5, 880);   // keep the pointer off the results, or hovering picks the row
  await olive.locator('.search input').press('ArrowUp'); await olive.locator('.search input').press('ArrowUp');
  for (let i = 0; i < firstDocIdx; i++) await olive.keyboard.press('ArrowDown');
  await olive.keyboard.press('Enter');
  await olive.waitForSelector('.docs-title'); out('Enter opened:', await olive.locator('.docs-title').inputValue(), '| tab:', await olive.locator('.tab.is-active').innerText());
  // a message result jumps to the message
  await olive.locator('.search input').fill('north gate'); await olive.waitForTimeout(150);
  await olive.locator('.search input').fill('check-in'); await olive.waitForSelector('.search-group:has-text("Messages")');
  await olive.locator('.search-list > li:has(.search-group:has-text("Messages")) .search-row').first().dispatchEvent('mousedown');
  await olive.waitForTimeout(1500);
  out('message focused in chat:', await olive.locator('.msg.is-focus').count(), '| chat shows:', await olive.locator('.thread-head h3').innerText());
  // Pat: nothing from Organizers
  const pat = await open('Pat Public');
  await pat.locator('.search input').fill('host contacts'); await pat.waitForTimeout(1200);
  const metas = await pat.locator('.search-row').allInnerTexts();
  out('Pat results:', metas.length, '| any from Organizers:', metas.some((m) => /#organizers|#volunteers/.test(m)));
  await pat.locator('.search input').fill('zzqqxx'); await pat.waitForSelector('.search-empty');
  out('no results says:', await pat.locator('.search-empty').innerText());
  await pat.keyboard.press('Escape'); out('Escape closes:', await pat.locator('.search-panel').count() === 0);
  out('errors:', errs); await b.close();
})();
