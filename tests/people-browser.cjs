// People browser check: create a channel, add someone live, owner-only controls, leaving, and an admin
// disabling an account that is signed in. Targets the test stack (tests/run.sh --keep).
// Run from a dir with playwright (the Weft server: /tmp/pw).
const { chromium } = require('playwright');
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a);
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Load-in crew' : undefined));
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title'); return p;
  };
  const olive = await open('Olive Organizer'); const vic = await open('Vic Volunteer', true);
  // 1. Olive creates a channel; the people panel opens; she adds Vic as editor.
  await olive.getByRole('button', { name: 'New channel' }).click();
  await olive.getByLabel('Channel name').fill('Load-in crew'); await olive.getByRole('button', { name: 'Create' }).click();
  await olive.waitForSelector('dialog.people[open]');
  out('panel title:', await olive.locator('#people-title').innerText());
  await olive.selectOption('#people-add-user', { label: 'Vic Volunteer (vic.volunteer@example.com)' });
  await olive.selectOption('#people-add-role', 'editor');
  await olive.getByRole('button', { name: 'Add', exact: true }).click();
  await olive.waitForSelector('.person:has-text("Vic Volunteer")');
  out('status:', await olive.locator('dialog .slot-status').innerText());
  out('Olive (last owner) role select disabled:', await olive.locator(`.person:has-text("(you)") select`).isDisabled());
  await olive.screenshot({ path: '/tmp/pw/people-panel-light.png' });
  // 2. Vic sees the channel appear without a reload.
  const t0 = Date.now();
  await vic.waitForSelector('.convo:has-text("Load-in crew")', { timeout: 6000 });
  out(`Vic saw the new channel live: ${Date.now() - t0} ms`);
  await vic.locator('.convo:has-text("Load-in crew")').click();
  await vic.getByRole('button', { name: /members, see people/ }).click(); await vic.waitForSelector('dialog.people[open] .person');
  out('Vic (editor) sees role selects:', await vic.locator('dialog.people select').count(), '| Leave button:', await vic.getByRole('button', { name: 'Leave channel' }).count(), '| Delete button:', await vic.getByRole('button', { name: 'Delete channel' }).count());
  await vic.screenshot({ path: '/tmp/pw/people-panel-dark.png' });
  await vic.keyboard.press('Escape');
  // 3. Olive makes Vic owner, then leaves; Vic then deletes the channel (prompt answered with its name).
  const vicId = await olive.locator('.person:has-text("Vic Volunteer") select').getAttribute('id');
  await olive.selectOption(`#${vicId}`, 'owner'); await olive.waitForTimeout(600);
  await olive.getByRole('button', { name: 'Leave channel' }).click(); await olive.waitForTimeout(1200);
  out('Olive still lists the channel after leaving:', await olive.locator('.convo:has-text("Load-in crew")').count());
  await vic.getByRole('button', { name: /members?, see people/ }).click(); await vic.waitForSelector('dialog.people[open] .person');
  out('Vic is now owner; Delete button:', await vic.getByRole('button', { name: 'Delete channel' }).count());
  await vic.getByRole('button', { name: 'Delete channel' }).click(); await vic.waitForTimeout(1500);
  out('Vic lists the channel after deleting:', await vic.locator('.convo:has-text("Load-in crew")').count());
  // 4. Alex disables Pat while Pat is signed in.
  const pat = await open('Pat Public'); const alex = await open('Alex (test admin)');
  await alex.locator('.app:has-text("Settings")').click(); await alex.waitForSelector('.users-table tbody tr');
  out('accounts listed:', (await alex.locator('.users-table tbody th').allInnerTexts()).map((s) => s.split('\n')[0]).join(', '));
  await alex.screenshot({ path: '/tmp/pw/people-admin-light.png' });
  await alex.locator('.users-table tr:has-text("Pat Public") button').click();
  const t1 = Date.now();
  await pat.waitForSelector('text=This account has been disabled', { timeout: 8000 });
  out(`Pat was signed out by the disable: ${Date.now() - t1} ms`);
  out('row now shows:', await alex.locator('.users-table tr:has-text("Pat Public") .users-account').innerText());
  await alex.locator('.users-table tr:has-text("Pat Public") button').click(); await alex.waitForTimeout(600);
  out('after enable, row offers:', await alex.locator('.users-table tr:has-text("Pat Public") button').innerText());
  out('Alex own row has a button:', await alex.locator('.users-table tr:has-text("(you)") button').count(), '| own admin box disabled:', await alex.locator('.users-table tr:has-text("(you)") input').isDisabled());
  out('errors:', errs); await b.close();
})();
