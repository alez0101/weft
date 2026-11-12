// Wiki browser check: the admin wiki for admins only, the generated index, managed pages read-only, and a
// page republished while open reopens on the new text without duplicating it. Test stack (run.sh --keep).
// Run from a dir with playwright (the Weft server: /tmp/pw). WEFT_REPO points at the repo (for the publish step).
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const REPO = process.env.WEFT_REPO || `${process.env.HOME}/work/weft`;
const DC = `sudo docker compose -p weft-test -f ${REPO}/stacks/weft/compose.yaml -f ${REPO}/stacks/weft-test/compose.test.yaml --env-file ${REPO}/stacks/weft-test/.env exec -T postgres psql -qAt -U weft_owner -d weft`;
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a);
  const open = async (who) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Wiki")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const alex = await open('Alex (test admin)'); const pat = await open('Pat Public');
  out('Alex rail has Weft admin:', await alex.locator('.convo:has-text("Weft admin")').count(), '| Pat:', await pat.locator('.convo:has-text("Weft admin")').count());
  out('Pat sees admin pages in Wiki:', await pat.locator('.doc-link', { hasText: 'Operations' }).count());
  await alex.locator('.doc-link', { hasText: 'Weft admin' }).first().click();
  await alex.waitForSelector('.docs-editor .bn-editor');
  await alex.waitForTimeout(800);
  const text = await alex.locator('.docs-editor .bn-editor').innerText();
  out('index lists pages:', ['Accounts and access', 'Publishing the wikis', 'Technical specification', 'Architecture'].map((t) => `${t}=${text.includes(t)}`).join(' '));
  out('managed note:', await alex.locator('.docs-managed').count(), '| editable:', await alex.locator('.docs-editor [contenteditable="true"]').count(), '| Move/Delete controls:', await alex.locator('.docs-head select[id^="move-"]').count());
  await alex.screenshot({ path: '/tmp/pw/wiki-admin-index.png' });
  // Republish Troubleshooting with a change while Alex has it open.
  await alex.locator('.doc-link', { hasText: 'Troubleshooting' }).first().click(); await alex.waitForSelector('.docs-editor .bn-editor'); await alex.waitForTimeout(800);
  const before = (await alex.locator('.docs-editor .bn-editor').innerText()).length;
  execSync(`rm -rf /tmp/wiki-root && mkdir -p /tmp/wiki-root && cp -r ${REPO}/docs /tmp/wiki-root/ && printf '\\nREPUBLISHED-LINE-4410\\n' >> /tmp/wiki-root/docs/admin/06-troubleshooting.md && python3 -I ${REPO}/tools/sync_wikis.py --root /tmp/wiki-root | ${DC} >/dev/null`);
  const t0 = Date.now();
  await alex.waitForFunction(() => document.querySelector('.docs-editor .bn-editor')?.innerText.includes('REPUBLISHED-LINE-4410'), null, { timeout: 8000 });
  await alex.waitForTimeout(800);
  const after = await alex.locator('.docs-editor .bn-editor').innerText();
  out(`republished text appeared without a reload: ${Date.now() - t0} ms | length ${before} -> ${after.length} | headings once:`, (after.match(/Someone cannot sign in/g) || []).length === 1);
  execSync(`python3 -I ${REPO}/tools/sync_wikis.py | ${DC} >/dev/null && rm -rf /tmp/wiki-root`);
  out('errors:', errs); await b.close();
})();
