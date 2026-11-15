// Away warnings in real browsers, on the test stack (tests/run.sh --keep): Pat (viewer in #festival) adds her
// own time off in Time off; Olive makes a #festival task list and, picking Pat with a due date in Pat's time
// off, sees "Pat Public is away then" in the add form and on the task (and not for a day outside it); Alex
// (dark mode) sees the note on the list; Pat reads the list and sees "You are away then" on her task; in Shifts,
// Pat is told "You are away then" before taking a place on a shift that day, and once she takes it Olive sees
// "Pat Public is away then" by her name, live. When Pat removes her time off, Olive's notes go, live.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node away-warnings-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const RUN = Date.now() % 100000;
const LIST = `Festival set-up ${RUN}`;
const SHIFT = `Gate ${RUN}`;
const NOTE = `Away test ${RUN}`;
const AWAY_FROM = day(20), AWAY_TO = day(22), INSIDE = day(21), OUTSIDE = day(24);
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const app = async (p, label) => { await p.locator('#tab-home').click(); await p.locator(`.app:has-text("${label}")`).first().click(); await p.waitForSelector('.docs-list'); };
  const openRow = (p, title) => p.locator(`.task:not(.is-done):has(input[value="${title}"]), .task:not(.is-done):has(.task-title--read:text-is("${title}"))`);

  // Pat adds her own time off in #festival.
  const pat = await open('Pat Public');
  await app(pat, 'Time off');
  await pat.getByRole('button', { name: 'Add time off' }).click();
  await pat.locator('#to-new-from').fill(AWAY_FROM); await pat.locator('#to-new-to').fill(AWAY_TO);
  await pat.locator('#to-new-note').fill(NOTE);
  await pat.locator('form[aria-label="New time off"]').getByRole('button', { name: 'Add time off' }).click();
  await pat.waitForSelector(`li.away:has-text("${NOTE}")`);
  expect('Pat adds her own time off in #festival (setup)', true);

  // Olive: a new #festival task list; the add form warns when Pat is picked for a day she is away.
  const olive = await open('Olive Organizer');
  await app(olive, 'Tasks');
  await olive.selectOption('#new-tasklist', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New task list' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'New task list' && document.querySelector('.tasks .convo-empty'));
  await olive.fill('#title-tasklist', LIST); await olive.press('#title-tasklist', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${LIST}")`);
  const live = olive.locator('form[aria-label="Add a task"] .away-live');
  await olive.fill('#task-new', 'Hang the bunting');
  await olive.selectOption('#task-new-who', { label: 'Pat Public' });
  expect('No note before a due date is picked', (await live.innerText()) === '', await live.innerText());
  await olive.fill('#task-new-due', OUTSIDE);
  expect('No note for a day outside Pat\'s time off', (await live.innerText()) === '', await live.innerText());
  await olive.fill('#task-new-due', INSIDE);
  await olive.waitForFunction(() => document.querySelector('form[aria-label="Add a task"] .away-live')?.textContent.includes('Pat Public is away then'), null, { timeout: 5000 }).catch(() => {});
  expect('The add form says "Pat Public is away then" for a day inside it, with her dates, in a status region',
    (await live.innerText()).includes('Pat Public is away then') && (await live.getAttribute('role')) === 'status', await live.innerText());
  await olive.getByRole('button', { name: 'Add task' }).click();
  await olive.waitForSelector('.task input[value="Hang the bunting"]');
  expect('The note does not stop Olive adding the task (positive control)', true);
  await olive.fill('#task-new', 'Count the chairs'); await olive.selectOption('#task-new-who', { label: 'Olive Organizer (you)' }); await olive.fill('#task-new-due', INSIDE);
  await olive.getByRole('button', { name: 'Add task' }).click(); await olive.waitForSelector('.task input[value="Count the chairs"]');
  await olive.fill('#task-new', 'Print the maps'); await olive.selectOption('#task-new-who', { label: 'Pat Public' }); await olive.fill('#task-new-due', OUTSIDE);
  await olive.getByRole('button', { name: 'Add task' }).click(); await olive.waitForSelector('.task input[value="Print the maps"]');
  expect('The task row says "Pat Public is away then"', (await openRow(olive, 'Hang the bunting').locator('.away-note').innerText()).startsWith('Pat Public is away then'));
  expect('No note on Olive\'s own task, nor on Pat\'s task due after her time off',
    await openRow(olive, 'Count the chairs').locator('.away-note').count() === 0 && await openRow(olive, 'Print the maps').locator('.away-note').count() === 0);
  // Moving the due date into her time off brings the note; out again takes it away.
  await openRow(olive, 'Print the maps').locator('.task-due').fill(AWAY_FROM);
  await olive.waitForSelector('.task:has(input[value="Print the maps"]) .away-note');
  expect('Changing a due date into Pat\'s time off shows the note (first day counts)', true);
  await openRow(olive, 'Print the maps').locator('.task-due').fill(OUTSIDE);
  await olive.waitForFunction(() => !document.querySelector('.task:has(input[value="Print the maps"]) .away-note'));
  expect('and out of it again hides it', true);
  // Reassigning to someone who is not away hides it too.
  await openRow(olive, 'Hang the bunting').locator('select.task-who').selectOption({ label: 'Olive Organizer (you)' });
  await olive.waitForFunction(() => !document.querySelector('.task:has(input[value="Hang the bunting"]) .away-note'));
  await openRow(olive, 'Hang the bunting').locator('select.task-who').selectOption({ label: 'Pat Public' });
  await olive.waitForSelector('.task:has(input[value="Hang the bunting"]) .away-note');
  expect('Reassigning away from Pat hides the note; back to Pat shows it', true);
  await olive.fill('#task-new', 'Sweep the stage'); await olive.selectOption('#task-new-who', { label: 'Pat Public' }); await olive.fill('#task-new-due', INSIDE);
  await olive.locator('#task-new').focus();
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-away-warnings-olive-tasks-light.png` });

  // Alex (dark mode) sees the note on the list too.
  const alex = await open('Alex (test admin)', true);
  await app(alex, 'Tasks');
  await alex.locator('.doc-link', { hasText: LIST }).click(); await alex.waitForSelector('.task input[value="Hang the bunting"]');
  await alex.waitForSelector('.task:has(input[value="Hang the bunting"]) .away-note');
  expect('Alex (owner) sees "Pat Public is away then" on the task', (await openRow(alex, 'Hang the bunting').locator('.away-note').innerText()).startsWith('Pat Public is away then'));
  await alex.selectOption('#task-new-who', { label: 'Pat Public' }); await alex.fill('#task-new-due', AWAY_TO);
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-away-warnings-alex-dark.png` });

  // Pat reads the list (viewer): "You are away then" on her task; no form.
  await app(pat, 'Tasks');
  await pat.locator('.doc-link', { hasText: LIST }).click(); await pat.waitForSelector('.task-title--read');
  await pat.waitForSelector('.task:has(.task-title--read:text-is("Hang the bunting")) .away-note');
  expect('Pat (viewer) sees "You are away then" on her task, and has no add form',
    (await openRow(pat, 'Hang the bunting').locator('.away-note').innerText()).startsWith('You are away then') && await pat.locator('#task-new').count() === 0);
  expect('Pat sees no note on her task due after her time off', await openRow(pat, 'Print the maps').locator('.away-note').count() === 0);
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-away-warnings-pat-viewer.png` });

  // Shifts: Olive adds a shift on a day Pat is away; Pat is told before taking a place; Olive sees it by her name.
  await app(olive, 'Shifts');
  await olive.getByRole('button', { name: 'New shift' }).click();
  await olive.locator('#sh-new-space').selectOption({ label: '#festival' });
  await olive.locator('#sh-new-title').fill(SHIFT);
  await olive.locator('#sh-new-day').fill(INSIDE);
  await olive.locator('#sh-new-from').fill('10:00'); await olive.locator('#sh-new-to').fill('14:00');
  await olive.locator('#sh-new-places').fill('3');
  await olive.locator('form[aria-label="New shift"]').getByRole('button', { name: 'Add shift' }).click();
  const card = (p) => p.locator(`li.shift:has(.shift-title:text-is("${SHIFT}"))`);
  await card(olive).waitFor();
  expect('Olive is not warned about herself (not away)', await card(olive).locator('.away-note').count() === 0);
  await app(pat, 'Shifts');
  await card(pat).waitFor();
  await card(pat).locator('.away-note').waitFor({ timeout: 5000 }).catch(() => {});
  expect('Pat sees "You are away then" before taking a place', (await card(pat).locator('.link-foot .away-note').innerText().catch(() => '')).startsWith('You are away then'));
  await card(pat).getByRole('button', { name: /^Take a place/ }).click();
  await card(pat).getByRole('button', { name: /^Give back my place/ }).waitFor();
  expect('The note does not stop Pat taking a place (positive control); it now shows by her name',
    await card(pat).locator('.link-foot .away-note').count() === 0 && (await card(pat).locator('.shift-who .away-note').innerText()).startsWith('You are away then'));
  await olive.waitForSelector(`li.shift:has(.shift-title:text-is("${SHIFT}")) .shift-who .away-note`, { timeout: 8000 });
  expect('Olive sees "Pat Public is away then" by Pat\'s name, live', (await card(olive).locator('.shift-who .away-note').innerText()).startsWith('Pat Public is away then'));

  // Pat removes her time off: Olive's notes go, live (Shifts here; Tasks on Alex's screen).
  await app(pat, 'Time off');
  await pat.locator(`li.away:has-text("${NOTE}")`).getByRole('button', { name: /^Remove/ }).click();
  await pat.waitForFunction((n) => ![...document.querySelectorAll('li.away')].some((e) => e.textContent.includes(n)), NOTE);
  await olive.waitForFunction((s) => { const c = [...document.querySelectorAll('li.shift')].find((e) => e.querySelector('.shift-title')?.textContent === s); return c && !c.querySelector('.away-note'); }, SHIFT, { timeout: 8000 });
  expect('Pat removes her time off: the note by her name in Shifts goes, live', true);
  await alex.waitForFunction(() => !document.querySelector('.task .away-note'), null, { timeout: 8000 });
  expect('and the note on her task goes from Alex\'s list, live', true);

  // Tidy: Olive deletes the shift.
  await card(olive).getByRole('button', { name: /^Delete/ }).click();
  await card(olive).waitFor({ state: 'detached' });

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
