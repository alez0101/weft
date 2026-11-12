// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Phase 4 browser check: co-editing, view-only, sharing, no-access. Run after db/reset.sh from a dir
// with playwright installed (npm install playwright):  node <repo>/tests/docs-browser.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto((process.env.WEFT_BASE || 'http://localhost:3211/'), { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const openDoc = async (p, app, title) => {
    await p.getByRole('tab', { name: 'Home' }).click();
    await p.locator(`.app:has-text("${app}")`).click(); await p.waitForSelector('.docs-list');
    await p.getByRole('button', { name: title, exact: true }).click();
    await p.waitForSelector('.bn-editor'); await p.waitForTimeout(1500);
  };
  const olive = await open('Olive Organizer'); const alex = await open('Alex (test admin)');
  await openDoc(olive, 'Documents', 'Run of show'); await openDoc(alex, 'Documents', 'Run of show');
  console.log('Olive status:', await olive.locator('.docs-status').innerText());
  console.log('seeded text present:', (await olive.locator('.bn-editor').innerText()).includes('info booth'));
  await olive.locator('.bn-editor').first().click();
  await olive.keyboard.press('Control+End'); await olive.keyboard.press('Enter');
  await olive.keyboard.type('Olive typed this live');
  await olive.waitForTimeout(800);
  console.log('Olive own editor has it:', (await olive.locator('.bn-editor').innerText()).includes('Olive typed this live'));
  console.log('Alex status:', await alex.locator('.docs-status').innerText().catch(()=>'?'));
  console.log('Alex editor text:', (await alex.locator('.bn-editor').innerText()).slice(0,200).replace(/\n/g,' | '));
  const t0 = Date.now();
  await alex.getByText('Olive typed this live').waitFor({ timeout: 5000 });
  console.log(`Alex saw Olive's typing: ${Date.now() - t0} ms`);
  await alex.locator('.bn-editor').first().click();
  await alex.keyboard.press('Control+End'); await alex.keyboard.press('Enter'); await alex.keyboard.type('Alex replies in the same doc');
  await olive.getByText('Alex replies in the same doc').waitFor({ timeout: 5000 });
  console.log('Olive saw Alex: yes');
  await olive.screenshot({ path: '/tmp/pw/p4-coedit.png' });

  const vic = await open('Vic Volunteer'); await openDoc(vic, 'Documents', 'Run of show');
  console.log('Vic status:', await vic.locator('.docs-status').innerText(), '| editable:', await vic.locator('.bn-editor').getAttribute('contenteditable'));

  // Olive shares Host contacts (Organizers) into #festival; Pat follows the link.
  await openDoc(olive, 'Documents', 'Host contacts');
  await olive.selectOption('#share-document', { label: '#festival' }); await olive.getByRole('button', { name: 'Share' }).click();
  await olive.waitForTimeout(800); console.log('Olive share note:', await olive.locator('.slot-status').innerText());
  const pat = await open('Pat Public');
  await pat.getByRole('button', { name: 'festival', exact: true }).click(); await pat.waitForTimeout(1200);
  await pat.locator('.item-link').last().click(); await pat.waitForTimeout(1200);
  console.log('Pat follows the link:', (await pat.locator('.docs-main').innerText()).split('\n')[0]);
  console.log('Pat list has Host contacts:', await pat.getByRole('button', { name: 'Host contacts' }).count());
  await pat.screenshot({ path: '/tmp/pw/p4-noaccess.png' });
  await openDoc(pat, 'Wiki', 'Rain plan');
  console.log('Pat on Rain plan:', await pat.locator('.docs-status').innerText());
  await pat.screenshot({ path: '/tmp/pw/p4-wiki.png' });
  console.log('page errors:', errs); await b.close();
})();
