// Task from a message in real browsers, on the test stack (tests/run.sh --keep): Pat (viewer) asks for something in
// #festival. Olive (editor) presses Make a task under the message: Add a task opens with the message as the title,
// she picks the list, herself and a date and adds it; the message shows "Task open in <list>". Alex (owner, dark
// mode) sees that live, opens the list in Tasks, and "From a message" takes him back to the message in chat. Pat
// has no Make a task action, sees the task under her message and "From a message" in Tasks (read-only), and sees
// it turn to "Task done" live when Olive ticks it off. Cancel closes the form without adding anything. Where there
// is no task list yet (Olive's Personal space), the form offers a new list called Tasks and makes it.
// Run from a dir with playwright:  WEFT_REPO=<this repo> WEFT_SHOTS=<dir> node task-from-a-message-browser.cjs
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const API = process.env.WEFT_API || 'http://127.0.0.1:3200';
const REPO = process.env.WEFT_REPO || (require('fs').existsSync(path.resolve(__dirname, '../stacks')) ? path.resolve(__dirname, '..') : `${process.env.HOME}/work/weft`);
const TAG = Date.now().toString(36).slice(-5);
const LIST = `Stage crew ${TAG}`;
const ASK = `Can someone fix the gate sign before Saturday? It fell over in the wind ${TAG}`;
const OTHER = `The parking field opens at 9 ${TAG}`;
const tok = (who) => execFileSync('python3', ['-I', path.join(REPO, 'tools', 'mint_token.py'), who], { encoding: 'utf8' }).trim();
const api = async (who, p, method = 'GET', body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${tok(who)}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t}`); return t ? JSON.parse(t) : null;
};

(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.convos .convo', { hasText: 'festival' }).first().click();
    await p.locator('.messages').getByText(ASK).waitFor({ timeout: 15000 });
    return p;
  };
  const msg = (p, text) => p.locator('.msg', { hasText: text });
  const openList = async (p) => {
    await p.locator('.app:has-text("Tasks")').click(); await p.waitForSelector('.docs-list');
    await p.locator('.doc-link', { hasText: LIST }).click(); await p.waitForSelector('.task');
  };
  try {
    const fest = (await api('u-alex', '/spaces?kind=eq.channel&name=eq.festival&select=id'))[0].id;
    await api('u-org', '/items', 'POST', { space_id: fest, kind: 'tasklist', title: LIST });
    await api('u-org', '/messages', 'POST', { space_id: fest, body: OTHER });
    await api('u-pub', '/messages', 'POST', { space_id: fest, body: ASK });

    const olive = await open('Olive Organizer');
    const alex = await open('Alex (test admin)', true);
    const pat = await open('Pat Public');

    // Olive: Make a task under Pat's message, in full screen chat (after tests/run.sh --keep, pinned announcements
    // in #festival leave little room for messages at this window size).
    await olive.getByRole('button', { name: 'Full screen chat' }).click();
    await olive.waitForSelector('.shell[data-full="chat"]');
    await msg(olive, ASK).hover();
    await msg(olive, ASK).getByRole('button', { name: /^Make a task/ }).click();
    const form = msg(olive, ASK).locator('form[aria-label="Add a task"]');
    const opened = await form.waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    expect('Make a task opens Add a task under the message', opened);
    const title = opened ? await form.getByLabel('Task', { exact: true }).inputValue() : '';
    expect('The title is the message text', title === ASK, title);
    const lists = opened ? await form.getByLabel('Task list').locator('option').allInnerTexts() : [];
    expect('The task lists offered are the ones in this channel', lists.includes(LIST), lists.join(', '));
    await form.getByLabel('Task list').selectOption({ label: LIST });
    await form.getByLabel('Assigned to').selectOption({ label: 'Olive Organizer (you)' });
    await form.getByLabel('Due date').fill('2027-04-16');
    await msg(olive, ASK).evaluate((el) => { const l = el.closest('.messages'); l.scrollTop += el.getBoundingClientRect().top - l.getBoundingClientRect().top - 8; });
    await olive.screenshot({ path: `${SHOTS}/1-make-a-task-light.png` });
    await form.getByRole('button', { name: 'Add task' }).click();
    const chip = (p, state) => msg(p, ASK).locator('.msg-task', { hasText: `${state} in ${LIST}` });
    expect('The form closes and says where the task went', await olive.locator('.thinking', { hasText: `to ${LIST}` }).waitFor({ timeout: 6000 }).then(() => true).catch(() => false)
      && await form.count() === 0);
    expect('The message shows "Task open in <list>"', await chip(olive, 'Task open').waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
    const [l] = await api('u-org', `/items?title=eq.${encodeURIComponent(LIST)}&select=id`);
    const row = await api('u-org', `/tasks?list_id=eq.${l.id}&select=title,due_on,message_id`);
    const [m] = await api('u-org', `/messages?space_id=eq.${fest}&body=eq.${encodeURIComponent(ASK)}&select=id`);
    expect('The database has the task, linked to the message', row.length === 1 && row[0].message_id === m.id && row[0].due_on === '2027-04-16' && row[0].title === ASK, JSON.stringify(row));

    // Cancel closes the form and adds nothing.
    await msg(olive, OTHER).hover();
    await msg(olive, OTHER).getByRole('button', { name: /^Make a task/ }).click();
    await msg(olive, OTHER).getByRole('button', { name: 'Cancel' }).click();
    expect('Cancel closes the form without adding a task', await msg(olive, OTHER).locator('form').count() === 0 && await msg(olive, OTHER).locator('.msg-task').count() === 0);

    // Alex (dark): sees it live, opens the list, and goes back to the message.
    expect('Alex sees "Task open" under the message live', await chip(alex, 'Task open').waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
    await openList(alex);
    const task = alex.locator('.task', { has: alex.locator(`input[value="${ASK}"]`) });
    expect('In Tasks, the task says "From a message"', await task.locator('.task-from').isVisible().catch(() => false));
    await alex.evaluate(() => { const l = document.querySelector('.messages'); if (l) l.scrollTop = 0; });
    await task.locator('.task-from').click();
    expect('"From a message" opens the chat at the message', await alex.waitForSelector(`.msg.is-focus:has-text("${ASK}")`, { timeout: 6000 }).then(() => true).catch(() => false));
    await alex.screenshot({ path: `${SHOTS}/2-from-a-message-dark.png` });

    // Pat (viewer): no action, but sees the task, and its link in Tasks.
    expect('Pat (viewer) has no Make a task action', await pat.locator('.msg-action').count() === 0);
    expect('Pat sees "Task open" under her message', await chip(pat, 'Task open').waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
    await openList(pat);
    const ptask = pat.locator('.task', { hasText: ASK });
    expect('Pat sees the task read-only, with "From a message"', await ptask.locator('.task-title--read').isVisible().catch(() => false)
      && await ptask.locator('.task-from').isVisible().catch(() => false));

    // Olive ticks it off in Tasks; Pat's message says "Task done" live.
    await olive.getByRole('button', { name: 'Exit full screen chat' }).click();
    await openList(olive);
    await olive.locator('.task', { has: olive.locator(`input[value="${ASK}"]`) }).locator('.task-check').check();
    expect('Pat sees "Task done" under her message live', await chip(pat, 'Task done').waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
    await pat.screenshot({ path: `${SHOTS}/3-viewer-read-only.png` });

    // No task list yet (Olive's Personal space, emptied of task lists first; test stack only): the form offers
    // a new list called Tasks and makes it.
    const mine = (await api('u-org', '/spaces?kind=eq.personal&select=id'))[0].id;
    await api('u-org', `/items?space_id=eq.${mine}&kind=eq.tasklist`, 'DELETE');
    const NOTE = `Remember the ice for Sunday ${TAG}`;
    await api('u-org', '/messages', 'POST', { space_id: mine, body: NOTE });
    await olive.locator('.convos .convo', { hasText: 'Personal' }).first().click();
    await msg(olive, NOTE).waitFor({ timeout: 15000 });
    await msg(olive, NOTE).hover();
    await msg(olive, NOTE).getByRole('button', { name: /^Make a task/ }).click();
    const pform = msg(olive, NOTE).locator('form[aria-label="Add a task"]');
    const offered = await pform.getByLabel('Task list').locator('option').allInnerTexts().catch(() => []);
    expect('With no task list yet, the form offers a new list called Tasks', offered.length === 1 && offered[0] === 'A new list called Tasks', offered.join(', '));
    await pform.getByRole('button', { name: 'Add task' }).click();
    expect('Adding makes the list and the task', await msg(olive, NOTE).locator('.msg-task', { hasText: 'Task open in Tasks' }).waitFor({ timeout: 6000 }).then(() => true).catch(() => false));
  } catch (e) {
    failed += 1; out(`FAIL ${e.message.split('\n')[0]}`);
    for (const [i, pg] of b.contexts().flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: `${SHOTS}/task-from-a-message-failed-${i}.png` }).catch(() => {});
  }
  expect('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  out(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
