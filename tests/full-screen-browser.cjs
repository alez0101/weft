// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Full screen: from any app's tab bar, the open app fills the window (top bar and chat hidden), works in
// light and dark, keyboard reachable, and comes back with the same button.
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`); if (!ok) failed++; };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto((process.env.WEFT_BASE || 'http://localhost:3211/'), { waitUntil: 'networkidle' });
  await p.getByRole('button', { name: 'Olive Organizer' }).click(); await p.waitForSelector('.rail-title');
  await p.locator('.app:has-text("Sheets")').click(); await p.waitForTimeout(1200);
  // Open a real sheet: the first one in a channel that has any.
  const sel = p.locator('.panel select').first();
  for (const v of await sel.locator('option').evaluateAll((os) => os.map((o) => o.value))) {
    await sel.selectOption(v); await p.waitForTimeout(500);
    const first = p.locator('.docs-list li button, .docs-list li a').first();
    if (await first.count()) { await first.click(); await p.waitForTimeout(1500); break; }
  }
  const before = await p.locator('.panel').boundingBox();
  const btn = p.getByRole('button', { name: 'Full screen', exact: true });
  check('Each tab bar has a Full screen button', await btn.count() === 1);
  await btn.click(); await p.waitForTimeout(600);
  const after = await p.locator('.panel').boundingBox();
  check('The top bar and chat are hidden', !(await p.locator('.topbar').isVisible()) && !(await p.locator('.rail').isVisible()));
  check('The app fills the window', after.width >= 1430 && after.x <= 2 && after.width > before.width + 300, `${before.width} -> ${after.width}`);
  check('The tabs stay, so other apps are one click away', await p.getByRole('tab', { name: /Spreadsheets/ }).isVisible());
  check('The button now says Exit full screen and is pressed', await p.getByRole('button', { name: 'Exit full screen' }).getAttribute('aria-pressed') === 'true');
  await p.screenshot({ path: `${SHOTS}/full-screen-sheets.png` });
  await p.getByRole('tab', { name: /Home/ }).click(); await p.locator('.app:has-text("Documents")').click(); await p.waitForTimeout(800);
  check('Switching apps stays full screen', !(await p.locator('.topbar').isVisible()));
  await p.getByRole('button', { name: 'Exit full screen' }).focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  check('Exit (by keyboard) brings the top bar and chat back', await p.locator('.topbar').isVisible() && await p.locator('.rail').isVisible());
  await p.evaluate(() => { localStorage.setItem('weft-mode', 'dark'); document.documentElement.dataset.mode = 'dark'; });
  await p.getByRole('button', { name: 'Full screen', exact: true }).click(); await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS}/full-screen-dark.png` });
  check('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed'); process.exit(failed ? 1 : 0);
})();
