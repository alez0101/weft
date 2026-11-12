// Version 1.5 browser check: two people on one whiteboard, viewer in view mode, fonts served by Weft.
// Targets the test stack (tests/run.sh --keep). Run from a dir with playwright (the Weft server: /tmp/pw).
const { chromium } = require('playwright');
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const fontReqs = [];
  const open = async (who) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('request', (r) => { if (/\.(woff2?|ttf)/.test(r.url())) fontReqs.push(r.url().replace(/^https?:\/\/[^/]+/, (h) => (h.includes('localhost') ? '[weft]' : h))); });
    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Whiteboard")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const olive = await open('Olive Organizer');
  await olive.selectOption('#new-whiteboard', { label: '#festival' }); await olive.getByRole('button', { name: 'New whiteboard' }).click();
  await olive.waitForSelector('.excalidraw', { timeout: 15000 }); await olive.waitForTimeout(1500);
  console.log('Olive status:', await olive.locator('.docs-status').innerText());
  const alex = await open('Alex (test admin)');
  await alex.getByRole('button', { name: 'Untitled whiteboard', exact: true }).click(); await alex.waitForSelector('.excalidraw'); await alex.waitForTimeout(1500);
  const canvasBox = await alex.locator('.excalidraw canvas').last().boundingBox();
  const before = await alex.screenshot({ clip: canvasBox });
  // Olive: text tool, click, type.
  const ob = await olive.locator('.excalidraw canvas').last().boundingBox();
  await olive.mouse.click(ob.x + 700, ob.y + 450); await olive.keyboard.press('t'); await olive.mouse.click(ob.x + 300, ob.y + 200); await olive.keyboard.type('Porch map draft'); await olive.keyboard.press('Escape');
  await olive.keyboard.press('r'); await olive.mouse.move(ob.x + 300, ob.y + 260); await olive.mouse.down(); await olive.mouse.move(ob.x + 520, ob.y + 380, { steps: 6 }); await olive.mouse.up();
  await alex.waitForTimeout(2000);
  const after = await alex.screenshot({ clip: canvasBox });
  console.log("Alex's canvas changed live:", Buffer.compare(before, after) !== 0);
  await olive.screenshot({ path: '/tmp/pw/board-olive.png' }); await alex.screenshot({ path: '/tmp/pw/board-alex.png' });
  const vic = await open('Vic Volunteer');
  await vic.getByRole('button', { name: 'Untitled whiteboard', exact: true }).click(); await vic.waitForSelector('.excalidraw'); await vic.waitForTimeout(1500);
  console.log('Vic status:', await vic.locator('.docs-status').innerText(), '| view-mode class:', await vic.locator('.excalidraw.excalidraw--view-mode, .excalidraw .view-mode').count());
  console.log('font requests:', [...new Set(fontReqs)].slice(0, 4));
  console.log('errors:', errs); await b.close();
})();
