// Stand-in personal agent for tests/agents-browser.cjs: OpenAI-compatible, key "hermes-ui-key-12345678".
// Run on the test network: docker run -d --name weft-agent-mock --network weft-test_default -v "$PWD/services/assistant/test:/m:ro" node:22-alpine node /m/agent-mock.mjs
import http from 'node:http';
http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => { d += c; });
  req.on('end', () => {
    if ((req.headers.authorization || '') !== 'Bearer hermes-ui-key-12345678') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'hermes-agent' }] }));
    const last = (JSON.parse(d || '{}').messages || []).at(-1)?.content || '';
    const q = last.split('\n').at(-1);
    setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: `Happy to help with that.\n\nYou asked: "${q.slice(0, 90)}"\n- I keep this conversation separate (session ${req.headers['x-hermes-session-id']?.slice(0, 13)}…)\n- Ask me a follow-up any time.` } }] })), 1200);
  });
}).listen(9010, () => console.log('agent mock on 9010'));
