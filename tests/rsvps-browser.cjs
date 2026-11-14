// RSVPs in real browsers, on the test stack (tests/run.sh --keep): Olive answers Going and Maybe on
// upcoming events in the RSVPs app; Alex (dark mode) sees her answers arrive live, with her name, and
// answers too; pressing an answer again clears it; the filters count and narrow the list; the same box
// shows on the event in Calendar, and an answer given there shows in the app live; Pat (viewer in #festival
// only) sees only #festival events, answers for herself, and has no way to change anyone else's answer or
// the event; Olive's Home widget lists her upcoming yeses and a row opens the event in Calendar.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node rsvps-browser.cjs
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
    return p;
  };
  const openApp = async (p) => { await p.locator('.app:has-text("RSVPs")').click(); await p.waitForSelector('.rsvp-card'); };
  const card = (p, title) => p.locator('.rsvp-card', { has: p.locator('.rsvp-title', { hasText: title }) }).first();
  const btn = (p, title, label) => card(p, title).getByRole('button', { name: new RegExp(`^${label}`) });
  const pressed = async (p, title) => (await card(p, title).locator('.rsvp-btn[aria-pressed="true"]').allInnerTexts()).map((t) => t.replace(/\d+$/, '').trim());
  const sum = (p, title) => card(p, title).locator('.rsvp-sum').innerText();
  const waitSum = (p, title, text) => p.waitForFunction(([t, s]) => [...document.querySelectorAll('.rsvp-card')]
    .some((c) => c.querySelector('.rsvp-title')?.textContent === t && c.querySelector('.rsvp-sum')?.textContent === s), [title, text], { timeout: 6000 });
  // Set an answer (or clear it with null) and wait for the database's answer to be on screen.
  const answer = async (p, title, label) => {
    const now = await pressed(p, title);
    if (label === null) { if (now.length) await btn(p, title, now[0]).click(); }
    else if (now[0] !== label) await btn(p, title, label).click();
    await p.waitForFunction(([t, l]) => {
      const c = [...document.querySelectorAll('.rsvp-card')].find((x) => x.querySelector('.rsvp-title')?.textContent === t);
      const on = c && [...c.querySelectorAll('.rsvp-btn[aria-pressed="true"]')].map((x) => x.firstChild.textContent);
      return on && (l === null ? on.length === 0 : on.length === 1 && on[0] === l);
    }, [title, label], { timeout: 6000 });
    await p.waitForTimeout(250);
  };
  const filter = async (p, label) => { await p.locator('.rsvp-filter', { hasText: label }).click(); await p.waitForSelector(`.rsvp-head:text-is("${label === 'All upcoming' ? 'Upcoming events' : label}")`); };
  const filterCount = async (p, label) => Number(await p.locator('.rsvp-filter', { hasText: label }).locator('.convo-count').innerText());

  const olive = await open('Olive Organizer');
  await openApp(olive);
  const titles = await olive.locator('.rsvp-title').allInnerTexts();
  const spaces = await olive.locator('.rsvp-card .link-by').allInnerTexts();
  const fest = titles.filter((t, i) => spaces[i] === '#festival');
  const vol = titles.find((t, i) => spaces[i] === '#volunteers');
  const [A, B, C] = fest;
  out(`events: ${titles.length}; using "${A}", "${B}", "${C}" (#festival) and "${vol}" (#volunteers)`);
  expect('Olive sees upcoming events from #festival and #volunteers', fest.length >= 3 && !!vol, `${titles.length} ${spaces.slice(0, 5)}`);
  for (const t of [A, B, C, vol]) await answer(olive, t, null);   // a clean start if the check ran before

  const pat = await open('Pat Public');   // Pat (viewer in #festival only): opened early to start clean
  await openApp(pat);
  await answer(pat, A, null);
  const alex = await open('Alex (test admin)', true);
  await openApp(alex);
  for (const t of [A, B, C]) await answer(alex, t, null);
  const t0 = Date.now();
  await answer(olive, A, 'Going');
  await waitSum(alex, A, '1 going');
  out(`Alex saw Olive's answer live: ${Date.now() - t0} ms`);
  expect('Alex sees Olive named under Going, live', (await card(alex, A).locator('.rsvp-who').innerText()) === 'Going: Olive Organizer');
  expect('Olive sees herself as You', (await card(olive, A).locator('.rsvp-who').innerText()) === 'Going: You');
  await answer(alex, A, 'Going');
  await waitSum(olive, A, '2 going');
  expect('Olive sees Alex join live; the count on Going says 2', (await btn(olive, A, 'Going').locator('.rsvp-n').innerText()) === '2'
    && (await card(olive, A).locator('.rsvp-who').innerText()) === 'Going: You, Alex (test admin)', await card(olive, A).locator('.rsvp-who').innerText());
  await answer(olive, B, 'Maybe');
  await answer(alex, B, 'Not going');
  await waitSum(olive, B, '1 maybe, 1 not going');
  expect('Maybe and Not going are counted and named apart', (await card(olive, B).locator('.rsvp-who').allInnerTexts()).join('|') === 'Maybe: You|Not going: Alex (test admin)');
  await answer(olive, vol, 'Going');
  // Change, then clear by pressing again.
  await answer(olive, C, 'Going');
  await answer(olive, C, 'Maybe');
  await waitSum(alex, C, '1 maybe');
  await answer(olive, C, null);
  await waitSum(alex, C, 'No answers yet');
  expect('Changing an answer moves it, and pressing it again clears it, live for Alex', (await pressed(olive, C)).length === 0);

  // Filters.
  expect('The filters count: Going 2, Maybe 1', await filterCount(olive, 'Going') === 2 && await filterCount(olive, 'Maybe') === 1);
  await filter(olive, 'Going');
  const goingTitles = await olive.locator('.rsvp-title').allInnerTexts();
  expect('Going shows only the events Olive is going to', goingTitles.length === 2 && goingTitles.includes(A) && goingTitles.includes(vol), goingTitles.join(', '));
  await filter(olive, 'Not answered');
  expect('Not answered hides them', !(await olive.locator('.rsvp-title').allInnerTexts()).some((t) => [A, B, vol].includes(t)));
  await filter(olive, 'All upcoming');
  await card(olive, A).scrollIntoViewIfNeeded();
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-rsvps-olive-light.png` });

  // The same answers on the event in Calendar; an answer given there shows in the app live.
  await card(alex, B).locator('.rsvp-title').click();
  await alex.waitForSelector('#tab-calendar[aria-selected="true"]');
  await alex.waitForSelector('.cal-detail .rsvp-event');
  expect('Calendar: the event shows its answers', (await alex.locator('.cal-detail h3').innerText()) === B
    && (await alex.locator('.cal-detail .rsvp-sum').innerText()) === '1 maybe, 1 not going', await alex.locator('.cal-detail .rsvp-sum').innerText());
  const day = await alex.evaluate(() => document.querySelector('.cal-detail .cal-when')?.textContent.match(/^(\w+), \w+ (\d+)/)?.slice(1).join(' '));
  const heads = await alex.locator('.fc-col-header-cell, [role="columnheader"]').allInnerTexts();
  expect('Calendar: it opens on the event\'s week', !!day && heads.some((h) => h.replace(/\s+/g, ' ').trim().endsWith(day)), `${day} in ${heads.join(', ')}`);
  await alex.locator('.cal-detail').getByRole('button', { name: /^Going/ }).click();
  await alex.waitForFunction(() => document.querySelector('.cal-detail .rsvp-sum')?.textContent === '1 going, 1 maybe');
  await waitSum(olive, B, '1 going, 1 maybe');
  expect('Calendar: Alex switches to Going there, and Olive sees it in RSVPs live', (await card(olive, B).locator('.rsvp-who').allInnerTexts()).join('|') === 'Going: Alex (test admin)|Maybe: You');
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-rsvps-calendar-alex-dark.png` });

  // Pat (viewer in #festival only).
  await pat.locator('#tab-home').click(); await openApp(pat);
  const patSpaces = new Set(await pat.locator('.rsvp-card .link-by').allInnerTexts());
  expect('Pat sees #festival events only', patSpaces.size === 1 && patSpaces.has('#festival'), [...patSpaces].join(', '));
  expect('Pat sees who is coming', (await card(pat, A).locator('.rsvp-who').innerText()) === 'Going: Olive Organizer, Alex (test admin)'
    || (await card(pat, A).locator('.rsvp-who').innerText()) === 'Going: Alex (test admin), Olive Organizer');
  await answer(pat, A, 'Going');
  await waitSum(olive, A, '3 going');
  expect('Pat (viewer) answers Going for herself, and Olive sees it live', (await card(olive, A).locator('.rsvp-who').innerText()).includes('Pat Public'));
  expect('Pat has only her own three answer buttons on each card, no way to change the event', await card(pat, A).getByRole('button').count() === 4   // title + 3 answers
    && await pat.getByRole('button', { name: /Delete|Edit/ }).count() === 0);
  await card(pat, A).scrollIntoViewIfNeeded();
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-rsvps-pat-viewer.png` });

  // Home widget (on by default; turned on if this person saved a layout before it existed).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  let w = olive.locator('.widget:has(h3:text-is("Your upcoming yeses"))');
  if (!(await w.count())) {
    await olive.getByRole('button', { name: 'Customize' }).click();
    await olive.locator('.widget-picker label', { hasText: 'Your upcoming yeses' }).locator('input').check();
    await olive.getByRole('button', { name: 'Done', exact: true }).click();
    w = olive.locator('.widget:has(h3:text-is("Your upcoming yeses"))');
  }
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  expect('Widget: Olive\'s yeses are the two events she said Going to, soonest first', rows.length === 2 && rows.includes(A) && rows.includes(vol) && !rows.includes(B), rows.join(', '));
  await w.locator('.widget-row', { hasText: A }).click();
  await olive.waitForSelector('#tab-calendar[aria-selected="true"]');
  await olive.waitForSelector('.cal-detail .rsvp-event');
  expect('Widget: a row opens the event in Calendar, with her answer pressed', (await olive.locator('.cal-detail h3').innerText()) === A
    && (await olive.locator('.cal-detail .rsvp-btn[aria-pressed="true"]').innerText()).startsWith('Going'));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
