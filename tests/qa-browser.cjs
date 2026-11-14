// Q and A in real browsers, on the test stack (tests/run.sh --keep): Olive makes a board in Organizers
// and one in #festival and asks questions; Alex (dark mode) watches a question arrive live and answers it;
// Olive answers too, cannot upvote her own answer, upvotes Alex's and accepts it, and Alex sees the count
// and the accepted mark live; the filter and "No accepted answer yet" narrow the list; Weft search finds
// the board by an answer's words; Pat (viewer) reads the #festival board only, cannot ask, answer, edit,
// accept or delete, but can upvote, and sees a delete live; Olive turns on the "Open questions" Home
// widget and a row opens the board.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node qa-browser.cjs
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
    await p.locator('.app:has-text("Q and A")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const question = (p, title) => p.locator('.qa-question', { has: p.locator('.qa-title', { hasText: title }) });
  const answerOf = (p, q, text) => question(p, q).locator('.qa-answer', { has: p.locator('.qa-body', { hasText: text }) });
  const titles = (p) => p.locator('.qa-title').allInnerTexts();
  const newBoard = async (p, space, name) => {
    await p.selectOption('#new-qa', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New Q and A board' }).click();
    await p.waitForFunction(() => document.querySelector('#title-qa')?.value === 'Questions');
    await p.fill('#title-qa', name); await p.press('#title-qa', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const ask = async (p, title, details = '') => {
    await p.getByRole('button', { name: 'Ask a question' }).click();
    await p.fill('#qa-new-title', title); await p.fill('#qa-new-details', details);
    await p.locator('form[aria-label="Ask a question"]').getByRole('button', { name: 'Ask', exact: true }).click();
    await p.waitForSelector(`.qa-title:has-text("${title}")`);
  };
  const answer = async (p, q, text) => {
    const f = question(p, q).locator('form.qa-answer-form').last();
    await f.locator('textarea').fill(text); await f.getByRole('button', { name: 'Answer' }).click();
    await answerOf(p, q, text).waitFor();
  };
  const votes = (p, q, text) => answerOf(p, q, text).locator('.qa-votes').innerText();

  const olive = await open('Olive Organizer');
  await newBoard(olive, '#organizers', 'Organizer questions');
  await ask(olive, 'Who signs the sponsor contract?', 'The brewery wants it back by Friday.');
  await newBoard(olive, '#festival', 'Volunteer questions');
  await ask(olive, 'Is there a cloakroom?');
  await ask(olive, 'Where do volunteers park?', 'The field car park flooded last year.');
  expect('Questions are newest first', (await titles(olive)).join(',') === 'Where do volunteers park?,Is there a cloakroom?', (await titles(olive)).join(','));

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Volunteer questions' }).click(); await alex.waitForSelector('.qa-question');
  const t0 = Date.now();
  await ask(olive, 'When do the gates open?', 'For the early shift.');
  await alex.waitForSelector('.qa-title:has-text("When do the gates open?")', { timeout: 6000 });
  out(`Alex saw Olive's question live: ${Date.now() - t0} ms`);
  expect('Alex sees the new question live, with who asked', (await question(alex, 'When do the gates open?').locator('.link-by').innerText()).startsWith('Asked by Olive Organizer'));

  await answer(alex, 'Where do volunteers park?', 'Behind the school, entrance on Mill Lane. Show your volunteer badge at the gate.');
  await answerOf(olive, 'Where do volunteers park?', 'Mill Lane').waitFor({ timeout: 6000 });
  expect('Olive sees Alex\'s answer live', true);
  await answer(olive, 'Where do volunteers park?', 'On the field, unless it has rained.');
  await answer(olive, 'When do the gates open?', 'At 9:30; the early shift starts at 8:00.');
  expect('Olive cannot upvote her own answer', await answerOf(olive, 'Where do volunteers park?', 'On the field').locator('.qa-vote').isDisabled());
  await answerOf(olive, 'Where do volunteers park?', 'Mill Lane').locator('.qa-vote').click();
  await olive.waitForFunction(() => document.querySelector('.qa-vote[aria-pressed="true"] .qa-votes')?.textContent === '1');
  await alex.waitForFunction(() => [...document.querySelectorAll('.qa-answer')].some((a) => a.textContent.includes('Mill Lane') && a.querySelector('.qa-votes').textContent === '1'), null, { timeout: 6000 });
  expect('An upvote shows live for Alex', true);
  expect('Alex cannot upvote his own answer', await answerOf(alex, 'Where do volunteers park?', 'Mill Lane').locator('.qa-vote').isDisabled());

  // Olive accepts Alex's answer; it moves to the top for both.
  await answerOf(olive, 'Where do volunteers park?', 'Mill Lane').getByRole('button', { name: /^Accept/ }).click();
  await alex.waitForSelector('.qa-answer.is-accepted', { timeout: 6000 });
  const firstAlex = await question(alex, 'Where do volunteers park?').locator('.qa-answer').first().innerText();
  expect('The accepted answer is marked and first, live for Alex', firstAlex.includes('Accepted answer') && firstAlex.includes('Mill Lane'), firstAlex);
  expect('The question shows Answered', (await question(alex, 'Where do volunteers park?').locator('.qa-state').innerText()) === 'Answered');
  expect('The count says how many are answered', (await olive.locator('.qa .task-count').innerText()) === '3 questions, 1 answered', await olive.locator('.qa .task-count').innerText());

  // Edit your own answer, live.
  await answerOf(olive, 'When do the gates open?', 'At 9:30').getByRole('button', { name: /^Edit/ }).click();
  await question(olive, 'When do the gates open?').locator('form[aria-label="Edit your answer"] textarea').fill('At 9:30; the early shift starts at 8:00 at gate B.');
  await question(olive, 'When do the gates open?').locator('form[aria-label="Edit your answer"]').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.qa-body:has-text("at gate B")', { timeout: 6000 });
  expect('An edit shows live', true);
  expect('Nobody gets Edit on someone else\'s answer', await answerOf(olive, 'Where do volunteers park?', 'Mill Lane').getByRole('button', { name: /^Edit/ }).count() === 0);

  // Filters.
  await olive.check('.qa .toggle input');
  let shown = await titles(olive);
  expect('"No accepted answer yet" hides answered questions', shown.length === 2 && !shown.includes('Where do volunteers park?'), shown.join(', '));
  await olive.uncheck('.qa .toggle input');
  await olive.fill('#qa-find', 'mill lane');
  shown = await titles(olive);
  expect('Words find a question by its answers', shown.length === 1 && shown[0] === 'Where do volunteers park?', shown.join(', '));
  await olive.fill('#qa-find', 'nothing-like-this');
  expect('No match says so', (await olive.locator('.qa .convo-empty').innerText()) === 'No questions match.');
  await olive.fill('#qa-find', '');

  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-qa-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-qa-alex-dark.png` });

  // Weft search finds the board by an answer's words (through the board's text).
  await olive.locator('.search input').fill('Mill Lane');
  const hit = olive.locator('.search-group:has-text("Q and A")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the board by an answer\'s words', found && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Volunteer questions')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const boards = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival board, not the Organizers one', boards.includes('Volunteer questions') && !boards.includes('Organizer questions'), boards.join(', '));
  await pat.locator('.doc-link', { hasText: 'Volunteer questions' }).click(); await pat.waitForSelector('.qa-question');
  expect('Pat: no Ask, Answer, Edit, Accept, Delete or Move', await pat.getByRole('button', { name: 'Ask a question' }).count() === 0
    && await pat.locator('form.qa-answer-form').count() === 0
    && await pat.locator('.qa').getByRole('button', { name: /^(Edit|Delete|Accept|Unaccept)/ }).count() === 0
    && await pat.locator('#move-qa').count() === 0);
  expect('Pat: the board name is read-only and the hint says what she can do', await pat.locator('#title-qa[readonly]').count() === 1
    && (await pat.locator('.qa > .docs-hint').innerText()).includes('upvote'));
  await answerOf(pat, 'Where do volunteers park?', 'Mill Lane').locator('.qa-vote').click();
  await olive.waitForFunction(() => [...document.querySelectorAll('.qa-answer')].some((a) => a.textContent.includes('Mill Lane') && a.querySelector('.qa-votes').textContent === '2'), null, { timeout: 6000 });
  expect('Pat (viewer) upvotes, and Olive sees it live', (await votes(pat, 'Where do volunteers park?', 'Mill Lane')) === '2');
  await question(olive, 'Is there a cloakroom?').getByRole('button', { name: /^Delete/ }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.qa-title')].some((e) => e.textContent === 'Is there a cloakroom?'), null, { timeout: 6000 });
  expect('A delete shows live for Pat', (await titles(pat)).length === 2);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-qa-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Open questions' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Open questions"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: open questions only, newest first', rows[0] === 'When do the gates open?' && rows.includes('Who signs the sponsor contract?') && !rows.includes('Where do volunteers park?'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Who signs the sponsor contract?' }).click();
  await olive.waitForSelector('#tab-qa[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-qa')?.value === 'Organizer questions');
  expect('Widget: a row opens its board in Q and A', true);
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Open questions' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const pq = pat.locator('.widget:has(h3:has-text("Open questions"))');
  await pq.locator('.widget-main').first().waitFor();
  const pr = await pq.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival questions only', pr.length > 0 && !pr.includes('Who signs the sponsor contract?'), pr.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
