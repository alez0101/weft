// Time off in real browsers, on the test stack (tests/run.sh --keep): Olive (editor) adds time off in
// #festival for Vic (Monday of this week to the day after tomorrow) and for herself (from tomorrow, "Conference"); Alex
// (dark mode, owner) sees both arrive live in the week grid and the list; Olive is refused an entry over
// 366 days, with the database's answer; Pat (viewer in #festival only) adds her own holiday, is offered
// only herself, and has no Change or Remove on anyone else's; Olive changes Vic's note and Alex sees it
// live; the Calendar shows the entries as all-day "Away" entries and a click opens Time off; Olive's Home
// widget "Out this week" lists who is away; Pat removes her own and Alex sees it go live.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node timeoff-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const openApp = async (p) => { await p.locator('.app:has-text("Time off")').click(); await p.waitForSelector('.docs-list[aria-label="Show time off"]'); await p.waitForSelector('.away-grid'); await p.waitForTimeout(400); };
  const entry = (p, name) => p.locator('li.away', { has: p.locator('.away-who', { hasText: new RegExp(`^${name}$`) }) });
  const gridRow = (p, name) => p.locator('.away-grid tbody tr', { has: p.locator('th.away-name', { hasText: new RegExp(`^${name}$`) }) });
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const plus = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return key(d); };
  const MONDAY = plus(-((new Date().getDay() + 6) % 7));
  const add = async (p, { channel, who, from, to, note }) => {
    await p.getByRole('button', { name: 'Add time off' }).click();
    if (channel) await p.locator('#to-new-space').selectOption({ label: channel });
    if (who) await p.locator('#to-new-who').selectOption({ label: who });
    await p.locator('#to-new-from').fill(from); await p.locator('#to-new-to').fill(to);
    if (note) await p.locator('#to-new-note').fill(note);
    await p.locator('form[aria-label="New time off"]').getByRole('button', { name: 'Add time off' }).click();
  };

  // Start clean: Alex (owner of #festival) removes all #festival time off left by earlier runs.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex);
  const pick = async (p) => { const btn = p.locator('.docs-list').getByRole('button', { name: '#festival', exact: true }); if (await btn.count()) await btn.click(); };
  await pick(alex);
  while (await alex.locator('li.away').count()) {
    await alex.locator('li.away').first().getByRole('button', { name: /^Remove/ }).click();
    await alex.waitForTimeout(500);
  }
  expect('Alex starts from an empty #festival', await alex.locator('.away-nobody').count() === 1);

  const olive = await open('Olive Organizer');
  await openApp(olive);
  await add(olive, { channel: '#festival', who: 'Vic Volunteer', from: MONDAY, to: plus(2), note: 'Flu' });
  await entry(olive, 'Vic Volunteer').waitFor();
  await add(olive, { channel: '#festival', from: plus(1), to: plus(4), note: 'Conference' });
  await entry(olive, 'You').waitFor();
  expect('Olive adds time off for Vic and for herself', await entry(olive, 'Vic Volunteer').locator('.link-by').innerText() === '#festival'
    && await entry(olive, 'Vic Volunteer').locator('.away-now').count() === 1);
  const vicCells = await gridRow(olive, 'Vic Volunteer').locator('td.is-away').count();
  const expectCells = Math.min(7, (new Date().getDay() + 6) % 7 + 3);
  expect('The week grid shows Vic away from Monday to the day after tomorrow (or Sunday)', vicCells === expectCells, `${vicCells} vs ${expectCells}`);
  expect('Olive can change and remove both (an editor)', await olive.locator('li.away').getByRole('button', { name: /^Remove/ }).count() === 2);

  // The database's answer.
  await add(olive, { channel: '#festival', from: plus(1), to: plus(400) });
  await olive.waitForSelector('.links > .send-error[role="alert"]');
  const refusal = await olive.locator('.links > .send-error').innerText();
  expect('Olive is refused an entry over 366 days, with the database\'s reason', refusal.includes('at most 366 days'), refusal);
  await olive.locator('form[aria-label="New time off"]').getByRole('button', { name: 'Cancel' }).click();

  // Alex sees both live.
  await alex.waitForFunction(() => document.querySelectorAll('li.away').length === 2, null, { timeout: 6000 });
  expect('Alex sees the new time off live, in the grid and the list', await gridRow(alex, 'Vic Volunteer').count() === 1 && await entry(alex, 'Olive Organizer').count() === 1);

  // Pat (viewer) adds her own; she is offered only herself and changes nothing of anyone else's.
  const pat = await open('Pat Public');
  await openApp(pat);
  await pick(pat);
  await pat.getByRole('button', { name: 'Add time off' }).click();
  expect('Pat (viewer) is offered only herself', await pat.locator('select#to-new-who').count() === 0 && (await pat.locator('#to-new-who').innerText()) === 'You');
  await pat.locator('form[aria-label="New time off"]').getByRole('button', { name: 'Cancel' }).click();
  await add(pat, { from: plus(2), to: plus(8), note: 'Holiday' });
  await entry(pat, 'You').waitFor();
  expect('Pat adds her own holiday in #festival', (await entry(pat, 'You').locator('.link-note').innerText()) === 'Holiday');
  expect('Pat has no Change or Remove on Vic\'s or Olive\'s time off',
    await entry(pat, 'Vic Volunteer').getByRole('button').count() === 0 && await entry(pat, 'Olive Organizer').getByRole('button').count() === 0
    && await entry(pat, 'You').getByRole('button', { name: /^Remove/ }).count() === 1);
  await alex.waitForFunction(() => document.querySelectorAll('li.away').length === 3, null, { timeout: 6000 });
  expect('Alex sees Pat\'s holiday live', await entry(alex, 'Pat Public').count() === 1);

  // Olive changes Vic's note; Alex sees it live.
  await entry(olive, 'Vic Volunteer').getByRole('button', { name: /^Change/ }).click();
  await olive.locator('form[aria-label="Change time off"] input[id$="-note"]').fill('Flu, back Monday');
  await olive.locator('form[aria-label="Change time off"]').getByRole('button', { name: 'Save' }).click();
  await olive.locator('form[aria-label="Change time off"]').waitFor({ state: 'detached' });
  await alex.waitForFunction(() => [...document.querySelectorAll('li.away .link-note')].some((n) => n.textContent === 'Flu, back Monday'), null, { timeout: 6000 });
  expect('Olive changes Vic\'s note and Alex sees it live', true);

  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-timeoff-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-timeoff-alex-dark.png` });
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-timeoff-pat-viewer.png` });

  // The Calendar: all-day "Away" entries; a click opens Time off.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.locator('.app:has-text("Calendar")').click();
  const away = olive.locator('.cal-main .cal-away', { hasText: 'Away: Vic Volunteer' }).first();
  await away.waitFor({ timeout: 8000 });
  expect('The Calendar shows Vic\'s time off as an all-day entry', await away.count() === 1);
  expect('The Calendar has a Time off toggle', await olive.locator('label.cal-aways input').isChecked());
  await olive.screenshot({ path: `${require('os').tmpdir()}/timeoff-calendar.png` });
  await away.click();
  await olive.waitForSelector('#tab-timeoff[aria-selected="true"]');
  expect('Clicking it opens Time off', true);

  // Home widget (on by default; turned on if this person saved a layout before it existed).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  let w = olive.locator('.widget:has(h3:text-is("Out this week"))');
  if (!(await w.count())) {
    await olive.getByRole('button', { name: 'Customize' }).click();
    await olive.locator('.widget-picker label', { hasText: 'Out this week' }).locator('input').check();
    await olive.getByRole('button', { name: 'Done', exact: true }).click();
    w = olive.locator('.widget:has(h3:text-is("Out this week"))');
  }
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  expect('Widget: Vic is listed as away today, with the note and channel', rows.some((r) => r.includes('Vic Volunteer, away today') && r.includes('Flu, back Monday') && r.includes('#festival')), rows.join(' / '));
  await w.locator('.widget-row').first().click();
  await olive.waitForSelector('#tab-timeoff[aria-selected="true"]');
  expect('Widget: a row opens Time off', true);

  // Pat removes her own; Alex sees it go live.
  await entry(pat, 'You').getByRole('button', { name: /^Remove/ }).click();
  await alex.waitForFunction(() => document.querySelectorAll('li.away').length === 2, null, { timeout: 6000 });
  expect('Pat removes her holiday and Alex sees it go, live', await entry(alex, 'Pat Public').count() === 0);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
