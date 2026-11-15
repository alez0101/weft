// Next steps for ideas in real browsers, on the test stack (tests/run.sh --keep): Olive makes a task list and an
// ideas board in #festival and suggests three ideas. Alex (owner) marks one planned: the idea offers to add it as
// a task, Alex picks the list and it shows "Task open in <list>"; Olive (editor, dark mode) sees it live and has
// no way to add or change next steps. Alex declines another: the idea stays in view and asks why; the reason shows
// under it, live for Olive. "Not now" closes the offer and "Add as a task" brings it back. Olive ticks the task off
// in Tasks and Alex's board says "Task done" live; the list's name opens the list. Pat (viewer) reads the task and
// the reason and has no buttons to change them.
// Run from a dir with playwright:  WEFT_REPO=<this repo> WEFT_SHOTS=<dir> node idea-next-steps-browser.cjs
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
const LIST = 'Stage crew jobs'; const BOARD = 'Summer ideas';
const SHADE = 'Shade sails over the queue'; const FIRE = 'Fireworks at closing'; const SUN = 'Free sunscreen at the gate';
const REASON = 'The fire service said no for this site';

(async () => {
  // A second run on the same test stack starts clean (test stack only).
  ownerSql(`delete from weft.items where title in ('${LIST}', '${BOARD}') and space_id = (select id from weft.spaces where name = 'festival')`);
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, app, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator(`.app:has-text("${app}")`).click(); await p.waitForSelector('.docs-list'); return p;
  };
  const idea = (p, title) => p.locator('.idea', { has: p.locator('.qa-title', { hasText: new RegExp(`^${title}$`) }) });
  const live = (p, title, text, timeout = 6000) => p.waitForFunction(([t, x]) => [...document.querySelectorAll('.idea')]
    .some((e) => e.querySelector('.qa-title')?.textContent === t && e.textContent.includes(x)), [title, text], { timeout }).then(() => true).catch(() => false);
  const suggest = async (p, title) => {
    await p.getByRole('button', { name: 'Suggest an idea' }).click();
    await p.fill('#idea-new-title', title);
    await p.locator('form[aria-label="Suggest an idea"]').getByRole('button', { name: 'Add idea' }).click();
    await p.waitForSelector(`.idea .qa-title:text-is("${title}")`);
  };
  const openBoard = async (p) => { await p.locator('.doc-link', { hasText: BOARD }).click(); await p.waitForSelector('.idea'); };

  // Olive: a task list and an ideas board in #festival.
  const tasks = await open('Olive Organizer', 'Tasks');
  await tasks.selectOption('#new-tasklist', { label: '#festival' });
  await tasks.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await tasks.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list' && document.querySelector('.tasks .convo-empty'));
  await tasks.fill('#title-tasklist', LIST); await tasks.press('#title-tasklist', 'Enter');
  await tasks.waitForSelector(`.doc-link:has-text("${LIST}")`);
  const olive = await open('Olive Organizer', 'Ideas', true);
  await olive.selectOption('#new-ideaboard', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New ideas board' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-ideaboard')?.value === 'Ideas');
  await olive.fill('#title-ideaboard', BOARD); await olive.press('#title-ideaboard', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${BOARD}")`);
  for (const t of [SHADE, FIRE, SUN]) await suggest(olive, t);

  // Alex (owner) marks an idea planned and adds it as a task.
  const alex = await open('Alex (test admin)', 'Ideas');
  await openBoard(alex);
  await alex.selectOption(`select[aria-label="Status of ${SHADE}"]`, 'planned');
  const offer = alex.locator(`form[aria-label="Add ${SHADE} as a task"]`);
  const offered = await offer.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Marking an idea planned offers to add it as a task', offered);
  const opts = offered ? await offer.locator('select option').allInnerTexts() : [];
  expect('The offer lists the task lists in the same channel', opts.includes(LIST), opts.join(', '));
  if (offered) { await offer.locator('select').selectOption({ label: LIST }); await offer.getByRole('button', { name: 'Add task' }).click(); }
  expect('The idea shows its task and list', await live(alex, SHADE, `Task open in ${LIST}`));
  expect('The offer closes once the task is added', await offer.count() === 0);
  expect('Olive sees the task under the idea live', await live(olive, SHADE, `Task open in ${LIST}`));
  expect('Olive (editor) has no status menu and no Add as a task button', await olive.locator('select.idea-status').count() === 0
    && await olive.getByRole('button', { name: /^Add as a task/ }).count() === 0);

  // Alex declines an idea: it stays in view and asks why.
  await alex.selectOption(`select[aria-label="Status of ${FIRE}"]`, 'declined');
  const ask = alex.locator(`form[aria-label="Why ${FIRE} was declined"]`);
  const asked = await ask.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Declining an idea asks for a short reason, and the idea stays in view under Open', asked && await idea(alex, FIRE).count() === 1);
  if (asked) { await ask.locator('input').fill(REASON); await ask.getByRole('button', { name: 'Save reason' }).click(); }
  await olive.getByRole('button', { name: /^All/ }).click();
  expect('Olive sees the reason under the declined idea live', await live(olive, FIRE, `Declined: ${REASON}`));
  expect('Olive has no Change reason button', await olive.getByRole('button', { name: /^Change reason/ }).count() === 0);
  await alex.getByRole('button', { name: /^All/ }).click();
  expect('Alex sees the reason and can change it', await live(alex, FIRE, `Declined: ${REASON}`)
    && await idea(alex, FIRE).getByRole('button', { name: /^Change reason/ }).count() === 1);

  // "Not now", then "Add as a task" brings the offer back.
  await alex.selectOption(`select[aria-label="Status of ${SUN}"]`, 'planned');
  const offer2 = alex.locator(`form[aria-label="Add ${SUN} as a task"]`);
  await offer2.waitFor({ timeout: 6000 }).catch(() => {});
  await offer2.getByRole('button', { name: 'Not now' }).click();
  expect('"Not now" closes the offer and leaves an Add as a task button', await offer2.count() === 0
    && await idea(alex, SUN).getByRole('button', { name: /^Add as a task/ }).count() === 1);
  await idea(alex, SUN).getByRole('button', { name: /^Add as a task/ }).click();
  expect('Add as a task opens the offer again', await offer2.waitFor({ timeout: 4000 }).then(() => true).catch(() => false));
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/1-idea-next-steps-alex-light.png` });
  await offer2.getByRole('button', { name: 'Not now' }).click();

  // The task is a real task: Olive ticks it off in Tasks, the board says so live. (Tasks is opened afresh: the app
  // keeps only the latest live notice, so a screen already open may miss the task's notice in the burst that
  // adding it sends, an existing limit of App.jsx.)
  await tasks.context().close();
  const tasks2 = await open('Olive Organizer', 'Tasks');
  await tasks2.locator('.doc-link', { hasText: LIST }).click();
  await tasks2.waitForSelector(`.task input[value="${SHADE}"]`);
  expect('The idea is a task in the list', await tasks2.locator(`.task input[value="${SHADE}"]`).count() === 1);
  await tasks2.getByRole('checkbox', { name: `Done: ${SHADE}` }).check();
  expect('Ticking it off shows "Task done" on the board live', await live(alex, SHADE, `Task done in ${LIST}`) && await live(olive, SHADE, `Task done in ${LIST}`));
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/2-idea-next-steps-olive-dark.png` });
  await idea(alex, SHADE).getByRole('button', { name: LIST }).click();
  const opened = await alex.waitForFunction((l) => document.querySelector('#title-tasklist')?.value === l, LIST, { timeout: 6000 }).then(() => true).catch(() => false);
  expect('The list name opens the task list', opened);

  // Pat (viewer in #festival) reads both and changes nothing.
  const pat = await open('Pat Public', 'Ideas');
  await openBoard(pat);
  await pat.getByRole('button', { name: /^All/ }).click();
  expect('Pat reads the task and the reason', await live(pat, SHADE, `Task done in ${LIST}`) && await live(pat, FIRE, `Declined: ${REASON}`));
  expect('Pat has no status menu, Add as a task, Add a reason or Change reason', await pat.locator('select.idea-status').count() === 0
    && await pat.getByRole('button', { name: /^(Add as a task|Add a reason|Change reason)/ }).count() === 0 && await pat.locator('.idea-ask').count() === 0);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-idea-next-steps-pat-viewer.png` });

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
