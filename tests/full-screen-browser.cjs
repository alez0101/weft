// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Full screen and phones. Laptop: the tab bar's button hides the top bar and shrinks chat to its icon strip; chat has its own button (apps shrink to a toolbar); the tabs shrink to a slim
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
  const strip = await box(p.locator('.rail'));
  check('The top bar hides and chat shrinks to its icon strip', !(await p.locator('.topbar').isVisible()) && strip && strip.width <= 72, JSON.stringify(strip));
  const rib = await box(p.locator('.tabbar'));
  check('The tabs shrink to a slim ribbon', rib && rib.height <= 40, JSON.stringify(rib));
  check('The open item has the whole width: no list beside it', !(await p.locator('.docs-list').isVisible()) && (await box(p.locator('.docs-main'))).width >= 1360 && before.width < 1300);
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
  // Picking a conversation in the strip leaves full screen and shows it.
  await p.getByRole('button', { name: 'Full screen', exact: true }).click(); await p.waitForTimeout(500);
  await p.locator('.rail .convo').nth(2).click(); await p.waitForTimeout(500);
  check('A conversation picked in the strip leaves full screen', !(await p.locator('.shell').getAttribute('data-full')) && (await box(p.locator('.rail'))).width >= 300);
  // Chat full screen: chat fills the window, channels beside the conversation, apps shrink to a toolbar.
  check('Chat has its own Full screen button', await p.getByRole('button', { name: 'Full screen chat' }).count() === 1);
  await p.getByRole('button', { name: 'Full screen chat' }).click(); await p.waitForTimeout(600);
  const cr = await box(p.locator('.rail')); const st = await box(p.locator('.stage')); const th = await box(p.locator('.thread')); const cv = await box(p.locator('.convos'));
  check('Chat full screen: top bar hidden, chat fills the window', !(await p.locator('.topbar').isVisible()) && cr && cr.width >= 1360, JSON.stringify(cr));
  check('Chat full screen: the channel list sits beside the conversation', cv && th && th.x >= cv.x + cv.width - 1 && Math.abs(th.y - cv.y) < 2, JSON.stringify([cv, th]));
  check('Chat full screen: the apps shrink to a toolbar of their tabs', st && st.width <= 64 && !(await p.locator('.panel').isVisible()) && await p.locator('.tab[title="Documents"]').isVisible(), JSON.stringify(st));
  await p.locator('.tab[title="Documents"]').click(); await p.waitForTimeout(600);
  check('Picking an app in the toolbar leaves full screen and shows it', !(await p.locator('.shell').getAttribute('data-full')) && await p.locator('.panel').isVisible() && await p.locator('.topbar').isVisible());
  await p.getByRole('button', { name: 'Full screen chat' }).click(); await p.waitForTimeout(400);
  await p.getByRole('button', { name: 'Exit full screen chat' }).focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  check('Exit full screen chat (by keyboard) brings everything back', !(await p.locator('.shell').getAttribute('data-full')) && await p.locator('.panel').isVisible());
  // No dead space under a document: its page runs to the bottom of the window.
  await p.locator('.docs-list .doc-link').first().click(); await p.waitForTimeout(1000);
  const ed = await box(p.locator('.docs-editor'));
  check('The document page runs to the bottom of the window', ed && ed.y + ed.height >= 900 - 40, JSON.stringify(ed));
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
