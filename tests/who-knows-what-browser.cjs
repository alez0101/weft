// Who knows what in real browsers, on the test stack (tests/run.sh --keep): Olive, Alex (dark mode) and Pat
// fill in profiles; Olive's "Who knows what" row counts each skill and a skill shows only who has it; the
// channel chooser narrows the counts and the list to one channel (Pat is not in Organizers); Pat adds a skill
// and Olive's count goes up live; Pat (a viewer everywhere) sees only her own channel in the chooser and
// filters read-only; Alex turns on the "Who knows what" Home widget and a skill there opens Profiles filtered.
// Profiles are cleared at the end, so the check can run again.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node who-knows-what-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Profiles")').click(); await p.waitForSelector('.profiles #profile-mine-title'); return p;
  };
  const names = (p) => p.locator('.profile-list li.profile .contact-name').allInnerTexts();
  const fill = async (p, skills, role) => {
    await p.getByRole('button', { name: /^(Fill in your profile|Edit profile)$/ }).click();
    if (role) await p.fill('#profile-role', role);
    await p.fill('#profile-skills', skills);
    await p.locator('form[aria-label="Your profile"]').getByRole('button', { name: 'Save profile' }).click();
    await p.waitForSelector('li.profile.is-mine');
  };
  const known = (p) => p.locator('.profiles .who-knows');
  const skillBtn = (p, s) => known(p).locator('button.link-tag', { hasText: new RegExp(`^${s}\\s`) });
  const count = async (p, s) => ((await skillBtn(p, s).count()) ? Number((await skillBtn(p, s).locator('.idea-count').innerText()).trim()) : 0);
  const status = (p) => p.locator('.profiles .links-filters [role="status"]').innerText();
  const pickChannel = async (p, re) => {
    const opt = await p.locator('#profiles-channel option').evaluateAll((os, src) => (os.find((o) => new RegExp(src, 'i').test(o.textContent)) || {}).value, re.source);
    await p.selectOption('#profiles-channel', opt ?? '');
  };

  const olive = await open('Olive Organizer');
  const alex = await open('Alex (test admin)', true);
  const pat = await open('Pat Public');
  await fill(olive, 'first aid, van licence', 'Festival lead');
  await fill(alex, 'forklift, van licence, first aid', 'Site manager');
  await fill(pat, 'face painting', 'Volunteer');

  // Olive's view: counts leave her out; a skill filters.
  await olive.waitForFunction(() => /face painting/.test(document.querySelector('.profiles .who-knows')?.textContent || ''), null, { timeout: 6000 });
  expect('Who knows what counts the others (van licence: Alex), not Olive herself', await count(olive, 'van licence') === 1 && await count(olive, 'forklift') === 1, String(await count(olive, 'van licence')));
  await skillBtn(olive, 'van licence').click();
  let shown = await names(olive);
  expect('Pressing van licence shows only Alex', shown.length === 1 && shown[0].startsWith('Alex'), shown.join(', '));
  expect('The status answers the question', (await status(olive)) === '1 person knows van licence', await status(olive));
  expect('People without a profile are hidden while a skill is chosen', await olive.locator('.profile-without').count() === 0);

  // By channel: Pat is in #festival, not in Organizers.
  await skillBtn(olive, 'van licence').click();
  await pickChannel(olive, /organizers/);
  expect('In Organizers, face painting (Pat) is not counted', await count(olive, 'face painting') === 0 && await count(olive, 'forklift') === 1);
  shown = await names(olive);
  expect('In Organizers, Pat is not listed', !shown.some((n) => n.startsWith('Pat')) && shown.some((n) => n.startsWith('Alex')), shown.join(', '));
  await pickChannel(olive, /festival/);
  await skillBtn(olive, 'face painting').click();
  shown = await names(olive);
  expect('In #festival, face painting finds Pat', shown.length === 1 && shown[0].startsWith('Pat'), shown.join(', '));
  expect('The status names the channel', /^1 person knows face painting in #/i.test(await status(olive)), await status(olive));
  await pickChannel(olive, /organizers/);
  expect('A chosen skill no one in the channel has says so', /^No one in #.* has listed face painting\.$/i.test(await olive.locator('.profiles .convo-empty').innerText()));
  await olive.locator('.links-filters button.link-tag[aria-pressed="true"]').click();   // remove the skill filter
  await pickChannel(olive, /any channel/);

  // Live: Pat adds van licence; Olive's count goes to 2.
  const t0 = Date.now();
  await fill(pat, 'face painting, van licence');
  await olive.waitForFunction(() => [...document.querySelectorAll('.profiles .who-knows button')].some((b) => /^van licence\s*2/.test(b.textContent)), null, { timeout: 6000 });
  out(`Olive saw the new count live: ${Date.now() - t0} ms`);
  expect('A new skill shows live in the counts', await count(olive, 'van licence') === 2);
  await skillBtn(olive, 'van licence').click();
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-who-knows-olive-light.png` });

  // Pat (viewer): only her own channel, filtering read-only, no Edit on anyone else.
  await pat.waitForSelector('.profiles .who-knows button');
  const opts = await pat.locator('#profiles-channel option').allInnerTexts();
  // (The permission suite leaves Pat a channel of her own, so only the ones she is not in are checked.)
  expect('Pat\'s channel chooser has only channels she is in (#festival, not Organizers or Volunteers)',
    opts.some((o) => /festival/i.test(o)) && !opts.some((o) => /organizers|volunteers/i.test(o)), opts.join(', '));
  await skillBtn(pat, 'first aid').click();
  shown = await names(pat);
  expect('Pat finds who knows first aid (Alex and Olive)', shown.length === 2 && shown.some((n) => n.startsWith('Olive')) && shown.some((n) => n.startsWith('Alex')), shown.join(', '));
  expect('Pat: no Edit or Clear on anyone else\'s profile', await pat.locator('.profile-list').getByRole('button', { name: /^(Edit|Clear)/ }).count() === 0);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-who-knows-pat-viewer.png` });

  // Home widget (off by default): a skill opens Profiles filtered by it.
  await alex.locator('#tab-home').click(); await alex.waitForSelector('.widgets-area');
  expect('The widget is off by default', await alex.locator('.widget:has(h3:has-text("Who knows what"))').count() === 0);
  await alex.getByRole('button', { name: 'Customize' }).click();
  await alex.locator('.widget-picker label', { hasText: 'Who knows what' }).locator('input').check();
  await alex.getByRole('button', { name: 'Done', exact: true }).click();
  const w = alex.locator('.widget:has(h3:has-text("Who knows what"))');
  await w.locator('button.link-tag').first().waitFor();
  const wtags = await w.locator('button.link-tag').allInnerTexts();
  expect('Widget: most common first (van licence: Olive and Pat), not counting Alex', /^van licence\s*2/.test(wtags[0] || '') && !wtags.some((t) => t.startsWith('forklift')), wtags.join(' | '));
  await w.locator('button.link-tag', { hasText: /^first aid/ }).click();
  await alex.waitForSelector('#tab-profiles[aria-selected="true"]');
  await alex.waitForSelector('.profiles .links-filters button.link-tag[aria-pressed="true"]');
  shown = await names(alex);
  expect('Widget: opens Profiles showing who knows first aid (Olive)', shown.length === 1 && shown[0].startsWith('Olive'), shown.join(', '));
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-who-knows-alex-dark.png` });
  // Leave Alex's Home as it was.
  await alex.locator('#tab-home').click(); await alex.getByRole('button', { name: 'Customize' }).click();
  await alex.locator('.widget-picker label', { hasText: 'Who knows what' }).locator('input').uncheck();
  await alex.getByRole('button', { name: 'Done', exact: true }).click();

  // Clean up: everyone clears their profile; Olive's skill row empties live.
  for (const p of [alex, pat]) {
    if (p === alex) { await alex.locator('#tab-profiles').click(); await alex.waitForSelector('.profiles #profile-mine-title'); }
    await p.locator('li.profile.is-mine').getByRole('button', { name: 'Clear' }).click();
    await p.waitForSelector('button:has-text("Fill in your profile")');
  }
  await olive.waitForFunction(() => /No one has listed a skill yet/.test(document.querySelector('.profiles .who-knows')?.textContent || ''), null, { timeout: 6000 });
  expect('Clearing profiles empties the counts live', true);
  await olive.locator('li.profile.is-mine').getByRole('button', { name: 'Clear' }).click();
  await olive.waitForSelector('button:has-text("Fill in your profile")');

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
