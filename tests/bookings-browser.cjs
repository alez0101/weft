// Bookings in real browsers, on the test stack (tests/run.sh --keep): Olive adds a van and a projector to
// #festival and books the van for tomorrow; Alex (dark mode, owner) sees the booking arrive live, is refused
// an overlapping slot with the database's answer, then books the slot right after; the day strip shows both;
// Olive changes her booking and Alex sees it live; the bookings show on the Calendar and clicking one opens
// it in Bookings; Pat (viewer in #festival only) sees the bookings but has no way to book, change or cancel;
// Olive's Home widget lists her booking and opens it.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node bookings-browser.cjs
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
  const openApp = async (p) => { await p.locator('.app:has-text("Bookings")').click(); await p.waitForSelector('.docs-list[aria-label="Things to book"]'); await p.waitForTimeout(300); };
  const thing = (p, name) => p.locator('.docs-list .doc-link', { hasText: new RegExp(`^${name}$`) });
  const pick = async (p, name) => { await thing(p, name).click(); await p.waitForSelector(`.booking-title:text-is("${name}")`); await p.waitForSelector('.booking-strip'); };
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(); d.setDate(d.getDate() + 1);
  const TOMORROW = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const showDay = async (p) => { await p.locator('#bk-day').fill(TOMORROW); await p.waitForTimeout(400); };
  const book = async (p, from, to, note) => {
    await p.getByRole('button', { name: /^Book / }).click();
    await p.locator('#bk-new-day').fill(TOMORROW); await p.locator('#bk-new-from').fill(from); await p.locator('#bk-new-to').fill(to);
    if (note) await p.locator('#bk-new-note').fill(note);
    await p.locator('form[aria-label="New booking"]').getByRole('button', { name: 'Book' }).click();
  };
  const whens = (p) => p.locator('.booking .booking-when').allInnerTexts();

  // Start clean: Alex (owner of #festival) deletes the van and projector if an earlier run left them.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex);
  for (const name of ['Festival van', 'Projector']) {
    if (await thing(alex, name).count()) { await pick(alex, name); await alex.locator('.docs-meta').getByRole('button', { name: 'Delete' }).click(); await thing(alex, name).waitFor({ state: 'detached' }); }
  }

  const olive = await open('Olive Organizer');
  await openApp(olive);
  for (const [name, note] of [['Projector', 'In the office cupboard'], ['Festival van', 'Keys with the stage manager. Return it fuelled.']]) {
    await olive.getByRole('button', { name: 'New thing to book' }).click();
    await olive.locator('#bk-new-name').fill(name);
    await olive.locator('#bk-new-space').selectOption({ label: '#festival' });
    await olive.locator('#bk-new-note').fill(note);
    await olive.locator('form[aria-label="New thing to book"]').getByRole('button', { name: 'Add' }).click();
    await olive.waitForSelector(`.booking-title:text-is("${name}")`);
  }
  expect('Olive adds a van and a projector to #festival', await thing(olive, 'Festival van').count() === 1 && await thing(olive, 'Projector').count() === 1);
  await thing(alex, 'Festival van').waitFor({ timeout: 6000 });
  expect('Alex sees the new things live', await thing(alex, 'Projector').count() === 1);
  await pick(alex, 'Festival van'); await showDay(alex);

  const t0 = Date.now();
  await book(olive, '10:00', '12:00', 'Pick up chairs');
  await olive.waitForSelector('.booking .booking-when:text-is("10:00 to 12:00")');
  expect('Olive books the van for tomorrow 10:00 to 12:00', (await olive.locator('.booking.is-mine .link-note').innerText()) === 'Pick up chairs');
  await alex.waitForSelector('.booking .booking-when:text-is("10:00 to 12:00")', { timeout: 6000 });
  out(`Alex saw Olive's booking live: ${Date.now() - t0} ms`);
  expect('Alex sees it live, booked by Olive', (await alex.locator('.booking .booking-who').first().innerText()) === 'Booked by Olive Organizer');

  // No double booking: the database's answer is shown.
  await book(alex, '11:00', '13:00');
  await alex.waitForSelector('.send-error[role="alert"]');
  expect('Alex is refused an overlapping slot, with the reason', (await alex.locator('.send-error').innerText()).includes('overlaps another booking'), await alex.locator('.send-error').innerText());
  expect('and nothing was booked', (await whens(alex)).length === 1);
  await alex.locator('#bk-new-from').fill('12:00');
  await alex.locator('form[aria-label="New booking"]').getByRole('button', { name: 'Book' }).click();
  await alex.waitForSelector('.booking .booking-when:text-is("12:00 to 13:00")');
  expect('The slot right after is fine', (await whens(alex)).join('|') === '10:00 to 12:00|12:00 to 13:00', (await whens(alex)).join('|'));
  await olive.waitForSelector('.booking .booking-when:text-is("12:00 to 13:00")', { timeout: 6000 });
  await showDay(olive);
  const blocks = await olive.locator('.booking-block .booking-block-text').allInnerTexts();
  expect('The day strip shows both slots, hers marked as You', blocks.length === 2 && blocks.includes('You') && blocks.includes('Alex (test admin)'), blocks.join(', '));
  expect('Olive can change or cancel only her own booking', await olive.getByRole('button', { name: /^Cancel booking/ }).count() === 1);

  // Olive changes her booking; Alex sees it live.
  await olive.locator('.booking.is-mine').getByRole('button', { name: /^Change/ }).click();
  await olive.locator('form[aria-label="Change booking"] input[id$="-from"]').fill('09:00');
  await olive.locator('form[aria-label="Change booking"] input[id$="-note"]').fill('Pick up chairs and tables');
  await olive.locator('form[aria-label="Change booking"]').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.booking .booking-when:text-is("09:00 to 12:00")', { timeout: 6000 });
  expect('Olive moves her start to 09:00 and Alex sees the change live', (await alex.locator('.booking .link-note').first().innerText()) === 'Pick up chairs and tables');
  await olive.waitForSelector('.booking .booking-when:text-is("09:00 to 12:00")');
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-bookings-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-bookings-alex-dark.png` });

  // The Calendar shows the bookings; clicking one opens it in Bookings.
  await olive.locator('#tab-home').click(); await olive.locator('.app:has-text("Calendar")').click();
  await olive.waitForSelector('.cal-main'); await olive.waitForTimeout(1500);
  await olive.locator('.cal-main button[aria-label="This Week"]').click();
  const entry = olive.locator('.cal-main .cal-booking', { hasText: 'Festival van: Olive Organizer' });
  await olive.waitForTimeout(800);
  if (!(await entry.count())) await olive.locator('.cal-main button[aria-label="Next Week"]').click();
  await entry.first().waitFor({ timeout: 6000 }).catch(() => {});
  expect('Calendar: both bookings show as entries', await entry.count() >= 1 && await olive.locator('.cal-main .cal-booking', { hasText: 'Festival van: Alex (test admin)' }).count() >= 1);
  await olive.locator('label.cal-bookings input').uncheck();
  expect('Calendar: the Bookings toggle hides them', await olive.locator('.cal-main .cal-booking').count() === 0);
  await olive.locator('label.cal-bookings input').check();
  await entry.first().click();
  await olive.waitForSelector('#tab-bookings[aria-selected="true"]');
  await olive.waitForSelector('.booking-title:text-is("Festival van")');
  expect('Calendar: clicking a booking opens the van in Bookings', true);

  // Pat (viewer in #festival only): sees, cannot book or change.
  const pat = await open('Pat Public');
  await openApp(pat);
  await pick(pat, 'Festival van'); await showDay(pat);
  expect('Pat sees the van\'s bookings with names', (await whens(pat)).join('|') === '09:00 to 12:00|12:00 to 13:00'
    && (await pat.locator('.booking .booking-who').allInnerTexts()).join('|') === 'Booked by Olive Organizer|Booked by Alex (test admin)');
  expect('Pat\'s view of the van is read-only: no Book, Change, Cancel, Rename or Delete',
    await pat.locator('.docs-main').getByRole('button', { name: /^(Book |Change|Cancel booking|Rename|Delete)/ }).count() === 0
    && (await pat.locator('.docs-meta').innerText()).includes('View only'));
  expect('Pat sees only #festival things', (await pat.locator('.docs-list .tree-group').allInnerTexts()).every((g) => g === '#festival'));
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-bookings-pat-viewer.png` });

  // Home widget (on by default; turned on if this person saved a layout before it existed).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  let w = olive.locator('.widget:has(h3:text-is("Your bookings"))');
  if (!(await w.count())) {
    await olive.getByRole('button', { name: 'Customize' }).click();
    await olive.locator('.widget-picker label', { hasText: 'Your bookings' }).locator('input').check();
    await olive.getByRole('button', { name: 'Done', exact: true }).click();
    w = olive.locator('.widget:has(h3:text-is("Your bookings"))');
  }
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  expect('Widget: Olive\'s booking is listed (only hers)', rows.length === 1 && rows[0].includes('Festival van') && rows[0].includes('09:00 to 12:00'), rows.join(' / '));
  await w.locator('.widget-row').first().click();
  await olive.waitForSelector('#tab-bookings[aria-selected="true"]');
  expect('Widget: a row opens the van in Bookings', (await olive.locator('.booking-title').innerText()) === 'Festival van');

  // Olive cancels her booking; Alex sees it go.
  await showDay(olive);
  await olive.getByRole('button', { name: /^Cancel booking/ }).click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.booking .booking-when')].length === 1, null, { timeout: 6000 });
  expect('Olive cancels her booking and it disappears for Alex live', (await whens(alex)).join('|') === '12:00 to 13:00');

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
