// Spreadsheets suite. Runs inside the test stack's network (tests/run.sh) against the files service and
// the spreadsheet engine. Skipped (passing) when the engine is not set up; waits for it when it is starting.
// Proves: only editors make spreadsheets, edit or view is decided by row-level security and signed, the
// engine-only addresses need their own tokens, unsigned or misdirected saves are refused, a save runs as
// an editor who can still edit, final saves start a new session and periodic ones do not, files open as
// spreadsheets (xlsx, csv, tsv) and bad ones leave nothing behind, cell text (with dates) is searchable
// only by members, zip bombs are not read, and stored files (not spreadsheets) still never change.
import zlib from 'node:zlib';
import { SignJWT, decodeJwt } from 'jose';
const FILES = process.env.FILES || 'http://files:8095';
const AUTH = process.env.AUTH || 'http://svc:8081';
const API = process.env.API || 'http://postgrest:3000';
const OFFICE = process.env.OFFICE_INTERNAL_URL || 'http://office';
const SECRET = process.env.OFFICE_JWT_SECRET ? new TextEncoder().encode(process.env.OFFICE_JWT_SECRET) : null;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async (email) => (await (await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json());
const api = async (token, path, opts = {}) => {
  const r = await fetch(`${API}${path}`, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await r.text(); return { status: r.status, rows: t ? JSON.parse(t) : null };
};
const files = async (token, path, opts = {}) => {
  const r = await fetch(`${FILES}${path}`, { method: opts.method || 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: opts.body });
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
};
const make = (token, space, name, body) => files(token, `/files/spreadsheets?space=${space}&name=${encodeURIComponent(name)}`, { method: 'POST', body });
const sign = (payload) => new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(SECRET);
const engine = async (path, body) => (await fetch(`${OFFICE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...body, token: await sign(body) }) })).json();
const blob = async (token, id) => (await api(token, `/items?id=eq.${id}&select=body_text,file_info(size)`)).rows?.[0];
const version = async (id) => decodeJwt((await files(olive.token, `/files/${id}/editor`)).data.config.token).document.key;

function zip(entries) {   // deflated, enough for a .xlsx
  const locals = []; const centrals = []; let off = 0;
  for (const [name, data] of Object.entries(entries)) {
    const raw = Buffer.from(data); const b = zlib.deflateRawSync(raw); const n = Buffer.from(name); const crc = zlib.crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    locals.push(h, n, b);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    centrals.push(c, n); off += 30 + n.length + b.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(entries).length, 8); e.writeUInt16LE(Object.keys(entries).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const xlsx = (rowsXml, styles = '') => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' + (styles ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : '') + '</Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Costs" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' + (styles ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : '') + '</Relationships>',
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
  ...(styles ? { 'xl/styles.xml': styles } : {}),
});

const st = await (await fetch(`${FILES}/files/office`, { headers: { Authorization: `Bearer ${(await login('alex.admin@example.com')).token}` } })).json().catch(() => ({}));
if (!st.enabled || !SECRET) { console.log('spreadsheets suite: the spreadsheet engine is not set up here; skipped'); process.exit(0); }
// The secret is set but the engine is not running here (no COMPOSE_PROFILES=office): nothing to test.
const probe = await fetch(`${OFFICE}/healthcheck`).then(() => 'up', (e) => (/ENOTFOUND|EAI_AGAIN/.test(String(e.cause?.code || e.cause)) ? 'absent' : 'up'));
if (probe === 'absent') { console.log('spreadsheets suite: the spreadsheet engine is not running in this stack; skipped'); process.exit(0); }
for (let i = 0; i < 36 && !(await fetch(`${OFFICE}/healthcheck`).then((r) => r.text()).catch(() => '')).includes('true'); i += 1) await sleep(5000);

const [alex, olive, vic, pat] = await Promise.all(['alex.admin', 'olive.organizer', 'vic.volunteer', 'pat.public'].map((n) => login(`${n}@example.com`)));
const spaces = Object.fromEntries((await api(alex.token, '/spaces?kind=eq.channel&select=id,name')).rows.map((s) => [s.name, s.id]));
check('The engine reports ready', (await files(olive.token, '/files/office')).data?.ready === true);

// ---------- making
let r = await make(olive.token, spaces.festival, 'Budget.xlsx');
const sheet = r.data;
check('An editor makes a blank spreadsheet; a typed .xlsx is not kept in its name', r.status === 201 && sheet.title === 'Budget', sheet?.title);
check('A viewer cannot make one', (await make(pat.token, spaces.festival, 'Nope')).status === 403);
check('A non-member cannot make one', (await make(vic.token, spaces.organizers, 'Nope')).status === 403);
check('No token: nothing', (await make(null, spaces.festival, 'Nope')).status === 401);
r = await files(olive.token, `/files/${sheet.id}`);
check('It downloads as Budget.xlsx', r.status === 200 && /filename="Budget\.xlsx"/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));

// ---------- the editor configuration
const cfgO = (await files(olive.token, `/files/${sheet.id}/editor`)).data;
const cfgP = (await files(pat.token, `/files/${sheet.id}/editor`)).data;
check('An editor gets edit mode', cfgO.edit === true && cfgO.config.editorConfig.mode === 'edit' && cfgO.config.document.permissions.edit === true);
check('A viewer gets view mode, signed that way', cfgP.edit === false && decodeJwt(cfgP.config.token).editorConfig.mode === 'view' && decodeJwt(cfgP.config.token).document.permissions.edit === false);
check('Editor and viewer join one session (same key)', cfgO.config.document.key === cfgP.config.document.key);
check('The signed configuration expires within ten minutes', (decodeJwt(cfgO.config.token).exp - Date.now() / 1000) <= 600);
check('Plugins (and the engine\'s AI) are off', cfgO.config.editorConfig.customization.plugins === false);
const secret = (await make(olive.token, spaces.organizers, 'Secret plan')).data;
check('A non-member gets no configuration', (await files(vic.token, `/files/${secret.id}/editor`)).status === 404);
check('A malformed id is a 404, not a crash', (await files(olive.token, '/files/------------------------------------/editor')).status === 404 && (await files(null, '/files/healthz')).status === 200);
check('Tables are not spreadsheets', (await files(olive.token, `/files/${(await api(olive.token, '/items?kind=eq.table&select=id&limit=1')).rows[0]?.id}/editor`)).status === 404);

// ---------- engine-only addresses
const ftok = new URL(cfgO.config.document.url).searchParams.get('t');
const stok = new URL(cfgO.config.editorConfig.callbackUrl).searchParams.get('t');
check('The sheet\'s bytes need a token', (await files(null, `/files/${sheet.id}/office-file`)).status === 403);
check('A file token works for its own sheet', (await fetch(`${FILES}/files/${sheet.id}/office-file?t=${ftok}`)).status === 200);
check('A file token does not work for another sheet', (await fetch(`${FILES}/files/${secret.id}/office-file?t=${ftok}`)).status === 403);
check('A file token cannot save', (await fetch(`${FILES}/files/${sheet.id}/office-save?t=${ftok}`, { method: 'POST', body: '{}' })).status === 403);
check('An unsigned save is refused', (await fetch(`${FILES}/files/${sheet.id}/office-save?t=${stok}`, { method: 'POST', body: JSON.stringify({ status: 2, url: `${OFFICE}/cache/files/x`, users: [] }) })).status === 403);

// ---------- saving (a real engine-made file: a conversion stands in for an edit)
const conv = await make(olive.token, spaces.festival, 'source.csv', 'Item,Cost\nStage lights,1350\n');
const convRes = (await engine('/converter', { async: false, filetype: 'xlsx', outputtype: 'xlsx', key: `t-${Date.now()}`, title: 'a.xlsx',
  url: `${FILES}/files/${conv.data.id}/office-file?t=${await new SignJWT({ item: conv.data.id, sub: olive.user?.id || decodeJwt(olive.token).sub, use: 'file' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(SECRET)}` }));
const convUrl = convRes.fileUrl;
if (!convUrl) { console.log('conversion fixture:', JSON.stringify(convRes), 'csv import status', conv.status, JSON.stringify(conv.data)); }
check('The engine converts on request (test fixture)', !!convUrl, JSON.stringify(convRes));
const save = async (body) => (await fetch(`${FILES}/files/${sheet.id}/office-save?t=${stok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: await sign({ key: cfgO.config.document.key, ...body }) }) })).json();
const v0 = await version(sheet.id);
const patId = decodeJwt(pat.token).sub; const oliveId = decodeJwt(olive.token).sub; const vicId = decodeJwt(vic.token).sub;
// The callback address was made for Olive, so a save from only-viewers still falls back to her (she can edit);
// to see a refusal, use a sheet whose callback was made for someone who has since lost access.
r = await save({ status: 6, url: convUrl, users: [patId] });
let b = await blob(olive.token, sheet.id);
check('A periodic save (status 6) lands, as an editor (the viewer is skipped)', r.error === 0 && /Stage lights\t1350/.test(b.body_text), b.body_text);
check('A periodic save keeps the session (same key)', (await version(sheet.id)) === v0);
r = await save({ status: 2, url: convUrl, users: [oliveId] });
check('A final save (status 2) lands and starts a new session', r.error === 0 && (await version(sheet.id)) !== v0);
check('A save from anywhere but the engine\'s cache is refused', (await save({ status: 2, url: 'http://office/etc/passwd', users: [oliveId] })).error === 1);
check('A save naming another host is still fetched only from the engine', (await save({ status: 6, url: convUrl.replace(/^https?:\/\/[^/]+/, 'http://evil.example'), users: [oliveId] })).error === 0);
check('Status 1 and 4 change nothing', (await save({ status: 4, users: [oliveId] })).error === 0 && (await save({ status: 1, users: [oliveId] })).error === 0);
// Someone who lost access: Vic made a callback address on a Volunteers sheet, then is no longer an editor there.
const vs = (await make(vic.token, spaces.volunteers, 'Vic sheet')).data;
const vcfg = (await files(vic.token, `/files/${vs.id}/editor`)).data;
await api(alex.token, `/members?space_id=eq.${spaces.volunteers}&user_id=eq.${vicId}`, { method: 'PATCH', body: { role: 'viewer' } });
const vsave = await (await fetch(vcfg.config.editorConfig.callbackUrl.replace('http://files:8095', FILES), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: await sign({ key: vcfg.config.document.key, status: 2, url: convUrl, users: [vicId] }) }) })).json();
check('A save from people who can no longer edit is refused', vsave.error === 1 && !(await blob(alex.token, vs.id)).body_text);
await api(alex.token, `/members?space_id=eq.${spaces.volunteers}&user_id=eq.${vicId}`, { method: 'PATCH', body: { role: 'editor' } });

// ---------- opening files as spreadsheets
r = await make(olive.token, spaces.festival, 'costs.csv', 'Item,Cost\nTent rental,4200\n"Café, chairs",310\n');
b = r.status === 201 && await blob(olive.token, r.data.id);
check('A CSV file opens as a spreadsheet (converted by the engine)', r.status === 201 && r.data.title === 'costs' && /Tent rental\t4200/.test(b.body_text) && /Café, chairs\t310/.test(b.body_text), b?.body_text);
r = await make(olive.token, spaces.festival, 'shifts.tsv', 'Name\tHours\nVic\t6\n');
check('A TSV file opens as a spreadsheet', r.status === 201 && /Vic\t6/.test((await blob(olive.token, r.data.id)).body_text));
const dated = xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>Pickup</t></is></c><c r="B1" s="1"><v>46341</v></c><c r="C1"><v>46341</v></c></row>',
  '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>');
r = await make(olive.token, spaces.festival, 'dates.xlsx', dated);
check('An .xlsx opens as is; a date cell is indexed as a date, a plain number as a number', r.status === 201 && (await blob(olive.token, r.data.id)).body_text === 'Costs\nPickup\t2026-11-15\t46341', (await blob(olive.token, r.data.id))?.body_text);
check('Other kinds of file are refused', (await make(olive.token, spaces.festival, 'notes.pdf', '%PDF-1.4')).status === 400);
const before = (await api(olive.token, '/items?kind=eq.spreadsheet&select=id')).rows.length;
r = await make(olive.token, spaces.festival, 'broken.ods', Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(3000, 1)]));   // a zip header, then junk (the engine reads any .xls as text, so not that)
check('A file the engine cannot read is refused and leaves nothing behind', r.status === 422 && (await api(olive.token, '/items?kind=eq.spreadsheet&select=id')).rows.length === before, String(r.status));
check('A viewer cannot open a file as a spreadsheet in their space', (await make(pat.token, spaces.festival, 'x.csv', 'a,b\n1,2\n')).status === 403);

// ---------- search and visibility
await save({ status: 2, url: convUrl, users: [oliveId] });
const findFor = async (who, q) => (await api(who.token, '/rpc/search', { method: 'POST', body: { p_q: q, p_limit: 10 } })).rows.filter((x) => x.kind === 'spreadsheet');
check('A member finds a spreadsheet by a cell', (await findFor(pat, 'stage lights')).some((x) => x.id === sheet.id));
await (await fetch(`${FILES}/files/${secret.id}/office-save?t=${new URL((await files(olive.token, `/files/${secret.id}/editor`)).data.config.editorConfig.callbackUrl).searchParams.get('t')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: await sign({ status: 2, url: convUrl, users: [oliveId] }) }) })).json();
check('A non-member does not', !(await findFor(vic, 'stage lights')).some((x) => x.id === secret.id) && (await findFor(olive, 'stage lights')).some((x) => x.id === secret.id));

// ---------- hard limits
const bomb = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>', 'xl/worksheets/sheet1.xml': Buffer.concat([Buffer.from('<'), Buffer.alloc(120 * 1024 * 1024, 32), Buffer.from('/>')]) });
r = await files(olive.token, `/files?space=${spaces.festival}&name=bomb.xlsx`, { method: 'POST', body: bomb });
check('A zip bomb is stored, not read, and the service stays up', r.status === 201 && !r.data.has_text && (await files(null, '/files/healthz')).status === 200, `${bomb.length} bytes`);
const plain = await files(olive.token, `/files?space=${spaces.festival}&name=a.txt`, { method: 'POST', body: 'unchanging' });
r = await api(olive.token, `/file_blobs?item_id=eq.${plain.data.id}`, { method: 'PATCH', body: { size: 1 } });
check('A stored file (not a spreadsheet) still never changes in place', (r.rows || []).length === 0, String(r.status));
r = await api(pat.token, `/file_blobs?item_id=eq.${sheet.id}`, { method: 'PATCH', body: { size: 1 } });
check('A viewer cannot change a spreadsheet\'s bytes', (r.rows || []).length === 0, String(r.status));
await api(olive.token, `/items?id=eq.${sheet.id}`, { method: 'DELETE' });
check('Deleting the spreadsheet deletes its bytes', (await files(olive.token, `/files/${sheet.id}/editor`)).status === 404 && (await api(olive.token, `/file_info?item_id=eq.${sheet.id}`)).rows.length === 0);

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\nspreadsheets: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
