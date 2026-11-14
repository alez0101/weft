// Forms in real browsers, on the test stack (tests/run.sh --keep): Olive makes a form in #festival and
// sets its questions; Alex (owner, dark mode) watches the answers table fill in live; Pat and Vic
// (viewers) answer but cannot change the form or see each other's answers, and Pat never sees the
// Organizers form; once answered the questions lock; Olive copies the answers into a Sheets table,
// her Home widget lists the form she has not answered, and closing it shows live for Pat.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node forms-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Forms")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const openForm = async (p, title) => {
    await p.locator('.doc-link', { hasText: title }).click();
    await p.waitForFunction((t) => document.querySelector('#title-form')?.value === t, title); await p.waitForSelector('.form');
  };
  const newForm = async (p, space, title) => {
    await p.selectOption('#new-form', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New form' }).click();
    await p.waitForFunction(() => document.querySelector('#title-form')?.value === 'New form' && document.querySelectorAll('.form-q.is-editing').length === 1);
    await p.fill('#title-form', title); await p.press('#title-form', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${title}")`);
  };
  const addQuestion = async (p, label) => {
    const n = await p.locator('.form-q.is-editing').count();
    await p.fill('#form-new-q', label); await p.getByRole('button', { name: 'Add question' }).click();
    await p.waitForFunction((k) => document.querySelectorAll('.form-q.is-editing').length === k, n + 1);
    return p.locator('.form-q.is-editing').nth(n);
  };
  const rows = (p) => p.locator('.form-table tbody tr');

  const olive = await open('Olive Organizer');
  await newForm(olive, '#organizers', 'Caterer quotes');
  await newForm(olive, '#festival', 'Volunteer T-shirts');
  expect('A new form starts with a required "Your name" question, in edit view', await olive.locator('.form-q.is-editing input[id^="fq-"]').inputValue() === 'Your name'
    && await olive.locator('.form-q.is-editing .form-req input').isChecked());
  const size = await addQuestion(olive, 'Shirt size');
  await size.locator('select[id^="fk-"]').selectOption('choice');
  await size.locator('textarea[id^="fo-"]').waitFor();
  await size.locator('textarea[id^="fo-"]').fill('S\nM\nL\nXL');
  await size.locator('.form-req input').check();   // blurs the choices, which saves them
  await olive.waitForFunction(() => { const q = [...document.querySelectorAll('.form-q.is-editing')][1]; return q?.querySelector('.form-req input')?.checked && q.querySelector('textarea')?.value === 'S\nM\nL\nXL'; });
  const extra = await addQuestion(olive, 'Anything else?');
  await extra.locator('select[id^="fk-"]').selectOption('long');
  await olive.waitForTimeout(300);
  await olive.getByRole('button', { name: 'Fill in' }).click();
  expect('Olive: the form shows three questions, one with four choices', await olive.locator('.form-fill .form-q').count() === 3 && await olive.locator('.form-choice').count() === 4);

  const alex = await open('Alex (test admin)', true);
  await openForm(alex, 'Volunteer T-shirts');
  await alex.getByRole('button', { name: /^Answers/ }).click();
  expect('Alex (owner): no answers yet', await alex.locator('.convo-empty', { hasText: 'No answers yet' }).count() === 1);

  const pat = await open('Pat Public');
  const list = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival form, not the Organizers one', list.includes('Volunteer T-shirts') && !list.includes('Caterer quotes'), list.join(', '));
  await openForm(pat, 'Volunteer T-shirts');
  const patControls = [await pat.getByRole('button', { name: /^Answers/ }).count(), await pat.getByRole('button', { name: 'Edit questions' }).count(),
    await pat.getByRole('button', { name: 'Close form', exact: true }).count(), await pat.getByRole('button', { name: 'Delete', exact: true }).count(), await pat.locator('#move-form').count()];
  expect('Pat: no Answers, Edit questions, Close form, Delete or Move', patControls.every((n) => n === 0), patControls.join(' '));
  expect('Pat: the form name is read-only', await pat.locator('#title-form[readonly]').count() === 1);
  await pat.getByRole('button', { name: 'Send my answer' }).click();
  expect('Pat: required questions stop an empty answer in the browser', await pat.locator('.form-fill input:invalid').count() >= 1 && await pat.locator('.slot-status').count() === 0);
  await pat.getByLabel('Your name').fill('Pat Public');
  await pat.locator('.form-choice', { hasText: /^\s*M$/ }).locator('input').check();
  const t0 = Date.now();
  await pat.getByRole('button', { name: 'Send my answer' }).click();
  await pat.waitForSelector('.slot-status:has-text("your answer was sent")');
  await alex.waitForFunction(() => document.querySelectorAll('.form-table tbody tr').length === 1, null, { timeout: 6000 });
  out(`Alex saw Pat's answer live: ${Date.now() - t0} ms`);
  expect('Pat (viewer) answers, and Alex sees it in the table live', (await rows(alex).first().innerText()).includes('Pat Public'), await rows(alex).first().innerText());
  await pat.locator('.form-choice', { hasText: /^\s*L$/ }).locator('input').check();
  await pat.getByRole('button', { name: 'Update my answer' }).click();
  await pat.waitForSelector('.slot-status:has-text("updated")');
  await alex.waitForFunction(() => /\bL\b/.test(document.querySelector('.form-table tbody tr')?.innerText || ''), null, { timeout: 6000 });
  expect('Pat changes her answer, live for Alex', true);

  const vic = await open('Vic Volunteer');
  await openForm(vic, 'Volunteer T-shirts');
  await vic.getByLabel('Your name').fill('Vic V.');
  await vic.locator('.form-choice', { hasText: /^\s*XL$/ }).locator('input').check();
  await vic.getByLabel('Anything else?').fill('VIC-NOTE: I can also help carry boxes');
  await vic.getByRole('button', { name: 'Send my answer' }).click();
  await vic.waitForSelector('.slot-status:has-text("your answer was sent")');
  await alex.waitForFunction(() => document.querySelectorAll('.form-table tbody tr').length === 2, null, { timeout: 6000 });
  expect('Vic answers; Alex now has two rows', true);
  await pat.waitForTimeout(800);
  expect('Pat never sees Vic\'s answer', !(await pat.locator('.docs-main').innerText()).includes('VIC-NOTE'));
  expect('Pat\'s own answer stays filled in', await pat.getByLabel('Your name').inputValue() === 'Pat Public');

  await olive.getByRole('button', { name: 'Edit questions' }).click();
  await olive.waitForSelector('.docs-hint:has-text("People have answered")');
  expect('Once answered, Olive cannot reword, retype or remove questions', await olive.locator('.form-q.is-editing input[id^="fq-"][readonly]').count() === 3
    && await olive.locator('.form-q.is-editing select:disabled').count() === 3 && await olive.locator('.form-q.is-editing button:disabled').count() === 3);
  await olive.getByRole('button', { name: /^Answers/ }).click();
  await olive.waitForFunction(() => document.querySelectorAll('.form-table tbody tr').length === 2);
  const head = await olive.locator('.form-table thead').innerText();
  expect('Olive\'s table: a column per question', ['Person', 'Answered', 'Your name', 'Shirt size', 'Anything else?'].every((h) => head.includes(h)), head);
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-forms-olive-answers-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-forms-alex-answers-dark.png` });

  const [download] = await Promise.all([olive.waitForEvent('download'), olive.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = require('fs').readFileSync(await download.path(), 'utf8');
  expect('Download CSV: a header and two answers', download.suggestedFilename() === 'Volunteer T-shirts answers.csv' && csv.split('\r\n').filter(Boolean).length === 3 && csv.includes('VIC-NOTE'), csv.slice(0, 200));
  await olive.getByRole('button', { name: 'Copy to a new table' }).click();
  await olive.waitForSelector('.slot-status:has-text("Copied 2 answers")');
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  const w = olive.locator('.widget:has(h3:has-text("Forms to fill in"))');
  const wrows = await w.locator('.widget-main').allInnerTexts();
  expect('Widget: lists the forms Olive has not answered', wrows.includes('Volunteer T-shirts') && wrows.includes('Caterer quotes'), wrows.join(', '));
  await olive.locator('.app:has-text("Sheets")').click(); await olive.waitForSelector('.docs-list');
  await olive.locator('.doc-link', { hasText: 'Volunteer T-shirts (answers)' }).click();
  await olive.waitForSelector('.ag-row[row-index="1"]', { timeout: 8000 });
  await olive.waitForTimeout(500);
  expect('Copy to a new table: exactly two rows, with the answers', await olive.locator('.ag-row[row-index="2"]').count() === 0
    && (await olive.locator('.docs-table').innerText()).includes('VIC-NOTE'), (await olive.locator('.docs-table').innerText()).slice(0, 300));
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  await w.locator('.widget-row', { hasText: 'Volunteer T-shirts' }).click();
  await olive.waitForSelector('#tab-forms[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-form')?.value === 'Volunteer T-shirts');
  expect('Widget: a row opens the form in Forms', true);

  await olive.getByRole('button', { name: 'Close form', exact: true }).click();
  await pat.waitForSelector('.poll-badge.is-closed', { timeout: 6000 });
  expect('Closing shows live for Pat; her answer is read-only', await pat.locator('.form-fieldset:disabled').count() === 1
    && await pat.getByRole('button', { name: 'Update my answer' }).count() === 0 && (await pat.locator('.poll-state').innerText()).includes('by Olive Organizer'), await pat.locator('.poll-state').innerText());
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-forms-pat-viewer.png` });
  await olive.getByRole('button', { name: 'Reopen form', exact: true }).click();
  await pat.waitForSelector('.poll-badge:not(.is-closed)', { timeout: 6000 });
  expect('Reopening shows live too', await pat.getByRole('button', { name: 'Update my answer' }).count() === 1);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
