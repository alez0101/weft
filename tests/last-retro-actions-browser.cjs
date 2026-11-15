// Last retro's actions in real browsers, on the test stack (tests/run.sh --keep): Olive makes a task list and a
// retro in #festival with three actions, turns two into tasks (one for her, one for Vic due in the past) and
// ticks hers off; she starts a second retro and "Last retro's actions" shows the three with Done, Late and Not a
// task and the counts; she carries the one that never became a task over and it lands in this retro's Actions;
// Alex (dark mode) watches the same retro and sees the carried note and a tick live; Pat (viewer) sees the
// actions but cannot tick Vic's task; the previous retro's name opens it. Names carry a run tag, so the check
// can run again on the same stack.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node last-retro-actions-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const RUN = Date.now().toString(36).slice(-5);
const LIST = `Follow-ups ${RUN}`;
const R1 = `Spring fair retro ${RUN}`;
const R2 = `Summer fair retro ${RUN}`;
const A_DONE = 'Print bigger signs for the car park';
const A_LATE = 'Book a second first-aid tent';
const A_NONE = 'Ask the council about late buses';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark, app = 'Retros') => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator(`.app:has-text("${app}")`).first().click(); await p.waitForSelector('.docs-list'); return p;
  };
  const note = (p, text) => p.locator('.retro-note', { has: p.locator('.retro-body', { hasText: text }) });
  const row = (p, text) => p.locator('.retro-last-row', { hasText: text });
  const addAction = async (p, text) => {
    const f = p.locator('form[aria-label="Add to Actions"]');
    await f.locator('textarea').fill(text);
    await f.getByRole('button', { name: /^Add/ }).click();
    await p.waitForSelector(`.retro-col--action .retro-body:has-text("${text}")`);
  };
  const newRetro = async (p, title) => {
    await p.selectOption('#new-retro', { label: '#festival' });
    await p.locator('.docs-new').getByRole('button', { name: 'New retro' }).click();
    await p.waitForFunction(() => document.querySelector('#title-retro')?.value === 'Retro');
    await p.fill('#title-retro', title); await p.press('#title-retro', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${title}")`);
    await p.waitForSelector('.retro-columns');
  };
  const openRetro = async (p, title) => {
    await p.locator('.doc-link', { hasText: title }).click();
    await p.waitForFunction((t) => document.querySelector('#title-retro')?.value === t, title);
    await p.waitForSelector('.retro-columns');
  };
  const makeTask = async (p, text, who, due) => {
    await note(p, text).getByRole('button', { name: /^Make a task/ }).click();
    await p.locator('form[aria-label="Make a task"] select').selectOption({ label: who });
    await p.locator('form[aria-label="Make a task"] input[type="date"]').fill(due);
    await p.locator('form[aria-label="Make a task"]').getByRole('button', { name: 'Make the task' }).click();
    await note(p, text).locator('.retro-task').waitFor();
  };

  // Olive: a task list in #festival, then the first retro with three actions.
  const olive = await open('Olive Organizer', false, 'Tasks');
  await olive.selectOption('#new-tasklist', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list');
  await olive.fill('#title-tasklist', LIST); await olive.press('#title-tasklist', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${LIST}")`);
  await olive.locator('#tab-home').click();
  await olive.locator('.app:has-text("Retros")').first().click(); await olive.waitForSelector('.docs-list');
  await newRetro(olive, R1);
  await olive.fill('#retro-from', '2026-04-01');
  await olive.waitForTimeout(300);
  await olive.fill('#retro-to', '2026-04-30');
  await olive.selectOption('#retro-list', { label: LIST });
  await olive.waitForSelector('button:has-text("Open the list")');
  for (const a of [A_DONE, A_LATE, A_NONE]) await addAction(olive, a);
  await makeTask(olive, A_DONE, 'Olive Organizer (you)', '2026-05-15');
  await makeTask(olive, A_LATE, 'Vic Volunteer', '2026-05-20');
  await note(olive, A_DONE).locator('.retro-task input').click();
  await olive.waitForSelector(`.retro-note:has-text("${A_DONE}") .retro-task.is-done`);

  // The second retro: the first one's actions are waiting at the top.
  await newRetro(olive, R2);
  await olive.waitForSelector('.retro-last');
  expect('A new retro shows "Last retro\'s actions" from the previous #festival retro, with its period',
    (await olive.locator('.retro-last-from').innerText()).replace(/\s+/g, ' ').startsWith(`From ${R1}, `)
    && (await olive.locator('.retro-last-from').innerText()).includes('Apr'), await olive.locator('.retro-last-from').innerText());
  const texts = (await olive.locator('.retro-last-row .retro-body').allInnerTexts());
  expect('It lists the three actions in the order they were written', texts.join('|') === [A_DONE, A_LATE, A_NONE].join('|'), texts.join('|'));
  const badge = async (p, t) => (await row(p, t).locator('.retro-last-badge').innerText()).trim();
  expect('Each shows its task: Done, Late, Not a task', (await badge(olive, A_DONE)) === 'Done' && (await badge(olive, A_LATE)) === 'Late' && (await badge(olive, A_NONE)) === 'Not a task',
    `${await badge(olive, A_DONE)} ${await badge(olive, A_LATE)} ${await badge(olive, A_NONE)}`);
  expect('The open task says who it is for', (await row(olive, A_LATE).locator('.retro-last-state').innerText()).includes('Vic Volunteer'));
  expect('The counts', (await olive.locator('.retro-last .goal-meta').innerText()) === '3 actions: 1 done, 1 still open, 1 never made a task', await olive.locator('.retro-last .goal-meta').innerText());
  expect('Done actions have no Carry over; the others do', await row(olive, A_DONE).getByRole('button', { name: /^Carry over/ }).count() === 0
    && await row(olive, A_LATE).getByRole('button', { name: /^Carry over/ }).count() === 1 && await row(olive, A_NONE).getByRole('button', { name: /^Carry over/ }).count() === 1);
  expect('The new retro itself starts empty', await olive.locator('.retro-note').count() === 0);

  // Alex watches the second retro in dark mode.
  const alex = await open('Alex (test admin)', true);
  await openRetro(alex, R2);
  await alex.waitForSelector('.retro-last-row');

  // Olive carries the action that never became a task over.
  await row(olive, A_NONE).getByRole('button', { name: /^Carry over/ }).click();
  await olive.waitForSelector(`.retro-col--action .retro-body:has-text("${A_NONE}")`);
  await row(olive, A_NONE).locator('.retro-last-carried').waitFor();
  expect('Carry over adds it to this retro\'s Actions, in Olive\'s name, and the row says "In this retro"',
    (await note(olive, A_NONE).locator('.retro-by').innerText()).trim() === 'Olive Organizer (you)'
    && await row(olive, A_NONE).getByRole('button', { name: /^Carry over/ }).count() === 0);
  let t0 = Date.now();
  await alex.waitForSelector(`.retro-col--action .retro-body:has-text("${A_NONE}")`, { timeout: 6000 });
  await row(alex, A_NONE).locator('.retro-last-carried').waitFor({ timeout: 6000 });
  out(`Alex saw the carried action live: ${Date.now() - t0} ms`);
  expect('Alex sees the carried action live', true);

  await olive.mouse.click(5, 995);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-last-retro-actions-olive-light.png` });

  // Pat (viewer): sees them, cannot tick Vic's task.
  const pat = await open('Pat Public');
  await openRetro(pat, R2);
  await pat.waitForSelector('.retro-last-row');
  expect('Pat sees the last retro\'s actions', (await pat.locator('.retro-last-row').count()) === 3);
  expect('Pat cannot tick Vic\'s task (or Olive\'s) from there', await row(pat, A_LATE).locator('input.task-check').isDisabled() && await row(pat, A_DONE).locator('input.task-check').isDisabled());
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-last-retro-actions-pat-viewer.png` });

  // Olive (editor) ticks the late task off from the box: Alex and Pat see it done live.
  await row(olive, A_LATE).locator('input.task-check').click();
  t0 = Date.now();
  await alex.waitForFunction((t) => [...document.querySelectorAll('.retro-last-row.is-done')].some((e) => e.textContent.includes(t)), A_LATE, { timeout: 6000 });
  out(`Alex saw the tick live: ${Date.now() - t0} ms`);
  await pat.waitForFunction((t) => [...document.querySelectorAll('.retro-last-row.is-done')].some((e) => e.textContent.includes(t)), A_LATE, { timeout: 6000 });
  expect('A tick from the box shows as Done for Alex and Pat live, and the counts follow',
    (await alex.locator('.retro-last .goal-meta').innerText()) === '3 actions: 2 done, 0 still open, 1 never made a task', await alex.locator('.retro-last .goal-meta').innerText());
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-last-retro-actions-alex-dark.png` });

  // The previous retro's name opens it.
  await olive.locator('.retro-last-link').click();
  await olive.waitForFunction((t) => document.querySelector('#title-retro')?.value === t, R1);
  expect('The previous retro\'s name opens it', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
