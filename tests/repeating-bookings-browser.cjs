// Repeating bookings in real browsers, on the test stack (tests/run.sh --keep): Olive adds a rehearsal room to
// #festival; Alex (dark mode, owner) books it once, two weeks from tomorrow; Olive books it every week for 4 weeks
// from tomorrow and is told 3 were booked and which date was refused, and whose booking is in the way; Alex sees
// the weekly bookings arrive live; the form refuses 30 weeks before sending; Pat (viewer in #festival only) sees
// the weekly bookings but cannot book, repeat or cancel; Olive cancels a week and the later ones, and Alex sees
// them go live.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node repeating-bookings-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const ROOM = 'Rehearsal room';
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
  const dayIn = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const TOMORROW = dayIn(1); const IN15 = dayIn(15);
  const weekly = (p) => p.locator('.booking .booking-weekly');
  const openForm = async (p, day, from, to) => {
    await p.getByRole('button', { name: `Book ${ROOM}` }).click();
    await p.locator('#bk-new-day').fill(day); await p.locator('#bk-new-from').fill(from); await p.locator('#bk-new-to').fill(to);
  };

  // Start clean: Alex (owner of #festival) deletes the room if an earlier run left it.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex);
  if (await thing(alex, ROOM).count()) { await pick(alex, ROOM); await alex.locator('.docs-meta').getByRole('button', { name: 'Delete' }).click(); await thing(alex, ROOM).waitFor({ state: 'detached' }); }

  const olive = await open('Olive Organizer');
  await openApp(olive);
  await olive.getByRole('button', { name: 'New thing to book' }).click();
  await olive.locator('#bk-new-name').fill(ROOM);
  await olive.locator('#bk-new-space').selectOption({ label: '#festival' });
  await olive.locator('#bk-new-note').fill('Upstairs, next to the bar');
  await olive.locator('form[aria-label="New thing to book"]').getByRole('button', { name: 'Add' }).click();
  await olive.waitForSelector(`.booking-title:text-is("${ROOM}")`);
  await thing(alex, ROOM).waitFor({ timeout: 6000 });
  await pick(alex, ROOM);

  // Alex books the room once, on the third week.
  await openForm(alex, IN15, '18:30', '20:00');
  await alex.locator('form[aria-label="New booking"]').getByRole('button', { name: 'Book', exact: true }).click();
  await alex.waitForSelector('.booking .booking-when:text-is("18:30 to 20:00")');
  expect('Alex books the room once, two weeks from tomorrow', await alex.locator('.booking').count() === 1);

  // Olive: the form checks the number of weeks before sending.
  await olive.locator('.booking .booking-when').first().waitFor({ timeout: 6000 });
  await openForm(olive, TOMORROW, '18:00', '19:30');
  await olive.locator('#bk-new-note').fill('Band rehearsal');
  await olive.locator('#bk-new-repeat').selectOption('weekly');
  await olive.locator('#bk-new-weeks').fill('30');
  const submit = olive.locator('form[aria-label="New booking"] button[type="submit"]');
  expect('30 weeks is refused in the form, with the reason', await submit.isDisabled()
    && (await olive.locator('form[aria-label="New booking"] .booking-warn[role="status"]').innerText()).includes('2 to 26 weeks'));
  await olive.locator('#bk-new-weeks').fill('4');
  expect('The button says how many weeks it books', (await submit.innerText()) === 'Book 4 weeks', await submit.innerText());
  const t0 = Date.now();
  await submit.click();
  await olive.waitForSelector('.booking-result');
  const head = await olive.locator('.booking-result-head').innerText();
  const clashes = await olive.locator('.booking-clashes li').allInnerTexts();
  expect('Olive is told 3 of 4 weeks were booked', head.startsWith('Booked 3 of 4 weeks.'), head);
  expect('and which date was refused, with whose booking is in the way', clashes.length === 1 && clashes[0].includes('18:00 to 19:30') && clashes[0].includes('booked by Alex (test admin)'), clashes.join(' / '));
  await olive.waitForFunction(() => document.querySelectorAll('.booking .booking-weekly').length === 3);
  const whens = await olive.locator('.booking.is-mine .booking-when').allInnerTexts();
  expect('The 3 weeks show in Coming up, each marked Weekly', whens.length === 3 && whens.every((w) => w.startsWith('18:00 to 19:30')), whens.join(' | '));
  await alex.waitForFunction(() => document.querySelectorAll('.booking .booking-weekly').length === 3, null, { timeout: 6000 });
  out(`Alex saw Olive's weekly bookings live: ${Date.now() - t0} ms`);
  expect('Alex sees the weekly bookings live, next to his own', await alex.locator('.booking').count() === 4);
  expect('Alex (owner) may cancel Olive\'s weeks, and the later ones', await alex.getByRole('button', { name: /^Cancel this and later weeks/ }).count() === 3);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-repeating-bookings-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-repeating-bookings-alex-dark.png` });

  // Pat (viewer in #festival only): sees, cannot book, repeat or cancel.
  const pat = await open('Pat Public');
  await openApp(pat);
  await pick(pat, ROOM);
  await pat.locator('.booking').first().waitFor();
  expect('Pat sees the weekly bookings with names', await weekly(pat).count() === 3 && await pat.locator('.booking').count() === 4);
  expect('Pat\'s view is read-only: no Book, Change, Cancel or repeat',
    await pat.locator('.docs-main').getByRole('button', { name: /^(Book |Change|Cancel)/ }).count() === 0 && await pat.locator('#bk-new-repeat').count() === 0
    && (await pat.locator('.docs-meta').innerText()).includes('View only'));
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-repeating-bookings-pat-viewer.png` });

  // Olive cancels the second week and the later ones; the first stays, and Alex sees it live.
  await olive.locator('.booking-result').getByRole('button', { name: 'Close' }).click();
  await olive.getByRole('button', { name: /^Cancel this and later weeks/ }).nth(1).click();
  await olive.waitForFunction(() => document.querySelectorAll('.booking .booking-weekly').length === 1);
  expect('Olive cancels a week and the later ones; the first week stays', await olive.locator('.booking.is-mine').count() === 1
    && (await olive.locator('.booking').count()) === 2);
  await alex.waitForFunction(() => document.querySelectorAll('.booking .booking-weekly').length === 1, null, { timeout: 6000 });
  expect('Alex sees them go live, and his own booking stays', await alex.locator('.booking .booking-when:text-is("18:30 to 20:00")').count() === 1);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
