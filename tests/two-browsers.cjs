// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Two signed-in browsers chatting live on the test stack (127.0.0.1:3211). Run after tests/run.sh:
//   cd <dir with playwright installed> && node <repo>/tests/two-browsers.cjs
// (a folder where `npm install playwright` was done)
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir(); // where screenshots go
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto((process.env.WEFT_BASE || 'http://localhost:3211/'), { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click();
    await p.waitForSelector('.rail-title');
    return p;
  };
  const olive = await open('Olive Organizer'); const pat = await open('Pat Public');
  const rail = async (p) => (await p.locator('.convo .convo-name').allInnerTexts());
  console.log('Olive rail:', await rail(olive));
  console.log('Pat rail:  ', await rail(pat));

  await olive.getByRole('button', { name: 'festival', exact: true }).click(); await olive.waitForTimeout(600);
  await olive.fill('#compose', 'Two-browser test: hello from Olive'); await olive.press('#compose', 'Enter');
  await pat.waitForTimeout(1500);
  const badge = await pat.locator('.convo[aria-label="festival"] .convo-count').innerText().catch(() => 'none');
  console.log('Pat festival badge while elsewhere:', badge);
  await olive.fill('#compose', '@Pat is the 13:00 set still on?'); await olive.press('#compose', 'Enter');
  await pat.waitForTimeout(1500);
  console.log('Pat festival badge after @mention:', await pat.locator('.convo[aria-label="festival"] .convo-count').innerText().catch(() => 'none'));

  await pat.getByRole('button', { name: 'festival', exact: true }).click(); await pat.waitForTimeout(800);
  const t0 = Date.now();
  await olive.fill('#compose', 'Live check while Pat watches'); await olive.press('#compose', 'Enter');
  await pat.getByText('Live check while Pat watches').waitFor({ timeout: 5000 });
  console.log(`Pat saw Olive's message live, no reload: ${Date.now() - t0} ms`);
  await pat.fill('#compose', 'Pat here, got it'); await pat.press('#compose', 'Enter');
  await olive.getByText('Pat here, got it').waitFor({ timeout: 5000 });
  console.log('Olive saw Pat reply live: yes');

  await olive.getByRole('button', { name: 'organizers', exact: true }).click(); await olive.waitForTimeout(500);
  await olive.fill('#compose', 'Organizers only: host list updated'); await olive.press('#compose', 'Enter');
  await pat.waitForTimeout(1500);
  const leaked = await pat.getByText('Organizers only').count();
  console.log('Organizers message visible to Pat:', leaked, '| Pat rail has organizers:', (await rail(pat)).includes('organizers'));
  await pat.screenshot({ path: SHOTS + '/p3-pat.png' }); await olive.screenshot({ path: SHOTS + '/p3-olive.png' });
  await pat.locator('.app').first().click(); await pat.waitForTimeout(300);
  console.log('Pat opens Documents tab:', await pat.locator('.tab').allInnerTexts());
  console.log('page errors:', errs);
  await b.close();
})();
