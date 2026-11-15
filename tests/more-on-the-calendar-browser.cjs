// More on the Calendar in real browsers, on the test stack (tests/run.sh --keep). Olive, through the API as
// herself, adds milestones tomorrow in #festival and #organizers and two shifts she signs up for (one in each),
// Pat signs up for the #festival one, and a #festival "Bar" shift has nobody on it. Then:
//   - Olive (light) sees both milestones as all-day entries and both her shifts at their times, never "Bar";
//   - Alex (dark, owner) sees both milestones and no shifts; a new milestone and his own sign-up for "Bar"
//     arrive live;
//   - Olive switches Milestones off: they go, and stay off after a reload (saved per person), then back on;
//     a milestone opens Timeline and a shift opens Shifts;
//   - Pat (viewer in #festival only) sees the #festival milestone and her shift, never the #organizers ones.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node more-on-the-calendar-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const pad = (n) => String(n).padStart(2, '0');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };

  // ---- the data, made through the API as the people the apps allow
  const login = async (email) => {
    const r = await fetch(`${BASE}auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify({ email }) });
    if (!r.ok) throw new Error(`test login ${email}: ${r.status}`);
    return r.json();
  };
  const api = async (who, path, body, method = body ? 'POST' : 'GET', prefer = 'return=representation') => {
    const r = await fetch(`${BASE}api${path}`, { method, headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body && JSON.stringify(body) });
    const t = await r.text(); const d = t ? JSON.parse(t) : null;
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 200)}`);
    return d;
  };
  const O = await login('olive.organizer@example.com');
  const P = await login('pat.public@example.com');
  const A = await login('alex.admin@example.com');
  const resetSwitches = (who) => api(who, '/user_prefs?on_conflict=user_id', { calendar: {} }, 'POST', 'resolution=merge-duplicates,return=minimal');
  for (const who of [O, P, A]) await resetSwitches(who);
  const spaces = Object.fromEntries((await api(O, '/spaces?kind=eq.channel&select=id,name')).map((s) => [s.name, s.id]));
  const fest = spaces.festival; const org = spaces.organizers;
  // Leftovers from an earlier run.
  for (const t of ['Stage build done', 'Budget sign-off', 'Fireworks test']) await api(O, `/milestones?title=eq.${encodeURIComponent(t)}`, undefined, 'DELETE');
  for (const t of ['Gate crew', 'Cash count', 'Bar (late)']) await api(O, `/shifts?title=eq.${encodeURIComponent(t)}`, undefined, 'DELETE');
  const D = new Date(); D.setDate(D.getDate() + 1); D.setHours(0, 0, 0, 0);
  const day = `${D.getFullYear()}-${pad(D.getMonth() + 1)}-${pad(D.getDate())}`;
  const at = (h) => { const x = new Date(D); x.setHours(h); return x.toISOString(); };
  const made = [];
  made.push(['milestones', (await api(O, '/milestones', { space_id: fest, title: 'Stage build done', day }))[0].id]);
  made.push(['milestones', (await api(O, '/milestones', { space_id: org, title: 'Budget sign-off', day }))[0].id]);
  const [gate] = await api(O, '/shifts', { space_id: fest, title: 'Gate crew', starts_at: at(10), ends_at: at(12), places: 4 });
  const [cash] = await api(O, '/shifts', { space_id: org, title: 'Cash count', starts_at: at(14), ends_at: at(16), places: 2 });
  const [bar] = await api(O, '/shifts', { space_id: fest, title: 'Bar (late)', starts_at: at(17), ends_at: at(19), places: 2 });
  made.push(['shifts', gate.id], ['shifts', cash.id], ['shifts', bar.id]);
  await api(O, '/shift_signups', { shift_id: gate.id });
  await api(O, '/shift_signups', { shift_id: cash.id });
  await api(P, '/shift_signups', { shift_id: gate.id });

  // ---- browsers
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  // Open the Calendar on the week with tomorrow in it (the Calendar's weeks run Sunday to Saturday, so on a Saturday that is next week).
  const openCal = async (p) => {
    await p.locator('.app:has-text("Calendar")').click();
    await p.waitForSelector('.cal-main [role="columnheader"]');
    await toWeek(p);
  };
  const toWeek = async (p) => {
    const btn = (name) => p.locator('.cal-main').getByRole('button', { name, exact: true });
    if (await btn('This Week').isEnabled()) await btn('This Week').click();
    if (new Date().getDay() === 6) await btn('Next Week').click();
    await p.waitForTimeout(800);
  };
  const entries = (p) => p.locator('.cal-main [class*="ev-t"]').allInnerTexts().then((a) => a.join(' | '));
  const has = (p, text) => p.locator('.cal-main [class*="ev-t"]', { hasText: text }).count().then((n) => n > 0);

  const olive = await open('Olive Organizer');
  await openCal(olive);
  await olive.locator('.cal-main .cal-milestone', { hasText: 'Stage build done' }).first().waitFor({ timeout: 8000 });
  let all = await entries(olive);
  // All-day entries sit above the hours; a 10:00 shift sits lower, and one at 14:00 lower still.
  const top = async (text) => (await olive.locator('.cal-main [class*="ev-t"]', { hasText: text }).first().boundingBox())?.y ?? -1;
  const [yMs, yGate, yCash] = [await top('Stage build done'), await top('Gate crew'), await top('Cash count')];
  expect('Olive sees both milestones as all-day entries', await has(olive, 'Milestone: Stage build done') && await has(olive, 'Milestone: Budget sign-off') && yMs >= 0 && yMs < yGate, all);
  expect('Olive sees her two shifts at their times', await has(olive, 'Shift: Gate crew') && await has(olive, 'Shift: Cash count') && yGate < yCash, `${all} ${yMs} ${yGate} ${yCash}`);
  expect('Olive does not see a shift she is not on', !(await has(olive, 'Bar (late)')), all);
  expect('The switches are all on, Milestones and Your shifts among them', await olive.locator('.cal-kinds input:checked').count() === 5
    && await olive.locator('label.cal-milestones input').isChecked() && await olive.locator('label.cal-shifts input').isChecked());

  const alex = await open('Alex (test admin)', true);
  await openCal(alex);
  await alex.locator('.cal-main .cal-milestone', { hasText: 'Budget sign-off' }).first().waitFor({ timeout: 8000 });
  all = await entries(alex);
  expect('Alex (owner) sees both milestones and none of the shifts he is not on', await has(alex, 'Stage build done') && !(await has(alex, 'Shift: Gate crew')) && !(await has(alex, 'Shift: Cash count')), all);
  made.push(['milestones', (await api(O, '/milestones', { space_id: fest, title: 'Fireworks test', day }))[0].id]);
  await alex.locator('.cal-main .cal-milestone', { hasText: 'Fireworks test' }).first().waitFor({ timeout: 8000 });
  expect('A new milestone arrives live in Alex\'s Calendar', true);
  await api(A, '/shift_signups', { shift_id: bar.id });
  await alex.locator('.cal-main .cal-shift', { hasText: 'Bar (late)' }).first().waitFor({ timeout: 8000 });
  expect('Signing up for a shift puts it on Alex\'s Calendar live', true);
  await olive.waitForTimeout(500);
  expect('...and not on Olive\'s, who is not on it', !(await has(olive, 'Bar (late)')));

  await olive.screenshot({ path: `${SHOTS}/1-calendar-olive-light.png` });
  await alex.screenshot({ path: `${SHOTS}/2-calendar-alex-dark.png` });

  // Switching a kind off is remembered.
  await olive.locator('label.cal-milestones input').uncheck();
  await olive.waitForTimeout(500);
  expect('Olive switches Milestones off and they go', !(await has(olive, 'Milestone:')) && await has(olive, 'Shift: Gate crew'));
  await olive.reload({ waitUntil: 'networkidle' }); await olive.getByRole('button', { name: 'Olive Organizer' }).click(); await olive.waitForSelector('.rail-title');
  if (!(await olive.locator('.cal-main [role="columnheader"]').count())) await openCal(olive);
  else { await olive.waitForTimeout(800); await toWeek(olive); }
  await olive.locator('.cal-main .cal-shift', { hasText: 'Gate crew' }).first().waitFor({ timeout: 8000 });
  await olive.waitForTimeout(500);
  expect('After a reload Milestones are still off for Olive', !(await olive.locator('label.cal-milestones input').isChecked()) && !(await has(olive, 'Milestone:')));
  await alex.waitForTimeout(300);
  expect('...and still on for Alex', await alex.locator('label.cal-milestones input').isChecked() && await has(alex, 'Milestone: Stage build done'));
  await olive.locator('label.cal-milestones input').check();
  await olive.locator('.cal-main .cal-milestone', { hasText: 'Stage build done' }).first().waitFor({ timeout: 8000 });
  expect('Olive switches them back on', true);

  // Clicking through.
  await olive.locator('.cal-main .cal-milestone', { hasText: 'Stage build done' }).first().click();
  await olive.waitForSelector('#tab-timeline[aria-selected="true"]');
  expect('A milestone opens Timeline', true);
  await olive.locator('#tab-calendar').click();
  await olive.locator('.cal-main .cal-shift', { hasText: 'Gate crew' }).first().click();
  await olive.waitForSelector('#tab-shifts[aria-selected="true"]');
  expect('A shift opens Shifts', true);

  // Pat, a viewer in #festival only.
  const pat = await open('Pat Public');
  await openCal(pat);
  await pat.locator('.cal-main .cal-milestone', { hasText: 'Stage build done' }).first().waitFor({ timeout: 8000 });
  all = await entries(pat);
  expect('Pat sees the #festival milestones and her shift', await has(pat, 'Milestone: Fireworks test') && await has(pat, 'Shift: Gate crew'), all);
  expect('Pat never sees the #organizers milestone or shift, nor a shift she is not on', !(await has(pat, 'Budget sign-off')) && !(await has(pat, 'Cash count')) && !(await has(pat, 'Bar (late)')), all);
  await pat.locator('.cal-main .cal-milestone', { hasText: 'Stage build done' }).first().hover();
  await pat.screenshot({ path: `${SHOTS}/3-calendar-pat-viewer.png` });

  // Clean up.
  for (const [t, id] of made) await api(O, `/${t}?id=eq.${id}`, undefined, 'DELETE');
  for (const who of [O, P, A]) await resetSwitches(who);
  expect('No page errors', errs.length === 0, errs.join(' / '));
  await b.close();
  out(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
