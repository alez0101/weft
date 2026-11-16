// Reading and editing the cells of an .xlsx spreadsheet without the spreadsheet engine (075), so @Weft can see
// where things are (A1, B2, ...) and, after the person confirms, add rows or set cells. Only the worksheet XML of
// the one sheet changes; every other part of the file (styles, other sheets, charts) is copied as it was.
//   readGrid(bytes, sheet?)               -> { sheets, sheet, rows: [{ r, cells: { A: 'shown value', ... } }], more }
//   applyEdits(bytes, { sheet?, append_rows?, set? }) -> { bytes, sheet, previous: [{ cell, value }] } (what each changed
//                                       cell held before, for undo), or throws an Error with .user (a message to show)
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const PART_MAX = 40 * 1024 * 1024;   // as in index.mjs: a zip bomb stops here
const P = '(?:[\\w-]+:)?';
const attr = (tag, name) => new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(tag)?.[1];
const unxml = (t) => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const userError = (m) => Object.assign(new Error(m), { user: m });

export const colNum = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const colName = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const REF = /^([A-Z]{1,3})([1-9]\d{0,6})$/;

function unzip(bytes) {
  let total = 0;
  return unzipSync(new Uint8Array(bytes), {
    filter: (f) => { total += f.originalSize; if (f.originalSize > PART_MAX || total > PART_MAX * 3) throw userError('This workbook is too large to change here.'); return true; },
  });
}

// The workbook's sheets: [{ name, path }], in order.
function sheetsOf(z) {
  const get = (n) => (z[n] ? strFromU8(z[n]) : '');
  const rels = {};
  for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<(?:[\w-]+:)?Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], 'Id'), target = attr(m[1], 'Target');
    if (id && target) rels[id] = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  return [...get('xl/workbook.xml').matchAll(new RegExp(`<${P}sheet\\b([^>]*)/?>`, 'g'))]
    .map((m) => ({ name: unxml(attr(m[1], 'name') || 'Sheet'), path: rels[attr(m[1], 'id')] }))
    .filter((s) => s.path && z[s.path]);
}
function pick(sheets, name) {
  if (!sheets.length) throw userError('This workbook has no sheets.');
  if (!name) return sheets[0];
  const s = sheets.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!s) throw userError(`There is no sheet called "${name}". Sheets: ${sheets.map((x) => x.name).join(', ')}.`);
  return s;
}

// Rows and their cells, keeping each piece of XML as it was so unchanged rows are written back byte for byte.
function parseSheet(xml) {
  const sd = new RegExp(`<(${P})sheetData\\b([^>]*?)(/>|>([\\s\\S]*?)</${P}sheetData>)`).exec(xml);
  if (!sd) throw userError('This sheet could not be read.');
  const pre = sd[1];
  const rows = []; let nextR = 1;
  for (const m of (sd[4] || '').matchAll(new RegExp(`<${P}row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}row>)`, 'g'))) {
    const r = Number(attr(m[1], 'r')) || nextR; nextR = r + 1;
    const cells = []; let nextC = 1;
    for (const c of (m[2] || '').matchAll(new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g'))) {
      const ref = REF.exec(attr(c[1], 'r') || '');
      const col = ref ? colNum(ref[1]) : nextC; nextC = col + 1;
      cells.push({ col, attrs: c[1], body: c[2] || '', xml: c[0] });
    }
    rows.push({ r, attrs: m[1], cells, xml: m[0], changed: false });
  }
  return { pre, rows, start: sd.index, end: sd.index + sd[0].length, open: `<${pre}sheetData${sd[2]}>`, close: `</${pre}sheetData>` };
}

export function readGrid(bytes, sheetName = null, maxRows = 1500) {
  const z = unzip(bytes);
  const get = (n) => (z[n] ? strFromU8(z[n]) : '');
  const sheets = sheetsOf(z);
  const s = pick(sheets, sheetName);
  const shared = [...get('xl/sharedStrings.xml').matchAll(new RegExp(`<${P}si\\b[^>]*>([\\s\\S]*?)</${P}si>`, 'g'))]
    .map((m) => unxml([...m[1].matchAll(new RegExp(`<${P}t\\b[^>]*>([\\s\\S]*?)</${P}t>`, 'g'))].map((t) => t[1]).join('')));
  const fmts = Object.fromEntries([...get('xl/styles.xml').matchAll(new RegExp(`<${P}numFmt\\b([^>]*)/?>`, 'g'))].map((m) => [attr(m[1], 'numFmtId'), unxml(attr(m[1], 'formatCode') || '')]));
  const isDate = (id) => {
    const n = Number(id);
    if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47)) return true;
    const code = (fmts[id] || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dy]/i.test(code) || (/h/i.test(code) && /m/i.test(code));
  };
  const xfs = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`).exec(get('xl/styles.xml'))?.[1] || '';
  const dateStyle = [...xfs.matchAll(new RegExp(`<${P}xf\\b([^>]*?)/?>`, 'g'))].map((m) => isDate(attr(m[1], 'numFmtId') || '0'));
  const asDate = (v) => {
    const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 2958465) return v;
    const iso = new Date(Math.round((x - 25569) * 86400000)).toISOString();
    return x < 1 ? iso.slice(11, 16) : Number.isInteger(x) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  };
  const { rows } = parseSheet(get(s.path));
  const out = [];
  for (const row of rows) {
    const cells = {};
    for (const c of row.cells) {
      const t = attr(c.attrs, 't');
      const v = new RegExp(`<${P}v>([\\s\\S]*?)</${P}v>`).exec(c.body)?.[1];
      const f = new RegExp(`<${P}f\\b[^>]*>([\\s\\S]*?)</${P}f>`).exec(c.body)?.[1];
      const val = t === 's' ? shared[+v] : t === 'inlineStr' ? unxml(new RegExp(`<${P}is>([\\s\\S]*?)</${P}is>`).exec(c.body)?.[1] || '')
        : v === undefined ? '' : (!t || t === 'n') && dateStyle[Number(attr(c.attrs, 's') || 0)] ? asDate(v) : unxml(v);
      const shown = f ? `${val ?? ''} (formula =${unxml(f)})`.trim() : val;
      if (shown !== undefined && shown !== '') cells[colName(c.col)] = shown;
    }
    if (Object.keys(cells).length) out.push({ r: row.r, cells });
  }
  return { sheets: sheets.map((x) => x.name), sheet: s.name, rows: out.slice(0, maxRows), more: Math.max(0, out.length - maxRows) };
}

// One cell's XML for a value: a number, a formula (text starting with =) or text (inline, so the shared-string
// table is left alone). The cell keeps its style.
function cellXml(pre, ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  const v = value === null || value === undefined ? '' : String(value);
  if (v === '') return `<${pre}c r="${ref}"${s}/>`;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim()) && v.trim().length < 16) return `<${pre}c r="${ref}"${s}><${pre}v>${v.trim()}</${pre}v></${pre}c>`;
  if (v.startsWith('=') && v.length > 1) return `<${pre}c r="${ref}"${s}><${pre}f>${esc(v.slice(1))}</${pre}f></${pre}c>`;
  return `<${pre}c r="${ref}"${s} t="inlineStr"><${pre}is><${pre}t xml:space="preserve">${esc(v.slice(0, 32767))}</${pre}t></${pre}is></${pre}c>`;
}

export function applyEdits(bytes, { sheet = null, append_rows = [], set = [] } = {}) {
  const z = unzip(bytes);
  const s = pick(sheetsOf(z), sheet);
  let xml = strFromU8(z[s.path]);
  const shared = z['xl/sharedStrings.xml'] ? [...strFromU8(z['xl/sharedStrings.xml']).matchAll(new RegExp(`<${P}si\\b[^>]*>([\\s\\S]*?)</${P}si>`, 'g'))]
    .map((m) => unxml([...m[1].matchAll(new RegExp(`<${P}t\\b[^>]*>([\\s\\S]*?)</${P}t>`, 'g'))].map((t) => t[1]).join(''))) : [];
  // A cell's stored value as it could be written back: its formula, text or number.
  const raw = (c) => {
    if (!c) return '';
    const f = new RegExp(`<${P}f\\b[^>]*>([\\s\\S]*?)</${P}f>`).exec(c.body)?.[1];
    if (f) return `=${unxml(f)}`;
    const t = attr(c.attrs, 't'); const v = new RegExp(`<${P}v>([\\s\\S]*?)</${P}v>`).exec(c.body)?.[1];
    if (t === 's') return shared[+v] ?? '';
    if (t === 'inlineStr') return unxml(new RegExp(`<${P}is>([\\s\\S]*?)</${P}is>`).exec(c.body)?.[1] || '');
    return v === undefined ? '' : unxml(v);
  };
  const previous = new Map();
  const sh = parseSheet(xml);
  const { pre } = sh;
  const rowAt = (r) => {
    let row = sh.rows.find((x) => x.r === r);
    if (!row) { row = { r, attrs: ` r="${r}"`, cells: [], xml: '', changed: true }; sh.rows.push(row); sh.rows.sort((a, b) => a.r - b.r); }
    return row;
  };
  const put = (row, col, value) => {
    const i = row.cells.findIndex((c) => c.col === col);
    const old = i >= 0 ? row.cells[i] : null;
    const ref = `${colName(col)}${row.r}`;
    if (!previous.has(ref)) previous.set(ref, raw(old));
    if (old && /<(?:[\w-]+:)?f\b[^>]*\bt="shared"[^>]*\bref=/.test(old.body)) throw userError(`${colName(col)}${row.r} holds a shared formula; change it in the spreadsheet itself.`);
    const c = { col, xml: cellXml(pre, `${colName(col)}${row.r}`, value, old ? attr(old.attrs, 's') : null) };
    if (old) row.cells[i] = c; else { row.cells.push(c); row.cells.sort((a, b) => a.col - b.col); }
    row.changed = true;
  };
  for (const e of set) {
    const m = REF.exec(String(e.cell || '').toUpperCase().trim());
    if (!m) throw userError(`"${e.cell}" is not a cell like B4.`);
    if (colNum(m[1]) > 16384) throw userError(`"${e.cell}" is past the last column.`);
    put(rowAt(Number(m[2])), colNum(m[1]), e.value);
  }
  let last = sh.rows.filter((x) => x.cells.length).reduce((n, x) => Math.max(n, x.r), 0);
  for (const values of append_rows) {
    const row = rowAt(++last);
    values.forEach((v, k) => { if (v !== null && v !== undefined && String(v) !== '') put(row, k + 1, v); });
  }
  if (last > 1048576) throw userError('That would go past the last row.');
  const body = sh.rows.map((row) => (row.changed
    ? `<${pre}row${row.attrs.replace(/\s(?:[\w-]+:)?r="[^"]*"/, '').replace(/\s(?:[\w-]+:)?spans="[^"]*"/, '')} r="${row.r}">${row.cells.map((c) => c.xml).join('')}</${pre}row>`
    : row.xml)).join('');
  xml = xml.slice(0, sh.start) + sh.open + body + sh.close + xml.slice(sh.end);
  xml = xml.replace(new RegExp(`<${P}dimension\\b[^>]*/>`), '');   // optional; stale after an edit, so dropped
  z[s.path] = strToU8(xml);
  delete z['xl/calcChain.xml'];   // formula order cache: rebuilt by the engine on open
  if (z['[Content_Types].xml']) z['[Content_Types].xml'] = strToU8(strFromU8(z['[Content_Types].xml']).replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
  if (z['xl/_rels/workbook.xml.rels']) z['xl/_rels/workbook.xml.rels'] = strToU8(strFromU8(z['xl/_rels/workbook.xml.rels']).replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, ''));
  return { bytes: Buffer.from(zipSync(z, { level: 6 })), sheet: s.name, previous: [...previous].map(([cell, value]) => ({ cell, value })) };
}
