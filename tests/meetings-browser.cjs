// Meetings in real browsers, on the test stack (tests/run.sh --keep): Olive makes a meeting in #festival
// (and one in Organizers), writes the agenda, notes and decisions, links it to a calendar event and adds
// action items to a task list; Alex (dark mode) watches it fill in live, and what he is typing is not
// overwritten by Olive's changes; the action item is a real task in Tasks; Pat (viewer) reads the meeting
// with no way to change it, ticks off the action item assigned to her (Olive sees it live), and finds the
// notes from the event in Calendar; Olive turns on the "Recent meetings" Home widget and a row opens it.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node meetings-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 1500 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Meetings")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  // Set-up through the API as Olive (the same calls the Calendar and Tasks apps make).
  const asOlive = (p, path, body) => p.evaluate(async ({ path, body }) => {
    const s = await (await fetch('/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify({ email: 'olive.organizer@example.com' }) })).json();
    const r = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, Prefer: 'return=representation' }, body: JSON.stringify(body) });
    return r.json();
  }, { path, body });
  const pick = async (p, title) => { await p.locator('.doc-link', { hasText: title }).click(); await p.waitForFunction((t) => document.querySelector('#title-meeting')?.value === t, title); await p.waitForSelector('.meeting'); };
  const newMeeting = async (p, space, name) => {
    await p.selectOption('#new-meeting', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New meeting' }).click();
    await p.waitForFunction(() => /^Meeting /.test(document.querySelector('#title-meeting')?.value || '') && document.querySelector('.meeting'));
    await p.fill('#title-meeting', name); await p.press('#title-meeting', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const write = async (p, key, text) => { await p.fill(`#meeting-${key}`, text); await p.locator('#title-meeting').focus(); await p.waitForSelector('.meeting .slot-status'); };

  const olive = await open('Olive Organizer');
  const start = new Date(Date.now() + 86400000); start.setUTCHours(17, 0, 0, 0);
  // Look up #festival's id the way the app does, then make the event and the task list there.
  const fest = (await olive.evaluate(async () => {
    const s = await (await fetch('/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify({ email: 'olive.organizer@example.com' }) })).json();
    return (await (await fetch('/api/spaces?kind=eq.channel&name=eq.festival&select=id', { headers: { Authorization: `Bearer ${s.token}` } })).json())[0].id;
  }));
  const [event] = await asOlive(olive, '/events', { space_id: fest, title: 'Volunteer briefing', starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600000).toISOString() });
  await asOlive(olive, '/items', { space_id: fest, kind: 'tasklist', title: 'Festival actions' });
  expect('Set-up: an event and a task list in #festival', event && event.id, JSON.stringify(event));

  await newMeeting(olive, '#organizers', 'Budget review');
  await write(olive, 'agenda', 'Caterer quotes');
  await newMeeting(olive, '#festival', 'Volunteer briefing notes');

  const alex = await open('Alex (test admin)', true);
  await pick(alex, 'Volunteer briefing notes');
  let t0 = Date.now();
  await write(olive, 'agenda', 'Gates and wristbands\nFirst aid tent\nWhere to park');
  await alex.waitForFunction(() => document.querySelector('#meeting-agenda')?.value.startsWith('Gates and wristbands'), null, { timeout: 6000 });
  out(`Alex saw Olive's agenda live: ${Date.now() - t0} ms`);
  expect('Alex sees the agenda live', true);

  // Alex starts typing notes; Olive's change to another section arrives without wiping what he typed.
  await alex.fill('#meeting-notes', 'Alex: bring the radios');
  await write(olive, 'decisions', 'Gates open at 9:30');
  await alex.waitForFunction(() => document.querySelector('#meeting-decisions')?.value === 'Gates open at 9:30', null, { timeout: 6000 });
  expect('Alex\'s unsaved notes survive Olive\'s live change to another section', await alex.inputValue('#meeting-notes') === 'Alex: bring the radios');
  await alex.locator('#title-meeting').focus(); await alex.waitForSelector('.meeting .slot-status');
  await olive.waitForFunction(() => document.querySelector('#meeting-notes')?.value === 'Alex: bring the radios', null, { timeout: 6000 });
  await write(olive, 'notes', 'Alex: bring the radios\nOlive: wristbands are in the blue box\nTwenty volunteers on Saturday morning');
  expect('Olive sees Alex\'s notes live and adds to them', true);

  // Link the calendar event: the meeting takes its time.
  await olive.selectOption('#meeting-event', { label: await olive.locator('#meeting-event option', { hasText: 'Volunteer briefing' }).innerText() });
  await olive.waitForSelector('.meeting-fact button:has-text("Open in Calendar")');
  const when = await olive.inputValue('#meeting-when');
  const local = new Date(start); local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  expect('Linking the event sets the meeting\'s time to the event\'s', when === local.toISOString().slice(0, 16), `${when} vs ${local.toISOString()}`);
  await alex.waitForSelector('.meeting-fact button:has-text("Open in Calendar")', { timeout: 6000 });

  // Action items go to the chosen list.
  expect('No action item form before a list is chosen', await olive.locator('form[aria-label="Add an action item"]').count() === 0);
  await olive.selectOption('#meeting-list', { label: 'Festival actions' });
  await olive.waitForSelector('form[aria-label="Add an action item"]');
  const due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await olive.fill('#action-new', 'Print the site maps'); await olive.selectOption('#action-new-who', { label: 'Pat Public' }); await olive.fill('#action-new-due', due);
  t0 = Date.now();
  await olive.getByRole('button', { name: 'Add action item' }).click();
  await olive.waitForSelector('.meeting-action:has-text("Print the site maps")');
  await alex.waitForSelector('.meeting-action:has-text("Print the site maps")', { timeout: 6000 });
  out(`Alex saw the action item live: ${Date.now() - t0} ms`);
  expect('The action item shows for Olive and live for Alex, with who and when', (await alex.locator('.meeting-action', { hasText: 'Print the site maps' }).innerText()).includes('Pat Public'));
  await olive.fill('#action-new', 'Order more wristbands'); await olive.selectOption('#action-new-who', { label: 'Olive Organizer (you)' });
  await olive.getByRole('button', { name: 'Add action item' }).click();
  await olive.waitForSelector('.meeting-action:has-text("Order more wristbands")');
  expect('The form keeps the person for the next item and clears the rest', await olive.inputValue('#action-new') === '');

  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-meetings-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-meetings-alex-dark.png` });

  // The action items are real tasks in the list.
  await alex.getByRole('button', { name: /^Open the list/ }).click();
  await alex.waitForSelector('#tab-tasks[aria-selected="true"]');
  await alex.waitForFunction(() => document.querySelector('#title-tasklist')?.value === 'Festival actions');
  await alex.waitForSelector('.task');
  const tasks = await alex.locator('.task input.task-title').evaluateAll((els) => els.map((e) => e.value));
  expect('Open the list: both action items are tasks in Festival actions', tasks.includes('Print the site maps') && tasks.includes('Order more wristbands'), tasks.join(', '));

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const names = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival meeting, not the Organizers one', names.includes('Volunteer briefing notes') && !names.includes('Budget review'), names.join(', '));
  expect('Pat cannot make a meeting in #festival', !(await pat.locator('#new-meeting option').allInnerTexts()).includes('#festival'));
  await pick(pat, 'Volunteer briefing notes');
  expect('Pat: no text boxes, pickers, action item form, Remove, Move or Delete',
    await pat.locator('.meeting textarea, #meeting-event:is(select), #meeting-list:is(select), form[aria-label="Add an action item"]').count() === 0
    && await pat.locator('.meeting-action').getByRole('button', { name: /^Remove/ }).count() === 0
    && await pat.locator('#move-meeting').count() === 0 && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0);
  expect('Pat: the title is read-only and the hint says why', await pat.locator('#title-meeting[readonly]').count() === 1
    && (await pat.locator('.meeting > .docs-hint').first().innerText()).includes('make you an editor'));
  const read = await pat.locator('.meeting-read').allInnerTexts();
  expect('Pat reads the agenda, notes and decisions', read.length === 3 && read[0].includes('First aid tent') && read[2] === 'Gates open at 9:30', read.join(' | '));
  expect('Pat can tick off only the action item assigned to her',
    await pat.locator('.meeting-action:has-text("Print the site maps") input[type="checkbox"]:not([disabled])').count() === 1
    && await pat.locator('.meeting-action:has-text("Order more wristbands") input[type="checkbox"][disabled]').count() === 1);
  t0 = Date.now();
  await pat.locator('.meeting-action:has-text("Print the site maps") input[type="checkbox"]').check();
  await olive.waitForSelector('.meeting-action.is-done:has-text("Print the site maps")', { timeout: 6000 });
  out(`Olive saw Pat tick it off live: ${Date.now() - t0} ms`);
  expect('Pat ticks it off; Olive sees it done live', true);
  await pat.waitForSelector('.meeting-action.is-done:has-text("Print the site maps")');
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-meetings-pat-viewer.png` });

  // From the meeting to the event, and from the event back to the notes.
  await pat.getByRole('button', { name: /^Open in Calendar/ }).click();
  await pat.waitForSelector('.cal-detail', { timeout: 8000 });
  await pat.waitForSelector('.cal-detail .cal-notes', { timeout: 6000 });
  expect('Calendar: the event shows its meeting notes, and Pat cannot start new ones', (await pat.locator('.cal-detail .cal-notes').innerText()) === 'Meeting notes: Volunteer briefing notes'
    && await pat.getByRole('button', { name: 'Start meeting notes' }).count() === 0);
  await pat.locator('.cal-detail .cal-notes').click();
  await pat.waitForSelector('#tab-meetings[aria-selected="true"]');
  await pat.waitForFunction(() => document.querySelector('#title-meeting')?.value === 'Volunteer briefing notes');
  expect('Calendar: the button opens the meeting', true);

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Recent meetings' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Recent meetings"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: lists both of Olive\'s meetings, the one with an event date first', rows[0] === 'Volunteer briefing notes' && rows.includes('Budget review'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Budget review' }).click();
  await olive.waitForSelector('#tab-meetings[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-meeting')?.value === 'Budget review');
  expect('Widget: a row opens the meeting', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
