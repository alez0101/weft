// Kudos on profiles in real browsers, on the test stack (tests/run.sh --keep): Alex (dark mode) thanks Olive in
// #organizers and in #festival from the Kudos app; Olive's own card in Profiles shows both live, newest first,
// with who gave each and where; Pat (a viewer in #festival, not in Organizers) sees Olive's card with only the
// #festival kudos and its count, no Organizers text, and nothing she can change; a channel name opens that
// channel's wall; Alex deletes a kudos and it leaves Olive's card live. Alex's kudos (and Olive's profile, if the
// check filled it in) are removed at the end, so the check can run again.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node kudos-on-profiles-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const ORG = 'KOP organizers: thanks for chasing every sponsor before the deadline.';
const FEST = 'KOP festival: the new stage map saved us an hour of questions at the gate.';
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
  const profiles = async (p) => { if (await p.locator('#tab-home').count()) await p.locator('#tab-home').click(); await p.locator('.app:has-text("Profiles")').click(); await p.waitForSelector('.profiles #profile-mine-title'); };
  const kudosApp = async (p) => { if (await p.locator('#tab-home').count()) await p.locator('#tab-home').click(); await p.locator('.app:has-text("Kudos")').click(); await p.waitForSelector('.docs-list[aria-label="Channels"]'); };
  const channel = async (p, name) => {
    await p.locator('.docs-list .doc-link', { hasText: `#${name}` }).click();
    await p.waitForSelector(`.kudos-head:has-text("#${name}")`);
    await p.waitForSelector('.kudos-wall, .links > .convo-empty');
  };
  const give = async (p, to, message) => {
    await p.selectOption('#kudos-new-to', { label: to });
    await p.fill('#kudos-new-message', message);
    await p.locator('form[aria-label="Give kudos"]').getByRole('button', { name: 'Give kudos' }).click();
    await p.waitForSelector(`.kudos-wall .kudos-message:has-text("${message}")`);
  };
  const remove = async (p, message) => {
    await p.locator('.kudos-card', { has: p.locator('.kudos-message', { hasText: message }) }).getByRole('button', { name: /^Delete/ }).click();
    await p.waitForFunction((m) => ![...document.querySelectorAll('.kudos-wall .kudos-message')].some((e) => e.textContent.includes(m)), message);
  };
  const thanks = (p, person) => p.locator(`.profiles section.profile-kudos[aria-label="Kudos for ${person}"]`);
  const messages = (p, person) => thanks(p, person).locator('.profile-kudos-message').allInnerTexts();
  const shows = (p, person, text) => p.waitForFunction(([who, t]) => [...document.querySelectorAll(`.profiles section.profile-kudos[aria-label="Kudos for ${who}"] .profile-kudos-message`)]
    .some((e) => e.textContent.includes(t)), [person, text], { timeout: 6000 });

  const olive = await open('Olive Organizer');
  const alex = await open('Alex (test admin)', true);
  const pat = await open('Pat Public');
  await profiles(olive);
  await profiles(pat);
  // Kudos show on the cards of people with a profile: Olive fills one in if she has none (cleared at the end).
  const oliveFilled = await olive.getByRole('button', { name: 'Fill in your profile' }).count() > 0;
  if (oliveFilled) {
    await olive.getByRole('button', { name: 'Fill in your profile' }).click();
    await olive.fill('#profile-role', 'Festival lead');
    await olive.locator('form[aria-label="Your profile"]').getByRole('button', { name: 'Save profile' }).click();
    await olive.waitForSelector('li.profile.is-mine');
  }
  await kudosApp(alex);

  // A run that stopped half way may have left its kudos: remove them first.
  for (const c of ['organizers', 'festival']) {
    await channel(alex, c);
    for (const m of [ORG, FEST]) if (await alex.locator('.kudos-wall .kudos-message', { hasText: m }).count()) await remove(alex, m);
  }

  // Alex thanks Olive in Organizers, then in #festival; Olive's own card shows both live, newest first.
  await channel(alex, 'organizers');
  await give(alex, 'Olive Organizer', ORG);
  let t0 = Date.now();
  await shows(olive, 'Olive Organizer', ORG);
  out(`Olive saw the Organizers kudos on her card live: ${Date.now() - t0} ms`);
  await channel(alex, 'festival');
  await give(alex, 'Olive Organizer', FEST);
  await shows(olive, 'Olive Organizer', FEST);
  let mine = await messages(olive, 'Olive Organizer');
  expect('Olive\'s card: both kudos, newest (#festival) first', mine.indexOf(FEST) === 0 && mine.indexOf(ORG) === 1, mine.join(' | '));
  expect('Olive\'s card: titled "Kudos you received" with a count', /^Kudos you received\s+\d+ in all$/.test((await thanks(olive, 'Olive Organizer').locator('.profile-kudos-title').innerText()).trim()));
  const from = await thanks(olive, 'Olive Organizer').locator('.profile-kudos-from').first().innerText();
  expect('Each kudos says who gave it, where and when', /^From Alex \(test admin\) in #festival, just now$/.test(from.replace(/\s*\(open its kudos\)\s*/, '').replace(/\s+/g, ' ').replace(' ,', ',')), from);
  expect('At most three kudos per card', await thanks(olive, 'Olive Organizer').locator('.profile-kudos-item').count() <= 3);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-kudos-on-profiles-olive-light.png` });

  // Pat (viewer in #festival only): Olive's card shows the #festival kudos, never the Organizers one.
  await shows(pat, 'Olive Organizer', FEST);
  const seen = await messages(pat, 'Olive Organizer');
  expect('Pat sees the #festival kudos on Olive\'s card', seen.includes(FEST), seen.join(' | '));
  expect('Pat does not see the Organizers kudos anywhere on the page', !(await pat.locator('.profiles').innerText()).includes('KOP organizers'));
  const patCount = Number(((await thanks(pat, 'Olive Organizer').locator('.profile-kudos-count').innerText()).match(/\d+/) || [])[0]);
  const oliveCount = Number(((await thanks(olive, 'Olive Organizer').locator('.profile-kudos-count').innerText()).match(/\d+/) || [])[0]);
  expect('Pat\'s count leaves out the Organizers kudos (one fewer than Olive\'s own, at least)', patCount < oliveCount, `${patCount} vs ${oliveCount}`);
  expect('Pat: nothing to change in the kudos on a card', await thanks(pat, 'Olive Organizer').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0);
  await thanks(pat, 'Olive Organizer').locator('.profile-kudos-item', { hasText: FEST }).scrollIntoViewIfNeeded();
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-kudos-on-profiles-pat-viewer.png` });

  // A channel name opens that channel's wall.
  await thanks(pat, 'Olive Organizer').locator('.profile-kudos-item', { hasText: FEST }).locator('button.profile-kudos-channel').click();
  await pat.waitForSelector('.kudos-head:has-text("#festival")');
  expect('The channel name opens the #festival kudos wall', await pat.locator('.kudos-wall .kudos-message', { hasText: FEST }).count() === 1);

  // Alex sees Olive's card too (dark mode), then deletes the Organizers kudos: it leaves Olive's card live.
  await profiles(alex);
  await shows(alex, 'Olive Organizer', ORG);
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-kudos-on-profiles-alex-dark.png` });
  await kudosApp(alex);
  await channel(alex, 'organizers');
  t0 = Date.now();
  await remove(alex, ORG);
  await olive.waitForFunction((m) => ![...document.querySelectorAll('.profiles .profile-kudos-message')].some((e) => e.textContent.includes(m)), ORG, { timeout: 6000 });
  out(`The deleted kudos left Olive's card live: ${Date.now() - t0} ms`);
  expect('A deleted kudos leaves the card live', (await messages(olive, 'Olive Organizer')).includes(FEST));

  // Clean up.
  await channel(alex, 'festival');
  await remove(alex, FEST);
  if (oliveFilled) {
    await olive.locator('li.profile.is-mine').getByRole('button', { name: 'Clear' }).click();
    await olive.waitForSelector('button:has-text("Fill in your profile")');
  }

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
