// A stand-in OpenAI-compatible model for UI checks: cites source 1 when there is one.
import http from 'node:http';
http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => { d += c; });
  req.on('end', () => {
    const user = JSON.parse(d || '{}').messages?.find((m) => m.role === 'user')?.content || '';
    const first = /^\[1\] (.*)$/m.exec(user);
    const text = first ? `The latest on that: "${first[1].slice(0, 80)}" [1].` : 'I am not sure.';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'stand-in-model', choices: [{ message: { content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }));
  });
}).listen(9009, () => console.log('mock on 9009'));
