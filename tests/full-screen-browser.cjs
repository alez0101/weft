// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Full screen and phones. Laptop: the tab bar's button hides the top bar and chat, the tabs shrink to a slim
// ribbon, and an open item fills the panel edge to edge (no list, one-line title with a way back, share, move
// and delete folded behind a button); exits by keyboard; light and dark. Phone: Chat and Apps each get the whole
// screen, an open item hides the list, and full screen works the same way.
const { chromium, devices } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`); if (!ok) failed++; };
const box = async (l) => (await l.count()) && (await l.first().isVisible()) ? l.first().boundingBox() : null;
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (opts) => {
    const ctx = await b.newContext(opts); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Olive Organizer' }).click(); await p.waitForSelector('.rail-title', { state: 'attached' });
    return p;
  };
  // Opens Documents and the first document Olive has (the sample has some in #festival).
  const openDoc = async (p) => {
    await p.getByRole('tab', { name: /Home/ }).click();
    await p.locator('.app:has-text("Documents")').click(); await p.waitForTimeout(800);
    await p.locator('.docs-list .doc-link').first().click(); await p.waitForTimeout(1200);
  };

  // ---------- laptop
  const p = await open({ viewport: { width: 1440, height: 900 } });
  await openDoc(p);
  const before = await box(p.locator('.docs-main'));
  check('Each tab bar has a Full screen button', await p.getByRole('button', { name: 'Full screen', exact: true }).count() === 1);
  await p.getByRole('button', { name: 'Full screen', exact: true }).click(); await p.waitForTimeout(600);
  check('The top bar and chat are hidden', !(await p.locator('.topbar').isVisible()) && !(await p.locator('.rail').isVisible()));
  const rib = await box(p.locator('.tabbar'));
  check('The tabs shrink to a slim ribbon', rib && rib.height <= 40, JSON.stringify(rib));
  check('The open item has the whole width: no list beside it', !(await p.locator('.docs-list').isVisible()) && (await box(p.locator('.docs-main'))).width >= 1430 && before.width < 1300);
  const head = await box(p.locator('.docs-head'));
  check('Its title is one slim line with a way back', head && head.height <= 48 && await p.locator('.docs-back').isVisible(), JSON.stringify(head));
  check('Share, move and delete are folded away...', !(await p.locator('.docs-share').isVisible()));
  await p.getByRole('button', { name: 'Share, move or delete' }).click();
  check('...and fold out from the button', await p.locator('.docs-share').isVisible());
  await p.screenshot({ path: `${SHOTS}/full-screen-laptop.png` });
  await p.locator('.docs-back').click(); await p.waitForTimeout(500);
  check('Back shows the list again', await p.locator('.docs-list').isVisible());
  check('The tabs stay in full screen', await p.getByRole('tab', { name: /Documents/ }).isVisible());
  await p.getByRole('button', { name: 'Exit full screen' }).focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  check('Exit (by keyboard) brings the top bar and chat back', await p.locator('.topbar').isVisible() && await p.locator('.rail').isVisible());
  await p.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });
  await openDoc(p);
  await p.getByRole('button', { name: 'Full screen', exact: true }).click(); await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS}/full-screen-dark.png` });

  // ---------- phone
  const m = await open({ ...devices['iPhone 13'] });
  check('Phone: a Chat and Apps switch in the top bar', await m.locator('.pane-switch').isVisible());
  await m.getByRole('button', { name: /^Chat/ }).first().click(); await m.waitForTimeout(300);
  check('Phone: Chat takes the whole screen', await m.locator('.rail').isVisible() && !(await m.locator('.stage').isVisible()));
  await m.getByRole('button', { name: 'Apps', exact: true }).click(); await m.waitForTimeout(300);
  check('Phone: Apps takes the whole screen', !(await m.locator('.rail').isVisible()) && await m.locator('.stage').isVisible());
  await openDoc(m);
  check('Phone: an open item hides the list, with a way back', !(await m.locator('.docs-list').isVisible()) && await m.locator('.docs-back').isVisible());
  const mh = await box(m.locator('.docs-head'));
  check('Phone: its title is one slim line', mh && mh.height <= 56, JSON.stringify(mh));
  await m.screenshot({ path: `${SHOTS}/phone-open.png` });
  await m.getByRole('button', { name: 'Full screen', exact: true }).click(); await m.waitForTimeout(400);
  check('Phone: full screen hides the top bar too', !(await m.locator('.topbar').isVisible()) && (await box(m.locator('.tabbar'))).y <= 1);
  await m.screenshot({ path: `${SHOTS}/phone-full.png` });

  check('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed'); process.exit(failed ? 1 : 0);
})();
