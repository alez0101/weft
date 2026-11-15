// Download as a file in real browsers, on the test stack (tests/run.sh --keep). Olive makes an address book in
// #festival and downloads it as CSV (a note starting with "=" is not run as a formula) and as vCards; Pat
// (viewer) opens the same book with no way to change it, sees Olive's next contact arrive live and downloads a
// file that has it. Olive downloads an expense list (one column per person's share) and an inventory. Alex
// (dark mode) downloads #festival's calendar as .ics from the Calendar; Pat's Calendar offers only her own
// spaces. Every file is checked line by line. Screenshots go to WEFT_SHOTS.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node downloads-browser.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const RUN = Date.now().toString(36).slice(-4);   // a fresh name each run, so the test can run again on the same stack
const BOOK = `Gate contacts ${RUN}`;
const LIST = `Gate costs ${RUN}`;
const INV = `Gate kit ${RUN}`;
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, app, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-US', acceptDownloads: true })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator(`.app:has-text("${app}")`).click();
    return p;
  };
  // Press a button and read the file the browser saves.
  const fetchFile = async (p, button) => {
    const [d] = await Promise.all([p.waitForEvent('download'), button.click()]);
    return { name: d.suggestedFilename(), text: fs.readFileSync(await d.path(), 'utf8') };
  };
  const rows = (text) => text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  const newItem = async (p, kind, button, deflt, space, name) => {
    await p.waitForSelector('.docs-list');
    await p.selectOption(`#new-${kind}`, { label: space });
    await p.locator('.docs-new').getByRole('button', { name: button }).click();
    await p.waitForFunction(([k, v]) => document.querySelector(`#title-${k}`)?.value === v, [kind, deflt]);
    await p.fill(`#title-${kind}`, name); await p.press(`#title-${kind}`, 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addContact = async (p, c) => {
    await p.getByRole('button', { name: 'Add a contact' }).click();
    await p.fill('#contact-new-name', c.name); await p.fill('#contact-new-org', c.organisation || ''); await p.fill('#contact-new-phone', c.phone || '');
    await p.fill('#contact-new-email', c.email || ''); await p.fill('#contact-new-notes', c.notes || '');
    await p.locator('form[aria-label="Add a contact"]').getByRole('button', { name: 'Add contact' }).click();
    await p.waitForSelector(`.contact-name:has-text("${c.name}")`);
  };

  // Contacts: CSV and vCard.
  const olive = await open('Olive Organizer', 'Contacts');
  await newItem(olive, 'addressbook', 'New address book', 'Contacts', '#festival', BOOK);
  expect('An empty book offers no download', await olive.getByRole('button', { name: /^Download/ }).count() === 0);
  await addContact(olive, { name: 'Sam Okafor', organisation: 'Stage crew, gate B', phone: '07700 900456', email: 'sam@example.org', notes: '=HYPERLINK("x") is not a formula' });
  await addContact(olive, { name: 'Ana Ruiz', organisation: 'Town council', email: 'events@example.gov', notes: 'Line one\nline two' });
  let f = await fetchFile(olive, olive.getByRole('button', { name: 'Download CSV' }));
  let r = rows(f.text);
  expect('Contacts CSV: named after the book, with a byte order mark', f.name === `${BOOK}.csv` && f.text.startsWith('﻿'), f.name);
  expect('Contacts CSV: a header, then the contacts sorted by name', r[0] === 'Name,Organisation,Phone,Email,Notes' && r[1].startsWith('Ana Ruiz,Town council,,events@example.gov,"Line one'), r.slice(0, 3).join(' | '));
  expect('Contacts CSV: a comma is quoted and a formula is defused', f.text.includes('Sam Okafor,"Stage crew, gate B",07700 900456,sam@example.org,"\'=HYPERLINK(""x"") is not a formula"'), f.text);
  f = await fetchFile(olive, olive.getByRole('button', { name: 'Download vCard' }));
  expect('vCard: one card per contact, escaped', f.name === `${BOOK}.vcf` && (f.text.match(/BEGIN:VCARD\r\n/g) || []).length === 2
    && f.text.includes('FN:Sam Okafor\r\nN:Okafor;Sam;;;\r\nORG:Stage crew\\, gate B\r\nTEL;TYPE=VOICE:07700 900456\r\nEMAIL;TYPE=INTERNET:sam@example.org')
    && f.text.includes('NOTE:Line one\\nline two'), f.text);

  // Pat (viewer): reads the book, can download it, cannot change it; Olive's next contact arrives live.
  const pat = await open('Pat Public', 'Contacts');
  await pat.waitForSelector('.docs-list');
  await pat.locator('.doc-link', { hasText: BOOK }).click(); await pat.waitForSelector('.contact');
  expect('Pat (viewer): Download CSV and vCard, but no Add, Edit or Delete', await pat.getByRole('button', { name: 'Download CSV' }).count() === 1
    && await pat.getByRole('button', { name: 'Download vCard' }).count() === 1 && await pat.getByRole('button', { name: /^(Add a contact|Edit|Delete)/ }).count() === 0);
  await addContact(olive, { name: 'Lee Marsh', organisation: 'First aid', phone: '07700 900789' });
  await pat.waitForSelector('.contact-name:has-text("Lee Marsh")', { timeout: 6000 });
  f = await fetchFile(pat, pat.getByRole('button', { name: 'Download CSV' }));
  expect('Pat\'s download has the contact that arrived live', rows(f.text).length === 4 && f.text.includes('Lee Marsh,First aid,07700 900789'), f.text);
  await olive.mouse.click(5, 895); await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-downloads-contacts-olive-light.png` });
  await pat.mouse.click(5, 895); await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-downloads-contacts-pat-viewer.png` });

  // Expenses: one column per person's share, amounts as plain numbers.
  const oliveExp = await open('Olive Organizer', 'Expenses');
  await newItem(oliveExp, 'expenselist', 'New expense list', 'Shared costs', '#festival', LIST);
  await oliveExp.getByRole('button', { name: 'Add an expense' }).click();
  const ef = oliveExp.locator('form[aria-label="Add an expense"]');
  await ef.getByLabel('What for').fill('Padlocks, two');
  await ef.getByLabel('Amount', { exact: true }).fill('90');
  await ef.getByRole('button', { name: 'Add expense' }).click();
  await oliveExp.waitForSelector('.exp-title:has-text("Padlocks")');
  f = await fetchFile(oliveExp, oliveExp.getByRole('button', { name: 'Download CSV' }));
  r = rows(f.text);
  expect('Expenses CSV: date, what for, amount, payer, split and a share column per person', f.name === `${LIST}.csv`
    && r[0] === 'Date,What for,Amount,Paid by,Split,Share of Alex (test admin),Share of Olive Organizer,Share of Pat Public,Share of Vic Volunteer'
    && /^\d{4}-\d\d-\d\d,"Padlocks, two",90\.00,Olive Organizer,evenly,22\.50,22\.50,22\.50,22\.50$/.test(r[1]), r.join(' | '));

  // Inventory.
  const oliveInv = await open('Olive Organizer', 'Inventory');
  await newItem(oliveInv, 'inventory', 'New inventory', 'Our things', '#festival', INV);
  await oliveInv.getByRole('button', { name: 'Add a thing' }).click();
  const tf = oliveInv.locator('form[aria-label="Add a thing"]');
  await tf.getByLabel('Thing').fill('Radio'); await tf.getByLabel('Kept in').fill('Gate hut'); await tf.getByLabel('Note').fill('Channel 3');
  await tf.getByRole('button', { name: 'Add thing' }).click();
  await oliveInv.waitForSelector('.inv-name:text-is("Radio")');
  f = await fetchFile(oliveInv, oliveInv.getByRole('button', { name: 'Download CSV' }));
  r = rows(f.text);
  expect('Inventory CSV: thing, kept in, note, who has it, since, back by', f.name === `${INV}.csv` && r[0] === 'Thing,Kept in,Note,Has it,Since,Back by'
    && r[1] === 'Radio,Gate hut,Channel 3,,,', r.join(' | '));

  // Calendar: one space's events as .ics.
  const alex = await open('Alex (test admin)', 'Calendar', true);
  await alex.waitForSelector('#cal-dl-space');
  await alex.selectOption('#cal-dl-space', { label: '#festival' });
  f = await fetchFile(alex, alex.getByRole('button', { name: 'Download .ics' }));
  const nEv = (f.text.match(/BEGIN:VEVENT\r\n/g) || []).length;
  const longest = Math.max(...f.text.split('\r\n').map((l) => Buffer.byteLength(l)));
  expect('Calendar .ics: a VCALENDAR with #festival\'s events in UTC, lines folded', f.name === '#festival calendar.ics'
    && f.text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && f.text.trimEnd().endsWith('END:VCALENDAR') && nEv >= 3
    && /DTSTART:\d{8}T\d{6}Z\r\n/.test(f.text) && longest <= 75, `${f.name} ${nEv} ${longest}`);
  await alex.waitForSelector('.cal-bar .slot-status');
  expect('The Calendar says how many events it downloaded', (await alex.locator('.cal-bar .slot-status').innerText()) === `Downloaded ${nEv} events from #festival.`);
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-downloads-calendar-alex-dark.png` });
  const patCal = await open('Pat Public', 'Calendar');
  await patCal.waitForSelector('#cal-dl-space');
  const opts = await patCal.locator('#cal-dl-space option').allInnerTexts();
  expect('Pat\'s Calendar offers only her own spaces to download (#festival, never Organizers or volunteers)', opts[0] === 'Personal' && opts.includes('#festival')
    && !opts.some((o) => /organizers|volunteers/.test(o)), opts.join(','));
  await patCal.selectOption('#cal-dl-space', { label: '#festival' });
  f = await fetchFile(patCal, patCal.getByRole('button', { name: 'Download .ics' }));
  expect('Pat (viewer) gets the same #festival events', (f.text.match(/BEGIN:VEVENT\r\n/g) || []).length === nEv);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
