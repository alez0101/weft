// Repeating tasks in real browsers, on the test stack (tests/run.sh --keep): Olive makes a list in #festival
// with a daily task for Pat, a weekly one for herself and a monthly one; ticking the weekly one off brings it
// back due a week later, and Alex (dark mode) sees both arrive live; Olive turns a plain task into a repeating
// one and back; Pat (viewer in #festival) reads how tasks repeat with no way to change it, ticks off her own
// daily task and gets the next one due tomorrow; the Boards card and the Home widget say how a task repeats.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node repeating-tasks-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const LIST = `Porch chores ${Date.now() % 100000}`;
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Tasks")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const addTask = async (p, title, who, due, repeats) => {
    await p.fill('#task-new', title);
    if (who) await p.selectOption('#task-new-who', { label: who });
    if (due) await p.fill('#task-new-due', due);
    await p.selectOption('#task-new-repeat', repeats || '');
    await p.getByRole('button', { name: 'Add task' }).click();
    await p.waitForSelector(`.task input[value="${title}"]`);
  };
  const openRow = (p, title) => p.locator(`.task:not(.is-done):has(input[value="${title}"])`);
  const rows = (p, title) => p.locator(`.task:has(input[value="${title}"]), .task:has(.task-title--read:text-is("${title}"))`);

  const olive = await open('Olive Organizer');
  await olive.selectOption('#new-tasklist', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list' && document.querySelector('.tasks .convo-empty'));
  await olive.fill('#title-tasklist', LIST); await olive.press('#title-tasklist', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${LIST}")`);
  expect('The add form has a Repeats choice, "Does not repeat" by default', await olive.inputValue('#task-new-repeat') === ''
    && (await olive.locator('#task-new-repeat option').allInnerTexts()).join('|') === 'Does not repeat|Every day|Every week|Every month');
  await addTask(olive, 'Water the porch plants', 'Pat Public', day(-1), 'daily');
  await addTask(olive, 'Take out the recycling', 'Olive Organizer (you)', day(0), 'weekly');
  await addTask(olive, 'Pay the hall rent', '', day(5), 'monthly');
  await addTask(olive, 'Buy gaffer tape', 'Olive Organizer (you)', day(2));
  expect('Each row shows how it repeats', await openRow(olive, 'Take out the recycling').locator('select.task-repeat').inputValue() === 'weekly'
    && await openRow(olive, 'Buy gaffer tape').locator('select.task-repeat').inputValue() === '');

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: LIST }).click(); await alex.waitForSelector('.task');

  // Olive ticks off the weekly one: it stays done, and the next one comes back due a week later.
  const t0 = Date.now();
  await olive.getByRole('checkbox', { name: 'Done: Take out the recycling' }).first().check();
  await olive.waitForSelector('.task.is-done:has(input[value="Take out the recycling"])');
  await olive.waitForFunction(() => document.querySelectorAll('.task input[value="Take out the recycling"]').length === 2);
  expect('Ticking it off brings back the next one, due a week later, still weekly and still Olive\'s',
    await openRow(olive, 'Take out the recycling').locator('.task-due').inputValue() === day(7)
    && await openRow(olive, 'Take out the recycling').locator('select.task-repeat').inputValue() === 'weekly'
    && (await openRow(olive, 'Take out the recycling').locator('select.task-who option:checked').innerText()).startsWith('Olive'),
    await openRow(olive, 'Take out the recycling').locator('.task-due').inputValue());
  expect('Olive is told the next one is on the list', (await olive.locator('.task-info').innerText()).includes('repeats every week, so the next one is on the list'),
    await olive.locator('.task-info').innerText());
  expect('The done one no longer repeats (its Repeats is off and locked)', await olive.locator('.task.is-done:has(input[value="Take out the recycling"]) select.task-repeat').isDisabled()
    && await olive.locator('.task.is-done:has(input[value="Take out the recycling"]) select.task-repeat').inputValue() === '');
  await alex.waitForFunction(() => document.querySelectorAll('.task input[value="Take out the recycling"]').length === 2, null, { timeout: 8000 });
  out(`Alex saw the tick and the next one live: ${Date.now() - t0} ms`);
  expect('Alex sees the done one and the next one live', await alex.locator('.task.is-done:has(input[value="Take out the recycling"])').count() === 1);

  // Unticking and ticking again makes no second copy.
  await olive.locator('.task.is-done:has(input[value="Take out the recycling"]) .task-check').click();
  await olive.waitForFunction(() => document.querySelectorAll('.task:not(.is-done) input[value="Take out the recycling"]').length === 2);
  await olive.locator('.task-check[aria-label="Done: Take out the recycling"]').first().click();
  await olive.waitForTimeout(800);
  const n = await olive.locator('.task input[value="Take out the recycling"]').count();
  expect('Reopening and ticking the old one again adds no third copy', n === 2, `${n} rows`);

  // A plain task becomes weekly, then plain again.
  await openRow(olive, 'Buy gaffer tape').locator('select.task-repeat').selectOption('weekly');
  await alex.waitForFunction(() => [...document.querySelectorAll('.task')].some((r) => r.querySelector('input[value="Buy gaffer tape"]') && r.querySelector('select.task-repeat')?.value === 'weekly'), null, { timeout: 8000 });
  expect('Olive makes a plain task repeat weekly; Alex sees it live', true);
  await openRow(olive, 'Buy gaffer tape').locator('select.task-repeat').selectOption('');
  await alex.waitForFunction(() => [...document.querySelectorAll('.task')].some((r) => r.querySelector('input[value="Buy gaffer tape"]') && r.querySelector('select.task-repeat')?.value === ''), null, { timeout: 8000 });
  expect('and back to not repeating (Alex sees that live too)', await openRow(olive, 'Buy gaffer tape').locator('select.task-repeat').inputValue() === '');
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-repeating-tasks-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-repeating-tasks-alex-dark.png` });

  // Pat (viewer in #festival): reads the repeats, cannot change them, ticks off her own daily task.
  const pat = await open('Pat Public');
  await pat.locator('.doc-link', { hasText: LIST }).click(); await pat.waitForSelector('.task');
  expect('Pat: no add form and no Repeats controls', await pat.locator('#task-new, #task-new-repeat, select.task-repeat').count() === 0);
  const reps = await pat.locator('.task:not(.is-done) .task-repeats').allInnerTexts();
  expect('Pat reads how each task repeats', reps.includes('Every day') && reps.includes('Every week') && reps.includes('Every month'), reps.join(', '));
  expect('Pat can tick off only her own task', await pat.locator('.task-check:not([disabled])').count() === 1
    && await pat.getByRole('checkbox', { name: 'Done: Water the porch plants' }).isEnabled());
  await pat.getByRole('checkbox', { name: 'Done: Water the porch plants' }).check();
  await pat.waitForFunction(() => [...document.querySelectorAll('.task-title--read')].filter((e) => e.textContent === 'Water the porch plants').length === 2);
  const next = pat.locator('.task:not(.is-done):has(.task-title--read:text-is("Water the porch plants"))');
  expect('Pat ticks it off and the next one is hers, due tomorrow, every day',
    (await next.locator('.task-meta').allInnerTexts()).join('|') === 'Pat Public|Due tomorrow|Every day', (await next.locator('.task-meta').allInnerTexts()).join('|'));
  expect('Pat is told the next one is on the list', (await pat.locator('.task-info').innerText()).includes('repeats every day'), await pat.locator('.task-info').innerText());
  await olive.waitForFunction(() => document.querySelectorAll('.task input[value="Water the porch plants"]').length === 2, null, { timeout: 8000 });
  expect('Olive sees Pat\'s next one live', true);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-repeating-tasks-pat-viewer.png` });

  // Boards: the card says how it repeats.
  await olive.locator('#tab-home').click(); await olive.locator('.app:has-text("Boards")').click(); await olive.waitForSelector('.docs-list');
  await olive.locator('.doc-link', { hasText: LIST }).click(); await olive.waitForSelector('.kanban-title');
  const card = olive.locator('li:has(.kanban-title:text-is("Pay the hall rent")) .kanban-meta');
  expect('Boards: the card says Every month', (await card.innerText()).includes('Every month'), await card.innerText());

  // Home: the Tasks due soon widget says how it repeats.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  const subs = await olive.locator('.widget:has(h3:has-text("Tasks due soon")) .widget-row').allInnerTexts();
  expect('Home widget: a repeating task says how it repeats', subs.some((t) => /Water the porch plants[\s\S]*every day|Take out the recycling[\s\S]*every week|Pay the hall rent[\s\S]*every month/.test(t)), subs.join(' / '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
