// Inventory in real browsers, on the test stack (tests/run.sh --keep): Olive makes an inventory in
// Organizers and a "Festival gear" one in #festival and adds things kept in two places and one with no place;
// Alex (dark mode) sees them live, grouped by where they are kept; Olive checks a thing out to Vic and Alex
// checks one out to himself, each seen live with "Checked out now" and the record; the filters and the word
// search; Weft search finds the inventory by a thing; Pat (viewer) sees only the #festival inventory, cannot
// add, change or delete, checks a free thing out to herself (Olive sees it live), cannot check in what Alex
// has, sees a delete live, turns on the "Things you have" Home widget, opens the inventory from it and
// checks the thing back in.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node inventory-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
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
  const newInventory = async (p, space, name) => {
    await p.selectOption('#new-inventory', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New inventory' }).click();
    await p.waitForFunction(() => document.querySelector('#title-inventory')?.value === 'Our things');
    await p.fill('#title-inventory', name); await p.press('#title-inventory', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addThing = async (p, name, where, note) => {
    await p.getByRole('button', { name: 'Add a thing' }).click();
    const f = p.locator('form[aria-label="Add a thing"]');
    await f.getByLabel('Thing').fill(name);
    if (where) await f.getByLabel('Kept in').fill(where);
    if (note) await f.getByLabel('Note').fill(note);
    await f.getByRole('button', { name: 'Add thing' }).click();
    await p.waitForSelector(`.inv-name:text-is("${name}")`);
  };
  const thing = (p, name) => p.locator('.inv-thing', { has: p.locator(`.inv-name:text-is("${name}")`) });
  const state = (p, name) => thing(p, name).locator('.inv-state').innerText();
  const waitState = (p, name, text) => p.waitForFunction(([n, t]) => [...document.querySelectorAll('.inv-thing')]
    .some((e) => e.querySelector('.inv-name')?.textContent === n && e.querySelector('.inv-state')?.textContent === t), [name, text], { timeout: 6000 });

  const olive = await open('Olive Organizer');
  await newInventory(olive, '#organizers', 'Organizer kit');
  await addThing(olive, 'Projector', 'Office cupboard');
  await newInventory(olive, '#festival', 'Festival gear');
  expect('A new inventory says it is empty', (await olive.locator('.inventory .convo-empty').first().innerText()).includes('Nothing here yet'));
  await addThing(olive, 'Tent', 'Shed, shelf 2', 'Sleeps four. Poles in the green bag.');

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival gear' }).click(); await alex.waitForSelector('.inventory');
  const t0 = Date.now();
  await addThing(olive, 'Gazebo', 'Garage');
  await alex.waitForSelector('.inv-name:text-is("Gazebo")', { timeout: 6000 });
  out(`Alex saw Olive's new thing live: ${Date.now() - t0} ms`);
  await addThing(olive, 'Extension lead', 'Shed, shelf 2');
  await addThing(olive, 'Van keys');
  await alex.waitForSelector('.inv-name:text-is("Van keys")', { timeout: 6000 });
  const places = await alex.locator('.inv-place > .cl-section').allInnerTexts();
  expect('Things are grouped by where they are kept, no place last', places.map((s) => s.replace(/\s+\d+$/, '')).join(' | ') === 'Garage | Shed, shelf 2 | No place set', places.join(' | '));
  expect('A new thing is in', (await state(alex, 'Tent')) === 'In');

  // Olive checks the lead out to Vic; Alex sees it live.
  await thing(olive, 'Extension lead').getByRole('button', { name: /^Check out/ }).click();
  const lend = olive.locator('form[aria-label="Check out Extension lead"]');
  expect('Checking out starts with you', (await lend.locator('select option:checked').innerText()).includes('(you)'));
  await lend.getByLabel('Check out to').selectOption({ label: 'Vic Volunteer' });
  await lend.getByRole('button', { name: 'Check out' }).click();
  await waitState(alex, 'Extension lead', 'With Vic Volunteer');
  expect('Alex sees the lead with Vic live', true);
  // Alex checks the tent out to himself.
  await thing(alex, 'Tent').getByRole('button', { name: /^Check out/ }).click();
  await alex.locator('form[aria-label="Check out Tent"]').getByRole('button', { name: 'Check out' }).click();
  await waitState(alex, 'Tent', 'With you');
  await waitState(olive, 'Tent', 'With Alex (test admin)');
  expect('Olive sees the tent with Alex live; Alex sees "With you"', true);
  const outNow = await olive.locator('.inv-out li').allInnerTexts();
  expect('Checked out now lists both', outNow.length === 2 && outNow.some((s) => s.includes('Tent') && s.includes('Alex')) && outNow.some((s) => s.includes('Extension lead') && s.includes('Vic')), outNow.join(' | '));
  const recent = await olive.locator('.inv-moves li').allInnerTexts();
  expect('The record says who checked out what, and by whom', recent.length === 2 && recent[0].includes('Tent') && recent[1].includes('Extension lead: checked out to Vic Volunteer by Olive Organizer'), recent.join(' | '));
  const count = await olive.locator('.inventory .links-filters > .task-count').innerText();
  expect('The count says how many are out', count === '4 things, 2 checked out', count);

  // Filters.
  await olive.getByRole('button', { name: 'Checked out', exact: true }).click();
  expect('Checked out shows only what is out', (await olive.locator('.inv-name').allInnerTexts()).sort().join(',') === 'Extension lead,Tent');
  await olive.getByRole('button', { name: 'In', exact: true }).click();
  expect('In shows only what is in', (await olive.locator('.inv-name').allInnerTexts()).sort().join(',') === 'Gazebo,Van keys');
  await olive.getByRole('button', { name: 'All', exact: true }).click();
  await olive.fill('#inv-find', 'vic');
  expect('Finding by who has it', (await olive.locator('.inv-name').allInnerTexts()).join(',') === 'Extension lead');
  await olive.fill('#inv-find', 'green bag');
  expect('Finding by the note', (await olive.locator('.inv-name').allInnerTexts()).join(',') === 'Tent');
  await olive.fill('#inv-find', '');

  await olive.locator('.inv-thing', { hasText: 'Tent' }).locator('.inv-history summary').click();
  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-inventory-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-inventory-alex-dark.png` });

  // Weft search finds the inventory by a thing.
  await olive.locator('.search input').fill('Gazebo');
  const hit = olive.locator('.search-group:has-text("Inventories")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the inventory by a thing', found && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Festival gear')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival inventory, not the Organizers one', lists.includes('Festival gear') && !lists.includes('Organizer kit'), lists.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival gear' }).click(); await pat.waitForSelector('.inv-thing');
  expect('Pat: no Add, Edit, Delete or Move', await pat.getByRole('button', { name: /^(Add a thing|Edit|Delete)/ }).count() === 0
    && await pat.locator('#move-inventory').count() === 0);
  expect('Pat: the hint says what she can do', (await pat.locator('.inventory > .docs-hint').innerText()).includes('check things out to yourself'));
  expect('Pat: no Check out or Check in on the tent Alex has', await thing(pat, 'Tent').getByRole('button').count() === 0);
  await thing(pat, 'Gazebo').getByRole('button', { name: /^Check out to me/ }).click();
  await waitState(pat, 'Gazebo', 'With you');
  await waitState(olive, 'Gazebo', 'With Pat Public');
  expect('Pat checks the gazebo out to herself; Olive sees it live', true);
  expect('Pat can check in what she has', await thing(pat, 'Gazebo').getByRole('button', { name: /^Check in/ }).count() === 1);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-inventory-pat-viewer.png` });
  await thing(olive, 'Van keys').getByRole('button', { name: /^Delete/ }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.inv-name')].some((e) => e.textContent === 'Van keys'), null, { timeout: 6000 });
  expect('A deleted thing disappears live for Pat', true);

  // Home widget: not on by default; Pat turns it on.
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Things you have' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const w = pat.locator('.widget:has(h3:has-text("Things you have"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: what Pat has, and where from', rows.length === 1 && rows[0].includes('Gazebo') && rows[0].includes('Festival gear'), rows.join(', '));
  await w.locator('.widget-row').first().click();
  await pat.waitForSelector('#tab-inventory[aria-selected="true"]');
  await pat.waitForFunction(() => document.querySelector('#title-inventory')?.value === 'Festival gear');
  expect('Widget: a row opens its inventory', true);
  await thing(pat, 'Gazebo').getByRole('button', { name: /^Check in/ }).click();
  await waitState(olive, 'Gazebo', 'In');
  expect('Pat checks the gazebo back in; Olive sees it live', (await olive.locator('.inv-moves li').first().innerText()).includes('Gazebo: checked in from Pat Public'));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
