// Tasks in real browsers, on the test stack (tests/run.sh --keep): Olive makes a list in #festival and
// adds tasks; Alex (dark mode) sees a new task arrive live; Pat (viewer) gets a read-only list and never
// sees the Organizers list; the due tasks show on the Calendar and in Olive's Home widget.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node tasks-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Tasks")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const newList = async (p, space, title) => {
    await p.selectOption('#new-tasklist', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
    await p.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list' && document.querySelector('.tasks .convo-empty'));
    await p.fill('#title-tasklist', title); await p.press('#title-tasklist', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${title}")`);
  };
  const addTask = async (p, title, who, due) => {
    await p.fill('#task-new', title);
    if (who) await p.selectOption('#task-new-who', { label: who });
    if (due) await p.fill('#task-new-due', due);
    await p.getByRole('button', { name: 'Add task' }).click();
    await p.waitForSelector(`.task input[value="${title}"]`);
  };

  const olive = await open('Olive Organizer');
  await newList(olive, '#organizers', 'Sponsor sign-offs');
  await addTask(olive, 'Countersign the bakery sponsorship', 'Olive Organizer (you)', day(2));
  await newList(olive, '#festival', 'Festival prep');
  await addTask(olive, 'Order the porch signs', 'Olive Organizer (you)', day(-1));
  await addTask(olive, 'Hang the bunting on Elm Street', 'Pat Public', day(1));
  await addTask(olive, 'Print the volunteer badges', 'Vic Volunteer', day(4));
  await addTask(olive, 'Book the sound check', '', day(9));
  await olive.getByRole('checkbox', { name: 'Done: Book the sound check' }).check();
  await olive.waitForSelector('.task.is-done');
  expect('Olive: 3 open, 1 done', (await olive.locator('.task-count').innerText()) === '3 open, 1 done', await olive.locator('.task-count').innerText());
  expect('Olive: the overdue task is marked late', await olive.locator('.task:has(input[value="Order the porch signs"]) .task-due.is-late').count() === 1);

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival prep' }).click(); await alex.waitForSelector('.task');
  const t0 = Date.now();
  await addTask(olive, 'Ask the library about chairs', 'Alex (test admin)', day(3));
  await alex.waitForSelector('.task input[value="Ask the library about chairs"]', { timeout: 6000 });
  out(`Alex saw Olive's new task live: ${Date.now() - t0} ms`);
  await olive.getByRole('checkbox', { name: 'Done: Hang the bunting on Elm Street' }).check();
  await alex.waitForSelector('.task.is-done:has(input[value="Hang the bunting on Elm Street"])', { timeout: 6000 });
  expect('Alex saw a tick live', true);
  await olive.getByRole('checkbox', { name: 'Done: Hang the bunting on Elm Street' }).uncheck();
  await alex.waitForSelector('.task:not(.is-done):has(input[value="Hang the bunting on Elm Street"])', { timeout: 6000 });
  await olive.waitForTimeout(500);
  await olive.screenshot({ path: `${SHOTS}/1-tasks-olive-light.png` });
  await alex.screenshot({ path: `${SHOTS}/2-tasks-alex-dark.png` });

  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees Festival prep, not Sponsor sign-offs', lists.includes('Festival prep') && !lists.includes('Sponsor sign-offs'), lists.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival prep' }).click(); await pat.waitForSelector('.task');
  expect('Pat: no add form, no editable fields', await pat.locator('#task-new').count() === 0 && await pat.locator('.task input:not([type=checkbox]), .task select').count() === 0);
  const nChecks = await pat.locator('.task-check').count(); const nOn = await pat.locator('.task-check:not([disabled])').count();
  expect('Pat: every checkbox is disabled', nOn === 0 && nChecks === 5, `${nOn} of ${nChecks} enabled`);
  expect('Pat: the title is read-only', await pat.locator('#title-tasklist[readonly]').count() === 1);
  expect('Pat: no delete or move', await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-tasklist').count() === 0);
  await pat.getByLabel('Only mine').check();
  expect('Pat: Only mine shows her task', (await pat.locator('.task-title--read').allInnerTexts()).join() === 'Hang the bunting on Elm Street', (await pat.locator('.task-title--read').allInnerTexts()).join());
  await pat.getByLabel('Only mine').uncheck();
  await pat.screenshot({ path: `${SHOTS}/3-tasks-pat-viewer.png` });

  // Home widget (Olive has never saved a layout, so she gets the default with Tasks due soon).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  const w = olive.locator('.widget:has(h3:has-text("Tasks due soon"))');
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: Olive\'s own tasks first, then others due within a week', rows[0] === 'Order the porch signs' || rows[0] === 'Countersign the bakery sponsorship', rows.join(', '));
  expect('Widget: done tasks and tasks due later are left out', !rows.includes('Book the sound check'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Countersign the bakery sponsorship' }).click();
  await olive.waitForSelector('#tab-tasks[aria-selected="true"]'); await olive.waitForSelector('.task input[value="Countersign the bakery sponsorship"]');
  expect('Widget: a row opens its list in Tasks', true);

  // Calendar: open tasks due this week appear as all-day entries; clicking one opens the list.
  await olive.locator('#tab-home').click(); await olive.locator('.app:has-text("Calendar")').click(); await olive.waitForSelector('.cal-main');
  await olive.waitForTimeout(1200);
  await olive.locator('.cal-main button[aria-label="Month view"]').click();
  await olive.waitForTimeout(1200);
  const cal = await olive.locator('.cal-main .cal-task').allInnerTexts();
  out('calendar tasks:', cal.join(' | '));
  expect('Calendar: due tasks show', cal.some((t) => t.includes('Print the volunteer badges')), cal.join(', '));
  expect('Calendar: done tasks do not', !cal.some((t) => t.includes('Book the sound check')), cal.join(', '));
  await olive.getByLabel('Tasks due').uncheck(); await olive.waitForTimeout(300);
  expect('Calendar: the Tasks due switch hides them', await olive.locator('.cal-main .cal-task').count() === 0);
  await olive.getByLabel('Tasks due').check(); await olive.waitForTimeout(300);
  await olive.locator('.cal-main .cal-task', { hasText: 'Print the volunteer badges' }).first().click();
  await olive.waitForSelector('#tab-tasks[aria-selected="true"]');
  expect('Calendar: a task opens its list', await olive.locator('#title-tasklist').inputValue() === 'Festival prep');

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
