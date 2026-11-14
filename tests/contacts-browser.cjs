// Contacts in real browsers, on the test stack (tests/run.sh --keep): Olive makes an address book in
// Organizers and one in #festival and adds contacts; Alex (dark mode) watches contacts arrive and change
// live; the filter matches name, organisation, notes and phone digits; a bad email is refused with the
// database's answer; phone and email become tel: and mailto: links; Pat (viewer) reads the #festival book
// only, with no way to change it, and sees a delete live; Weft search finds a contact's book; Olive turns
// on the "New contacts" Home widget and a row opens the book.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node contacts-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Contacts")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const card = (p, name) => p.locator('.contact', { has: p.locator('.contact-name', { hasText: name }) });
  const names = (p) => p.locator('.contact-name').allInnerTexts();
  const newBook = async (p, space, name) => {
    await p.selectOption('#new-addressbook', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New address book' }).click();
    await p.waitForFunction(() => document.querySelector('#title-addressbook')?.value === 'Contacts');
    await p.fill('#title-addressbook', name); await p.press('#title-addressbook', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addContact = async (p, { name, organisation = '', phone = '', email = '', notes = '' }, wait = true) => {
    await p.getByRole('button', { name: 'Add a contact' }).click();
    await p.fill('#contact-new-name', name); await p.fill('#contact-new-org', organisation); await p.fill('#contact-new-phone', phone);
    await p.fill('#contact-new-email', email); await p.fill('#contact-new-notes', notes);
    await p.locator('form[aria-label="Add a contact"]').getByRole('button', { name: 'Add contact' }).click();
    if (wait) await p.waitForSelector(`.contact-name:has-text("${name}")`);
  };

  const olive = await open('Olive Organizer');
  await newBook(olive, '#organizers', 'Sponsors');
  await addContact(olive, { name: 'Dana Whitfield', organisation: 'Riverside Bakery', phone: '+44 20 7946 0123', email: 'dana@example.org', notes: 'Gold sponsor. Prefers calls before noon.' });
  await newBook(olive, '#festival', 'Festival contacts');
  await addContact(olive, { name: 'Sam Okafor', organisation: 'Stage crew', phone: '07700 900456', email: 'Sam@Example.org', notes: 'Has the gate keys. Gate B is the volunteer entrance.' });
  await addContact(olive, { name: 'Lee Marsh', organisation: 'First aid', phone: '07700 900789' });
  await addContact(olive, { name: 'Ana Ruiz', organisation: 'Town council, events office', email: 'events@example.gov' });
  expect('Contacts are sorted by name', (await names(olive)).join(',') === 'Ana Ruiz,Lee Marsh,Sam Okafor', (await names(olive)).join(','));
  expect('The email is stored lowercased', (await card(olive, 'Sam Okafor').locator('a[href^="mailto:"]').innerText()).includes('sam@example.org'));
  expect('Phone and email are tel: and mailto: links', await card(olive, 'Sam Okafor').locator('a[href="tel:07700900456"]').count() === 1
    && await card(olive, 'Sam Okafor').locator('a[href="mailto:sam@example.org"]').count() === 1);

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival contacts' }).click(); await alex.waitForSelector('.contact');
  const t0 = Date.now();
  await addContact(olive, { name: 'Priya Shah', organisation: 'Sound hire', phone: '+44 161 496 0000', email: 'priya@example.net', notes: 'Delivers the PA on Friday at 9' });
  await alex.waitForSelector('.contact-name:has-text("Priya Shah")', { timeout: 6000 });
  out(`Alex saw Olive's contact live: ${Date.now() - t0} ms`);
  expect('Alex sees the new contact live, with who added it', (await card(alex, 'Priya Shah').locator('.link-by').innerText()) === 'Added by Olive Organizer');

  // Edit, live for Alex.
  await card(olive, 'Lee Marsh').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.contact form input[id$="-org"]', 'St John first aid'); await olive.fill('.contact form input[id$="-email"]', 'lee@example.org');
  await olive.locator('.contact form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.contact .link-host:has-text("St John first aid")', { timeout: 6000 });
  expect('An edit shows live', await card(alex, 'Lee Marsh').locator('a[href="mailto:lee@example.org"]').count() === 1);

  // The filter.
  await olive.fill('#contacts-find', 'gate keys');
  let shown = await names(olive);
  expect('Words filter by notes', shown.length === 1 && shown[0] === 'Sam Okafor', shown.join(', '));
  await olive.fill('#contacts-find', 'council');
  shown = await names(olive);
  expect('Words filter by organisation', shown.length === 1 && shown[0] === 'Ana Ruiz', shown.join(', '));
  await olive.fill('#contacts-find', '900789');
  shown = await names(olive);
  expect('Phone digits match however the number is spaced', shown.length === 1 && shown[0] === 'Lee Marsh', shown.join(', '));
  await olive.fill('#contacts-find', 'nobody-like-this');
  expect('No match says so', (await olive.locator('.contacts .convo-empty').innerText()) === 'No contacts match.');
  await olive.fill('#contacts-find', '');

  // The database refuses an email that is not a plain address, and the screen shows why.
  await olive.getByRole('button', { name: 'Add a contact' }).click();
  await olive.fill('#contact-new-name', 'Sneaky'); await olive.fill('#contact-new-email', 'x@example.org?cc=all@example.org');
  await olive.locator('form[aria-label="Add a contact"]').getByRole('button', { name: 'Add contact' }).click();
  await olive.waitForSelector('.contacts .send-error');
  expect('A bad email is refused, with the reason shown', (await olive.locator('.contacts .send-error').innerText()).startsWith('Could not add the contact')
    && !(await names(olive)).includes('Sneaky'));
  await olive.locator('form[aria-label="Add a contact"]').getByRole('button', { name: 'Cancel' }).click();
  // Reload so the refused attempt's message is gone before the screenshot.
  await olive.locator('.doc-link', { hasText: 'Sponsors' }).click(); await olive.waitForSelector('.contact-name:has-text("Dana Whitfield")');
  await olive.locator('.doc-link', { hasText: 'Festival contacts' }).click(); await olive.waitForSelector('.contact-name:has-text("Sam Okafor")');
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-contacts-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-contacts-alex-dark.png` });

  // Weft search finds a contact (through the address book's text).
  await olive.locator('.search input').fill('Riverside Bakery');
  const hit = olive.locator('.search-group:has-text("Address books")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the address book by a contact\'s organisation', found
    && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Sponsors')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const books = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival book, not the Organizers one', books.includes('Festival contacts') && !books.includes('Sponsors'), books.join(', '));
  const patSpaces = await pat.locator('#new-addressbook option').allInnerTexts();
  expect('Pat can make address books only where she edits (not #festival)', !patSpaces.includes('#festival') && patSpaces.length >= 1, patSpaces.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival contacts' }).click(); await pat.waitForSelector('.contact');
  expect('Pat: no Add a contact, Edit, Delete or Move', await pat.getByRole('button', { name: 'Add a contact' }).count() === 0
    && await pat.locator('.contact').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0
    && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-addressbook').count() === 0);
  expect('Pat: the book name is read-only and the hint says why', await pat.locator('#title-addressbook[readonly]').count() === 1
    && (await pat.locator('.contacts > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat can still call or email and filter', await pat.locator('.contact a[href^="tel:"]').count() === 3 && await pat.locator('#contacts-find').count() === 1);
  await card(olive, 'Ana Ruiz').getByRole('button', { name: 'Delete' }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.contact-name')].some((e) => e.textContent === 'Ana Ruiz'), null, { timeout: 6000 });
  expect('A delete shows live for Pat', (await names(pat)).length === 3);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-contacts-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'New contacts' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("New contacts"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: newest contacts first, deleted ones gone', rows[0] === 'Priya Shah, Sound hire' && !rows.some((r) => r.startsWith('Ana Ruiz')), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Dana Whitfield' }).click();
  await olive.waitForSelector('#tab-contacts[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-addressbook')?.value === 'Sponsors');
  expect('Widget: a row opens its address book in Contacts', true);
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'New contacts' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const pwd = pat.locator('.widget:has(h3:has-text("New contacts"))');
  await pwd.locator('.widget-main').first().waitFor();
  const pw = await pwd.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival contacts only', pw.length > 0 && !pw.some((r) => r.startsWith('Dana Whitfield')), pw.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
