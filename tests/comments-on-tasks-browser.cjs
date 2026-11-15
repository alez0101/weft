// Comments on tasks in real browsers, on the test stack (tests/run.sh --keep): Olive makes a list in #festival
// with a task for Pat and one for herself and comments on hers; Alex (dark mode) sees the count arrive live,
// opens the thread and replies, and Olive sees the reply live. Pat (viewer in #festival) reads every thread
// with no way to post on someone else's task or delete others' comments, and comments on the task assigned
// to her. On Boards the card shows the count and opens the thread in place (arrow keys typed there do not
// move the card). Pat's Home widget lists the comment Olive left on her task.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node comments-on-tasks-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const LIST = `Stage setup ${Date.now() % 100000}`;
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
  const addTask = async (p, title, who, due) => {
    await p.fill('#task-new', title);
    if (who) await p.selectOption('#task-new-who', { label: who });
    if (due) await p.fill('#task-new-due', due);
    await p.getByRole('button', { name: 'Add task' }).click();
    await p.waitForSelector(`.task input[value="${title}"]`);
  };
  // A task row, for an editor (title in an input) or a reader (title as text).
  const row = (p, title) => p.locator(`.task:has(input[value="${title}"]), .task:has(.task-title--read:text-is("${title}"))`);
  const toggle = (p, title) => row(p, title).locator('.tc-toggle');
  const waitToggle = (p, title, text) => p.waitForFunction(([t, x]) => [...document.querySelectorAll('.task')].some((r) =>
    (r.querySelector(`input[value="${t}"]`) || [...r.querySelectorAll('.task-title--read')].some((e) => e.textContent === t))
    && r.querySelector('.tc-toggle')?.textContent.startsWith(x)), [title, text], { timeout: 8000 });

  const olive = await open('Olive Organizer');
  await olive.selectOption('#new-tasklist', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list' && document.querySelector('.tasks .convo-empty'));
  await olive.fill('#title-tasklist', LIST); await olive.press('#title-tasklist', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${LIST}")`);
  await addTask(olive, 'Hang the banners', 'Pat Public', day(3));
  await addTask(olive, 'Order the stage', 'Olive Organizer (you)', day(5));
  await addTask(olive, 'Book the sound engineer', '', day(9));
  expect('Each task has a Comment button, closed', (await olive.locator('.task .tc-toggle').allInnerTexts()).every((t) => t.startsWith('Comment'))
    && await olive.locator('.task .tc-toggle').count() === 3 && await olive.locator('.tc-thread').count() === 0);

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: LIST }).click(); await alex.waitForSelector('.task');

  // Olive comments on her own task.
  await toggle(olive, 'Order the stage').click();
  expect('Opening it shows an empty thread with a comment box', await row(olive, 'Order the stage').locator('.tc-add textarea').count() === 1
    && await toggle(olive, 'Order the stage').getAttribute('aria-expanded') === 'true');
  await row(olive, 'Order the stage').locator('.tc-add textarea').fill('Stage company needs the size by Friday. Same as last year?');
  const t0 = Date.now();
  await row(olive, 'Order the stage').getByRole('button', { name: 'Post' }).click();
  await waitToggle(olive, 'Order the stage', '1 comment');
  const head = await row(olive, 'Order the stage').locator('.tc-head').first().innerText();
  expect('Olive posts; the thread shows "You", the time and the text, and the box is cleared',
    head.startsWith('You') && /just now/.test(head)
    && (await row(olive, 'Order the stage').locator('.tc-body').innerText()) === 'Stage company needs the size by Friday. Same as last year?'
    && await row(olive, 'Order the stage').locator('.tc-add textarea').inputValue() === '', head);

  // Alex sees the count live, opens the thread and replies; Olive sees the reply live.
  await waitToggle(alex, 'Order the stage', '1 comment');
  out(`Alex saw the comment count live: ${Date.now() - t0} ms`);
  expect('Alex sees "1 comment" on the task live', true);
  await toggle(alex, 'Order the stage').click();
  expect('Alex reads it, by Olive Organizer', (await row(alex, 'Order the stage').locator('.tc-who').first().innerText()) === 'Olive Organizer');
  await row(alex, 'Order the stage').locator('.tc-add textarea').fill('Yes, 8 by 6 metres. I can send the drawing.');
  await row(alex, 'Order the stage').locator('.tc-add textarea').press('Control+Enter');
  await waitToggle(alex, 'Order the stage', '2 comments');
  expect('Alex replies with Ctrl+Enter', true);
  await waitToggle(olive, 'Order the stage', '2 comments');
  await olive.waitForFunction(() => document.querySelectorAll('.tc-item').length === 2, null, { timeout: 8000 });
  expect('Olive sees the reply live, in order', (await row(olive, 'Order the stage').locator('.tc-who').allInnerTexts()).join('|') === 'You|Alex (test admin)');
  expect('Olive (editor) may delete only her own comment; Alex (owner) may delete both',
    await row(olive, 'Order the stage').locator('.tc-delete').count() === 1 && await row(alex, 'Order the stage').locator('.tc-delete').count() === 2);
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-comments-on-tasks-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-comments-on-tasks-alex-dark.png` });

  // Pat (viewer in #festival): reads, cannot post on others' tasks, posts on her own.
  const pat = await open('Pat Public');
  await pat.locator('.doc-link', { hasText: LIST }).click(); await pat.waitForSelector('.task');
  expect('Pat sees "2 comments" on Order the stage, and Comment only on her own task',
    (await toggle(pat, 'Order the stage').innerText()).startsWith('2 comments') && (await toggle(pat, 'Hang the banners').innerText()).startsWith('Comment')
    && await toggle(pat, 'Book the sound engineer').count() === 0);
  await toggle(pat, 'Order the stage').click();
  expect('Pat reads the thread, with no comment box and no Delete, and is told who can comment',
    await row(pat, 'Order the stage').locator('.tc-item').count() === 2 && await row(pat, 'Order the stage').locator('.tc-add, .tc-delete').count() === 0
    && (await row(pat, 'Order the stage').locator('.tc-hint').innerText()).includes('Only editors and the person the task is assigned to'));
  await toggle(pat, 'Hang the banners').click();
  await row(pat, 'Hang the banners').locator('.tc-add textarea').fill('Banners are in the shed, I will hang them Saturday morning.');
  await row(pat, 'Hang the banners').getByRole('button', { name: 'Post' }).click();
  await waitToggle(pat, 'Hang the banners', '1 comment');
  expect('Pat comments on the task assigned to her, and may delete it', await row(pat, 'Hang the banners').locator('.tc-delete').count() === 1);
  await waitToggle(olive, 'Hang the banners', '1 comment');
  expect('Olive sees Pat\'s comment arrive live', true);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-comments-on-tasks-pat-viewer.png` });

  // Boards: the card shows the count and opens the thread in place.
  await olive.locator('#tab-home').click(); await olive.locator('.app:has-text("Boards")').click(); await olive.waitForSelector('.docs-list');
  await olive.locator('.doc-link', { hasText: LIST }).click(); await olive.waitForSelector('.kanban-title');
  const card = (title) => olive.locator(`li.kanban-card:has(.kanban-title:text-is("${title}"))`);
  expect('Boards: the cards show their comment counts', (await card('Order the stage').locator('.tc-toggle').innerText()).startsWith('2 comments')
    && (await card('Hang the banners').locator('.tc-toggle').innerText()).startsWith('1 comment'), await card('Order the stage').innerText());
  await card('Hang the banners').locator('.tc-toggle').click();
  expect('Boards: the thread opens inside the card', (await card('Hang the banners').locator('.tc-body').innerText()).startsWith('Banners are in the shed'));
  const before = await card('Hang the banners').locator('xpath=ancestor::section[1]').getAttribute('aria-label');
  const box = card('Hang the banners').locator('.tc-add textarea');
  await box.fill('Thanks Pat! Take the long ladder');
  await box.press('ArrowLeft'); await box.press('ArrowRight');
  await card('Hang the banners').getByRole('button', { name: 'Post' }).click();
  await olive.waitForFunction(() => [...document.querySelectorAll('li.kanban-card')].some((c) => c.querySelector('.kanban-title')?.textContent === 'Hang the banners' && c.querySelector('.tc-toggle')?.textContent.startsWith('2 comments')), null, { timeout: 8000 });
  const after = await card('Hang the banners').locator('xpath=ancestor::section[1]').getAttribute('aria-label');
  expect('Boards: Olive comments from the card; arrow keys typed in the box did not move the card', before === after, `${before} -> ${after}`);
  await waitToggle(pat, 'Hang the banners', '2 comments');
  expect('Pat sees the comment from Boards live in Tasks', true);

  // Pat's Home: the comment Olive left on her task.
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets');
  if (await pat.locator('.widget:has(h3:has-text("New comments on your tasks"))').count() === 0) {
    await pat.getByRole('button', { name: 'Customize' }).click();
    await pat.getByLabel('New comments on your tasks').check();
    await pat.getByRole('button', { name: 'Done' }).click();
  }
  const w = pat.locator('.widget:has(h3:has-text("New comments on your tasks")) .widget-row');
  await w.first().waitFor({ timeout: 8000 });
  const wt = await w.allInnerTexts();
  expect('Home widget: Pat sees Olive\'s comment on her task (not her own)', wt.length >= 1 && /Olive Organizer on Hang the banners[\s\S]*Take the long ladder/.test(wt[0])
    && !wt.some((t) => t.includes('Banners are in the shed')), wt.join(' / '));
  await w.first().click(); await pat.waitForSelector('.task');
  expect('Home widget: the row opens the task list', await row(pat, 'Hang the banners').count() === 1);

  // Pat deletes her own comment; Olive sees it go.
  await toggle(pat, 'Hang the banners').click();
  await row(pat, 'Hang the banners').locator('.tc-item:has-text("Banners are in the shed") .tc-delete').click();
  await waitToggle(pat, 'Hang the banners', '1 comment');
  expect('Pat deletes her own comment', (await row(pat, 'Hang the banners').locator('.tc-body').allInnerTexts()).join('|') === 'Thanks Pat! Take the long ladder');

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
