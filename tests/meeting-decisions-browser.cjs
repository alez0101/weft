// Meeting decisions to the log in real browsers, on the test stack (tests/run.sh --keep): in #festival there is
// a meeting with three decision lines and two decision logs. Olive picks a log and sends two lines with one
// press each; Alex (dark mode) has the meeting open and sees them marked "In <log>" live. "Open the log" goes to
// the decision log, where the decision is dated the meeting's day, decided by the meeting, and links back to it.
// Pat (viewer in #festival) sees which lines are in a log, with no way to send, and the link back in the log.
// Deleting the decision in the log puts the Send button back on the meeting, live.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node meeting-decisions-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const N = Date.now() % 100000;
const MEETING = `Gate crew meeting ${N}`; const LOG = `Gate crew log ${N}`; const OTHER = `Bar log ${N}`;
const LINES = ['Gates open at 9:30, not 10', 'Wristbands are checked at the inner gate only', 'Lost children go to the info tent'];
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark, app = 'Meetings') => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1300 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator(`.app:has-text("${app}")`).click(); await p.waitForSelector('.docs-list'); return p;
  };
  // Set-up through the API as Olive (the same calls the Meetings and Decisions apps make).
  const asOlive = (p, method, path, body) => p.evaluate(async ({ method, path, body }) => {
    const s = await (await fetch('/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify({ email: 'olive.organizer@example.com' }) })).json();
    const r = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }, { method, path, body });
  const pick = async (p, title) => { await p.locator('.doc-link', { hasText: title }).click(); await p.waitForFunction((t) => document.querySelector('#title-meeting')?.value === t, title); await p.waitForSelector('.meeting'); };
  const line = (p, text) => p.locator('.meeting-decision', { hasText: text });

  const olive = await open('Olive Organizer');
  const [fest] = await asOlive(olive, 'GET', '/spaces?kind=eq.channel&name=eq.festival&select=id');
  const [mt] = await asOlive(olive, 'POST', '/items', { space_id: fest.id, kind: 'meeting', title: MEETING });
  const [log] = await asOlive(olive, 'POST', '/items', { space_id: fest.id, kind: 'decisionlog', title: LOG });
  await asOlive(olive, 'POST', '/items', { space_id: fest.id, kind: 'decisionlog', title: OTHER });
  await asOlive(olive, 'PATCH', `/meetings?id=eq.${mt.id}`, { held_at: '2026-11-12T15:00:00Z', decisions: `${LINES.join('\n')}\n\n` });
  expect('Set-up: a meeting with three decision lines and two decision logs in #festival', mt?.id && log?.id);

  // Reload so the meetings list has the new one (signing in again if the page asks).
  await olive.reload({ waitUntil: 'networkidle' });
  if (await olive.getByRole('button', { name: 'Olive Organizer' }).count()) await olive.getByRole('button', { name: 'Olive Organizer' }).click();
  await olive.waitForSelector('.rail-title');
  if (!(await olive.locator('.docs-list').count())) await olive.locator('.app:has-text("Meetings")').click();
  await olive.waitForSelector('.docs-list');
  await pick(olive, MEETING);
  await olive.waitForSelector('.meeting-decision');
  expect('Olive sees each decision line with a Send to log button', await olive.locator('.meeting-decision').count() === 3
    && await olive.locator('.meeting-decision').getByRole('button', { name: /^Send to log/ }).count() === 3);
  const opts = await olive.locator('#meeting-log option').allInnerTexts();
  expect('With two logs in the space, she picks which one', opts.includes(LOG) && opts.includes(OTHER), opts.join(', '));
  await olive.selectOption('#meeting-log', { label: LOG });

  const alex = await open('Alex (test admin)', true);
  await pick(alex, MEETING); await alex.waitForSelector('.meeting-decision');

  let t0 = Date.now();
  await line(olive, LINES[0]).getByRole('button', { name: /^Send to log/ }).click();
  await olive.waitForSelector(`.meeting-decision.is-sent:has-text("${LINES[0]}")`);
  expect('One press: the line says which log it is in', (await line(olive, LINES[0]).innerText()).includes(`In ${LOG}`)
    && (await olive.locator('.meeting .slot-status').last().innerText()).includes(`Sent to ${LOG}`));
  await alex.waitForSelector(`.meeting-decision.is-sent:has-text("${LINES[0]}")`, { timeout: 8000 });
  out(`Alex saw the sent line live: ${Date.now() - t0} ms`);
  expect('Alex sees it live', true);
  await line(olive, LINES[1]).getByRole('button', { name: /^Send to log/ }).click();
  await olive.waitForSelector(`.meeting-decision.is-sent:has-text("${LINES[1]}")`);
  expect('The count follows', (await olive.locator('.meeting-decisions .task-count').innerText()) === '1 of 3 not in a log yet');
  expect('The picker now starts on the log last used', await olive.locator('#meeting-log').inputValue() === log.id);
  await alex.waitForSelector(`.meeting-decision.is-sent:has-text("${LINES[1]}")`, { timeout: 8000 });
  await olive.locator('#meeting-h-decisions').scrollIntoViewIfNeeded(); await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-meeting-decisions-olive.png` });
  await alex.locator('#meeting-h-decisions').scrollIntoViewIfNeeded(); await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-meeting-decisions-alex-dark.png` });

  // From the meeting to the log, and back.
  await line(olive, LINES[0]).getByRole('button', { name: /^Open the log/ }).click();
  await olive.waitForSelector(`.decision:has-text("${LINES[0]}")`, { timeout: 8000 });
  const card = await olive.locator('.decision', { hasText: LINES[0] }).innerText();
  expect('In the log: the decision, dated the meeting day, decided by the meeting, from the meeting',
    /Nov 12, 2026|12 Nov 2026/.test(card) && card.includes(`Decided by ${MEETING}`) && card.includes(`From the meeting ${MEETING}`), card);
  expect('Only the sent lines are in the log', await olive.locator('.decision').count() === 2);
  await olive.locator('.decision', { hasText: LINES[0] }).getByRole('button', { name: MEETING }).click();
  await olive.waitForFunction((t) => document.querySelector('#title-meeting')?.value === t, MEETING, { timeout: 8000 });
  expect('"From the meeting" opens the meeting', true);

  // Pat: viewer in #festival.
  const pat = await open('Pat Public');
  await pick(pat, MEETING); await pat.waitForSelector('.meeting-decision');
  expect('Pat: no Send buttons and no log picker', await pat.getByRole('button', { name: /^Send to log/ }).count() === 0 && await pat.locator('#meeting-log').count() === 0);
  const patLines = await pat.locator('.meeting-decision-text').allInnerTexts();
  expect('Pat sees the lines that are in a log, and the full decisions text', patLines.length === 2 && patLines[0] === LINES[0]
    && (await pat.locator('.meeting-read').last().innerText()).includes(LINES[2]), patLines.join(' | '));
  await pat.locator('#meeting-h-decisions').scrollIntoViewIfNeeded(); await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-meeting-decisions-pat-viewer.png` });
  await line(pat, LINES[1]).getByRole('button', { name: /^Open the log/ }).click();
  await pat.waitForSelector(`.decision:has-text("${LINES[1]}")`, { timeout: 8000 });
  expect('Pat follows it to the log and sees where it came from, read-only', (await pat.locator('.decision', { hasText: LINES[1] }).innerText()).includes(`From the meeting ${MEETING}`)
    && await pat.getByRole('button', { name: /^Delete/ }).count() === 0);

  // Deleting the decision in the log frees the line again, live on the meeting.
  await line(olive, LINES[0]).getByRole('button', { name: /^Open the log/ }).click();
  await olive.waitForSelector(`.decision:has-text("${LINES[0]}")`);
  t0 = Date.now();
  await olive.locator('.decision', { hasText: LINES[0] }).getByRole('button', { name: /^Delete/ }).click();
  await alex.waitForFunction((t) => [...document.querySelectorAll('.meeting-decision:not(.is-sent)')].some((r) => r.textContent.includes(t)), LINES[0], { timeout: 8000 });
  out(`Alex saw the line freed live: ${Date.now() - t0} ms`);
  expect('Deleted from the log: the meeting offers Send again, live', await line(alex, LINES[0]).getByRole('button', { name: /^Send to log/ }).count() === 1);

  // Tidy up.
  for (const t of [MEETING, LOG, OTHER]) await asOlive(olive, 'DELETE', `/items?title=eq.${encodeURIComponent(t)}`);
  expect('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  out(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
