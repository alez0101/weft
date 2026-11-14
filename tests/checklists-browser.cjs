// Checklists in real browsers, on the test stack (tests/run.sh --keep): Olive makes a checklist in
// Organizers and an "Opening up" checklist in #festival, adds steps and reorders them; Alex (dark mode)
// watches a run start live and ticks steps, which Olive sees live with who ticked; changing the template
// leaves the run as it was; finishing moves the run to Past runs with its ticks fixed; Pat (viewer) reads
// the #festival checklist only, with no way to change it, and sees a run deleted live; Weft search finds
// the checklist by a step; Olive turns on the "Checklists in progress" Home widget and a row opens it.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node checklists-browser.cjs
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
    await p.locator('.app:has-text("Checklists")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const newChecklist = async (p, space, name) => {
    await p.selectOption('#new-checklist', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New checklist' }).click();
    await p.waitForFunction(() => document.querySelector('#title-checklist')?.value === 'New checklist');
    await p.fill('#title-checklist', name); await p.press('#title-checklist', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addStep = async (p, label) => {
    await p.fill('#cl-new-step', label); await p.locator('form[aria-label="Add a step"]').getByRole('button', { name: 'Add step' }).click();
    await p.waitForSelector(`.cl-step-label:has-text("${label}")`);
  };
  const steps = (p) => p.locator('.cl-step-label').allInnerTexts();
  const run = (p, name) => p.locator('.cl-run', { has: p.locator('.cl-run-title', { hasText: name }) });
  const tick = (p, name, step) => run(p, name).locator('.cl-tick', { hasText: step }).locator('input[type="checkbox"]');

  const olive = await open('Olive Organizer');
  await newChecklist(olive, '#organizers', 'Packing the van');
  await addStep(olive, 'Cash box and float');
  expect('Start a run is offered once there is a step', await olive.getByRole('button', { name: 'Start a run' }).isEnabled());
  await newChecklist(olive, '#festival', 'Opening up');
  expect('An empty checklist cannot be run yet', await olive.getByRole('button', { name: 'Start a run' }).isDisabled()
    && (await olive.locator('.cl-runs .docs-hint').innerText()).includes('Add steps'));
  for (const s of ['Unlock the side gate', 'Lights and power on', 'Float in the till', 'Check the first aid kit', 'Signs out on the road']) await addStep(olive, s);
  await olive.getByRole('button', { name: 'Move up: Check the first aid kit' }).click();
  await olive.waitForFunction(() => document.querySelectorAll('.cl-step-label')[2]?.textContent === 'Check the first aid kit');
  expect('Steps move up and down', (await steps(olive)).join(',') === 'Unlock the side gate,Lights and power on,Check the first aid kit,Float in the till,Signs out on the road', (await steps(olive)).join(','));

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Opening up' }).click(); await alex.waitForSelector('.cl-step');
  expect('Alex sees the steps in the saved order', (await steps(alex))[2] === 'Check the first aid kit', (await steps(alex)).join(','));
  const t0 = Date.now();
  await olive.fill('#cl-run-label', 'Saturday'); await olive.getByRole('button', { name: 'Start a run' }).click();
  await alex.waitForSelector('.cl-run-title:has-text("Saturday")', { timeout: 6000 });
  out(`Alex saw Olive's run live: ${Date.now() - t0} ms`);
  expect('The run is a fresh copy of the steps, none ticked', await run(alex, 'Saturday').locator('.cl-tick').count() === 5
    && await run(alex, 'Saturday').locator('input:checked').count() === 0);
  expect('The run says who started it', (await run(olive, 'Saturday').locator('.cl-run-meta').innerText()).includes('by Olive Organizer'));

  await tick(alex, 'Saturday', 'Unlock the side gate').check();
  await tick(alex, 'Saturday', 'Lights and power on').check();
  await olive.waitForFunction(() => document.querySelectorAll('.cl-run input:checked').length === 2, null, { timeout: 6000 });
  expect('Olive sees Alex\'s ticks live, with who ticked', (await run(olive, 'Saturday').locator('.cl-tick', { hasText: 'Unlock the side gate' }).locator('.cl-tick-by').innerText()).startsWith('Alex'));
  expect('Progress counts the ticks', (await run(olive, 'Saturday').locator('.cl-progress').innerText()).includes('2 of 5 done'));
  await tick(olive, 'Saturday', 'Check the first aid kit').check();
  await olive.waitForFunction(() => document.querySelector('.cl-run .cl-progress')?.textContent.includes('3 of 5'));

  // Changing the template does not change the run already started.
  await olive.locator('.cl-step', { hasText: 'Signs out on the road' }).getByRole('button', { name: /^Rename/ }).click();
  await olive.fill('.cl-rename input', 'Signs out on Mill Road');
  await olive.locator('.cl-rename').getByRole('button', { name: 'Save' }).click();
  await olive.waitForSelector('.cl-step-label:has-text("Signs out on Mill Road")');
  expect('Renaming a template step leaves the run as it was', await run(olive, 'Saturday').locator('.cl-tick', { hasText: 'Signs out on the road' }).count() === 1);

  // Finish: the run moves to Past runs, its ticks fixed.
  await run(olive, 'Saturday').getByRole('button', { name: /^Finish/ }).click();
  await alex.waitForSelector('.cl-run.is-finished', { timeout: 6000 });
  expect('A finished run moves to Past runs live, saying who finished it', (await alex.locator('.cl-run.is-finished summary').innerText()).includes('by Olive Organizer'));
  await alex.locator('.cl-run.is-finished summary').click();
  expect('A finished run\'s ticks cannot be changed', await alex.locator('.cl-run.is-finished input[type="checkbox"]:not([disabled])').count() === 0);
  expect('No run in progress says so', (await olive.locator('.cl-runs .convo-empty').innerText()) === 'No run in progress.');

  // A second run starts from the template as it is now.
  await olive.fill('#cl-run-label', 'Sunday'); await olive.getByRole('button', { name: 'Start a run' }).click();
  await olive.waitForSelector('.cl-run:not(.is-finished) .cl-run-title:has-text("Sunday")');
  expect('A new run uses the changed template', await run(olive, 'Sunday').locator('.cl-tick', { hasText: 'Signs out on Mill Road' }).count() === 1);
  await tick(olive, 'Sunday', 'Unlock the side gate').check();
  await olive.waitForFunction(() => document.querySelector('.cl-run:not(.is-finished) .cl-progress')?.textContent.includes('1 of 5'));
  await tick(alex, 'Sunday', 'Lights and power on').check();
  await olive.waitForFunction(() => document.querySelector('.cl-run:not(.is-finished) .cl-progress')?.textContent.includes('2 of 5'), null, { timeout: 6000 });

  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-checklists-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-checklists-alex-dark.png` });

  // Weft search finds the checklist by a step's words.
  await olive.locator('.search input').fill('first aid kit');
  const hit = olive.locator('.search-group:has-text("Checklists")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the checklist by a step', found && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Opening up')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival checklist, not the Organizers one', lists.includes('Opening up') && !lists.includes('Packing the van'), lists.join(', '));
  await pat.locator('.doc-link', { hasText: 'Opening up' }).click(); await pat.waitForSelector('.cl-run');
  expect('Pat: no Start a run, Add step, Rename, Remove, Finish, Delete or Move', await pat.getByRole('button', { name: /^(Start a run|Add step|Rename|Remove|Finish|Reopen|Delete run)/ }).count() === 0
    && await pat.locator('#cl-new-step').count() === 0 && await pat.locator('#move-checklist').count() === 0);
  expect('Pat: the ticks are read-only and the hint says why', await pat.locator('.cl-run input[type="checkbox"]:not([disabled])').count() === 0
    && (await pat.locator('.checklist > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat reads who ticked what', (await run(pat, 'Sunday').locator('.cl-tick-by').allInnerTexts()).length === 2);
  await pat.locator('.cl-run.is-finished summary').click();
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-checklists-pat-viewer.png` });
  await olive.locator('.cl-run.is-finished summary').click();
  await run(olive, 'Saturday').getByRole('button', { name: /^Delete run/ }).click();
  await pat.waitForFunction(() => !document.querySelector('.cl-run.is-finished'), null, { timeout: 6000 });
  expect('A deleted run disappears live for Pat', true);

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Checklists in progress' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Checklists in progress"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: the run in progress with how far it got', rows.length === 1 && rows[0].includes('Sunday') && rows[0].includes('2 of 5 done'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Sunday' }).click();
  await olive.waitForSelector('#tab-checklists[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-checklist')?.value === 'Opening up');
  expect('Widget: a row opens its checklist', true);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
