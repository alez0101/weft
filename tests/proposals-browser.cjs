// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Phase 6 browser check: proposal cards (confirm / dismiss / undo; others see who decides). Needs the
// stand-in model (services/assistant/test/mock.mjs) configured as an anthropic primary at http://weft-mock:9009/anthropic.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Los_Angeles' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto((process.env.WEFT_BASE || 'http://localhost:3211/'), { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.getByRole('button', { name: 'festival', exact: true }).click(); await p.waitForTimeout(800);
    return p;
  };
  const olive = await open('Olive Organizer'); const pat = await open('Pat Public');
  await olive.fill('#compose', '@Weft MOVE-IT: it may rain, move The Backyard Radio to the garage'); await olive.press('#compose', 'Enter');
  await olive.locator('.proposal').last().waitFor({ timeout: 20000 });
  console.log('Olive sees:', (await olive.locator('.proposal').last().innerText()).replace(/\n+/g, ' | '));
  await pat.locator('.proposal').last().waitFor({ timeout: 8000 });
  console.log('Pat sees:  ', (await pat.locator('.proposal').last().innerText()).replace(/\n+/g, ' | '));
  await olive.screenshot({ path: '/tmp/pw/p6-proposal.png' });
  await olive.locator('.proposal').last().getByRole('button', { name: 'Confirm' }).click(); await olive.waitForTimeout(1200);
  console.log('after Confirm:', (await olive.locator('.proposal').last().innerText()).replace(/\n+/g, ' | '));
  await olive.screenshot({ path: '/tmp/pw/p6-done.png' });
  await olive.locator('.proposal').last().getByRole('button', { name: 'Undo' }).click(); await olive.waitForTimeout(1200);
  console.log('after Undo:', (await olive.locator('.proposal').last().innerText()).replace(/\n+/g, ' | '));
  console.log('errors:', errs); await b.close();
})();
