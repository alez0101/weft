// Polls in real browsers, on the test stack (tests/run.sh --keep): Olive makes a poll in #festival and
// sets its choices; Alex (dark mode) watches the votes arrive live; Vic and Pat (viewers) vote but cannot
// change the poll, and Pat never sees the Organizers poll; Olive closes it and everyone sees it closed;
// Olive's Home widget lists the poll she has not voted in yet.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node polls-browser.cjs
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
    await p.locator('.app:has-text("Polls")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const choice = (p, label) => p.locator('.poll-choice', { has: p.locator('.poll-label', { hasText: label }) });
  const countOf = async (p, label) => (await choice(p, label).locator('.poll-count').innerText()).trim();
  const vote = async (p, label) => { await choice(p, label).locator('input[type=radio]').check(); await p.waitForSelector(`.poll-choice.is-mine:has-text("${label}")`); };
  const waitCount = (p, label, text) => p.waitForFunction(([l, t]) => [...document.querySelectorAll('.poll-choice')]
    .some((c) => c.querySelector('.poll-label')?.textContent.startsWith(l) && c.querySelector('.poll-count')?.textContent.startsWith(t)), [label, text], { timeout: 6000 });
  const newPoll = async (p, space, question, labels) => {
    await p.selectOption('#new-poll', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New poll' }).click();
    await p.waitForFunction(() => document.querySelector('#title-poll')?.value === 'New poll' && document.querySelectorAll('.poll-choice').length === 2);
    await p.fill('#title-poll', question); await p.press('#title-poll', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${question}")`);
    await p.getByRole('button', { name: 'Edit choices' }).click();
    for (const [i, label] of labels.slice(0, 2).entries()) {
      await p.locator('.poll-edit input').nth(i).fill(label); await p.locator('.poll-edit input').nth(i).press('Enter');
      await p.waitForSelector(`.poll-edit input[value="${label}"]`);
    }
    for (const label of labels.slice(2)) {
      await p.fill('#poll-new', label); await p.getByRole('button', { name: 'Add choice' }).click();
      await p.waitForSelector(`.poll-edit input[value="${label}"]`);
    }
    await p.getByRole('button', { name: 'Done editing' }).click();
    await p.waitForFunction((n) => document.querySelectorAll('.poll-option').length === n, labels.length);
  };

  const olive = await open('Olive Organizer');
  await newPoll(olive, '#organizers', 'Caterer for the volunteer lunch?', ['Bakery', 'Taco truck']);
  await newPoll(olive, '#festival', 'Which day for the parade?', ['Saturday', 'Sunday', 'Monday']);
  expect('Olive: three choices, no votes yet', (await olive.locator('.poll-state').innerText()).includes('0 votes'), await olive.locator('.poll-state').innerText());

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Which day for the parade?' }).click(); await alex.waitForSelector('.poll-option');
  const t0 = Date.now();
  await vote(olive, 'Saturday');
  await waitCount(alex, 'Saturday', '1 vote');
  out(`Alex saw Olive's vote live: ${Date.now() - t0} ms`);
  expect('Alex sees Olive named under Saturday', (await choice(alex, 'Saturday').locator('.poll-voters').innerText()) === 'Olive Organizer');
  await vote(alex, 'Sunday');
  await waitCount(olive, 'Sunday', '1 vote, 50%');
  expect('Olive saw Alex\'s vote live', true);
  await vote(olive, 'Sunday');
  await waitCount(alex, 'Sunday', '2 votes, 100%');
  expect('Changing a vote moves it, live (Sunday 2, Saturday 0)', (await countOf(alex, 'Saturday')).startsWith('0 votes'), await countOf(alex, 'Saturday'));
  await vote(olive, 'Saturday');
  await waitCount(alex, 'Saturday', '1 vote');

  const vic = await open('Vic Volunteer');
  await vic.locator('.doc-link', { hasText: 'Which day for the parade?' }).click(); await vic.waitForSelector('.poll-option');
  await vote(vic, 'Saturday');
  await waitCount(olive, 'Saturday', '2 votes');
  expect('Vic (viewer) voted, and Olive saw it', true);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-polls-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-polls-alex-dark.png` });

  const pat = await open('Pat Public');
  const polls = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival poll, not the Organizers one', polls.includes('Which day for the parade?') && !polls.includes('Caterer for the volunteer lunch?'), polls.join(', '));
  await pat.locator('.doc-link', { hasText: 'Which day for the parade?' }).click(); await pat.waitForSelector('.poll-option');
  expect('Pat: no Edit choices, Close poll, Delete or Move', await pat.getByRole('button', { name: 'Edit choices' }).count() === 0
    && await pat.getByRole('button', { name: 'Close poll', exact: true }).count() === 0 && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-poll').count() === 0);
  expect('Pat: the question is read-only', await pat.locator('#title-poll[readonly]').count() === 1);
  await vote(pat, 'Monday');
  await waitCount(alex, 'Monday', '1 vote, 25%');
  expect('Pat (viewer) can vote, and Alex sees it live', true);
  await pat.getByRole('button', { name: 'Withdraw my vote' }).click();
  await waitCount(alex, 'Monday', '0 votes');
  expect('Pat withdraws her vote', await pat.locator('.poll-choice.is-mine').count() === 0);
  await vote(pat, 'Sunday');

  await olive.getByRole('button', { name: 'Close poll', exact: true }).click();
  await pat.waitForSelector('.poll-badge.is-closed', { timeout: 6000 });
  expect('Closing shows live for Pat; her choices are disabled', await pat.locator('.poll-option input:enabled').count() === 0
    && (await pat.locator('.poll-state').innerText()).includes('by Olive Organizer'), await pat.locator('.poll-state').innerText());
  expect('The leading choice is marked when closed', await pat.locator('.poll-choice.is-top .poll-label', { hasText: 'Saturday' }).count() === 1);
  expect('Pat: no Withdraw button on a closed poll', await pat.getByRole('button', { name: 'Withdraw my vote' }).count() === 0);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-polls-pat-viewer.png` });
  await olive.getByRole('button', { name: 'Reopen poll', exact: true }).click();
  await pat.waitForSelector('.poll-badge:not(.is-closed)', { timeout: 6000 });
  expect('Reopening shows live too', await pat.locator('.poll-option input:enabled').count() === 3);

  // Home widget (Olive has never saved a layout, so she gets the default with Polls to vote in).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  const w = olive.locator('.widget:has(h3:has-text("Polls to vote in"))');
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: lists the poll Olive has not voted in, not the one she has', rows.includes('Caterer for the volunteer lunch?') && !rows.includes('Which day for the parade?'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Caterer for the volunteer lunch?' }).click();
  await olive.waitForSelector('#tab-polls[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-poll')?.value === 'Caterer for the volunteer lunch?');
  expect('Widget: a row opens the poll in Polls', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
