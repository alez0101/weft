// Phase 5 browser check (Pacific time): drag-create, live update, view-only, share link. Run after db/reset.sh
// from a dir with playwright installed (the Weft server: /tmp/pw):  node <repo>/tests/calendar-browser.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto('http://localhost:3011/', { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Calendar")').click(); await p.waitForTimeout(2000);
    return p;
  };
  const olive = await open('Olive Organizer'); const pat = await open('Pat Public');
  const evs = (p) => p.locator('.cal-main [class*="ev-t"]');
  console.log('Olive sees events this week:', await evs(olive).count(), '| Pat:', await evs(pat).count());
  console.log('Pat hint:', await pat.locator('.cal-hint').innerText());
  // Olive drags across Wednesday 10:00-11:00 to create an event.
  const grid = olive.locator('.cal-main [role="grid"], .cal-main table').last();
  const colHead = olive.getByText('Wed 14', { exact: true }); const hb = await colHead.boundingBox();
  const row10 = olive.getByText('10am', { exact: true }); const r10 = await row10.boundingBox();
  const row11 = olive.getByText('11am', { exact: true }); const r11 = await row11.boundingBox();
  const x = hb.x + hb.width / 2;
  await olive.waitForTimeout(1500);
  await olive.mouse.move(x, r10.y + 8); await olive.mouse.down(); await olive.mouse.move(x, r11.y - 4, { steps: 8 }); await olive.mouse.up();
  await olive.waitForSelector('.cal-form', { timeout: 5000 }).catch(async (e) => { await olive.screenshot({ path: '/tmp/pw/cal-dragfail.png' }); throw e; });
  console.log('draft time:', await olive.locator('.cal-form .cal-when').innerText());
  await olive.fill('#ev-title', 'Porch captain walkthrough'); await olive.selectOption('#ev-space', { label: '#festival' }); await olive.fill('#ev-loc', 'P01');
  const t0 = Date.now(); await olive.getByRole('button', { name: 'Add event' }).click();
  await pat.getByText('Porch captain walkthrough').first().waitFor({ timeout: 6000 });
  console.log(`Pat saw the new event without reloading: ${Date.now() - t0} ms`);
  await pat.getByText('Porch captain walkthrough').first().click(); await pat.waitForSelector('.cal-detail');
  console.log('Pat event detail:', (await pat.locator('.cal-detail').innerText()).replace(/\n+/g, ' | ').slice(0, 160));
  console.log('Pat has Delete button:', await pat.locator('.cal-detail').getByRole('button', { name: 'Delete' }).count());
  // Olive shares it; Pat opens it from chat.
  await olive.getByText('Porch captain walkthrough').first().click(); await olive.waitForSelector('.cal-detail');
  await olive.selectOption('#ev-share', { label: '#festival' }); await olive.waitForTimeout(800);
  await pat.getByRole('tab', { name: 'Home' }).click(); await pat.getByRole('button', { name: 'festival', exact: true }).click(); await pat.waitForTimeout(1000);
  await pat.getByRole('button', { name: 'Open in Calendar' }).last().click(); await pat.waitForSelector('.cal-detail', { timeout: 6000 });
  console.log('Pat opened it from chat:', (await pat.locator('.cal-detail h3').innerText()));
  await pat.screenshot({ path: '/tmp/pw/cal-pat.png' });
  // Day view of the festival.
  await olive.getByRole('button', { name: 'next' }).click().catch(() => {});
  console.log('errors:', errs); await b.close();
})();
