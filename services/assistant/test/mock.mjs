// A stand-in model for UI checks. OpenAI-compatible at /, Anthropic Messages format at /anthropic.
// It cites source 1; "MOVE-IT" proposes an event change (The Backyard Radio if present).
import http from 'node:http';
http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => { d += c; });
  req.on('end', () => {
    const body = JSON.parse(d || '{}');
    const msgs = body.messages || [];
    const user = (msgs.find((m) => m.role === 'user')?.content) || '';
    const text = typeof user === 'string' ? user : '';
    const first = /^\[1\] (.*)$/m.exec(text);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/anthropic')) {
      const ev = /^\[(\d+)\] event "The Backyard Radio/m.exec(text) || /^\[(\d+)\] event /m.exec(text);
      const content = /MOVE-IT/.test(text) && ev
        ? [{ type: 'text', text: 'I can move that set to the garage porch.' }, { type: 'tool_use', id: 'toolu_ui', name: 'change_event', input: { source: Number(ev[1]), title: null, location: 'Garage at P01 (rain plan)', starts_at: null, ends_at: null } }]
        : [{ type: 'text', text: first ? `The latest on that: "${first[1].slice(0, 80)}" [1].` : 'NOT_FOUND' }];
      return res.end(JSON.stringify({ id: 'msg_ui', type: 'message', role: 'assistant', model: 'stand-in-claude', content, stop_reason: content.length > 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 500, output_tokens: 40 } }));
    }
    res.end(JSON.stringify({ model: 'stand-in-model', choices: [{ message: { content: first ? `The latest on that: "${first[1].slice(0, 80)}" [1].` : 'I am not sure.' } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }));
  });
}).listen(9009, () => console.log('mock on 9009'));
