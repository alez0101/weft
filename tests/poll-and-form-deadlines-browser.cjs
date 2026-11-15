// Poll and form deadlines in real browsers, on the test stack (tests/run.sh --keep): Olive makes a poll in
// #festival and gives it a closing time; Alex (dark mode) sees it live; a time in the past is refused.
// Olive gives a form a closing time too. Pat (viewer) sees both closing times in the "Polls to vote in" and
// "Forms to fill in" widgets, sees the time on the poll but cannot set it, and votes. Then the
// poll's time is moved to a few seconds ahead (with the owner's SQL on the test stack, as Olive: the box takes
// whole minutes) and, when it passes, every open screen shows it closed by itself with no reload; Pat can no
// longer vote. Olive reopens it, which clears the time.
// Run from a dir with playwright:  WEFT_REPO=<this repo> WEFT_SHOTS=<dir> node poll-and-form-deadlines-browser.cjs
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
// A datetime-local value n days from now at hh:00, in the browser's (and this machine's) time zone.
const local = (days, hh) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hh, 0, 0, 0); return { d, v: new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }; };
const words = (d) => d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });

(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, app, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-US' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    if (app) { await p.locator(`.app:has-text("${app}")`).click(); await p.waitForSelector('.docs-list'); }
    return p;
  };
  const state = (p) => p.locator('.poll-state').innerText();
  const waitState = (p, text, timeout = 6000) => p.waitForFunction((t) => (document.querySelector('.poll-state')?.textContent || '').includes(t), text, { timeout });
  const setTime = async (p, value) => {
    await p.getByRole('button', { name: /^(Set|Change) closing time$/ }).click();
    const f = p.locator('form[aria-label="Closing time"]');
    await f.getByLabel('Closes at').fill(value);
    await f.getByRole('button', { name: 'Save time' }).click();
  };
  const T3 = local(3, 17); const T2 = local(2, 12);

  // Olive's poll in #festival, with two choices.
  const olive = await open('Olive Organizer', 'Polls');
  await olive.selectOption('#new-poll', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New poll' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-poll')?.value === 'New poll' && document.querySelectorAll('.poll-choice').length === 2);
  await olive.fill('#title-poll', 'Which day for the clean-up?'); await olive.press('#title-poll', 'Enter');
  await olive.waitForSelector('.doc-link:has-text("Which day for the clean-up?")');
  await olive.getByRole('button', { name: 'Edit choices' }).click();
  for (const [i, label] of ['Sunday morning', 'Monday evening'].entries()) {
    await olive.locator('.poll-edit input').nth(i).fill(label); await olive.locator('.poll-edit input').nth(i).press('Enter');
    await olive.waitForSelector(`.poll-edit input[value="${label}"]`);
  }
  await olive.getByRole('button', { name: 'Done editing' }).click();
  expect('A new poll has no closing time', !(await state(olive)).includes('closes'));

  const alex = await open('Alex (test admin)', 'Polls', true);
  await alex.locator('.doc-link', { hasText: 'Which day for the clean-up?' }).click(); await alex.waitForSelector('.poll-option');

  // Olive sets the time; Alex sees it live.
  await setTime(olive, T3.v);
  await waitState(olive, `closes ${words(T3.d)}`);
  expect('Olive sets a closing time and the poll shows it', true);
  const live = await waitState(alex, `closes ${words(T3.d)}`).then(() => true).catch(() => false);
  expect('Alex sees the closing time live', live, await state(alex));
  // A time in the past: the box itself refuses it (the database would too: see tests/permissions.py), and the time stays.
  await setTime(olive, local(-1, 9).v);
  await olive.waitForTimeout(500);
  const under = await olive.locator('form[aria-label="Closing time"] input').evaluate((e) => e.validity.rangeUnderflow);
  expect('A closing time in the past is refused by the box', under);
  expect('and the old time stays', (await state(olive)).includes(words(T3.d)) && await olive.locator('.poll .send-error').count() === 0);
  await olive.locator('form[aria-label="Closing time"]').getByRole('button', { name: 'Cancel' }).click();
  await olive.mouse.click(5, 895); await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-deadlines-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-deadlines-alex-dark.png` });

  // A form with a closing time.
  const oliveForms = await open('Olive Organizer', 'Forms');
  await oliveForms.selectOption('#new-form', { label: '#festival' });
  await oliveForms.locator('.docs-new').getByRole('button', { name: 'New form' }).click();
  await oliveForms.waitForFunction(() => document.querySelector('#title-form')?.value === 'New form' && document.querySelectorAll('.form-q.is-editing').length === 1);
  await oliveForms.fill('#title-form', 'Clean-up helpers'); await oliveForms.press('#title-form', 'Enter');
  await oliveForms.waitForSelector('.doc-link:has-text("Clean-up helpers")');
  await setTime(oliveForms, T2.v);
  await waitState(oliveForms, `closes ${words(T2.d)}`);
  expect('Olive sets a closing time on a form', true);

  // Pat (viewer): the widgets, soonest first, then the poll, read-only.
  const pat = await open('Pat Public');
  await pat.waitForSelector('.widgets-area');
  // Both widgets are on by default; after tests/run.sh Pat's layout may hold only Recent, so turn them on if needed.
  const missing = [];
  for (const t of ['Polls to vote in', 'Forms to fill in']) if (!(await pat.locator(`.widget:has(h3:has-text("${t}"))`).count())) missing.push(t);
  if (missing.length) {
    await pat.getByRole('button', { name: 'Customize' }).click();
    for (const t of missing) await pat.locator('.widget-picker label', { hasText: t }).locator('input').check();
    await pat.getByRole('button', { name: 'Done', exact: true }).click();
  }
  const pw = pat.locator('.widget:has(h3:has-text("Polls to vote in"))');
  const fw = pat.locator('.widget:has(h3:has-text("Forms to fill in"))');
  await pw.locator('.widget-row', { hasText: 'Which day for the clean-up?' }).waitFor({ timeout: 6000 });
  await fw.locator('.widget-row', { hasText: 'Clean-up helpers' }).waitFor({ timeout: 6000 });
  const prow = await pw.locator('.widget-row').first().innerText();
  const frow = await fw.locator('.widget-row').first().innerText();
  out('widget rows:', prow.replace(/\n/g, ' / '), '|', frow.replace(/\n/g, ' / '));
  expect('Polls to vote in: the poll with a closing time comes first and shows it', prow.includes('Which day for the clean-up?') && prow.includes(`Closes ${words(T3.d)}`), prow);
  expect('Forms to fill in: the form shows its closing time', frow.includes('Clean-up helpers') && frow.includes(`Closes ${words(T2.d)}`), frow);
  await pw.locator('.widget-row', { hasText: 'Which day for the clean-up?' }).click();
  await pat.waitForSelector('.poll-option');
  expect('Pat sees the closing time on the poll', (await state(pat)).includes(`closes ${words(T3.d)}`), await state(pat));
  expect('Pat: no closing time buttons', await pat.getByRole('button', { name: /closing time/ }).count() === 0);
  await pat.locator('.poll-choice', { hasText: 'Sunday morning' }).locator('input[type=radio]').check();
  await pat.waitForSelector('.poll-choice.is-mine');
  expect('Pat votes before the time (positive control)', true);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-deadlines-pat-viewer.png` });

  // The time comes: closed by itself on every open screen. (The box takes whole minutes, so the owner's SQL
  // moves the time to a few seconds ahead, as Olive; the change is announced like any other.)
  ownerSql(`select set_config('request.jwt.claims', json_build_object('sub', (select id from weft.users where display_name = 'Olive Organizer'))::text, false);
    update weft.polls set closes_at = now() + interval '4 seconds' where id = (select id from weft.items where title = 'Which day for the clean-up?');`);
  const shut = await Promise.all([pat, alex, olive].map((p) => waitState(p, 'closed by itself', 12000).then(() => true).catch(() => false)));
  expect('When the time passes, Pat, Alex and Olive all see the poll closed by itself, without reloading', shut.every(Boolean), shut.join(','));
  expect('The badge says Closed', (await pat.locator('.poll-badge').innerText()) === 'Closed');
  expect('Pat can no longer vote', await pat.locator('.poll-choices:disabled').count() === 1);
  const hint = await olive.locator('.poll-foot .docs-hint').innerText();
  expect('Olive is told how to open it again', hint.includes('set a later closing time'), hint);
  // Olive reopens it, which clears the time.
  await olive.getByRole('button', { name: 'Reopen poll' }).click();
  await waitState(olive, 'Open');
  const reopened = await waitState(pat, 'Open').then(() => true).catch(() => false);
  expect('Olive reopens it; the time is gone and Pat can vote again', reopened && !(await state(pat)).includes('clos') && await pat.locator('.poll-choices:disabled').count() === 0, await state(pat));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
