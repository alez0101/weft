// Accounts browser check, on the test stack's PUBLIC door (http://localhost:3210, Weft accounts):
// an invite link, staying signed in across a reload, signing out and in, a wrong password, and the
// admin invite screen. Needs tests/run.sh --keep. Run from a dir with playwright (WEFT_REPO = the repo).
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir(); // where screenshots go
const { execSync } = require('child_process');
const BASE = process.env.WEFT_PUBLIC || 'http://localhost:3210';
const REPO = process.env.WEFT_REPO || `${process.env.HOME}/work/weft`;
const link = (email, reset) => execSync(`python3 -I ${REPO}/tools/weft_admin.py link ${email} --test --url ${BASE}${reset ? ' --reset' : ''}`).toString().trim().split('\n').pop();
const ROBIN = `robin.${Date.now().toString(36)}@example.org`;
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  // 1. invite
  await p.goto(link(ROBIN), { waitUntil: 'networkidle' });
  out('link page:', (await p.locator('.signin-form p').first().innerText()).replace(/\s+/g, ' '));
  await p.screenshot({ path: SHOTS + '/accounts-invite.png' });
  await p.getByLabel('Your name, as others will see it').fill('Robin New');
  await p.getByLabel('Password (at least 12 characters)').fill('robin likes long passwords');
  await p.getByLabel('The same password again').fill('robin likes long passwords');
  await p.getByRole('button', { name: 'Create my account' }).click();
  await p.waitForSelector('.rail-title');
  out('signed in as:', await p.locator('.avatar').getAttribute('aria-label'), '| address has no link:', !p.url().includes('link='));
  // 2. reload keeps the session
  await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('.rail-title', { timeout: 8000 });
  out('still signed in after a reload');
  // 3. sign out, wrong password, sign in
  await p.locator('.avatar').click(); await p.getByRole('button', { name: 'Sign out' }).click();
  await p.waitForSelector('#signin-email');
  await p.getByLabel('Email').fill(ROBIN); await p.getByLabel('Password').fill('not the password at all');
  await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForSelector('.signin-error');
  out('wrong password says:', await p.locator('.signin-error').innerText());
  await p.screenshot({ path: SHOTS + '/accounts-signin.png' });
  await p.getByLabel('Password').fill('robin likes long passwords'); await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForSelector('.rail-title'); out('signed in again with the password');
  // 4. used link
  const p2 = await (await b.newContext()).newPage();
  // 5. admin: reset link for the test admin, then the invite screen
  await p2.goto(link('alex.admin@example.com', true), { waitUntil: 'networkidle' });
  await p2.getByLabel('Password (at least 12 characters)').fill('alex test admin password');
  await p2.getByLabel('The same password again').fill('alex test admin password');
  await p2.getByRole('button', { name: 'Save and sign in' }).click(); await p2.waitForSelector('.rail-title');
  await p2.locator('.app:has-text("Settings")').click(); await p2.waitForSelector('.users-table tbody tr');
  await p2.locator('#invite-email').fill('sam.next@example.org'); await p2.getByRole('button', { name: 'Make invite link' }).click();
  await p2.waitForSelector('.new-link');
  const url = await p2.locator('#new-link-url').inputValue();
  out('admin made an invite link:', url.startsWith(`${BASE}/#link=`), '| open links listed:', await p2.locator('.open-links li').count());
  out('password column:', (await p2.locator('.users-table tr:has-text("Robin New") td').nth(3).innerText()).split('\n')[0]);
  await p2.screenshot({ path: SHOTS + '/accounts-admin.png', fullPage: false });
  const p3 = await (await b.newContext()).newPage();
  await p3.goto(link(ROBIN, true).replace(/#link=.*/, '#link=' + 'z'.repeat(43)), { waitUntil: 'networkidle' });
  await p3.waitForSelector('.signin-error'); out('bad link says:', await p3.locator('.signin-error').innerText());
  out('errors:', errs); await b.close();
})();
