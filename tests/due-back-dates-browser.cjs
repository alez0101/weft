// Due-back dates in real browsers, on the test stack (tests/run.sh --keep): Olive makes a "Loan gear"
// inventory in #festival, checks a ladder out to Pat with a back-by date (Alex, in dark mode, sees it live),
// checks a drill out with no date and gives it one later; a date in the past is refused and the reason shown.
// Nobody can set a past date, so the test makes the ladder overdue with the owner's SQL on the test stack;
// then it shows "Overdue" in red, the count and the Overdue filter, and "Checked out now" sorted overdue first.
// Pat (viewer) has no date buttons on what others have, sets a date on what she borrowed (Olive sees it
// live), sees the "Things you have" widget sorted by date with the overdue one in red, and checking the
// ladder in clears it.
// Run from a dir with playwright:  WEFT_REPO=<this repo> WEFT_SHOTS=<dir> node due-back-dates-browser.cjs
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const REPO = process.env.WEFT_REPO || (require('fs').existsSync(path.resolve(__dirname, '../stacks')) ? path.resolve(__dirname, '..') : `${process.env.HOME}/work/weft`);
// The owner's SQL on the TEST stack only (compose project weft-test), to make a thing overdue.
const ownerSql = (sql) => {
  const docker = (process.env.WEFT_DOCKER || 'docker').split(' ');
  return execFileSync(docker[0], [...docker.slice(1), 'compose', '-p', 'weft-test', '-f', `${REPO}/stacks/weft/compose.yaml`, '-f', `${REPO}/stacks/weft-test/compose.test.yaml`,
    '--env-file', `${REPO}/stacks/weft-test/.env`, 'exec', '-T', 'postgres', 'psql', '-At', '-U', 'weft_owner', '-d', 'weft', '-c', sql]).toString().trim();
};
const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-US' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Inventory")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const addThing = async (p, name, where) => {
    await p.getByRole('button', { name: 'Add a thing' }).click();
    const f = p.locator('form[aria-label="Add a thing"]');
    await f.getByLabel('Thing').fill(name);
    if (where) await f.getByLabel('Kept in').fill(where);
    await f.getByRole('button', { name: 'Add thing' }).click();
    await p.waitForSelector(`.inv-name:text-is("${name}")`);
  };
  const thing = (p, name) => p.locator('.inv-thing', { has: p.locator(`.inv-name:text-is("${name}")`) });
  const meta = (p, name) => thing(p, name).locator('.inv-meta').innerText().catch(() => '');
  const waitMeta = (p, name, text) => p.waitForFunction(([n, t]) => [...document.querySelectorAll('.inv-thing')]
    .some((e) => e.querySelector('.inv-name')?.textContent === n && (e.querySelector('.inv-meta')?.textContent || '').includes(t)), [name, text], { timeout: 6000 });
  const lendTo = async (p, name, who, due) => {
    await thing(p, name).getByRole('button', { name: /^Check out/ }).click();
    const f = p.locator(`form[aria-label="Check out ${name}"]`);
    await f.getByLabel('Check out to').selectOption({ label: who });
    if (due) await f.getByLabel('Back by').fill(due);
    await f.getByRole('button', { name: 'Check out' }).click();
  };
  const D5 = iso(5); const D9 = iso(9); const D12 = iso(12);
  const words = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

  const olive = await open('Olive Organizer');
  await olive.selectOption('#new-inventory', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New inventory' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-inventory')?.value === 'Our things');
  await olive.fill('#title-inventory', 'Loan gear'); await olive.press('#title-inventory', 'Enter');
  await olive.waitForSelector('.doc-link:has-text("Loan gear")');
  for (const [n, w] of [['Ladder', 'Garage'], ['Drill', 'Garage'], ['Cool box', 'Shed'], ['Bike pump', 'Shed']]) await addThing(olive, n, w);

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Loan gear' }).click(); await alex.waitForSelector('.inv-thing');

  // Olive checks the ladder out to Pat, back in five days; Alex sees the date live.
  await lendTo(olive, 'Ladder', 'Pat Public', D5);
  await waitMeta(alex, 'Ladder', `back by ${words(D5)}`);
  expect('Alex sees the ladder with Pat and its back-by date live', (await meta(alex, 'Ladder')).includes('Pat Public'));
  // Checking out without a date still works, and says nothing about a date.
  await lendTo(olive, 'Drill', 'Vic Volunteer');
  await waitMeta(olive, 'Drill', 'Vic Volunteer');
  expect('A thing checked out with no date shows no date', !(await meta(olive, 'Drill')).includes('back by'));
  // Olive gives the drill a date afterwards, then tries a date in the past: the database's refusal is shown.
  await thing(olive, 'Drill').getByRole('button', { name: /^Set back by date/ }).click();
  const df = olive.locator('form[aria-label="Back by date for Drill"]');
  await df.getByLabel('Back by').fill(D12);
  await df.getByRole('button', { name: 'Save date' }).click();
  await waitMeta(olive, 'Drill', `back by ${words(D12)}`);
  expect('Olive sets a date on a thing already out', true);
  await thing(olive, 'Drill').getByRole('button', { name: /^Change date/ }).click();
  await df.getByLabel('Back by').fill(iso(-4));
  await df.getByRole('button', { name: 'Save date' }).click();
  await olive.waitForSelector('.inventory .send-error');
  expect('A date in the past is refused, with the reason', (await olive.locator('.inventory .send-error').innerText()).includes('cannot be in the past'));
  expect('and the old date stays', (await meta(olive, 'Drill')).includes(words(D12)));
  await df.getByRole('button', { name: 'Cancel' }).click();
  await lendTo(olive, 'Cool box', 'Alex (test admin)', D9);
  await waitMeta(olive, 'Cool box', words(D9));

  // The ladder becomes overdue (only the owner's SQL can make a past date; nobody can set one).
  // Triggers are off for that one statement; a second, empty change (as Olive) announces it to everyone.
  const ladder = "name = 'Ladder' and inventory_id = (select id from weft.items where title = 'Loan gear')";
  ownerSql(`begin; set local session_replication_role = replica; update weft.inventory_things set due_back = current_date - 2 where ${ladder}; commit;`);
  ownerSql(`select set_config('request.jwt.claims', json_build_object('sub', (select id from weft.users where display_name = 'Olive Organizer'))::text, false); update weft.inventory_things set note = note where ${ladder};`);
  await olive.waitForSelector('.inv-thing.is-overdue', { timeout: 6000 });
  expect('The overdue ladder is marked Overdue', (await thing(olive, 'Ladder').locator('.inv-state.is-overdue').innerText()) === 'Overdue');
  expect('and says when it was due, in the error colour', (await meta(olive, 'Ladder')).includes(`was due back ${words(iso(-2))}, overdue`)
    && await thing(olive, 'Ladder').locator('.inv-due.is-late').count() === 1);
  const colour = await thing(olive, 'Ladder').locator('.inv-due').evaluate((e) => getComputedStyle(e).color);
  const plain = await thing(olive, 'Ladder').locator('.inv-meta').evaluate((e) => getComputedStyle(e).color);
  expect('The overdue words are a different colour from the rest of the line', colour !== plain, `${colour} ${plain}`);
  const count = await olive.locator('.inventory .links-filters > .task-count').innerText();
  expect('The count says how many are overdue', count === '4 things, 3 checked out, 1 overdue', count);
  const outNow = await olive.locator('.inv-out li').allInnerTexts();
  expect('Checked out now is sorted by back-by date, overdue first', outNow.length === 3 && outNow[0].includes('Ladder') && outNow[1].includes('Cool box') && outNow[2].includes('Drill'), outNow.join(' | '));
  await olive.getByRole('button', { name: 'Overdue', exact: true }).click();
  expect('The Overdue filter shows only the ladder', (await olive.locator('.inv-name').allInnerTexts()).join(',') === 'Ladder');
  await olive.getByRole('button', { name: 'All', exact: true }).click();
  const alexLive = await alex.waitForSelector('.inv-thing.is-overdue', { timeout: 6000 }).then(() => true).catch(() => false);
  expect('Alex sees the ladder overdue live', alexLive);
  await alex.mouse.click(5, 895); await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-due-back-alex-dark.png` });
  await olive.mouse.click(5, 895); await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-due-back-olive-light.png` });

  // Pat (viewer in #festival).
  const pat = await open('Pat Public');
  await pat.locator('.doc-link', { hasText: 'Loan gear' }).click(); await pat.waitForSelector('.inv-thing');
  expect('Pat sees the ladder she has as overdue', await thing(pat, 'Ladder').locator('.inv-state.is-overdue').count() === 1);
  expect('Pat: no date buttons on what others have', await thing(pat, 'Drill').getByRole('button').count() === 0
    && await thing(pat, 'Cool box').getByRole('button').count() === 0);
  // She borrows the pump herself and gives it a date.
  await thing(pat, 'Bike pump').getByRole('button', { name: /^Check out to me/ }).click();
  await waitMeta(pat, 'Bike pump', 'you');
  await thing(pat, 'Bike pump').getByRole('button', { name: /^Set back by date/ }).click();
  const pf = pat.locator('form[aria-label="Back by date for Bike pump"]');
  await pf.getByLabel('Back by').fill(D9);
  await pf.getByRole('button', { name: 'Save date' }).click();
  await waitMeta(pat, 'Bike pump', `back by ${words(D9)}`);
  await waitMeta(olive, 'Bike pump', `back by ${words(D9)}`);
  expect('Pat sets a date on what she borrowed; Olive sees it live', true);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-due-back-pat-viewer.png` });

  // The widget: Pat's things sorted by date, overdue in red.
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Things you have' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const w = pat.locator('.widget:has(h3:has-text("Things you have"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: sorted by back-by date, overdue first', rows.length === 2 && rows[0].includes('Ladder') && rows[0].includes('overdue') && rows[1].includes('Bike pump') && rows[1].includes(`Back by ${words(D9)}`), rows.join(' | '));
  expect('Widget: the overdue one is in the error colour', await w.locator('.widget-row').first().locator('.is-late').count() === 1
    && await w.locator('.widget-row').nth(1).locator('.is-late').count() === 0);
  await w.locator('.widget-row').first().click();
  await pat.waitForFunction(() => document.querySelector('#title-inventory')?.value === 'Loan gear');
  // Checking in clears the date.
  await thing(pat, 'Ladder').getByRole('button', { name: /^Check in/ }).click();
  await olive.waitForFunction(() => [...document.querySelectorAll('.inv-thing')].some((e) => e.querySelector('.inv-name')?.textContent === 'Ladder' && e.querySelector('.inv-state')?.textContent === 'In'), null, { timeout: 6000 });
  expect('Pat checks the ladder in; it is no longer overdue for Olive', await thing(olive, 'Ladder').locator('.is-overdue, .inv-due').count() === 0
    && await olive.locator('.inv-thing.is-overdue').count() === 0);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
