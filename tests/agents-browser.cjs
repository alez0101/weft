// Targets the TEST stack by default (start it with: tests/run.sh --keep). WEFT_BASE overrides.
// Personal agents (067) in the browser: an admin adds Olive's agent in Settings, Olive starts two
// conversations with it (each named after its first message), asks in both, then @mentions it in #festival
// where Vic sees the reply; Pat sees no agents. Needs the stand-in agent on the test network:
//   docker run -d --name weft-agent-mock --network weft-test_default -v "$PWD/services/assistant/test:/m:ro" node:22-alpine node /m/agent-mock.mjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const SCALE = Number(process.env.WEFT_SCALE || 1);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`); if (!ok) failed++; };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (who) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto((process.env.WEFT_BASE || 'http://localhost:3211/'), { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const alex = await open('Alex (test admin)');
  // Settings tile, Personal agents section.
  await alex.locator('.app:has-text("Settings")').click(); await alex.waitForSelector('.users-table tbody tr');
  await alex.getByRole('button', { name: 'Add an agent' }).click();
  await alex.getByLabel('Name', { exact: true }).last().fill("Olive's Hermes");
  await alex.getByLabel('@name (for channels)').last().fill('hermes');
  await alex.getByLabel('Whose agent').last().selectOption({ label: 'Olive Organizer' });
  await alex.getByLabel('Address').last().fill('http://weft-agent-mock:9010/v1');
  await alex.getByRole('button', { name: 'Add agent' }).click();
  const card = alex.locator('.slot', { has: alex.getByRole('heading', { name: "Olive's Hermes" }) });
  await card.waitFor({ timeout: 8000 });
  await card.getByLabel('Key').fill('hermes-ui-key-12345678');
  await card.getByRole('button', { name: 'Save key' }).click();
  const card2 = alex.locator('.slot', { has: alex.getByRole('heading', { name: "Olive's Hermes" }) });
  await card2.getByText('Set, ending in 5678').waitFor({ timeout: 8000 });
  await card2.getByRole('button', { name: 'Test connection' }).click();
  await card2.locator('.slot-status').waitFor({ timeout: 10000 });
  const tested = await card2.locator('.slot-status').innerText();
  check('Admin adds the agent, saves its key and the connection test passes', /^Connected in \d+ ms\.$/.test(tested), tested);
  await card2.scrollIntoViewIfNeeded();
  await alex.screenshot({ path: `${SHOTS}/agents-admin.png` });

  const olive = await open('Olive Organizer');
  const group = olive.locator('.agent-group', { hasText: "Olive's Hermes" });
  check("Olive's chat list shows her agent", await group.count() === 1);
  await olive.getByRole('button', { name: "New conversation with Olive's Hermes" }).click();
  await olive.waitForTimeout(600);
  await olive.fill('#compose', 'Plan a packing list for the Saturday festival'); await olive.press('#compose', 'Enter');
  await olive.locator('.thinking').waitFor({ timeout: 4000 }).catch(() => {});
  check('While it works, a line says so', /is working on it/.test(await olive.locator('.thinking').innerText().catch(() => '')));
  await olive.locator('.msg--own-agent').first().waitFor({ timeout: 15000 });
  const reply = await olive.locator('.msg--own-agent').first().innerText();
  check('The agent replies in the conversation, line breaks kept', /You asked: "Plan a packing list/.test(reply) && reply.includes('\n- I keep'), reply);
  check('The conversation is named after its first message', await group.getByRole('button', { name: 'Plan a packing list for the Saturday festival' }).count() === 1);
  await olive.getByRole('button', { name: "New conversation with Olive's Hermes" }).click();
  await olive.waitForTimeout(600);
  await olive.fill('#compose', 'Draft a thank-you note to the porch hosts'); await olive.press('#compose', 'Enter');
  await olive.locator('.msg--own-agent').first().waitFor({ timeout: 15000 });
  check('A second conversation, listed separately', await group.locator('.convo').count() === 2);
  await olive.screenshot({ path: `${SHOTS}/agents-conversation.png` });
  // Rename, via the header.
  await olive.locator('.thread-sub').getByRole('button', { name: 'Rename' }).click();
  await olive.fill('#agent-rename', 'Thank-you note'); await olive.press('#agent-rename', 'Enter');
  await olive.waitForTimeout(800);
  check('Renaming a conversation updates the list', await group.getByRole('button', { name: 'Thank-you note' }).count() === 1);

  // @mention in #festival; Vic sees it.
  const vic = await open('Vic Volunteer');
  await vic.getByRole('button', { name: 'festival', exact: true }).click();
  await olive.getByRole('button', { name: 'festival', exact: true }).click(); await olive.waitForTimeout(600);
  check('The channel box suggests the @name', /@hermes/.test(await olive.locator('#compose').getAttribute('placeholder')));
  await olive.fill('#compose', '@hermes what still needs doing for the festival?'); await olive.press('#compose', 'Enter');
  await vic.locator('.msg--own-agent').last().waitFor({ timeout: 15000 });
  check('Vic sees the agent reply in #festival', /what still needs doing/.test(await vic.locator('.msg--own-agent').last().innerText()));
  await olive.locator('.msg--own-agent').last().waitFor({ timeout: 5000 });
  await olive.screenshot({ path: `${SHOTS}/agents-channel.png` });

  const pat = await open('Pat Public');
  check('Pat has no agents in her chat list', await pat.locator('.agent-group').count() === 0);
  check('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
