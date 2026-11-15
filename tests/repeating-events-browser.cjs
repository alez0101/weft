// Repeating events in real browsers, on the test stack (tests/run.sh --keep), in Berlin time: Olive drags
// out an event on this week's Wednesday in #festival and makes it repeat every week for three more weeks;
// next week has it too, and its panel says how it repeats; Alex (dark mode) sees it arrive live; Olive
// renames all of them at once and Alex sees the new name live in a later week; Olive deletes just next
// week's and the others stay; Olive drags this week's an hour later and moves all of them; a refused change
// shows the database's answer; Pat (viewer in #festival only) reads the series with no way to change it.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node repeating-events-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const TZ = 'Europe/Berlin';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: TZ, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Calendar")').click(); await p.waitForSelector('.cal-main [role="columnheader"]');
    await p.waitForTimeout(800);
    return p;
  };
  const nav = async (p, name, n = 1) => { for (let i = 0; i < n; i += 1) { await p.locator('.cal-main').getByRole('button', { name, exact: true }).click(); await p.waitForTimeout(400); } };
  const today = async (p) => { if (await p.locator('.cal-main').getByRole('button', { name: 'This Week', exact: true }).isEnabled()) await nav(p, 'This Week'); };
  const next = (p, n = 1) => nav(p, 'Next Week', n);
  const prev = (p, n = 1) => nav(p, 'Previous Week', n);
  const ev = (p, title) => p.locator('.cal-main [class*="ev-t"]', { hasText: title });
  const has = async (p, title) => (await ev(p, title).count()) > 0;
  const waitFor = (p, title, present = true) => p.waitForFunction(([t, want]) => [...document.querySelectorAll('.cal-main [class*="ev-t"]')].some((e) => e.textContent.includes(t)) === want, [title, present], { timeout: 15000 });
  const detail = (p) => p.locator('.cal-detail[aria-label="Event"]');
  // The column for this week's Wednesday: its header's centre.
  const wedX = async (p) => {
    const hs = p.locator('.cal-main [role="columnheader"]');
    for (let i = 0; i < await hs.count(); i += 1) {
      const t = (await hs.nth(i).innerText()).trim();
      if (/\bWed\b/.test(t)) { const bb = await hs.nth(i).boundingBox(); return bb.x + bb.width / 2; }
    }
    throw new Error('no Wednesday column');
  };
  const rowY = async (p, label) => (await p.getByText(label, { exact: true }).first().boundingBox()).y;

  const olive = await open('Olive Organizer');
  const alex = await open('Alex (test admin)', true);
  await today(olive); await today(alex);

  // Olive drags across Wednesday 10:00 to 11:00 and makes it repeat every week.
  const x = await wedX(olive); const y10 = await rowY(olive, '10am'); const y11 = await rowY(olive, '11am');
  await olive.mouse.move(x, y10 + 8); await olive.mouse.down(); await olive.mouse.move(x, y11 - 4, { steps: 8 }); await olive.mouse.up();
  await olive.waitForSelector('.cal-form[aria-label="New event"]');
  await olive.fill('#ev-title', 'Choir rehearsal'); await olive.selectOption('#ev-space', { label: '#festival' }); await olive.fill('#ev-loc', 'Church hall');
  await olive.selectOption('#ev-repeat', 'weekly');
  const suggested = await olive.inputValue('#ev-until');
  expect('Choosing a repeat suggests a last day', /^\d{4}-\d{2}-\d{2}$/.test(suggested), suggested);
  const firstDay = await olive.locator('#ev-until').getAttribute('min');
  const end = new Date(`${firstDay}T12:00`); end.setDate(end.getDate() + 21);
  const pad = (n) => String(n).padStart(2, '0');
  await olive.fill('#ev-until', `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`);
  const t0 = Date.now();
  await olive.locator('.cal-form').getByRole('button', { name: 'Add event' }).click();
  await waitFor(olive, 'Choir rehearsal');
  await waitFor(alex, 'Choir rehearsal');
  out(`Alex saw the new repeating event live: ${Date.now() - t0} ms`);
  expect('The first one is on the calendar for Olive and, live, for Alex', true);
  await next(olive);
  expect('Next week has it too', await has(olive, 'Choir rehearsal'));
  await ev(olive, 'Choir rehearsal').first().click(); await detail(olive).waitFor();
  expect('Its panel says how it repeats', (await detail(olive).locator('.cal-repeats').innerText()).startsWith('Repeats every week until'), await detail(olive).innerText());
  expect('Olive (editor) can change it, delete this one or all of them', await detail(olive).getByRole('button', { name: 'Change' }).count() === 1
    && await detail(olive).getByRole('button', { name: 'Delete this one' }).count() === 1 && await detail(olive).getByRole('button', { name: 'Delete all of them' }).count() === 1);
  await next(olive, 3);
  expect('Four weeks on there is none (it ends after the fourth)', !(await has(olive, 'Choir rehearsal')));
  await prev(olive);
  expect('The fourth week has the last one', await has(olive, 'Choir rehearsal'));

  // Olive renames all of them from this week's; Alex, looking three weeks on, sees the new name live.
  await today(olive); await next(alex, 3); await waitFor(alex, 'Choir rehearsal');
  await ev(olive, 'Choir rehearsal').first().click(); await detail(olive).waitFor();
  await detail(olive).getByRole('button', { name: 'Change' }).click();
  await olive.fill('#ev-edit-title', 'Choir rehearsal, full cast');
  await detail(olive).getByRole('button', { name: 'Save all of them' }).click();
  await waitFor(alex, 'full cast');
  expect('Save all of them renames every one, live for Alex three weeks on', true);
  expect('Olive\'s panel shows the new name', (await detail(olive).locator('h3').innerText()) === 'Choir rehearsal, full cast');

  // Just this one: rename this week's only, then delete next week's only.
  await detail(olive).getByRole('button', { name: 'Change' }).click();
  await olive.fill('#ev-edit-title', 'Choir rehearsal, sectionals');
  await detail(olive).getByRole('button', { name: 'Save this one' }).click();
  await waitFor(olive, 'sectionals');
  await next(olive); await waitFor(olive, 'full cast');
  expect('Save this one changes only that one (next week keeps the series name)', !(await has(olive, 'sectionals')));
  await ev(olive, 'full cast').first().click(); await detail(olive).waitFor();
  await detail(olive).getByRole('button', { name: 'Delete this one' }).click();
  await waitFor(olive, 'full cast', false);
  await next(olive); await waitFor(olive, 'full cast');
  expect('Delete this one removes only next week\'s; the week after still has it', true);

  // A refused change shows the database's answer (the request is changed on its way out to an empty title).
  await today(olive); await ev(olive, 'sectionals').first().click(); await detail(olive).waitFor();
  await olive.route('**/rpc/change_series', async (route) => route.continue({ postData: JSON.stringify({ ...JSON.parse(route.request().postData()), p_title: ' ' }) }));
  await detail(olive).getByRole('button', { name: 'Change' }).click();
  await detail(olive).getByRole('button', { name: 'Save all of them' }).click();
  await olive.waitForSelector('.cal-bar .send-error');
  expect('A refused change shows the database\'s answer', (await olive.locator('.cal-bar .send-error').innerText()).includes('needs a title'), await olive.locator('.cal-bar .send-error').innerText());
  await olive.unroute('**/rpc/change_series');
  await detail(olive).getByRole('button', { name: 'Cancel' }).click();

  // Olive drags this week's an hour later and moves all of them.
  const box = await ev(olive, 'sectionals').first().boundingBox();
  const hour = (await rowY(olive, '11am')) - (await rowY(olive, '10am'));
  await olive.mouse.move(box.x + box.width / 2, box.y + 6); await olive.mouse.down();
  await olive.mouse.move(box.x + box.width / 2, box.y + 6 + hour, { steps: 10 }); await olive.mouse.up();
  await olive.waitForSelector('.cal-choice');
  expect('Dragging a repeating event asks: just this one, or all of them', (await olive.locator('.cal-choice').innerText()).includes('Just this one'));
  await olive.locator('.cal-choice').getByRole('button', { name: 'All of them' }).click();
  await olive.waitForTimeout(1000);
  await next(olive, 2); await ev(olive, 'full cast').first().click(); await detail(olive).waitFor();
  const moved = await detail(olive).locator('.cal-when').first().innerText();
  expect('All of them moved an hour later (two weeks on it is 11:00 to 12:00)', /11:00.*12:00/.test(moved), moved);
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-repeating-olive-light.png` });
  await alex.waitForTimeout(500);
  await ev(alex, 'full cast').first().click(); await detail(alex).waitFor();
  await alex.screenshot({ path: `${SHOTS}/2-repeating-alex-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  await today(pat); await next(pat, 2);
  await waitFor(pat, 'full cast');
  await ev(pat, 'full cast').first().click(); await detail(pat).waitFor();
  expect('Pat reads the event and how it repeats', (await detail(pat).locator('.cal-repeats').innerText()).startsWith('Repeats every week'));
  expect('Pat: view only, and no Change or Delete', (await detail(pat).innerText()).includes('View only')
    && await detail(pat).getByRole('button', { name: /^(Change|Delete)/ }).count() === 0);
  await pat.screenshot({ path: `${SHOTS}/3-repeating-pat-viewer.png` });

  // Delete all of them: they go everywhere, live.
  await ev(olive, 'full cast').first().click(); await detail(olive).waitFor();
  await detail(olive).getByRole('button', { name: 'Delete all of them' }).click();
  await waitFor(pat, 'full cast', false);
  await today(olive); await waitFor(olive, 'sectionals', false);
  expect('Delete all of them removes every one, live for Pat', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
