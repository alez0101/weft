// Spreadsheets in real browsers, on the test stack (tests/run.sh --keep, with the spreadsheet engine):
// make a sheet in #festival, two editors typing into it at once, the periodic save landing while they are
// still in it, a viewer's read-only view, dark mode, a CSV opened as a spreadsheet from Files, search,
// and the final save after everyone closes. Run from a dir with playwright.
const { chromium } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
const SHOTS = process.env.WEFT_SHOTS || os.tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const NAME = `Gate takings ${Date.now() % 100000}`;
const results = []; const check = (n, ok, d = '') => { results.push({ n, ok: !!ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : `  ${d}`}`); };
const token = async (email) => (await (await fetch(`${BASE}auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify({ email }) })).json()).token;
const text = async (id) => (await (await fetch(`${BASE}api/items?id=eq.${id}&select=body_text`, { headers: { Authorization: `Bearer ${await token('olive.organizer@example.com')}` } })).json())[0]?.body_text || '';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (who, dark) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.getByRole('link', { name: 'Spreadsheets', exact: true }).click(); await p.waitForSelector('.docs-list');
    return { p, ctx };
  };
  const ready = async (p) => { await p.waitForFunction(() => { const f = document.querySelector('.sheet-frame'); return f && !f.hidden && !document.querySelector('.sheet-view .skeleton'); }, null, { timeout: 120000 }); await p.waitForTimeout(3000); await p.keyboard.press('Escape'); };
  // A1 is about (97, 151) from the editor's top left with the compact header; rows are 19 px, columns 64 px.
  const cell = async (p, col, row) => { const box = await p.locator('.sheet-frame').boundingBox(); return [box.x + 97 + col * 64, box.y + 151 + row * 19]; };
  const type = async (p, col, row, t) => { const [x, y] = await cell(p, col, row); await p.mouse.click(x, y); await p.keyboard.type(t); await p.keyboard.press('Enter'); await p.waitForTimeout(400); };

  // Olive makes a spreadsheet in #festival and renames it.
  const olive = await open('Olive Organizer');
  const fest = await olive.p.locator('#new-spreadsheet option', { hasText: 'festival' }).getAttribute('value');
  await olive.p.selectOption('#new-spreadsheet', fest);
  await olive.p.getByRole('button', { name: 'New spreadsheet' }).click();
  await ready(olive.p);
  const id = new URLSearchParams(new URL(olive.p.url()).hash.slice(1)).get('spreadsheet');
  check('New spreadsheet opens the editor', !!id && (await olive.p.frameLocator('.sheet-frame iframe').locator('#ws-canvas, canvas').count()) > 0);
  const title = olive.p.locator('.docs-head input').first();
  await title.fill(NAME); await title.press('Enter'); await olive.p.waitForSelector(`.doc-link:has-text("${NAME}")`);

  // Alex (dark mode) opens it too; both type.
  const alex = await open('Alex (test admin)', true);
  await alex.p.locator('.doc-link', { hasText: NAME }).click(); await ready(alex.p);
  await type(olive.p, 0, 0, 'Saturday gate'); await type(olive.p, 1, 0, '980');
  await type(alex.p, 0, 1, 'Sunday gate'); await type(alex.p, 1, 1, '1120'); await type(alex.p, 1, 2, '=B1+B2');
  await olive.p.waitForTimeout(2000);
  await olive.p.screenshot({ path: `${SHOTS}/spreadsheets-olive.png` }); await alex.p.screenshot({ path: `${SHOTS}/spreadsheets-alex-dark.png` });

  // The periodic save (every 30 s on the test stack) lands while both are still in it.
  let t = ''; for (let i = 0; i < 20 && !/Sunday gate\t1120/.test(t); i += 1) { await olive.p.waitForTimeout(5000); t = await text(id); }
  check('Saved while both are still editing (both people\'s cells, the formula\'s result)', /Saturday gate\t980/.test(t) && /Sunday gate\t1120/.test(t) && /\b2100\b/.test(t), JSON.stringify(t));

  // Pat, a viewer, sees it read-only, with the changes so far.
  const pat = await open('Pat Public');
  await pat.p.locator('.doc-link', { hasText: NAME }).click(); await ready(pat.p);
  check('A viewer is told it is read-only', /look at this spreadsheet but not change it/.test(await pat.p.locator('.sheet-note').innerText().catch(() => '')));
  await type(pat.p, 0, 5, 'Viewer typing');
  await pat.p.screenshot({ path: `${SHOTS}/spreadsheets-pat.png` });

  // Search finds it by a cell.
  await olive.p.locator('input[type=search]').fill('saturday gate'); await olive.p.waitForSelector('.search-row', { timeout: 10000 });
  check('Search finds the spreadsheet by a cell', (await olive.p.locator('.search-panel').innerText()).includes(NAME));
  await olive.p.keyboard.press('Escape');

  // Everyone closes; the final save lands, and the viewer's typing is not in it.
  await Promise.all([alex.ctx.close(), pat.ctx.close()]);
  await olive.p.getByRole('tab', { name: 'Home' }).click();
  await olive.p.getByRole('link', { name: 'Files', exact: true }).click(); await olive.p.waitForSelector('.docs-list');
  await olive.p.waitForTimeout(15000);
  t = await text(id);
  check('Final save after everyone closed; nothing from the viewer', /Saturday gate/.test(t) && !/Viewer typing/.test(t), JSON.stringify(t));

  // Files: a CSV opened as a spreadsheet.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-sheets-')); const csv = path.join(dir, 'Raffle prizes.csv');
  fs.writeFileSync(csv, 'Prize,Donor\nHamper,Bakery\nBike,Cycle shop\n');
  await olive.p.selectOption('#new-file', fest);
  await olive.p.locator('.file-pick input[type=file]').setInputFiles(csv);
  await olive.p.waitForSelector('.doc-link:has-text("Raffle prizes.csv")', { timeout: 15000 });
  await olive.p.locator('.doc-link', { hasText: 'Raffle prizes.csv' }).first().click();
  await olive.p.getByRole('button', { name: 'Open as spreadsheet' }).click();
  await ready(olive.p);
  const sid = new URLSearchParams(new URL(olive.p.url()).hash.slice(1)).get('spreadsheet');
  check('Open as spreadsheet makes one and opens it', !!sid && sid !== id && /Hamper\tBakery/.test(await text(sid)), sid);
  await olive.p.screenshot({ path: `${SHOTS}/spreadsheets-from-csv.png` });

  check('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\nspreadsheets in the browser: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
