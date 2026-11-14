// Retros in real browsers, on the test stack (tests/run.sh --keep): Olive makes a task list and a retro in
// #festival, sets the period and the list, and adds notes in the three columns, one anonymously; Alex (dark
// mode) sees them arrive live, the anonymous one with no name; Pat (viewer) adds an anonymous note, sees it
// as hers and can change it, and has no way to set the period, delete others' notes or make tasks; Olive
// sees Pat's note live as Anonymous, with Delete but no Change; Olive turns an action into a task for Vic
// and the note shows it; a period that ends before it starts shows the database's answer; Weft search finds
// the retro by a note's words; the "Open retro actions" Home widget lists the open actions and a row opens
// the retro.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node retros-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark, app = 'Retros') => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator(`.app:has-text("${app}")`).first().click(); await p.waitForSelector('.docs-list'); return p;
  };
  const col = (p, kind) => p.locator(`.retro-col--${kind}`);
  const note = (p, text) => p.locator('.retro-note', { has: p.locator('.retro-body', { hasText: text }) });
  const addNote = async (p, kind, label, text, anon = false) => {
    const f = p.locator(`form[aria-label="Add to ${label}"]`);
    await f.locator('textarea').fill(text);
    if (anon) await f.getByLabel('Post anonymously').check();
    await f.getByRole('button', { name: /^Add/ }).click();
    await p.waitForSelector(`.retro-body:has-text("${text}")`);
  };
  const by = async (p, text) => (await note(p, text).locator('.retro-by').innerText()).trim();

  // Olive: a task list in #festival for the actions, then the retro.
  const olive = await open('Olive Organizer', false, 'Tasks');
  await olive.selectOption('#new-tasklist', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list');
  await olive.fill('#title-tasklist', 'Festival follow-ups'); await olive.press('#title-tasklist', 'Enter');
  await olive.waitForSelector('.doc-link:has-text("Festival follow-ups")');
  await olive.locator('#tab-home').click();
  await olive.locator('.app:has-text("Retros")').first().click(); await olive.waitForSelector('.docs-list');
  await olive.selectOption('#new-retro', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New retro' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-retro')?.value === 'Retro');
  await olive.fill('#title-retro', 'Festival 2026 retro'); await olive.press('#title-retro', 'Enter');
  await olive.waitForSelector('.doc-link:has-text("Festival 2026 retro")');
  await olive.waitForSelector('.retro-columns');
  expect('A new retro has three empty columns', (await olive.locator('.retro-col-head').allInnerTexts()).map((t) => t.replace(/\d+$/, '').trim()).join('|') === 'Went well|To improve|Actions'
    && await olive.locator('.retro-note').count() === 0);
  await olive.fill('#retro-from', '2026-10-01');
  await olive.waitForTimeout(300);
  await olive.fill('#retro-to', '2026-10-31');
  await olive.selectOption('#retro-list', { label: 'Festival follow-ups' });
  await olive.waitForSelector('button:has-text("Open the list")');

  // Alex watches in dark mode.
  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival 2026 retro' }).click(); await alex.waitForSelector('.retro-columns');

  await addNote(olive, 'went_well', 'Went well', 'The volunteer briefing was clear and short');
  await addNote(olive, 'to_improve', 'To improve', 'Bins overflowed by the food stalls on Saturday', true);
  await addNote(olive, 'action', 'Actions', 'Open a second entrance gate');
  await addNote(olive, 'action', 'Actions', 'Book twice the bins for next year');
  expect('Olive sees her named note with her name', (await by(olive, 'volunteer briefing')) === 'Olive Organizer (you)', await by(olive, 'volunteer briefing'));
  expect('And her anonymous note marked as hers, for her eyes only', (await by(olive, 'Bins overflowed')) === 'Anonymous (you)', await by(olive, 'Bins overflowed'));
  const t0 = Date.now();
  await alex.waitForSelector('.retro-body:has-text("Book twice the bins")', { timeout: 6000 });
  out(`Alex saw Olive's notes live: ${Date.now() - t0} ms`);
  expect('Alex sees the notes live: the named one with Olive\'s name, the anonymous one with none',
    (await by(alex, 'volunteer briefing')) === 'Olive Organizer' && (await by(alex, 'Bins overflowed')) === 'Anonymous', `${await by(alex, 'volunteer briefing')} / ${await by(alex, 'Bins overflowed')}`);
  expect('Alex (owner) can delete the anonymous note but not change it', await note(alex, 'Bins overflowed').getByRole('button', { name: /^Delete/ }).count() === 1
    && await note(alex, 'Bins overflowed').getByRole('button', { name: /^Change/ }).count() === 0);
  expect('Alex sees the period Olive set', (await alex.inputValue('#retro-from')) === '2026-10-01' && (await alex.inputValue('#retro-to')) === '2026-10-31');

  // Pat (viewer) takes part.
  const pat = await open('Pat Public');
  const retros = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival retro', retros.includes('Festival 2026 retro'), retros.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival 2026 retro' }).click(); await pat.waitForSelector('.retro-columns');
  expect('Pat: the period is text, the list is text, no Make a task, no Move, the hint says why',
    await pat.locator('#retro-from').count() === 0 && (await pat.locator('.retro .meeting-value').first().innerText()).includes('Oct')
    && await pat.getByRole('button', { name: /^Make a task/ }).count() === 0 && await pat.locator('#move-retro').count() === 0
    && (await pat.locator('.retro > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat cannot delete or change anyone else\'s note', await pat.locator('.retro-note').getByRole('button', { name: /^(Delete|Change)/ }).count() === 0);
  await addNote(pat, 'to_improve', 'To improve', 'The queue at the gate was far too long', true);
  expect('Pat sees her anonymous note as hers, with Change and Delete', (await by(pat, 'queue at the gate')) === 'Anonymous (you)'
    && await note(pat, 'queue at the gate').getByRole('button', { name: /^(Change|Delete)/ }).count() === 2);
  await olive.waitForSelector('.retro-body:has-text("queue at the gate")', { timeout: 6000 });
  expect('Olive sees Pat\'s note live, with no name', (await by(olive, 'queue at the gate')) === 'Anonymous');
  expect('Olive (editor) can delete it but not change it', await note(olive, 'queue at the gate').getByRole('button', { name: /^Delete/ }).count() === 1
    && await note(olive, 'queue at the gate').getByRole('button', { name: /^Change/ }).count() === 0);
  await note(pat, 'queue at the gate').getByRole('button', { name: /^Change/ }).click();
  await pat.locator('form[aria-label="Change your note"] textarea').fill('The queue at the gate was far too long on Friday evening');
  await pat.locator('form[aria-label="Change your note"]').getByRole('button', { name: 'Save' }).click();
  await olive.waitForSelector('.retro-body:has-text("on Friday evening")', { timeout: 6000 });
  expect('Pat changes her note and Olive sees the change live', true);

  // Actions become tasks.
  await note(olive, 'second entrance gate').getByRole('button', { name: /^Make a task/ }).click();
  await olive.locator('form[aria-label="Make a task"] select').selectOption({ label: 'Vic Volunteer' });
  await olive.locator('form[aria-label="Make a task"] input[type="date"]').fill('2027-03-01');
  await olive.locator('form[aria-label="Make a task"]').getByRole('button', { name: 'Make the task' }).click();
  await olive.waitForSelector('.retro-task');
  const taskText = await note(olive, 'second entrance gate').locator('.retro-task-text').innerText();
  expect('The action shows its task: who and when', taskText.startsWith('Task: Vic Volunteer') && taskText.includes('Mar'), taskText);
  expect('The other action can still become a task; notes in other columns cannot', await note(olive, 'Book twice the bins').getByRole('button', { name: /^Make a task/ }).count() === 1
    && await col(olive, 'went_well').getByRole('button', { name: /^Make a task/ }).count() === 0);
  expect('The counts follow', (await olive.locator('.retro .goal-meta').innerText()) === '5 notes, 2 actions, 1 made into tasks', await olive.locator('.retro .goal-meta').innerText());
  await pat.waitForSelector('.retro-task', { timeout: 6000 });
  expect('Pat sees the task live and cannot tick it off (it is Vic\'s)', await pat.locator('.retro-task input').isDisabled());

  // The database's answer when it refuses.
  await olive.fill('#retro-to', '2026-09-01');
  await olive.waitForSelector('.retro .send-error');
  expect('A period that ends before it starts shows the database\'s answer', (await olive.locator('.retro .send-error').innerText()).startsWith('Could not set the period:'),
    await olive.locator('.retro .send-error').innerText());
  expect('And the period stays as it was', (await olive.inputValue('#retro-to')) === '2026-10-31', await olive.inputValue('#retro-to'));

  // Reload so the refused attempt's message is gone before the screenshots.
  await olive.locator('.doc-link', { hasText: 'Festival 2026 retro' }).click();
  await olive.locator('#tab-home').click(); await olive.locator('#tab-retros').click(); await olive.waitForSelector('.retro-columns');
  await olive.waitForFunction(() => !document.querySelector('.retro .send-error'));
  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-retros-olive-light.png` });
  await alex.waitForSelector('.retro-task', { timeout: 6000 });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-retros-alex-dark.png` });
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-retros-pat-viewer.png` });

  // Weft search finds a note's words (through the retro's text).
  await olive.locator('.search input').fill('entrance gate');
  const hit = olive.locator('.search-group:has-text("Retros")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the retro by a note\'s words', found && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Festival 2026 retro')));
  await olive.keyboard.press('Escape');

  // Pat deletes her own note.
  await note(pat, 'queue at the gate').getByRole('button', { name: /^Delete/ }).click();
  await olive.waitForFunction(() => !document.body.textContent.includes('queue at the gate'), null, { timeout: 6000 });
  expect('Pat deletes her own note and it goes for Olive live', true);

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Open retro actions' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Open retro actions"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  out('widget rows:', rows.map((r) => r.replace(/\n/g, ' / ')).join(' | '));
  expect('Widget: both open actions, one a task and one not yet', rows.some((r) => r.includes('Book twice the bins') && r.includes('Not a task yet'))
    && rows.some((r) => r.includes('second entrance gate') && r.includes('Task open') && r.includes('#festival')), rows.join(' | '));
  await w.locator('.widget-row', { hasText: 'Book twice the bins' }).click();
  await olive.waitForSelector('#tab-retros[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-retro')?.value === 'Festival 2026 retro');
  expect('Widget: a row opens its retro', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
