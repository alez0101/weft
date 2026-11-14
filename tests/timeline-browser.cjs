// Timeline in real browsers, on the test stack (tests/run.sh --keep): Olive adds milestones in #festival
// (two past, one today, two ahead) and one in #organizers; the line is in date order with the today marker
// between past and coming milestones, past ones greyed; Alex (dark mode) sees a new milestone and a date
// change arrive live and in the right place; Alex (owner) deletes one and it goes for Olive live; a refused
// write shows the database's answer; Pat (viewer in #festival only) reads the #festival timeline with no
// way to add, change or delete; the Home widget "Next milestones" lists coming milestones from the person's
// channels only and a row opens that channel's timeline.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node timeline-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const x = new Date(); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() + offset); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
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
  const openApp = async (p) => { await p.locator('.app:has-text("Timeline")').click(); await p.waitForSelector('.docs-list[aria-label="Channels"]'); };
  const channel = async (p, name) => {
    await p.locator('.docs-list .doc-link', { hasText: `#${name}` }).click();
    await p.waitForSelector(`.tl-head:has-text("#${name}")`);
    await p.waitForSelector('.tl-track, .tl-empty');
  };
  // The line, left to right: milestone titles, with TODAY where the marker is.
  const line = (p) => p.locator('.tl-track > li').evaluateAll((els) => els.map((e) => (e.classList.contains('tl-today') ? 'TODAY' : e.querySelector('.tl-title')?.textContent || '(editing)')));
  const stop = (p, title) => p.locator('.tl-stop', { has: p.locator('.tl-title', { hasText: title }) });
  // Whether an element is inside the visible part of the sideways-scrolling timeline.
  const inView = (p, sel) => p.locator(sel).evaluate((t) => { const s = t.closest('.tl-scroll'); return t.offsetLeft + t.offsetWidth > s.scrollLeft && t.offsetLeft < s.scrollLeft + s.clientWidth; });
  const add = async (p, title, d, note = '', wait = true) => {
    await p.fill('#tl-new-title', title);
    await p.fill('#tl-new-day', d);
    await p.fill('#tl-new-note', note);
    await p.locator('form[aria-label="Add a milestone"]').getByRole('button', { name: 'Add milestone' }).click();
    if (wait) await p.waitForSelector(`.tl-title:text-is("${title}")`);
  };

  const olive = await open('Olive Organizer');
  await openApp(olive);
  await channel(olive, 'organizers');
  expect('An empty timeline says so', (await olive.locator('.tl-empty').innerText()).includes('No milestones yet'));
  await add(olive, 'Budget signed off', day(20), 'The board meets in the town hall.');
  await channel(olive, 'festival');
  await add(olive, 'Gates open', day(45), 'Ten in the morning, Gate B first.');
  await add(olive, 'Site visit', day(-30));
  await add(olive, 'Volunteer briefing', day(0));
  await add(olive, 'Line-up announced', day(-6), 'Posted on the noticeboard and in #festival.');
  await add(olive, 'Stage build', day(40));
  expect('The line is in date order, with today between past and coming milestones',
    (await line(olive)).join('|') === 'Site visit|Line-up announced|TODAY|Volunteer briefing|Stage build|Gates open', (await line(olive)).join('|'));
  expect('Past milestones are greyed (marked past), coming ones are not', await stop(olive, 'Site visit').evaluate((e) => e.classList.contains('is-past'))
    && await stop(olive, 'Line-up announced').evaluate((e) => e.classList.contains('is-past'))
    && !(await stop(olive, 'Gates open').evaluate((e) => e.classList.contains('is-past'))));
  const greyed = await olive.evaluate(() => {
    const t = (s) => getComputedStyle(document.querySelector(s)).color;
    return t('.tl-stop.is-past .tl-title') !== t('.tl-stop.is-future .tl-title');
  });
  expect('Past titles are drawn in a different (muted) colour', greyed);
  expect('A milestone today is marked today', await stop(olive, 'Volunteer briefing').evaluate((e) => e.classList.contains('is-today'))
    && (await stop(olive, 'Volunteer briefing').locator('.tl-when').innerText()) === 'today');
  expect('Each milestone says how far away it is', (await stop(olive, 'Line-up announced').locator('.tl-when').innerText()).includes('6 days ago')
    && (await stop(olive, 'Gates open').locator('.tl-when').innerText()).startsWith('in '));
  expect('The header counts milestones and names the next one', (await olive.locator('.docs-meta').innerText()).includes('5 milestones, 2 past')
    && (await olive.locator('.tl-next').innerText()).startsWith('Next: Volunteer briefing'), await olive.locator('.docs-meta').innerText());

  // A refused write shows the database's answer (the request is changed on its way out to a date the
  // database does not accept, as a stale or tampered screen could send).
  await olive.route('**/milestones?*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    await route.continue({ postData: JSON.stringify({ ...JSON.parse(req.postData()), day: '2999-01-01' }) });
  });
  await add(olive, 'This should not arrive', day(3), '', false);
  await olive.waitForSelector('.tl-wrap .send-error');
  expect('A refused milestone is not shown, and the database\'s answer is', (await olive.locator('.tl-wrap .send-error').innerText()).startsWith('Not added')
    && !(await line(olive)).includes('This should not arrive'), await olive.locator('.tl-wrap .send-error').innerText());
  await olive.unroute('**/milestones?*');
  await olive.fill('#tl-new-title', '');

  // Alex watches #festival in dark mode.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex); await channel(alex, 'festival');
  const t0 = Date.now();
  await add(olive, 'Programme printed', day(10));
  await alex.waitForSelector('.tl-title:text-is("Programme printed")', { timeout: 6000 });
  out(`Alex saw Olive's milestone live: ${Date.now() - t0} ms`);
  expect('Alex sees a new milestone live, in its place on the line', (await line(alex)).join('|') === 'Site visit|Line-up announced|TODAY|Volunteer briefing|Programme printed|Stage build|Gates open', (await line(alex)).join('|'));
  // Olive moves a milestone to another date; Alex sees it move.
  await stop(olive, 'Programme printed').getByRole('button', { name: /^Edit/ }).click();
  await olive.fill('.tl-stop.is-editing input[type="date"]', day(50));
  await olive.locator('.tl-stop.is-editing form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.tl-track .tl-title')].map((e) => e.textContent).pop() === 'Programme printed', null, { timeout: 6000 });
  await olive.waitForTimeout(800);
  expect('After her change, Olive\'s view follows the milestone she moved', await inView(olive, '.tl-stop:has(.tl-title:text-is("Programme printed"))'));
  expect('A date change shows live, and the milestone moves along the line', (await line(alex)).slice(-2).join('|') === 'Gates open|Programme printed', (await line(alex)).join('|'));
  // Alex (owner) deletes Olive's milestone; it goes for Olive live.
  await add(alex, 'Duplicate to tidy up', day(12));
  await olive.waitForSelector('.tl-title:text-is("Duplicate to tidy up")', { timeout: 6000 });
  await stop(alex, 'Duplicate to tidy up').getByRole('button', { name: /^Delete/ }).click();
  await olive.waitForFunction(() => ![...document.querySelectorAll('.tl-title')].some((e) => e.textContent.includes('Duplicate')), null, { timeout: 6000 });
  expect('Alex deletes a milestone, and it goes for Olive live', true);
  await channel(olive, 'organizers'); await channel(olive, 'festival'); // reopening brings today back into view
  await olive.waitForTimeout(800);
  expect('Reopening a timeline brings today into view', await inView(olive, '.tl-today'));
  await olive.screenshot({ path: `${SHOTS}/1-timeline-olive-light.png` });
  await alex.waitForTimeout(500);
  await alex.screenshot({ path: `${SHOTS}/2-timeline-alex-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  await openApp(pat);
  const chans = await pat.locator('.docs-list .doc-link').allInnerTexts();
  expect('Pat sees #festival in the app, not #organizers', chans.includes('#festival') && !chans.includes('#organizers'), chans.join(', '));
  await channel(pat, 'festival');
  expect('Pat reads the #festival timeline', (await line(pat)).join('|') === 'Site visit|Line-up announced|TODAY|Volunteer briefing|Stage build|Gates open|Programme printed', (await line(pat)).join('|'));
  await pat.waitForTimeout(800);
  expect('On opening, the today marker is in view', await inView(pat, '.tl-today'));
  expect('Pat: no form, no Edit or Delete', await pat.locator('form[aria-label="Add a milestone"]').count() === 0 && await pat.locator('.tl-track').getByRole('button').count() === 0);
  expect('Pat: the hint says why, and the header says view only', (await pat.locator('.tl-below > .docs-hint').innerText()).includes('make you an editor')
    && (await pat.locator('.docs-meta').innerText()).includes('View only'));
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-timeline-pat-viewer.png` });

  // Home widget (opt-in).
  const widget = async (p) => {
    await p.locator('#tab-home').click(); await p.waitForSelector('.widgets-area');
    let w = p.locator('.widget:has(h3:text-is("Next milestones"))');
    if (!(await w.count())) {
      await p.getByRole('button', { name: 'Customize' }).click();
      await p.locator('.widget-picker label', { hasText: 'Next milestones' }).locator('input').check();
      await p.getByRole('button', { name: 'Done', exact: true }).click();
      w = p.locator('.widget:has(h3:text-is("Next milestones"))');
    }
    await w.locator('.widget-main').first().waitFor();
    return w;
  };
  const ow = await widget(olive);
  const otitles = await ow.locator('.widget-main').allInnerTexts();
  expect('Widget: Olive sees coming milestones from #festival and #organizers, soonest first, none past',
    otitles.join('|') === 'Volunteer briefing|Budget signed off|Stage build|Gates open|Programme printed', otitles.join('|'));
  const pw = await widget(pat);
  const ptitles = await pw.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival milestones only', ptitles.join('|') === 'Volunteer briefing|Stage build|Gates open|Programme printed', ptitles.join('|'));
  await ow.locator('.widget-row', { hasText: 'Budget signed off' }).click();
  await olive.waitForSelector('#tab-timeline[aria-selected="true"]');
  await olive.waitForSelector('.tl-head:has-text("#organizers")');
  await olive.waitForSelector('.tl-title:text-is("Budget signed off")');
  expect('Widget: a row opens Timeline on its channel', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
