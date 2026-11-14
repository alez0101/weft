// Boards in real browsers, on the test stack (tests/run.sh --keep): Olive makes a task list in #festival and
// one in Organizers from Boards; each starts with To do, Doing and Done. She adds cards and a column, drags a
// card (Alex, in dark mode, sees it move live), moves one with the arrow keys, and drags one to Done, which
// ticks it off in Tasks: the same task, not a copy. A task ticked in Tasks shows in Done on the board.
// Pat (viewer in #festival only) sees the #festival board read-only, cannot drag, and marks her own card done.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node boards-browser.cjs
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
    await p.locator('.app:has-text("Boards")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const lanes = (p) => p.locator('.kanban-col').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label').split(',')[0]));
  const laneOf = (p, title) => p.evaluate((t) => {
    const card = [...document.querySelectorAll('.kanban-card')].find((c) => c.querySelector('.kanban-title')?.textContent === t);
    return card ? card.closest('.kanban-col').getAttribute('aria-label').split(',')[0] : null;
  }, title);
  const waitLane = (p, title, lane) => p.waitForFunction(([t, l]) => {
    const card = [...document.querySelectorAll('.kanban-card')].find((c) => c.querySelector('.kanban-title')?.textContent === t);
    return card && card.closest('.kanban-col').getAttribute('aria-label').split(',')[0] === l;
  }, [title, lane], { timeout: 6000 });
  const col = (p, name) => p.locator(`.kanban-col[aria-label^="${name},"]`);
  const card = (p, title) => p.locator('.kanban-card', { has: p.locator('.kanban-title', { hasText: title }) });
  const newList = async (p, space, name) => {
    await p.selectOption('#new-tasklist', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
    await p.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list');
    await p.fill('#title-tasklist', name); await p.press('#title-tasklist', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`); await p.waitForSelector('.kanban');
  };
  const addCard = async (p, lane, title) => {
    const c = col(p, lane);
    await c.locator('.kanban-add input').fill(title); await c.locator('.kanban-add').getByRole('button', { name: 'Add' }).click();
    await c.locator('.kanban-title', { hasText: title }).waitFor();
  };

  const olive = await open('Olive Organizer');
  await newList(olive, '#organizers', 'Sponsor board');
  await addCard(olive, 'To do', 'Call the brewery');
  await newList(olive, '#festival', 'Stage crew');
  expect('A new board starts with To do, Doing and Done', (await lanes(olive)).join(',') === 'To do,Doing,Done', (await lanes(olive)).join(','));
  for (const t of ['Build the stage', 'Test the sound', 'Print the running order', 'Paint the signs', 'Hire the lights']) await addCard(olive, 'To do', t);
  await olive.fill('#kanban-newcol', 'Check'); await olive.getByRole('button', { name: 'Add column' }).click();
  await olive.waitForFunction(() => document.querySelectorAll('.kanban-col').length === 4);
  expect('A new column goes before Done', (await lanes(olive)).join(',') === 'To do,Doing,Check,Done', (await lanes(olive)).join(','));

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Stage crew' }).click(); await alex.waitForSelector('.kanban-card');

  // Drag, seen live.
  const t0 = Date.now();
  await card(olive, 'Build the stage').dragTo(col(olive, 'Doing').locator('.kanban-cards'));
  await waitLane(olive, 'Build the stage', 'Doing');
  await waitLane(alex, 'Build the stage', 'Doing');
  out(`Alex saw Olive's drag live: ${Date.now() - t0} ms`);
  expect('Dragging a card moves it, and Alex sees it live', true);
  await card(olive, 'Hire the lights').dragTo(col(olive, 'Check').locator('.kanban-cards'));
  await waitLane(alex, 'Hire the lights', 'Check');
  // Order within a column: drop above another card.
  await card(olive, 'Paint the signs').dragTo(card(olive, 'Build the stage'), { targetPosition: { x: 20, y: 4 } });
  await waitLane(olive, 'Paint the signs', 'Doing');
  const doing = await col(olive, 'Doing').locator('.kanban-title').allInnerTexts();
  expect('Dropping on the top half of a card puts it above that card', doing.join(',') === 'Paint the signs,Build the stage', doing.join(','));

  // Keyboard.
  await card(olive, 'Test the sound').focus(); await olive.keyboard.press('ArrowRight');
  await waitLane(olive, 'Test the sound', 'Doing');
  expect('The arrow keys move a focused card, and it keeps the focus', await olive.evaluate(() => document.activeElement?.querySelector('.kanban-title')?.textContent) === 'Test the sound');
  await olive.keyboard.press('ArrowUp');
  await olive.waitForTimeout(300);
  const doing2 = await col(olive, 'Doing').locator('.kanban-title').allInnerTexts();
  expect('Up and down reorder within the column', doing2.join(',') === 'Paint the signs,Test the sound,Build the stage', doing2.join(','));
  await waitLane(alex, 'Test the sound', 'Doing');

  // Done is the same as ticked off in Tasks.
  await card(olive, 'Print the running order').dragTo(col(olive, 'Done').locator('.kanban-cards'));
  await waitLane(alex, 'Print the running order', 'Done');
  await olive.getByRole('button', { name: 'See as a list' }).click();
  await olive.waitForSelector('#tab-tasks[aria-selected="true"]'); await olive.waitForSelector('.task');
  expect('A card dragged to Done is ticked off in Tasks (the same task)', await olive.locator('input[aria-label="Done: Print the running order"]').isChecked());
  await olive.locator('input[aria-label="Done: Hire the lights"]').check();
  await waitLane(alex, 'Hire the lights', 'Done');
  expect('A task ticked off in Tasks shows in Done on the board, live', true);
  const paint = olive.locator('.task', { has: olive.locator('input[aria-label="Done: Paint the signs"]') });
  await paint.locator('select.task-who').selectOption({ label: 'Pat Public' });
  await olive.waitForTimeout(300);
  await olive.getByRole('button', { name: 'See as a board' }).click();
  await olive.waitForSelector('#tab-boards[aria-selected="true"]'); await olive.waitForSelector('.kanban-card');
  expect('Back on the board, the card shows who it is assigned to', (await card(olive, 'Paint the signs').locator('.kanban-meta').innerText()).includes('Pat Public'));

  // Rename a column, live.
  await olive.fill('.kanban-col[aria-label^="Check,"] .kanban-name', 'Ready for show'); await olive.press('.kanban-col[aria-label^="Check,"] .kanban-name', 'Enter');
  await alex.waitForSelector('.kanban-col[aria-label^="Ready for show,"]', { timeout: 6000 });
  expect('A renamed column shows live', (await lanes(alex)).join(',') === 'To do,Doing,Ready for show,Done', (await lanes(alex)).join(','));
  await olive.locator('.kanban-col[aria-label^="Ready for show,"] .kanban-head').hover();
  await olive.locator('.kanban-col[aria-label^="Ready for show,"]').getByRole('button', { name: 'Move Ready for show left' }).click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.kanban-col')].map((e) => e.getAttribute('aria-label').split(',')[0]).join(',') === 'To do,Ready for show,Doing,Done', null, { timeout: 6000 });
  expect('Moving a column left shows live', true);
  await olive.locator('.kanban-col[aria-label^="Ready for show,"] .kanban-head').hover();
  await olive.locator('.kanban-col[aria-label^="Ready for show,"]').getByRole('button', { name: 'Move Ready for show right' }).click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.kanban-col')].map((e) => e.getAttribute('aria-label').split(',')[0]).join(',') === 'To do,Doing,Ready for show,Done', null, { timeout: 6000 });

  await olive.mouse.move(5, 890); await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-boards-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-boards-alex-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival board, not the Organizers one', lists.includes('Stage crew') && !lists.includes('Sponsor board'), lists.join(', '));
  await pat.locator('.doc-link', { hasText: 'Stage crew' }).click(); await pat.waitForSelector('.kanban-card');
  expect('Pat: no dragging, no Add a card, no column tools', await pat.locator('.kanban-card[draggable="true"]').count() === 0
    && await pat.locator('.kanban-add').count() === 0 && await pat.locator('.kanban-tool').count() === 0 && await pat.locator('#kanban-newcol').count() === 0
    && await pat.locator('input.kanban-name').count() === 0);
  expect('Pat: the hint says why, and the list name is read-only', (await pat.locator('.kanban-wrap > .docs-hint').innerText()).includes('make you an editor')
    && await pat.locator('#title-tasklist[readonly]').count() === 1);
  expect('Pat: only her own card has Mark done', await pat.getByRole('button', { name: /^Mark done/ }).count() === 1
    && await card(pat, 'Paint the signs').getByRole('button', { name: /^Mark done/ }).count() === 1);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-boards-pat-viewer.png` });
  await card(pat, 'Build the stage').dragTo(col(pat, 'Done').locator('.kanban-cards')).catch(() => {});
  await pat.waitForTimeout(500);
  expect('Pat: trying to drag a card does nothing', await laneOf(pat, 'Build the stage') === 'Doing' && await laneOf(olive, 'Build the stage') === 'Doing');
  await card(pat, 'Paint the signs').getByRole('button', { name: /^Mark done/ }).click();
  await waitLane(pat, 'Paint the signs', 'Done');
  await waitLane(olive, 'Paint the signs', 'Done');
  expect('Pat marks her own card done; it moves to Done for Olive too', true);
  await card(pat, 'Paint the signs').getByRole('button', { name: /^Reopen/ }).click();
  await waitLane(olive, 'Paint the signs', 'Doing');
  expect('Reopening puts it back in the column it came from', await laneOf(pat, 'Paint the signs') === 'Doing');

  // Deleting a column moves its cards to the first one.
  await olive.locator('.kanban-col[aria-label^="Doing,"] .kanban-head').hover();
  await olive.locator('.kanban-col[aria-label^="Doing,"]').getByRole('button', { name: 'Delete column Doing' }).click();
  await waitLane(alex, 'Build the stage', 'To do');
  expect('Deleting a column moves its cards to the first column, live', (await lanes(alex)).join(',') === 'To do,Ready for show,Done', (await lanes(alex)).join(','));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
