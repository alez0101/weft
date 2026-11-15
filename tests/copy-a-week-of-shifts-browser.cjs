// Copy a week of shifts in real browsers, on the test stack (tests/run.sh --keep): Olive adds a #festival rota
// (Rota gate in 30 days, Rota bar the day after) and takes a place on the gate; she opens Copy shifts, sees the
// preview of the two shifts and copies the week a week on; the copies arrive with nobody signed up, and Alex
// (dark mode, owner) sees them live; copying again makes nothing new and says so; Copy this day on a day heading
// copies just that day two weeks on; Pat (viewer in #festival only) sees the copies but has no way to copy;
// Alex deletes the rota again.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node copy-a-week-of-shifts-browser.cjs
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
  const openApp = async (p) => { await p.locator('.app:has-text("Shifts")').click(); await p.waitForSelector('.docs-list[aria-label="Show shifts"]'); await p.waitForSelector('.shift-head'); await p.waitForTimeout(400); };
  const card = (p, title) => p.locator('li.shift', { has: p.locator('.shift-title', { hasText: new RegExp(`^${title}$`) }) });
  const pad = (n) => String(n).padStart(2, '0');
  const dayIn = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const label = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' }); };
  // Scroll the shift list (not the page) so a day is at the top, for the screenshots.
  const scrollTo = (loc) => loc.evaluate((e) => {
    let s = e.parentElement;
    while (s && !(s.scrollHeight > s.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (s) s.scrollTop += e.getBoundingClientRect().top - s.getBoundingClientRect().top - 8;
    window.scrollTo(0, 0);
  });
  const D = 30;   // far enough on that the permission suite's own shifts are not in the copied week
  const day = (p, n) => p.locator(`section.rsvp-day[aria-label="${label(n)}"]`);
  const addShift = async (p, title, n, from, to, places) => {
    await p.getByRole('button', { name: 'New shift', exact: true }).click();
    await p.locator('#sh-new-space').selectOption({ label: '#festival' });
    await p.locator('#sh-new-title').fill(title); await p.locator('#sh-new-day').fill(dayIn(n));
    await p.locator('#sh-new-from').fill(from); await p.locator('#sh-new-to').fill(to); await p.locator('#sh-new-places').fill(String(places));
    await p.getByRole('button', { name: 'Add shift' }).click();
    await card(p, title).first().waitFor();
  };

  // Start clean: Alex (owner of #festival) deletes the rota if an earlier run left it.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex);
  for (const title of ['Rota gate', 'Rota bar']) {
    while (await card(alex, title).count()) {
      await card(alex, title).first().getByRole('button', { name: /^Delete/ }).click();
      await alex.waitForTimeout(600);
    }
  }

  // Olive adds the rota and takes a place on the gate.
  const olive = await open('Olive Organizer');
  await openApp(olive);
  await addShift(olive, 'Rota gate', D, '10:00', '14:00', 2);
  await addShift(olive, 'Rota bar', D + 1, '18:00', '22:00', 3);
  await card(olive, 'Rota gate').getByRole('button', { name: /^Take a place/ }).click();
  await card(olive, 'Rota gate').locator('.shift-yours').waitFor();

  // Copy shifts: a week from the gate's day, to a week later. The preview lists both.
  await olive.getByRole('button', { name: 'Copy shifts', exact: true }).click();
  const form = olive.locator('form[aria-label="Copy shifts"]');
  await form.waitFor();
  await olive.locator('#sh-copy-space').selectOption({ label: '#festival' });
  await form.getByRole('radio', { name: 'a week' }).check();
  await olive.locator('#sh-copy-from').fill(dayIn(D));
  expect('Choosing the first day sets the target a week later', await olive.locator('#sh-copy-to').inputValue() === dayIn(D + 7), await olive.locator('#sh-copy-to').inputValue());
  await form.locator('.shift-copy-list li').nth(1).waitFor();
  const items = await form.locator('.shift-copy-list li').allInnerTexts();
  expect('The preview lists the two shifts of that week, with their new days',
    items.length === 2 && items[0].includes('Rota gate') && items[0].includes('10:00 to 14:00') && items[1].includes('Rota bar') && items[0].includes('→'), items.join(' | '));
  const submit = form.locator('button[type="submit"]');
  expect('The button says how many shifts it copies', (await submit.innerText()) === 'Copy 2 shifts', await submit.innerText());
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-copy-shifts-olive-light.png` });

  const t0 = Date.now();
  await submit.click();
  await olive.waitForSelector('.booking-result');
  const head = await olive.locator('.booking-result-head').innerText();
  expect('Olive is told 2 shifts were copied to that week in #festival', head.startsWith(`Copied 2 shifts to the week from ${label(D + 7)} in #festival.`), head);
  await day(olive, D + 7).locator('li.shift').first().waitFor();
  const gateCopy = day(olive, D + 7).locator('li.shift', { has: olive.locator('.shift-title', { hasText: /^Rota gate$/ }) });
  expect('The gate copy is on the same clock time a week later, with nobody on it and both places open',
    await gateCopy.locator('.shift-when').innerText() === '10:00 to 14:00' && (await gateCopy.locator('.shift-who').innerText()).includes('Nobody yet')
    && await gateCopy.locator('.shift-count').innerText() === '2 of 2 open', await gateCopy.innerText());
  expect('The bar copy is there too, and the original gate still has Olive on it',
    await day(olive, D + 8).locator('.shift-title', { hasText: /^Rota bar$/ }).count() === 1
    && await day(olive, D).locator('li.shift.is-mine .shift-title', { hasText: /^Rota gate$/ }).count() === 1);
  await alex.waitForFunction(() => [...document.querySelectorAll('.shift-title')].filter((e) => e.textContent === 'Rota gate').length === 2, null, { timeout: 6000 });
  out(`Alex saw the copies live: ${Date.now() - t0} ms`);
  expect('Alex sees the copies live', await card(alex, 'Rota bar').count() === 2);

  // Copying the same week again makes nothing new.
  await olive.getByRole('button', { name: 'Copy shifts', exact: true }).click();
  await olive.locator('#sh-copy-space').selectOption({ label: '#festival' });
  await form.getByRole('radio', { name: 'a week' }).check();
  await olive.locator('#sh-copy-from').fill(dayIn(D));
  await form.locator('.shift-copy-list li').nth(1).waitFor();
  await submit.click();
  await olive.waitForSelector('.booking-result.has-clashes');
  const again = await olive.locator('.booking-result').innerText();
  expect('Copying again says nothing was copied, as 2 were already there', again.includes('Nothing was copied.') && again.includes('2 shifts were already there'), again);
  expect('and there are still only two gate shifts', await card(olive, 'Rota gate').count() === 2);

  // Copy this day: the bar's day, two weeks on.
  await day(olive, D + 1).getByRole('button', { name: /^Copy this day/ }).click();
  await form.waitFor();
  expect('Copy this day opens the form for that one day', await form.getByRole('radio', { name: 'a day' }).isChecked()
    && await olive.locator('#sh-copy-from').inputValue() === dayIn(D + 1));
  await olive.locator('#sh-copy-to').fill(dayIn(D + 15));
  await form.locator('.shift-copy-list li').first().waitFor();
  expect('The day preview has just the bar', (await form.locator('.shift-copy-list li').allInnerTexts()).length === 1 && (await submit.innerText()) === 'Copy 1 shift');
  await submit.click();
  await olive.waitForSelector('.booking-result:not(.has-clashes)');
  await day(olive, D + 15).locator('.shift-title', { hasText: /^Rota bar$/ }).waitFor();
  expect('The bar is copied two weeks on', await card(olive, 'Rota bar').count() === 3 && await card(olive, 'Rota gate').count() === 2);
  await card(alex, 'Rota bar').nth(2).waitFor({ timeout: 6000 });
  await scrollTo(day(alex, D));
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-copy-shifts-alex-dark.png` });

  // Pat (viewer in #festival only): sees the copies, cannot copy.
  const pat = await open('Pat Public');
  await openApp(pat);
  await card(pat, 'Rota bar').nth(2).waitFor();
  expect('Pat sees all the copies', await card(pat, 'Rota bar').count() === 3 && await card(pat, 'Rota gate').count() === 2);
  expect('Pat has no Copy this day on the #festival days', await pat.getByRole('button', { name: /^Copy this day/ }).count() === 0);
  // The permission suite may have made Pat an editor of a channel of its own; #festival is never offered to her.
  if (await pat.getByRole('button', { name: 'Copy shifts', exact: true }).count()) {
    await pat.getByRole('button', { name: 'Copy shifts', exact: true }).click();
    const opts = await pat.locator('#sh-copy-space option').allInnerTexts();
    expect('Pat cannot copy #festival shifts', opts.length > 0 && !opts.includes('#festival'), opts.join('|'));
    await pat.locator('form[aria-label="Copy shifts"]').getByRole('button', { name: 'Cancel' }).click();
  } else expect('Pat cannot copy #festival shifts (no Copy shifts button)', true);
  await scrollTo(day(pat, D));
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-copy-shifts-pat-viewer.png` });

  // Clean up, so later browser checks (the Shifts one counts Olive's shifts) see no trace of this rota.
  for (const title of ['Rota gate', 'Rota bar']) {
    while (await card(alex, title).count()) {
      await card(alex, title).first().getByRole('button', { name: /^Delete/ }).click();
      await alex.waitForTimeout(600);
    }
  }
  expect('Alex deletes the rota and its copies again', await card(olive, 'Rota gate').count() === 0 && await card(olive, 'Rota bar').count() === 0);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
