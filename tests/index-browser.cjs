// Index the rest in real browsers, on the test stack (tests/run.sh --keep). Olive, through the apps' API as
// herself, posts things about parking in nine apps: an announcement, an event she answers, a thing to book with
// a booking, a shift she signs up for, a milestone and a kudos for Pat in #festival; an announcement and her
// time off in #organizers; a journal page; and her profile. Then:
//   - Olive types "parking" in the search box and sees each app as its own group, journal included; Enter on a
//     result opens the right app (her journal on that day, the kudos wall of #festival);
//   - Alex (dark mode) finds a kudos the moment Olive gives it (no waiting for an index), sees the
//     #organizers rows, and never Olive's journal;
//   - Pat (viewer in #festival only) finds the #festival rows and Olive's profile, never the #organizers rows
//     or the journal, and an announcement result opens the read-only announcements of #festival.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node index-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const pad = (n) => String(n).padStart(2, '0');
const isoIn = (days, hours = 10) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + days); x.setUTCHours(hours, 0, 0, 0); return x.toISOString(); };
const today = () => { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };

  // ---- the data, made through the API as the people the apps allow
  const login = async (email) => {
    const r = await fetch(`${BASE}auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify({ email }) });
    if (!r.ok) throw new Error(`test login ${email}: ${r.status}`);
    return r.json();
  };
  const api = async (who, path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`${BASE}api${path}`, { method, headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
    const t = await r.text(); const d = t ? JSON.parse(t) : null;
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 200)}`);
    return d;
  };
  const O = await login('olive.organizer@example.com');
  const P = await login('pat.public@example.com');
  const spaces = Object.fromEntries((await api(O, '/spaces?kind=eq.channel&select=id,name')).map((s) => [s.name, s.id]));
  const fest = spaces.festival; const org = spaces.organizers;
  await api(O, '/announcements', { space_id: fest, title: 'Parking moves to lot B', body: 'Volunteers park behind the school from Friday.' });
  await api(O, '/announcements', { space_id: org, title: 'Parking budget approved', body: 'The board agreed the extra marshals.' });
  const [ev] = await api(O, '/events', { space_id: fest, title: 'Parking crew dinner', starts_at: isoIn(5, 18), ends_at: isoIn(5, 20) });
  await api(O, '/rsvps', { event_id: ev.id, answer: 'going' });
  const [cones] = await api(O, '/resources', { space_id: fest, name: 'Parking cones', note: 'Forty cones in the shed' });
  await api(O, '/bookings', { resource_id: cones.id, starts_at: isoIn(6, 7), ends_at: isoIn(6, 19), note: 'Lot B on Saturday' });
  const [shift] = await api(O, '/shifts', { space_id: fest, title: 'Parking shift', starts_at: isoIn(6, 8), ends_at: isoIn(6, 12), places: 4, note: 'Hi-vis vests at the gate' });
  await api(O, '/shift_signups', { shift_id: shift.id });
  await api(O, '/milestones', { space_id: fest, title: 'Parking permits arrive', day: isoIn(12).slice(0, 10), note: 'From the city office' });
  await api(O, '/kudos', { space_id: fest, to_user: P.user.id, message: 'Thank you for running parking all weekend!' });
  await api(O, '/time_off', { space_id: org, user_id: O.user.id, starts_on: isoIn(20).slice(0, 10), ends_on: isoIn(24).slice(0, 10), note: 'At the parking conference' });
  const day = today();
  const old = await api(O, `/journal_entries?day=eq.${day}&select=id`);
  if (old.length) await api(O, `/journal_entries?id=eq.${old[0].id}`, undefined, 'DELETE');
  await api(O, '/journal_entries', { day, body: 'Long day. The parking plan finally works, and nobody shouted.' });
  await fetch(`${BASE}api/profiles?on_conflict=user_id`, { method: 'POST', headers: { Authorization: `Bearer ${O.token}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ role: 'Parking marshal', skills: ['first aid', 'traffic control'], reach: 'Message me in Weft', availability: 'Weekends' }) });

  // ---- browsers
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const search = async (p, q, waitFor) => {
    await p.locator('.search input').fill('');
    await p.locator('.search input').fill(q);
    if (waitFor) await p.waitForSelector(`.search-group:text-is("${waitFor}")`, { timeout: 8000 });
    await p.waitForTimeout(900);   // let the meaning results (if any) settle
    return p.locator('.search-group').allInnerTexts();
  };
  // For the screenshots: the results scrolled to the first app group, the pointer off the list.
  const showApps = async (p) => {
    await p.mouse.move(5, 880);
    await p.locator('.search-list > li', { has: p.locator('.search-group:text-is("Announcements")') }).evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(300);
  };
  const titles = (p) => p.locator('.search-row .search-title').allInnerTexts();
  const pick = async (p, group, title) => {
    await p.locator('.search-list > li', { has: p.locator(`.search-group:text-is("${group}")`) }).locator('.search-row', { hasText: title }).first().dispatchEvent('mousedown');
  };

  const olive = await open('Olive Organizer');
  const og = await search(olive, 'parking', 'Your journal');
  const want = ['Announcements', 'RSVPs', 'Bookings', 'Shifts', 'Time off', 'Kudos', 'Timeline', 'Profiles', 'Your journal'];
  expect('Olive: "parking" finds all nine apps, each as its own group', want.every((g) => og.includes(g)), og.join(', '));
  const ot = await titles(olive);
  expect('Olive: both announcements (hers in #festival and #organizers), her shift, cones, milestone and profile are listed',
    ['Parking moves to lot B', 'Parking budget approved', 'Parking shift', 'Parking cones', 'Parking permits arrive', 'Answers to Parking crew dinner', 'Olive Organizer away', 'Kudos for Pat Public'].every((t) => ot.some((x) => x.includes(t))), ot.join(' | '));
  const jrow = olive.locator('.search-list > li', { has: olive.locator('.search-group:text-is("Your journal")') }).locator('.search-row').first();
  expect('Olive: her journal page says "Only you" and shows the matching words highlighted',
    (await jrow.locator('.search-meta').innerText()).startsWith('Only you') && (await jrow.locator('.search-snippet mark').allInnerTexts()).some((m) => /parking/i.test(m)), await jrow.innerText());
  const shiftRow = olive.locator('.search-row', { hasText: 'Parking shift' }).first();
  expect('Olive: a shift result shows its channel and who signed up', (await shiftRow.innerText()).includes('#festival'), await shiftRow.innerText());
  await showApps(olive);
  await olive.screenshot({ path: `${SHOTS}/1-index-olive-search-light.png` });
  await pick(olive, 'Your journal', 'Journal page');
  await olive.waitForSelector('#tab-journal[aria-selected="true"]');
  await olive.waitForFunction(() => /parking plan finally works/.test(document.querySelector('#journal-text')?.value || ''), null, { timeout: 6000 });
  expect('Olive: the journal result opens Journal on that day\'s page', true);
  await search(olive, 'parking weekend', 'Kudos');
  await pick(olive, 'Kudos', 'Kudos for Pat');
  await olive.waitForSelector('#tab-kudos[aria-selected="true"]');
  await olive.waitForSelector('.kudos-head:text-is("#festival")');
  expect('Olive: a kudos result opens the kudos wall of its channel', (await olive.locator('.kudos-wall').innerText()).includes('running parking'));

  // Alex in dark mode: a new kudos is found at once; Organizers rows yes; Olive's journal never.
  const alex = await open('Alex (test admin)', true);
  await api(O, '/kudos', { space_id: org, to_user: (await api(O, '/users?display_name=like.Alex*&select=id'))[0].id, message: 'Thanks for the parking signs, they look great' });
  const ag = await search(alex, 'parking signs', 'Kudos');
  expect('Alex: a kudos Olive just gave is found straight away (no index to wait for)', (await titles(alex)).some((t) => t.startsWith('Kudos for Alex')), (await titles(alex)).join(' | '));
  await search(alex, 'parking', 'Announcements');
  const at = await titles(alex);
  const agroups = await alex.locator('.search-group').allInnerTexts();
  expect('Alex (owner of #organizers): sees the Organizers announcement and Olive\'s time off', at.includes('Parking budget approved') && at.includes('Olive Organizer away'), at.join(' | '));
  expect('Alex (admin): never Olive\'s journal', !agroups.includes('Your journal') && !(await alex.locator('.search-panel').innerText()).includes('nobody shouted'), agroups.join(', '));
  void ag;
  await showApps(alex);
  await alex.screenshot({ path: `${SHOTS}/2-index-alex-search-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const pg = await search(pat, 'parking', 'Announcements');
  const pt = await titles(pat);
  expect('Pat: finds the #festival announcement, shift, cones, milestone, answers and kudos', ['Parking moves to lot B', 'Parking shift', 'Parking cones', 'Parking permits arrive', 'Answers to Parking crew dinner', 'Kudos for Pat Public'].every((t) => pt.includes(t)), pt.join(' | '));
  expect('Pat: and Olive\'s profile (they share #festival)', pt.includes('Olive Organizer') && pg.includes('Profiles'), pt.join(' | '));
  const ppanel = await pat.locator('.search-panel').innerText();
  expect('Pat: never the Organizers announcement, Olive\'s time off, Olive\'s journal or anything in #organizers',
    !pt.includes('Parking budget approved') && !pt.some((t) => t.includes('away')) && !pg.includes('Your journal') && !pg.includes('Time off')
    && !/#organizers|nobody shouted|parking conference/.test(ppanel), pt.join(' | '));
  await showApps(pat);
  await pat.screenshot({ path: `${SHOTS}/3-index-pat-viewer.png` });
  await pick(pat, 'Announcements', 'Parking moves to lot B');
  await pat.waitForSelector('#tab-announcements[aria-selected="true"]');
  await pat.waitForSelector('.notice-head:text-is("#festival")');
  expect('Pat: the announcement result opens #festival announcements, view only', (await pat.locator('.docs-meta').innerText()).includes('View only')
    && await pat.getByRole('button', { name: 'New announcement' }).count() === 0);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
