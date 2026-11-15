// Download as a file (066): plain files built in the browser from rows the screen already read as the person,
// through the API and row-level security. Nothing is sent anywhere; the file is made here and saved by the
// browser. CSV for lists (Expenses, Inventory, Contacts, Form answers), iCalendar (.ics, RFC 5545) for a
// channel's events, vCard 3.0 (.vcf, RFC 2426) for contacts.

// A file name from a title: no characters a file system refuses, never empty.
export const fileName = (title, fallback, ext) => `${String(title ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || fallback}.${ext}`;

// Save text as a file. A link with `download` keeps it in the browser (no request leaves it).
export function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- CSV
// A spreadsheet must not run a cell as a formula, so text starting with = + - @ (or a tab or return) gets a
// leading apostrophe. Numbers are given as numbers and left alone.
export const csvCell = (v) => {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// With a byte order mark, so a spreadsheet opens accented names as UTF-8; lines end with CRLF (RFC 4180).
export const toCsv = (header, rows) => `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
export const saveCsv = (title, fallback, header, rows) => saveFile(fileName(title, fallback, 'csv'), toCsv(header, rows), 'text/csv;charset=utf-8');
// Money as a plain number with two decimals (12.50), whatever the screen's language, so sums work.
// A time as the local day (YYYY-MM-DD).
export const localDay = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
export const plainMoney = (cents) => (cents / 100).toFixed(2);

// ---- iCalendar and vCard share escaping and line folding.
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
const enc = new TextEncoder();
// Lines longer than 75 octets are folded: CRLF and one space, never inside a character.
function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = ''; let n = 0; let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > limit) { out.push(cur); cur = ''; n = 0; limit = 74; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const lines = (ls) => `${ls.filter(Boolean).map(fold).join('\r\n')}\r\n`;
const utc = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// events: [{id, title, starts_at, ends_at, location}]. Times in UTC, so every calendar app shows them at the
// right local time. The UID is the event's id, so importing the file again updates rather than duplicates.
export function toIcs(name, events, now = new Date()) {
  const stamp = utc(now.toISOString());
  return lines([
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Weft//Download as a file//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    ...events.flatMap((e) => [
      'BEGIN:VEVENT', `UID:${e.id}@weft`, `DTSTAMP:${stamp}`, `DTSTART:${utc(e.starts_at)}`, `DTEND:${utc(e.ends_at)}`,
      `SUMMARY:${esc(e.title)}`, e.location ? `LOCATION:${esc(e.location)}` : '', 'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ]);
}

// contacts: [{name, organisation, phone, email, notes}]. One card each; N splits the last word off as the
// family name (a guess, but address books need the field).
export function toVcard(contacts) {
  return contacts.map((c) => {
    const words = c.name.trim().split(/\s+/);
    const family = words.length > 1 ? words.pop() : '';
    return lines([
      'BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name)}`, `N:${esc(family)};${esc(words.join(' '))};;;`,
      c.organisation ? `ORG:${esc(c.organisation)}` : '', c.phone ? `TEL;TYPE=VOICE:${esc(c.phone)}` : '',
      c.email ? `EMAIL;TYPE=INTERNET:${esc(c.email)}` : '', c.notes ? `NOTE:${esc(c.notes)}` : '', 'END:VCARD',
    ]);
  }).join('');
}
