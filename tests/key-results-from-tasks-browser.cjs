// Key results from tasks in real browsers, on the test stack (tests/run.sh --keep): Olive makes a task list in
// #festival with four tasks (one done, one assigned to Pat), then a goal set there whose key result counts from
// that list: "1 of 4 tasks done", 25 %, with no Update box. Alex (dark mode) watches the set; Olive ticks off a
// task in Tasks and both Goals screens move to 2 of 4 live. Pat (viewer) ticks off the task assigned to Pat in
// Tasks; the key result reaches 3 of 4, says Pat updated it, and Pat's Goals screen has no way to change it. The
// list's name opens the list. Olive switches the key result back to typed numbers: it keeps 3 of 4 and gets its
// Update box back.
// Run from a dir with playwright:  WEFT_REPO=<this repo> WEFT_SHOTS=<dir> node key-results-from-tasks-browser.cjs
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const REPO = process.env.WEFT_REPO || (require('fs').existsSync(path.resolve(__dirname, '../stacks')) ? path.resolve(__dirname, '..') : `${process.env.HOME}/work/weft`);
const ownerSql = (sql) => {
  const docker = (process.env.WEFT_DOCKER || 'docker').split(' ');
  return execFileSync(docker[0], [...docker.slice(1), 'compose', '-p', 'weft-test', '-f', `${REPO}/stacks/weft/compose.yaml`, '-f', `${REPO}/stacks/weft-test/compose.test.yaml`,
    '--env-file', `${REPO}/stacks/weft-test/.env`, 'exec', '-T', 'postgres', 'psql', '-At', '-U', 'weft_owner', '-d', 'weft', '-c', sql]).toString().trim();
};
const LIST = 'Parade prep'; const SET = 'Parade goals'; const GOAL = 'Run a smooth parade'; const KR = `Tasks done in ${LIST}`;

(async () => {
  // A second run on the same test stack starts clean (test stack only).
  ownerSql(`delete from weft.items where title in ('${LIST}', '${SET}') and space_id = (select id from weft.spaces where name = 'festival')`);
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, app, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator(`.app:has-text("${app}")`).click(); await p.waitForSelector('.docs-list'); return p;
  };
  const kr = (p) => p.locator('.goal-kr', { has: p.locator('.goal-kr-title', { hasText: KR }) });
  const value = (p) => kr(p).locator('.goal-kr-value').innerText();
  const waitValue = (p, text, timeout = 6000) => p.waitForFunction(([t, v]) => [...document.querySelectorAll('.goal-kr')]
    .some((e) => e.querySelector('.goal-kr-title')?.textContent.includes(t) && e.querySelector('.goal-kr-value')?.textContent === v), [KR, text], { timeout }).then(() => true).catch(() => false);
  const addTask = async (p, title, who) => {
    await p.fill('#task-new', title);
    if (who) await p.selectOption('#task-new-who', { label: who });
    await p.getByRole('button', { name: 'Add task' }).click();
    await p.waitForSelector(`.task input[value="${title}"]`);
  };

  // Olive's task list in #festival.
  const tasks = await open('Olive Organizer', 'Tasks');
  await tasks.selectOption('#new-tasklist', { label: '#festival' });
  await tasks.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await tasks.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list' && document.querySelector('.tasks .convo-empty'));
  await tasks.fill('#title-tasklist', LIST); await tasks.press('#title-tasklist', 'Enter');
  await tasks.waitForSelector(`.doc-link:has-text("${LIST}")`);
  await addTask(tasks, 'Book the brass band');
  await addTask(tasks, 'Close Elm Street for the morning');
  await addTask(tasks, 'Hang the bunting on the route', 'Pat Public');
  await addTask(tasks, 'Find two first-aid volunteers');
  await tasks.getByRole('checkbox', { name: 'Done: Book the brass band' }).check();
  await tasks.waitForSelector('.task.is-done');

  // Olive's goal set, with a key result that counts from the list.
  const olive = await open('Olive Organizer', 'Goals');
  await olive.selectOption('#new-goalset', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New goal set' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-goalset')?.value === 'Goals');
  await olive.fill('#title-goalset', SET); await olive.press('#title-goalset', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${SET}")`);
  await olive.getByRole('button', { name: 'Add a goal' }).click();
  await olive.fill('#goal-new-title', GOAL); await olive.fill('#goal-new-note', 'Everything on the prep list done by parade day.');
  await olive.locator('form[aria-label="Add a goal"]').getByRole('button', { name: 'Add goal' }).click();
  await olive.waitForSelector(`.goal-title:has-text("${GOAL}")`);
  await olive.getByRole('button', { name: `Add a key result to ${GOAL}` }).click();
  const f = olive.locator(`form[aria-label="Add a key result to ${GOAL}"]`);
  const options = await f.getByLabel('Count from').locator('option').allInnerTexts();
  expect('Count from offers typed numbers and the task lists of this space only', options[0] === 'Numbers typed by hand' && options.includes(`Done tasks in ${LIST}`)
    && !options.some((o) => o.includes('Sponsor')), options.join(' | '));
  await f.getByLabel('Count from').selectOption({ label: `Done tasks in ${LIST}` });
  expect('Choosing a list fills in a title and hides the number boxes', (await f.locator('input[id$="-title"]').inputValue()) === KR && await f.locator('input[id$="-target"]').count() === 0);
  await f.getByRole('button', { name: 'Add key result' }).click();
  await olive.waitForSelector(`.goal-kr-title:has-text("${KR}")`);
  expect('The key result counts the list: 1 of 4 tasks done, 25%', (await value(olive)) === '1 of 4 tasks done' && (await kr(olive).locator('.goal-pct').innerText()) === '25%', await value(olive));
  expect('It says where it counts from, and has no Update box', (await kr(olive).locator('.goal-kr-source').innerText()) === `Counts from ${LIST}` && await kr(olive).locator('.goal-update').count() === 0);

  // Alex watches in dark mode; Olive ticks a task in Tasks.
  const alex = await open('Alex (test admin)', 'Goals', true);
  await alex.locator('.doc-link', { hasText: SET }).click(); await alex.waitForSelector('.goal-kr');
  const t0 = Date.now();
  await tasks.getByRole('checkbox', { name: 'Done: Close Elm Street for the morning' }).check();
  const live = await waitValue(alex, '2 of 4 tasks done');
  out(`Alex saw the key result move live: ${Date.now() - t0} ms`);
  expect('Olive ticks off a task in Tasks; Alex sees 2 of 4 live', live, await value(alex));
  expect('and so does Olive\'s own Goals screen, with the goal at 50%', await waitValue(olive, '2 of 4 tasks done')
    && (await olive.locator('.goal .goal-head .goal-pct').innerText()) === '50%');
  await olive.mouse.move(5, 895); await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-key-results-from-tasks-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-key-results-from-tasks-alex-dark.png` });

  // Pat (viewer) ticks off the task assigned to Pat; the key result follows and names Pat.
  const patGoals = await open('Pat Public', 'Goals');
  await patGoals.locator('.doc-link', { hasText: SET }).click(); await patGoals.waitForSelector('.goal-kr');
  const patTasks = await open('Pat Public', 'Tasks');
  await patTasks.locator('.doc-link', { hasText: LIST }).click(); await patTasks.waitForSelector('.task');
  await patTasks.getByRole('checkbox', { name: 'Done: Hang the bunting on the route' }).check();
  expect('Pat ticks off the task assigned to Pat; Pat\'s Goals screen shows 3 of 4 live', await waitValue(patGoals, '3 of 4 tasks done'), await value(patGoals));
  const by = await kr(patGoals).locator('.link-by').innerText();
  expect('and says Pat updated it', by.includes('by Pat Public'), by);
  expect('Pat: no way to change goals or key results', await patGoals.locator('.goals button:not(.link-btn), .goals input, .goals select').count() === 0,
    await patGoals.locator('.goals button:not(.link-btn), .goals input, .goals select').count());
  expect('Alex sees 3 of 4 too', await waitValue(alex, '3 of 4 tasks done'));
  await patGoals.waitForTimeout(300);
  await patGoals.screenshot({ path: `${SHOTS}/3-key-results-from-tasks-pat-viewer.png` });

  // The list's name opens the list.
  await kr(patGoals).locator('.goal-kr-source .link-btn').click();
  const opened = await patGoals.waitForSelector('.task:has-text("Hang the bunting on the route")', { timeout: 6000 }).then(() => true).catch(() => false);
  expect('The list\'s name opens the task list', opened);

  // Back to typed numbers: the last count stays, and the Update box returns.
  await kr(olive).getByRole('button', { name: `Edit ${KR}` }).click();
  const ef = olive.locator(`form[aria-label="Edit ${KR}"]`);
  expect('Editing shows the list it counts from', (await ef.getByLabel('Count from').locator('option:checked').innerText()) === `Done tasks in ${LIST}`);
  await ef.getByLabel('Count from').selectOption({ label: 'Numbers typed by hand' });
  await ef.getByRole('button', { name: 'Save' }).click();
  await olive.waitForSelector(`.goal-kr:has-text("${KR}") .goal-update`);
  expect('Typed again: it keeps 3 of 4 and gets its Update box back', (await value(olive)) === '3 of 4 tasks' && await kr(olive).locator('.goal-kr-source').count() === 0, await value(olive));
  await tasks.getByRole('checkbox', { name: 'Done: Find two first-aid volunteers' }).check();
  await tasks.waitForTimeout(1500);
  expect('and ticking another task no longer moves it', (await value(olive)) === '3 of 4 tasks', await value(olive));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
