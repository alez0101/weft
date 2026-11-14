// Expenses in real browsers, on the test stack (tests/run.sh --keep): Olive makes an expense list in
// Organizers and a "Festival costs" list in #festival and adds an even split; Alex (dark mode) sees it live
// and adds a split by amounts (Save stays off until the shares add up); both see the balances and the
// settle-up list; Olive changes the amount and Alex sees the balances move live; Pat (viewer) reads the
// #festival list only, with no way to change it, and sees a delete live; Weft search finds the list by an
// expense; Pat turns on the "Your balances" Home widget and a row opens the list.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node expenses-browser.cjs
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
    await p.locator('.app:has-text("Expenses")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const newList = async (p, space, name) => {
    await p.selectOption('#new-expenselist', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New expense list' }).click();
    await p.waitForFunction(() => document.querySelector('#title-expenselist')?.value === 'Shared costs');
    await p.fill('#title-expenselist', name); await p.press('#title-expenselist', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const form = (p) => p.locator('form[aria-label="Add an expense"]');
  const person = (f, name) => f.locator('.exp-person', { hasText: name });
  const balance = (p, name) => p.locator('.exp-bal', { hasText: name }).locator('.exp-bal-net').innerText();
  const settle = (p) => p.locator('.exp-settle li').allInnerTexts();
  const flat = (a) => a.map((s) => s.replace(/\s+/g, ' ').trim());

  const olive = await open('Olive Organizer');
  await newList(olive, '#organizers', 'Organizer dinners');
  await newList(olive, '#festival', 'Festival costs');
  expect('A new list says it is empty', (await olive.locator('.expenses .convo-empty').first().innerText()).includes('No expenses yet'));
  await olive.getByRole('button', { name: 'Add an expense' }).click();
  let f = form(olive);
  expect('Paid by starts as you, and everyone in the space is in the split', await f.locator('select').inputValue() !== ''
    && await f.locator('.exp-person input[type="checkbox"]:checked').count() === 4);
  expect('Add expense is off until there is a title and an amount', await f.getByRole('button', { name: 'Add expense' }).isDisabled());
  await f.getByLabel('What for').fill('Van hire');
  await f.getByLabel('Amount', { exact: true }).fill('90');
  expect('The form says what each person pays', (await f.locator('.exp-left').innerText()).includes('22.50 each'), await f.locator('.exp-left').innerText());

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival costs' }).click(); await alex.waitForSelector('.expenses');
  const t0 = Date.now();
  await f.getByRole('button', { name: 'Add expense' }).click();
  await alex.waitForSelector('.exp-title:has-text("Van hire")', { timeout: 6000 });
  out(`Alex saw Olive's expense live: ${Date.now() - t0} ms`);
  expect('The expense says who paid and how it is split', flat([await alex.locator('.expense .exp-meta').first().innerText()])[0]
    .includes('Paid by Olive Organizer, split evenly between Alex (test admin), Olive Organizer, Pat Public, Vic Volunteer'));
  expect('Balances after one expense: Olive is owed 67.50, Pat owes 22.50', (await balance(alex, 'Olive')) === 'is owed 67.50' && (await balance(alex, 'Pat')) === 'owes 22.50');

  // Alex: a split by amounts; Save stays off until the shares add up.
  await alex.getByRole('button', { name: 'Add an expense' }).click();
  f = form(alex);
  await f.getByLabel('What for').fill('Ice and water');
  await f.getByLabel('Amount', { exact: true }).fill('25');
  await f.getByLabel('By amounts').check();
  await person(f, 'Alex').locator('input[type="checkbox"]').uncheck();
  await person(f, 'Olive').locator('input[type="checkbox"]').uncheck();
  await person(f, 'Pat').locator('input.exp-amount').fill('10');
  await person(f, 'Vic').locator('input.exp-amount').fill('10');
  expect('By amounts: the form says what is still to share out, and Add expense is off', (await f.locator('.exp-left').innerText()).includes('5.00 still to share out')
    && await f.getByRole('button', { name: 'Add expense' }).isDisabled(), await f.locator('.exp-left').innerText());
  await person(f, 'Vic').locator('input.exp-amount').fill('15');
  expect('When the shares add up it says so', (await f.locator('.exp-left').innerText()) === 'The shares add up.');
  await f.getByRole('button', { name: 'Add expense' }).click();
  await olive.waitForSelector('.exp-title:has-text("Ice and water")', { timeout: 6000 });
  expect('Olive sees Alex\'s split by amounts live', flat([await olive.locator('.expense', { hasText: 'Ice and water' }).locator('.exp-meta').innerText()])[0]
    .includes('split by amounts: Pat Public 10.00, Vic Volunteer 15.00'));
  expect('Running balances: Olive owed 67.50, Alex owed 2.50, Pat owes 32.50, Vic owes 37.50',
    (await balance(olive, 'Olive')) === 'is owed 67.50' && (await balance(olive, 'Alex')) === 'is owed 2.50'
    && (await balance(olive, 'Pat')) === 'owes 32.50' && (await balance(olive, 'Vic')) === 'owes 37.50');
  const s1 = flat(await settle(olive));
  expect('To settle up: the fewest payments', s1.join(' | ') === 'Vic Volunteer pays Olive Organizer 37.50 | Pat Public pays Olive Organizer 30.00 | Pat Public pays Alex (test admin) 2.50', s1.join(' | '));
  expect('The total is shown', (await olive.locator('#exp-list-title').innerText()).includes('2, total 115.00'));

  // Olive changes the van to 80.00: Alex sees the balances move live.
  await olive.locator('.expense', { hasText: 'Van hire' }).getByRole('button', { name: /^Edit/ }).click();
  const ef = olive.locator('form[aria-label="Edit Van hire"]');
  expect('Editing starts from the saved expense', (await ef.getByLabel('Amount', { exact: true }).inputValue()) === '90.00');
  await ef.getByLabel('Amount', { exact: true }).fill('80');
  await ef.getByRole('button', { name: 'Save' }).click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.exp-bal')].some((e) => e.textContent.includes('Olive') && e.textContent.includes('is owed 60.00')), null, { timeout: 6000 });
  expect('Alex sees the new balances live', (await balance(alex, 'Vic')) === 'owes 35.00' && (await balance(alex, 'Alex')) === 'is owed 5.00');

  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-expenses-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-expenses-alex-dark.png` });

  // Weft search finds the list by an expense.
  await olive.locator('.search input').fill('Ice and water');
  const hit = olive.locator('.search-group:has-text("Expenses")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the list by an expense', found && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Festival costs')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival list, not the Organizers one', lists.includes('Festival costs') && !lists.includes('Organizer dinners'), lists.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival costs' }).click(); await pat.waitForSelector('.expense');
  expect('Pat: no Add, Edit, Delete or Move', await pat.getByRole('button', { name: /^(Add an expense|Edit|Delete)/ }).count() === 0
    && await pat.locator('#move-expenselist').count() === 0);
  expect('Pat: the hint says why', (await pat.locator('.expenses > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat reads the balances, marked as you', (await pat.locator('.exp-bal', { hasText: 'Pat' }).innerText()).includes('(you)') && (await balance(pat, 'Pat')) === 'owes 30.00');
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-expenses-pat-viewer.png` });
  await olive.locator('.expense', { hasText: 'Ice and water' }).getByRole('button', { name: /^Delete/ }).click();
  await pat.waitForFunction(() => !document.querySelector('.exp-title')?.textContent.includes('Ice') && document.querySelectorAll('.expense').length === 1, null, { timeout: 6000 });
  expect('A deleted expense disappears live for Pat, and the balances follow', (await balance(pat, 'Pat')) === 'owes 20.00');

  // Home widget: not on by default; Pat turns it on.
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Your balances' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const w = pat.locator('.widget:has(h3:has-text("Your balances"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: what Pat owes, and where', rows.length === 1 && rows[0].includes('You owe 20.00') && rows[0].includes('Festival costs'), rows.join(', '));
  await w.locator('.widget-row').first().click();
  await pat.waitForSelector('#tab-expenses[aria-selected="true"]');
  await pat.waitForFunction(() => document.querySelector('#title-expenselist')?.value === 'Festival costs');
  expect('Widget: a row opens its list', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
