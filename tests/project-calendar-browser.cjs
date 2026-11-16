// Project calendars in real browsers, on the test stack (tests/run.sh --keep): Alex (owner of #festival) makes a
// project, then in Calendar drags out an event and puts it in the project from the new-event form; its details name
// the project; the Project filter shows only the project's events; Pat (viewer) sees it with no way to change the
// project; Alex takes it out of the project and it leaves the filtered view; the .ics download offers the project.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node project-calendar-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const P = `Cal ${Date.now().toString(36).slice(-5)}`;   // a new project name each run
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
  const calendar = async (p) => { await p.getByRole('tab', { name: 'Home' }).click(); await p.locator('.app:has-text("Calendar")').click(); await p.waitForSelector('.cal-main [data-time="10:00:00"]'); await p.waitForTimeout(800); };
  const ev = (p, title) => p.locator('.cal-main').getByText(title).first();
  const TITLE = `${P} sorting`;

  try {
    const alex = await open('Alex (test admin)');
    await alex.locator('.convos .convo', { hasText: 'festival' }).first().click();
    await alex.waitForSelector('.project-strip');
    await alex.locator('.project-add').click();
    await alex.fill('#project-name', P);
    await alex.getByRole('button', { name: 'Make project' }).click();
    await alex.waitForSelector(`.project-strip .link-tag[aria-pressed="true"]:has-text("${P}")`);

    await calendar(alex);
    // Drag across the third day's column, 10:00 to 11:00.
    const dates = await alex.locator('.cal-main [data-date]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-date')))]);
    const day = dates[2];
    const col = await alex.locator(`.cal-main [data-date="${day}"]`).evaluateAll((els) => {
      const r = els.map((e) => e.getBoundingClientRect()).sort((x, y) => y.height - x.height)[0];
      return { x: r.x + r.width / 2 };
    });
    const r10 = await alex.locator('.cal-main [data-time="10:00:00"]').last().boundingBox();
    const r11 = await alex.locator('.cal-main [data-time="11:00:00"]').last().boundingBox();
    await alex.mouse.move(col.x, r10.y + 6); await alex.mouse.down(); await alex.mouse.move(col.x, r11.y - 4, { steps: 8 }); await alex.mouse.up();
    await alex.waitForSelector('.cal-form');
    const placeLabels = await alex.locator('#ev-space option').allInnerTexts();
    expect('The new-event form offers the project as a place', placeLabels.includes(`#festival › ${P}`), placeLabels.join(' | '));
    await alex.fill('#ev-title', TITLE);
    await alex.selectOption('#ev-space', { label: `#festival › ${P}` });
    await alex.getByRole('button', { name: 'Add event' }).click();
    await ev(alex, TITLE).waitFor({ timeout: 8000 });
    await ev(alex, TITLE).click();
    await alex.waitForSelector('.cal-detail');
    expect('The event names its channel and project', (await alex.locator('.cal-detail .docs-meta').innerText()).includes(`#festival › ${P}`),
      await alex.locator('.cal-detail .docs-meta').innerText());
    expect('An owner can change its project from the event', (await alex.locator('#ev-project option:checked').innerText()) === P);
    await alex.selectOption('#cal-only', { label: `#festival › ${P}` });
    await alex.waitForTimeout(400);
    expect('With the project chosen, its event shows', await ev(alex, TITLE).isVisible());
    expect('...and the hint says what is shown', (await alex.locator('.cal-project .cal-hint').innerText()).includes(P));
    const dl = await alex.locator('#cal-dl-space option').allInnerTexts();
    expect('Download as a file offers the project', dl.includes(`#festival › ${P}`), dl.join(' | '));
    await alex.screenshot({ path: `${SHOTS}/project-calendar-owner.png` });

    const pat = await open('Pat Public', true);
    await calendar(pat);
    await pat.selectOption('#cal-only', { label: `#festival › ${P}` });
    await pat.waitForTimeout(400);
    // Pat's calendar may open on another week: step to the week holding the event's day.
    for (let i = 0; i < 80; i += 1) {
      const ds = await pat.locator('.cal-main [data-date]').evaluateAll((els) => els.map((e) => e.getAttribute('data-date')).sort());
      if (ds[0] <= day && day <= ds[ds.length - 1]) break;
      await pat.locator('.cal-main button').filter({ has: pat.locator(ds[0] > day ? '[class*="prev"], [class*="left"]' : '[class*="next"], [class*="right"]') }).first().click()
        .catch(async () => pat.getByRole('button', { name: ds[0] > day ? /prev/i : /next/i }).first().click());
      await pat.waitForTimeout(250);
    }
    await ev(pat, TITLE).waitFor({ timeout: 5000 });
    await ev(pat, TITLE).click();
    await pat.waitForSelector('.cal-detail');
    expect('Pat (viewer) sees the project on the event, with no way to change it',
      (await pat.locator('.cal-detail .docs-meta').innerText()).includes(P) && !(await pat.locator('#ev-project').count()));
    await pat.screenshot({ path: `${SHOTS}/project-calendar-viewer-dark.png` });

    await alex.selectOption('#ev-project', { label: 'No project' });
    await alex.waitForSelector('.cal-bar .slot-status:has-text("no longer in a project")');
    await alex.waitForTimeout(600);
    expect('Taken out of the project, it leaves the project view', !(await ev(alex, TITLE).isVisible().catch(() => false)));
    await alex.selectOption('#cal-only', { label: 'Everything' });
    await ev(alex, TITLE).waitFor({ timeout: 5000 });
    expect('...and is still in the calendar under Everything', true);
    // Leave the slot free for the next run.
    await ev(alex, TITLE).click();
    await alex.waitForSelector('.cal-detail');
    await alex.locator('.cal-detail').getByRole('button', { name: 'Delete' }).click();
    await alex.waitForTimeout(800);
    expect('The owner deletes the event (clean up)', !(await ev(alex, TITLE).isVisible().catch(() => false)));
  } catch (e) {
    failed += 1; out(`FAIL ${e.message.split('\n')[0]}`);
    for (const [i, pg] of b.contexts().flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: `${SHOTS}/project-calendar-failed-${i}.png` }).catch(() => {});
  }
  expect('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  out(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
