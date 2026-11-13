// Files and Home widgets in real browsers, on the test stack (tests/run.sh --keep):
// upload through the Files app (picker), PDF preview and its text, a viewer's view, and the widgets:
// content, customising, and the layout surviving a reload. Run from a dir with playwright.
const { chromium } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
const SHOTS = process.env.WEFT_SHOTS || os.tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
function pdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const s = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`; objs[3] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = []; objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-files-'));
  fs.writeFileSync(path.join(dir, 'Stage plan.pdf'), pdf('Stage plan: the main stage faces the oak tree'));
  fs.writeFileSync(path.join(dir, 'Parking.txt'), 'Volunteer parking is behind the library.');
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a);
  const open = async (who) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title'); return p;
  };
  const olive = await open('Olive Organizer');
  // Files: upload two files into #festival
  await olive.locator('.app:has-text("Files")').click(); await olive.waitForSelector('.docs-list');
  const fest = await olive.locator('#new-file option', { hasText: 'festival' }).getAttribute('value');
  await olive.selectOption('#new-file', fest);
  await olive.locator('.file-pick input[type=file]').setInputFiles([path.join(dir, 'Stage plan.pdf'), path.join(dir, 'Parking.txt')]);
  await olive.waitForSelector('.doc-link:has-text("Stage plan.pdf")', { timeout: 15000 }); await olive.waitForSelector('.doc-link:has-text("Parking.txt")');
  await olive.locator('.doc-link', { hasText: 'Stage plan.pdf' }).first().click();
  await olive.waitForSelector('.file-meta'); await olive.waitForTimeout(1500);
  out('file meta:', await olive.locator('.file-meta').innerText());
  out('PDF preview shown:', await olive.locator('iframe.file-preview--pdf').count(), '| text summary:', await olive.locator('.file-text summary').innerText());
  await olive.locator('.file-text summary').click();
  out('text Weft read:', (await olive.locator('.file-text pre').innerText()).trim());
  await olive.screenshot({ path: `${SHOTS}/files-olive.png` });
  // A viewer sees it, cannot upload there
  const pat = await open('Pat Public');
  await pat.locator('.app:has-text("Files")').click(); await pat.waitForSelector('.docs-list');
  out('Pat sees:', (await pat.locator('.doc-link').allInnerTexts()).join(', '), '| Pat can choose #festival to upload to:', await pat.locator('#new-file option', { hasText: 'festival' }).count());
  // Widgets
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  out('widgets:', (await olive.locator('.widget h3').allInnerTexts()).join(', '));
  out('recently changed shows the upload:', await olive.locator('.widget:has(h3:has-text("Recently changed")) .widget-main', { hasText: 'Parking.txt' }).count());
  out('coming up rows:', await olive.locator('.widget:has(h3:has-text("Coming up")) .widget-row').count());
  await olive.screenshot({ path: `${SHOTS}/widgets-olive.png`, fullPage: true });
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Recent files' }).locator('input').check();
  await olive.locator('.widget-picker label', { hasText: 'Unread' }).locator('input').uncheck();
  await olive.getByRole('button', { name: 'Earlier Recent files' }).click();
  await olive.getByRole('button', { name: 'Done' }).click(); await olive.waitForTimeout(500);
  await olive.reload({ waitUntil: 'networkidle' }); await olive.getByRole('button', { name: 'Olive Organizer' }).click(); // test accounts keep no session
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets');
  out('after customising and a reload:', (await olive.locator('.widget h3').allInnerTexts()).join(', '));
  await olive.locator('.widget:has(h3:has-text("Recent files")) .widget-row', { hasText: 'Stage plan.pdf' }).first().click();
  await olive.waitForSelector('.file-meta'); out('a widget row opens the file in Files:', await olive.locator('#tab-files[aria-selected="true"]').count());
  out('errors:', errs); await b.close(); fs.rmSync(dir, { recursive: true });
})();
