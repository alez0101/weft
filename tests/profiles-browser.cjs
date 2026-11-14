// People profiles in real browsers, on the test stack (tests/run.sh --keep): Olive fills in her profile;
// Alex (dark mode) sees it arrive live and fills in his own; the filter matches roles and skills and a skill
// button filters by that skill; too many skills are refused with the database's answer; Pat (a viewer
// everywhere) sees the others' profiles read-only, with Edit only on her own, and an edit live; Olive turns
// on the "Your profile" Home widget and it opens Profiles.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node profiles-browser.cjs
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
  const card = (p, name) => p.locator(`li.profile[aria-label^="${name}"]`);
  const names = (p) => p.locator('.profile-list li.profile .contact-name').allInnerTexts();
  const fill = async (p, { role, skills, reach, availability }) => {
    const btn = p.getByRole('button', { name: /^(Fill in your profile|Edit profile)$/ });
    await btn.click();
    if (role !== undefined) await p.fill('#profile-role', role);
    if (skills !== undefined) await p.fill('#profile-skills', skills);
    if (reach !== undefined) await p.fill('#profile-reach', reach);
    if (availability !== undefined) await p.fill('#profile-when', availability);
    await p.locator('form[aria-label="Your profile"]').getByRole('button', { name: 'Save profile' }).click();
  };

  const alex = await open('Alex (test admin)', true);
  const olive = await open('Olive Organizer');
  expect('Olive starts with a prompt to fill in her profile', await olive.getByRole('button', { name: 'Fill in your profile' }).count() === 1);
  const t0 = Date.now();
  await fill(olive, { role: 'Festival lead', skills: 'First aid, Van licence, first aid,  Spanish ', reach: 'Message me in Weft; call the site phone on the day', availability: 'Weekday evenings and all festival weekend' });
  await olive.waitForSelector('li.profile.is-mine .profile-role:has-text("Festival lead")');
  const tags = await card(olive, 'Olive').locator('.link-tag').allInnerTexts();
  expect('Skills are tidied by the database (lowercase, no repeats)', tags.join(',') === 'first aid,van licence,spanish', tags.join(','));
  await alex.waitForSelector('li.profile[aria-label^="Olive"] .profile-role', { timeout: 6000 });
  out(`Alex saw Olive's profile live: ${Date.now() - t0} ms`);
  expect('Alex sees which channels he shares with Olive', (await card(alex, 'Olive').locator('.profile-shared').innerText()).includes('#festival'));

  await fill(alex, { role: 'Site manager', skills: 'sound, lighting, forklift', reach: 'Phone first, then chat', availability: 'Fridays and Saturdays' });
  await alex.waitForSelector('li.profile.is-mine .profile-role:has-text("Site manager")');
  await olive.waitForSelector('li.profile[aria-label^="Alex"] .profile-role', { timeout: 6000 });

  // The filter and the skill buttons.
  await olive.fill('#profiles-find', 'forklift');
  let shown = await names(olive);
  expect('Words filter by skill', shown.length === 1 && shown[0].startsWith('Alex'), shown.join(', '));
  await olive.fill('#profiles-find', 'nobody-like-this');
  expect('No match says so', (await olive.locator('.profiles .convo-empty').innerText()) === 'No one matches.');
  await olive.fill('#profiles-find', '');

  // The database refuses too many skills, and the screen shows why.
  await olive.getByRole('button', { name: 'Edit profile' }).click();
  await olive.fill('#profile-skills', Array.from({ length: 13 }, (_, i) => `skill ${i + 1}`).join(', '));
  await olive.locator('form[aria-label="Your profile"]').getByRole('button', { name: 'Save profile' }).click();
  await olive.waitForSelector('.profiles .send-error');
  expect('Too many skills are refused, with the reason shown', (await olive.locator('.profiles .send-error').innerText()).includes('at most 12 skills'));
  await olive.locator('form[aria-label="Your profile"]').getByRole('button', { name: 'Cancel' }).click();
  expect('Her saved skills are unchanged', (await card(olive, 'Olive').locator('.link-tag').allInnerTexts()).length === 3);

  // Pat (viewer everywhere).
  const pat = await open('Pat Public');
  await pat.waitForSelector('li.profile[aria-label^="Olive"]');
  shown = await names(pat);
  expect('Pat sees Olive and Alex', shown.some((n) => n.startsWith('Olive')) && shown.some((n) => n.startsWith('Alex')), shown.join(', '));
  expect('Pat: no Edit or Clear on anyone else\'s profile', await pat.locator('.profile-list').getByRole('button', { name: /^(Edit|Clear)/ }).count() === 0);
  expect('Pat is told who has no profile yet', (await pat.locator('.profile-without').innerText()).includes('Vic'));
  await card(pat, 'Olive').getByRole('button', { name: 'first aid' }).click();
  shown = await names(pat);
  expect('A skill button filters by that skill', shown.length === 1 && shown[0].startsWith('Olive') && await pat.locator('.profile-without').count() === 0, shown.join(', '));
  await card(pat, 'Olive').getByRole('button', { name: 'first aid' }).click();
  await fill(pat, { role: 'Volunteer', skills: 'face painting', reach: 'Chat in #festival', availability: 'Saturday mornings' });
  await pat.waitForSelector('li.profile.is-mine .profile-role:has-text("Volunteer")');
  expect('Pat edits her own profile (positive control)', await pat.locator('li.profile.is-mine').getByRole('button', { name: 'Edit profile' }).count() === 1);

  // Olive changes her availability; Pat sees it live.
  await olive.getByRole('button', { name: 'Edit profile' }).click();
  await olive.fill('#profile-when', 'Weekends only until the festival');
  await olive.locator('form[aria-label="Your profile"]').getByRole('button', { name: 'Save profile' }).click();
  await pat.waitForSelector('li.profile[aria-label^="Olive"] .profile-line:has-text("Weekends only")', { timeout: 6000 });
  expect('An edit shows live for Pat', true);

  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-profiles-olive-light.png` });
  await alex.waitForSelector('li.profile[aria-label^="Pat"]', { timeout: 6000 });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-profiles-alex-dark.png` });
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-profiles-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on and it opens Profiles.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  expect('The widget is off by default', await olive.locator('.widget:has(h3:has-text("Your profile"))').count() === 0);
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Your profile' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Your profile"))');
  await w.locator('.widget-main').first().waitFor();
  expect('Widget: shows her role and skills', (await w.locator('.widget-main').innerText()) === 'Festival lead' && (await w.locator('.widget-note').innerText()).includes('first aid'));
  await w.locator('.widget-row').click();
  await olive.waitForSelector('#tab-profiles[aria-selected="true"]');
  expect('Widget: opens Profiles', true);

  // Clearing: Pat clears hers and it disappears for Olive live.
  await pat.locator('li.profile.is-mine').getByRole('button', { name: 'Clear' }).click();
  await pat.waitForSelector('button:has-text("Fill in your profile")');
  await olive.waitForFunction(() => ![...document.querySelectorAll('.profile-list .contact-name')].some((e) => e.textContent.startsWith('Pat')), null, { timeout: 6000 });
  expect('Clearing a profile shows live', (await olive.locator('.profile-without').innerText()).includes('Pat'));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
