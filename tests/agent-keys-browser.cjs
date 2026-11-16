// Agent keys and the new Settings sections in real browsers, on the test stack (tests/run.sh --keep or db/reset.sh):
// Alex makes a read-and-write key for his own agent from Connected apps, sees the address and key once with
// ready-to-paste setup for Claude Code, Hermes Agent, OpenClaw and Other, and the key is listed; Settings shows
// Web search and Answer sizes, and saving a size works; an agent card gives Weft access with the same setup;
// Pat (dark) makes a read-only key and disconnects it.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node agent-keys-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const TAG = Date.now().toString(36).slice(-5);
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}/agent-keys-${name}.png` });
  try {
    const alex = await open('Alex (test admin)');
    await alex.locator('.avatar').click();
    await alex.getByRole('button', { name: 'Connected apps' }).click();
    await alex.waitForSelector('#ca-title');
    const dlg = alex.locator('dialog[open]');
    await dlg.getByLabel('Agent name').fill(`Alex agent ${TAG}`);
    await dlg.getByLabel('Access').selectOption('write');
    await dlg.getByRole('button', { name: 'Make a key' }).click();
    await dlg.locator('.agent-setup').waitFor();
    const key = await dlg.locator('.agent-setup-key').innerText();
    expect('Connected apps: a key is shown once, with the /mcp address', /^weft_key_/.test(key) && (await dlg.locator('.agent-setup-pair').innerText()).includes('/mcp'), key.slice(0, 12));
    expect('Setup starts on Claude Code, with the key in the command', (await dlg.locator('.agent-setup-code').innerText()).startsWith('claude mcp add --transport http weft ') && (await dlg.locator('.agent-setup-code').innerText()).includes(key));
    await dlg.getByRole('button', { name: 'Hermes Agent' }).click();
    expect('Hermes Agent setup is a config.yaml block', /^mcp_servers:\n  weft:\n    url: "/.test(await dlg.locator('.agent-setup-code').innerText()) && await dlg.getByRole('button', { name: 'Hermes Agent' }).getAttribute('aria-pressed') === 'true');
    await dlg.getByRole('button', { name: 'OpenClaw' }).click();
    expect('OpenClaw setup adds and reloads', /openclaw mcp add weft --url .*\nopenclaw mcp reload/.test(await dlg.locator('.agent-setup-code').innerText()));
    await dlg.getByRole('button', { name: 'Other' }).click();
    const other = JSON.parse(await dlg.locator('.agent-setup-code').innerText());
    expect('Other is MCP JSON with the Bearer key', other.mcpServers.weft.type === 'http' && other.mcpServers.weft.headers.Authorization === `Bearer ${key}`);
    await dlg.getByRole('button', { name: 'Copy setup' }).click();
    expect('Copy setup puts it on the clipboard', (await alex.evaluate(() => navigator.clipboard.readText())).includes(key));
    await shot(alex, 'made');
    await dlg.getByRole('button', { name: 'Done' }).click();
    expect('The key is gone from the screen after Done, and listed', await dlg.locator('.agent-setup').count() === 0 && (await dlg.locator('.people-list').innerText()).includes(`Alex agent ${TAG}`) && (await dlg.locator('.people-list').innerText()).includes('Read and write'));
    await dlg.getByRole('button', { name: 'Close' }).click();

    await alex.locator('.app:has-text("Settings")').click(); await alex.waitForSelector('.users-table tbody tr');
    await alex.getByRole('heading', { name: 'Answer sizes' }).waitFor({ timeout: 8000 });
    expect('Settings shows Web search and Answer sizes', await alex.getByRole('heading', { name: 'Web search', exact: true }).isVisible() && await alex.getByRole('heading', { name: 'Answer sizes' }).isVisible());
    await alex.getByLabel('Rounds of reading or searching per question').fill('4');
    await alex.getByRole('button', { name: 'Save sizes' }).click();
    await alex.waitForSelector('.slot-status:has-text("The next question uses these")');
    await alex.getByLabel('Rounds of reading or searching per question').fill('');
    await alex.getByRole('button', { name: 'Save sizes' }).click();
    await alex.waitForSelector('.slot-status:has-text("The next question uses these")');
    expect('Answer sizes save, and empty goes back to the default', (await alex.getByLabel('Rounds of reading or searching per question').getAttribute('placeholder')).includes('default'));
    await alex.getByRole('heading', { name: 'Answer sizes' }).scrollIntoViewIfNeeded();
    await shot(alex, 'settings');
    // An agent card: Give access shows the same setup.
    await alex.getByRole('button', { name: 'Add an agent' }).click();
    await alex.getByLabel('Name', { exact: true }).last().fill(`Key test ${TAG}`);
    await alex.getByLabel('@name (for channels)').last().fill(`kt-${TAG}`);
    await alex.getByLabel('Whose agent').last().selectOption({ label: 'Olive Organizer' });
    await alex.getByLabel('Address').last().fill('http://nowhere.invalid:1/v1');
    await alex.getByRole('button', { name: 'Add agent' }).click();
    const card = alex.locator('.slot', { has: alex.getByRole('heading', { name: `Key test ${TAG}` }) });
    await card.waitFor({ timeout: 8000 });
    await card.getByRole('button', { name: 'Give access' }).click();
    await card.locator('.agent-setup').waitFor();
    expect('An agent card gives Weft access with the same setup panel', /^weft_agent_/.test(await card.locator('.agent-setup-key').innerText()));
    await card.getByRole('button', { name: 'Done' }).click();
    await card.locator('.key-state:has-text("Connected until")').waitFor({ timeout: 8000 });
    expect('...and then says it is connected, for its owner', (await card.innerText()).includes('reads what Olive Organizer can see'));
    await card.getByRole('button', { name: 'Remove' }).first().click();

    const pat = await open('Pat Public', true);
    await pat.locator('.avatar').click();
    await pat.getByRole('button', { name: 'Connected apps' }).click();
    const pd = pat.locator('dialog[open]');
    await pd.getByLabel('Agent name').fill(`Pat agent ${TAG}`);
    await pd.getByRole('button', { name: 'Make a key' }).click();
    await pd.locator('.agent-setup').waitFor();
    await shot(pat, 'dark');
    await pd.getByRole('button', { name: 'Done' }).click();
    const row = pd.locator('.person', { hasText: `Pat agent ${TAG}` });
    expect('Pat\'s key is read only', (await row.innerText()).includes('Read only'));
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await pd.locator('.slot-status:has-text("is disconnected")').waitFor();
    expect('Pat disconnects it', await pd.locator('.person', { hasText: `Pat agent ${TAG}` }).count() === 0);
  } catch (e) { expect('run', false, e.message); }
  expect('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  out(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
