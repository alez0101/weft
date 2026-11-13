// Files suite. Runs inside the test stack's network (tests/run.sh) against the files service.
// Proves: only editors upload, only members download, text is extracted from PDF / Word / text and is
// searchable only by members, types come from the bytes not the name, risky types never open in place,
// size and token rules hold, and deleting the item deletes the file.
import zlib from 'node:zlib';
const FILES = process.env.FILES || 'http://files:8095';
const AUTH = process.env.AUTH || 'http://svc:8081';
const API = process.env.API || 'http://postgrest:3000';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const login = async (email) => (await (await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json());
const api = async (token, path, opts = {}) => {
  const r = await fetch(`${API}${path}`, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: opts.body && JSON.stringify(opts.body) });
  const t = await r.text(); return { status: r.status, rows: t ? JSON.parse(t) : null };
};
const up = async (token, space, name, bytes) => {
  const r = await fetch(`${FILES}/files?space=${space}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: bytes });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const down = async (token, id, q = '') => {
  const r = await fetch(`${FILES}/files/${id}${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
};

// ---------- fixtures, built here
function pdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function zip(files) {   // stored (no compression), enough for a .docx
  const locals = []; const centrals = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const b = Buffer.from(data); const n = Buffer.from(name); const crc = zlib.crc32(b);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    locals.push(h, n, b);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    centrals.push(c, n); off += 30 + n.length + b.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const docx = (text) => zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
});

const [alex, olive, vic, pat] = await Promise.all(['alex.admin', 'olive.organizer', 'vic.volunteer', 'pat.public'].map((n) => login(`${n}@example.com`)));
const spaces = Object.fromEntries((await api(alex.token, '/spaces?kind=eq.channel&select=id,name')).rows.map((s) => [s.name, s.id]));

// ---------- who may upload
check('No token: no upload', (await up(null, spaces.festival, 'a.txt', 'x')).status === 401);
let r = await up(pat.token, spaces.festival, 'pat.txt', 'Pat was here');
check('Pat (viewer in #festival) cannot upload there', r.status === 403, JSON.stringify(r.data));
check('Pat cannot upload to Organizers (not a member)', (await up(pat.token, spaces.organizers, 'pat.txt', 'x')).status === 403);
const txt = await up(olive.token, spaces.festival, 'Load-in notes.txt', 'Trucks arrive at the north gate at 07:30. Badge pickup at the info tent.');
check('Olive (editor) uploads a text file to #festival', txt.status === 201 && txt.data.has_text && txt.data.mime === 'text/plain', JSON.stringify(txt.data));

// ---------- who may read, and the text
r = await down(pat.token, txt.data.id);
check('Pat (member) downloads it, byte for byte', r.status === 200 && r.bytes.toString() === 'Trucks arrive at the north gate at 07:30. Badge pickup at the info tent.');
check('Text files open in the browser, never sniffed, sandboxed', /^inline/.test(r.headers.get('content-disposition')) && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy') || ''));
check('?download=1 always downloads', /^attachment/.test((await down(pat.token, txt.data.id, '?download=1')).headers.get('content-disposition')));
r = await api(pat.token, `/items?id=eq.${txt.data.id}&select=kind,title,body_text`);
check('The text is on the item, so search and the assistant can use it', r.rows?.[0]?.kind === 'file' && /north gate/.test(r.rows[0].body_text));
r = await api(pat.token, `/items?kind=eq.file&body_text=wfts(english).badge&select=id`);
check('Keyword search finds it', r.rows?.some((x) => x.id === txt.data.id));

const p = await up(olive.token, spaces.organizers, 'Generator contract.pdf', pdf('Generator rental deposit PDF-SECRET-3321'));
check('A PDF uploads and its text is read', p.status === 201 && p.data.mime === 'application/pdf' && p.data.has_text, JSON.stringify(p.data));
r = await api(olive.token, `/items?id=eq.${p.data.id}&select=body_text`);
check('The PDF text is right', /PDF-SECRET-3321/.test(r.rows?.[0]?.body_text || ''), r.rows?.[0]?.body_text);
check('Pat cannot download an Organizers file, even with its id', (await down(pat.token, p.data.id)).status === 404);
check('Pat cannot see its item, text or file info', (await api(pat.token, `/items?id=eq.${p.data.id}`)).rows.length === 0 && (await api(pat.token, `/file_info?item_id=eq.${p.data.id}`)).rows.length === 0);
check('Pat cannot read its bytes through the API', (await api(pat.token, `/file_blobs?item_id=eq.${p.data.id}&select=size`)).rows.length === 0);
r = await api(pat.token, `/items?kind=eq.file&body_text=wfts(english).generator&select=id`);
check('Searching as Pat never finds it', r.status === 200 && r.rows.length === 0);
check('PDFs open in the browser', /^inline/.test((await down(olive.token, p.data.id)).headers.get('content-disposition')));

const d = await up(olive.token, spaces.volunteers, 'Shift handbook.docx', docx('Volunteers sign in at the DOCX-MARK-5520 table.'));
r = await api(olive.token, `/items?id=eq.${d.data.id}&select=body_text`);
check('A Word document uploads and its text is read', d.status === 201 && /DOCX-MARK-5520/.test(r.rows?.[0]?.body_text || ''), JSON.stringify(d.data));
check('Word documents download rather than open', /^attachment/.test((await down(olive.token, d.data.id)).headers.get('content-disposition')));

// ---------- types come from the bytes
const fake = await up(olive.token, spaces.festival, 'not really.pdf', 'just text pretending to be a PDF');
check('A file named .pdf that is not a PDF is stored as unknown, without text', fake.status === 201 && fake.data.mime === 'application/octet-stream' && !fake.data.has_text, JSON.stringify(fake.data));
check('and downloads instead of opening', /^attachment/.test((await down(olive.token, fake.data.id)).headers.get('content-disposition')));
const html = await up(olive.token, spaces.festival, 'page.html', '<script>alert(1)</script>');
r = await down(olive.token, html.data.id);
check('HTML never opens in the browser (it could run scripts)', html.status === 201 && /^attachment/.test(r.headers.get('content-disposition')) && r.headers.get('content-type') === 'application/octet-stream');
const img = await up(olive.token, spaces.festival, 'dot.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f60000000049454e44ae426082', 'hex'));
check('A picture is stored with its type, with a note that its text is not read', img.status === 201 && img.data.mime === 'image/png' && !img.data.has_text && /Pictures/.test(img.data.text_note || ''));

// ---------- limits and tokens
check('An empty file is refused', (await up(olive.token, spaces.festival, 'empty.txt', '')).status === 400);
check('A file over the size limit is refused', (await up(olive.token, spaces.festival, 'big.bin', Buffer.alloc(26 * 1024 * 1024))).status === 413);
check('A bad space id is refused', (await up(olive.token, 'not-a-space', 'a.txt', 'x')).status === 400);
check('No token: no download', (await down(null, txt.data.id)).status === 401);
const name = await up(olive.token, spaces.festival, '../../etc/passwd\u0000.txt', 'path trick');
check('File names cannot carry paths or control characters', name.status === 201 && !/[\/\\\u0000]/.test(name.data.title), name.data?.title);

// ---------- deleting
await api(olive.token, `/items?id=eq.${txt.data.id}`, { method: 'DELETE' });
check('Deleting the item deletes the file', (await down(olive.token, txt.data.id)).status === 404 && (await api(olive.token, `/file_info?item_id=eq.${txt.data.id}`)).rows.length === 0);
await api(pat.token, `/items?id=eq.${d.data.id}`, { method: 'DELETE' });
check('Pat cannot delete a Volunteers file', (await down(olive.token, d.data.id)).status === 200);
r = await api(olive.token, '/file_blobs', { method: 'PATCH', body: { mime: 'text/html' } });
check('Nobody can change a stored file in place', r.status === 401 || r.status === 403 || (r.rows || []).length === 0, String(r.status));

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
