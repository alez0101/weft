// weft-assistant: answers @Weft questions, and the admin provider settings.
//
//   POST /assistant/ask                      {message_id}  the asker's Weft token
//   GET  /assistant/admin/providers          admin only; never returns a key
//   PUT  /assistant/admin/providers/:slot    admin only; settings
//   PUT  /assistant/admin/providers/:slot/key    admin only; {key} write-only, encrypted here
//   DELETE /assistant/admin/providers/:slot/key  admin only
//   POST /assistant/admin/providers/:slot/test   admin only; a tiny live call
//   POST /assistant/agents/ask               {message_id}  ask one of your own agents (202; the reply arrives live)
//   GET/POST /assistant/admin/agents, PUT/DELETE /assistant/admin/agents/:id, PUT/DELETE .../:id/key,
//   POST .../:id/test                        admin only; personal agents
//
// The assistant never reads the database directly. For each question it mints a short-lived
// weft_assistant token for the asker (and, in a channel, scoped to that channel) and goes through
// PostgREST, so row-level security bounds everything it can see or write.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { jwtVerify, SignJWT } from 'jose';

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const MASTER = Buffer.from(env('ASSIST_MASTER_KEY'), 'hex');
if (MASTER.length !== 32) throw new Error('ASSIST_MASTER_KEY must be 32 bytes of hex');
const API = env('POSTGREST_URL', 'http://postgrest:3000');
const ASSISTANT_ID = '00000000-0000-4000-8000-00000000a001';
const CALL_TIMEOUT_MS = Number(env('CALL_TIMEOUT_MS', '120000'));
// How much an Anthropic model may read for one question (characters; ~4 per token). The numbered items start
// with up to EXCERPT_BUDGET between them, a short document whole; read_item and search may add up to READ_BUDGET
// more. Other models (the local fallback) keep short excerpts. The whole question must finish inside DEADLINE_MS,
// under the web server's 150 s wait.
const EXCERPT_BUDGET = Number(env('ASSIST_EXCERPT_BUDGET_CHARS', '32000'));
const ITEM_WHOLE_MAX = Number(env('ASSIST_ITEM_WHOLE_CHARS', '8000'));   // longer items start as excerpts
const READ_BUDGET = Number(env('ASSIST_READ_BUDGET_CHARS', '400000'));
const MAX_ROUNDS = Number(env('ASSIST_MAX_ROUNDS', '5'));
const DEADLINE_MS = Number(env('ASSIST_DEADLINE_MS', '130000'));
const MAX_OUT = Number(env('ASSIST_MAX_OUTPUT_TOKENS', '16000'));
const HISTORY = Number(env('ASSIST_HISTORY_MESSAGES', '12'));
// Where personal keys are used. Set by the server, never by the person, so a personal setting cannot
// point the assistant anywhere else (empty for Anthropic = the SDK's official endpoint).
const PERSONAL_ANTHROPIC_URL = env('PERSONAL_ANTHROPIC_URL', '');
const PERSONAL_OPENAI_URL = env('PERSONAL_OPENAI_URL', 'https://api.openai.com/v1');
// Meaning search: an Ollama server with nomic-embed-text (EMBED_URL, e.g. http://ollama-host:11434).
// Empty: meaning search is off and the assistant uses keyword search only.
const EMBED_URL = env('EMBED_URL', '');
const EMBED_MODEL = env('EMBED_MODEL', 'nomic-embed-text');
const EMBED_DIM = Number(env('EMBED_DIM', '768'));
const MAX_DISTANCE = Number(env('SEMANTIC_MAX_DISTANCE', '0.7'));
// Where confirmed content changes go: the files service (new spreadsheets) and collab's internal edit port
// (documents and wiki pages, so people with the page open see the edit live).
const FILES_URL = env('FILES_URL', 'http://files:8095');
const COLLAB_EDIT = env('COLLAB_EDIT_URL', 'http://collab:1235');
const db = new pg.Pool({ connectionString: env('DATABASE_URL_ASSIST'), max: 4 });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- keys at rest
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(blob) {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('unknown key format');
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- tokens and the API
async function userFrom(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    // agent: a token minted for a connected AI app (070). It may only search; everything else here acts or
    // posts, and an AI app changes things only in the person's personal space, through the API.
    return payload.role === 'weft_user' && payload.sub ? { id: payload.sub, token: m[1], agent: payload.agent === true } : null;
  } catch { return null; }
}
const assistantToken = (sub, scope, extra = {}) => new SignJWT({ role: 'weft_assistant', ...(scope ? { scope_space: scope } : {}), ...extra })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(sub).setIssuedAt().setExpirationTime('120s').sign(JWT_SECRET);

async function rest(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`API ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- retrieval
const STOP = new Set('a an and are as at be but by can could do does for from has have how i in is it me my of on or our please should so tell than that the their them there these they this to was we what when where which who why will with would you your weft'.split(' '));
const SELECT = 'id,space_id,body,created_at,author:users(display_name,is_assistant),space:spaces(name,kind)';
const ISELECT = 'id,space_id,kind,title,body_text,managed,space:spaces(name,kind)';
const ESELECT = 'id,space_id,title,location,starts_at,ends_at,space:spaces(name,kind),project:projects(name)';
const TIMEY = /\b(when|schedule|calendar|event|events|meeting|set|sets|shift|shifts|today|tomorrow|saturday|sunday|week|time|move|reschedule|start|starts)\b/i;
// Records: rows of the apps that are not items (048, weft.records), read through a view that runs as the caller.
const RSELECT = 'kind,id,space_id,title,body,at,ref';
const RKINDS = ['announcement', 'rsvps', 'resource', 'shift', 'timeoff', 'kudos', 'milestone', 'journal', 'profile'];
const RLABEL = { announcement: 'announcement', rsvps: 'answers to an event (who is going, maybe or not going)', resource: 'thing to book (with its bookings)', shift: 'shift (with who signed up)', timeoff: 'time off', kudos: 'kudos (a thank-you)', milestone: 'timeline milestone', journal: 'page of the person\'s own private journal (only they can read it)', profile: 'profile' };
const RCITE = { announcement: 'Announcement', rsvps: 'RSVPs', resource: 'Booking', shift: 'Shift', timeoff: 'Time off', kudos: null, milestone: 'Milestone', journal: 'Your journal', profile: 'Profile' };
const where = (s) => (s?.kind === 'channel' ? `#${s.name}` : s?.kind === 'personal' ? 'your personal space' : s?.kind === 'dm' ? 'a direct message' : 'your Weft conversation');

// A short excerpt of a document: the paragraphs that mention the question's words, else its start.
function excerpt(text, terms, max = 1200) {
  const paras = String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (max > 1200) return paras.join('\n').slice(0, max); // a table: as much of it as fits, rows intact
  const hits = paras.filter((x) => terms.some((w) => x.toLowerCase().includes(w)));
  return (hits.length ? hits : paras).join(' / ').slice(0, max);
}
// For the larger budget: the whole text if it fits; otherwise the passage search-by-meaning found, then the
// paragraphs that mention the question's words, in page order, then the start, up to max.
function budgetText(full, terms, max, chunk = null) {
  full = String(full || '');
  if (full.length <= max) return { text: full, whole: true };
  const paras = full.split(/\n+/);
  const keep = new Set();
  const head = chunk ? `${chunk}\n…\n` : '';
  let used = head.length;
  paras.forEach((x, k) => { if (used < max && terms.some((w) => x.toLowerCase().includes(w))) { keep.add(k); used += x.length + 1; } });
  for (let k = 0; k < paras.length && used < max; k++) if (!keep.has(k)) { keep.add(k); used += paras[k].length + 1; }
  return { text: head + paras.filter((_, k) => keep.has(k)).join('\n').slice(0, Math.max(0, max - head.length)), whole: false };
}

// Messages, documents and events matching the question, all read with the assistant token, so
// row-level security (and, in a channel, the scope_space claim) bounds what can be found.
async function retrieve(token, question, spaceId, scoped, excludeId, projectId = null) {
  const terms = [...new Set(question.toLowerCase().replace(/@weft\b/g, ' ').match(/[a-z0-9][a-z0-9'-]{1,}/g) || [])]
    .filter((w) => !STOP.has(w)).slice(0, 8);
  const out = new Map();
  const put = (key, v) => { if (!out.has(key)) out.set(key, v); };
  const msg = (r) => { if (!r.author?.is_assistant && r.space?.kind !== 'assistant' && r.id !== excludeId && !/@weft\b/i.test(r.body)) put(`m${r.id}`, { type: 'message', ...r }); };
  const q = terms.length ? encodeURIComponent(`"${terms.join(' or ').replace(/"/g, '')}"`) : null;
  if (q) {
    (await rest(token, `/messages?select=${SELECT}&body=wfts(english).${encodeURIComponent(terms.join(' or '))}&order=created_at.desc&limit=12`)).forEach(msg);
    // The team's own items before Weft's published help and admin pages (managed), newest first: the 6 kept are
    // then the likely ones, not whichever rows came first.
    (await rest(token, `/items?select=${ISELECT}&or=(title.wfts(english).${q},body_text.wfts(english).${q})&order=managed.asc,updated_at.desc&limit=6`))
      .forEach((r) => put(`i${r.id}`, { type: 'item', ...r, terms, text: excerpt(r.body_text, terms, r.kind === 'table' || r.kind === 'tasklist' ? 3500 : 1200) }));
    (await rest(token, `/events?select=${ESELECT}&or=(title.wfts(english).${q},location.wfts(english).${q})&order=starts_at&limit=10`))
      .forEach((r) => put(`e${r.id}`, { type: 'event', ...r }));
    (await rest(token, `/records?select=${RSELECT}&or=(title.wfts(english).${q},body.wfts(english).${q})&order=at.desc&limit=8`))
      .forEach((r) => put(`r${r.kind}${r.id}`, { type: 'record', ...r, text: excerpt(r.body, terms) }));
  }
  // The conversation it was asked in: the channel's general chat, or the project's own chat (069).
  if (scoped) (await rest(token, `/messages?select=${SELECT}&space_id=eq.${spaceId}&project_id=${projectId ? `eq.${projectId}` : 'is.null'}&order=created_at.desc&limit=15`)).forEach(msg);
  if (TIMEY.test(question)) {
    (await rest(token, `/events?select=${ESELECT}&ends_at=gte.${new Date().toISOString()}&order=starts_at&limit=10`)).forEach((r) => put(`e${r.id}`, { type: 'event', ...r }));
  }
  // Meaning, not just words: nearest neighbours of the question, read with the same token, so RLS and
  // the channel scope apply exactly as above. If the embedder is down, keyword results stand alone.
  try {
    const [qv] = await embed([`search_query: ${question}`]);
    const hits = (await rest(token, '/rpc/semantic_search', { method: 'POST', body: { p_query: `[${qv.join(',')}]`, p_limit: 12 } }))
      .filter((h) => h.distance <= MAX_DISTANCE);
    const ids = (type) => [...new Set(hits.filter((h) => h.source_type === type).map((h) => h.source_id))];
    const chunkOf = new Map(hits.filter((h) => h.source_type === 'item').map((h) => [h.source_id, h.content]));
    const mIds = ids('message'); const iIds = ids('item'); const eIds = ids('event');
    const rHits = hits.filter((h) => RKINDS.includes(h.source_type));
    if (mIds.length) (await rest(token, `/messages?select=${SELECT}&id=in.(${mIds.join(',')})`)).forEach(msg);
    if (iIds.length) (await rest(token, `/items?select=${ISELECT}&id=in.(${iIds.join(',')})`))
      .forEach((r) => put(`i${r.id}`, { type: 'item', ...r, terms, chunk: chunkOf.get(r.id)?.replace(/^[^\n]*\n/, '') || null, text: (chunkOf.get(r.id) || excerpt(r.body_text, terms)).replace(/^[^\n]*\n/, '') }));
    if (eIds.length) (await rest(token, `/events?select=${ESELECT}&id=in.(${eIds.join(',')})`)).forEach((r) => put(`e${r.id}`, { type: 'event', ...r }));
    if (rHits.length) {
      const want = new Set(rHits.map((h) => `${h.source_type}${h.source_id}`));
      (await rest(token, `/records?select=${RSELECT}&id=in.(${[...new Set(rHits.map((h) => h.source_id))].join(',')})`))
        .filter((r) => want.has(`${r.kind}${r.id}`)).forEach((r) => put(`r${r.kind}${r.id}`, { type: 'record', ...r, text: excerpt(r.body, terms) }));
    }
  } catch (e) { log('semantic search skipped:', e.message); }
  // Records name their space by id only (the view cannot be joined by PostgREST): look the names up, as the asker.
  const recs = [...out.values()].filter((x) => x.type === 'record');
  const sids = [...new Set(recs.map((x) => x.space_id).filter(Boolean))];
  if (sids.length) {
    const names = new Map((await rest(token, `/spaces?id=in.(${sids.join(',')})&select=id,name,kind`)).map((x) => [x.id, x]));
    for (const x of recs) x.space = names.get(x.space_id) || null;
  }
  const rank = { message: 0, item: 1, record: 1, event: 2 };
  return [...out.values()].sort((a, b) => rank[a.type] - rank[b.type] || String(a.created_at || a.at || a.starts_at).localeCompare(String(b.created_at || b.at || b.starts_at))).slice(-28);
}

const SYSTEM = `You are Weft, the assistant inside a small team's workspace. Answer questions about the team's work using only the numbered items provided (chat messages, documents, calendar events, and records from Weft's apps: announcements, RSVPs, bookings, shifts, time off, kudos, milestones, profiles and the person's own journal) and cite every fact with its number in square brackets, like [2]. If those items do not contain the answer, reply with exactly NOT_FOUND and nothing else; do not guess. Never invent items you were not given. When you talk to the person, call the numbered items "what I can see here" or name them (a message, a document, an event); never say "sources". Address the person as you. Keep answers short and plain: one or two full sentences.

If the person asks about you or what you can do, answer that directly and without citations: you answer from the messages, documents and events they can open (in a channel, only from that channel, because the whole channel reads the answer); you can propose posting a message, creating or changing a calendar event, creating a document, wiki page, spreadsheet, table or task list, adding to or rewriting a document or wiki page, adding rows to a table and adding tasks to a task list, in spaces where they can edit (in a channel, only in that channel); nothing happens until they confirm; and you cannot delete anything. Never answer NOT_FOUND to a question about what you can do.

Example. Sources: [1] message in #festival, Olive, 2026-04-01 09:00: The info booth opens at 11:00. Question: When does the info booth open? Answer: The info booth opens at 11:00 [1].`;

const ACT = `\n\nIf the person asks you to do something, you may propose it with a tool: send_message to post in a channel, create_event to add a new calendar event, change_event to change an event among the numbered items, create_item to make a new document, wiki page, spreadsheet, table or task list, edit_page to add to, rewrite or rename a document or wiki page among the numbered items, add_table_rows to add rows to a table among the numbered items, or add_tasks to add tasks to a task list among the numbered items. A proposal does nothing until the person confirms it, so say in one sentence what you are proposing. Only propose what was asked. Use the person's time zone for times they mention. You cannot delete anything, and you cannot change an existing spreadsheet (offer a new one instead).

Some documents are shown only in part, marked "excerpt". When the answer or the change needs more of one, call read_item with its number first; when what you need is not among the numbered items at all, call search with a few distinctive words (it adds new numbered items). Read before you act: never replace a page's whole content unless you have seen all of it. Cite read or found items by their numbers as usual.

When you are asked to make or add content, do not reply NOT_FOUND: write the content yourself from the request, the numbered items and what you generally know, and fill it in properly (real rows, real headings, not placeholders). Content you write does not need citations, but if you had to guess anything you could not check here (for example a school's exact dates), say so in one short sentence so the person can correct it. For a spreadsheet or table, give column names and every row; for a document or wiki page, Markdown.`;

// Questions about the assistant itself ("can you make a spreadsheet?", "what can you do?").
const CAPABILITY = /\b(?:can|could|will|would)\s+you\s+(?:please\s+)?(?:create|make|build|start|set\s+up|add|write|draft|edit|change|update|rename|post|send|schedule|put)\b|\bwhat\s+(?:can|could)\s+you\s+do\b|\bare\s+you\s+able\s+to\s+(?:create|make|add|write|edit|change)\b/i;
const CAN_DO = 'Here is what I can do. Ask me to make or change something and I will propose it for you to confirm: create a document, wiki page, spreadsheet, table or task list with the content filled in; add to or rewrite a page; add rows to a table or tasks to a list; post a message; add or change calendar events. I work only where you can edit (in a channel, only in that channel), nothing happens until you confirm, and I never delete anything.';

// Added to the instructions when an admin has turned web search on (074).
const WEB = `\n\nYou can also search the web with web_search, but only for facts about the outside world that are not in the numbered items (public dates such as a school district's calendar, places, opening hours, how-tos). Look in the numbered items first. Search with general words; never put private details from the numbered items into a search. The web pages you use are linked automatically; keep citing numbered items with [n]. When an answer or something you create relies on the web, say so in a few words.`;
// The basic search tool, on purpose: the newer web_search_20260209 filters results through code execution and,
// measured 2026-11-16, returned text with no citations (and ~45 % more input tokens, ~5x slower). Weft links what
// an answer relies on, so it needs the citations the basic tool gives.
const WEB_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: Number(env('ASSIST_WEB_MAX_USES', '3')) };

function fmtTime(iso, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)); }
  catch { return iso; }
}

// Sizes each item for the prompt. 'full' (Anthropic): the excerpt budget shared out, short items whole, the rest
// marked as excerpts the model can read in full. 'small': short excerpts, as before.
function sizeItems(sources, mode) {
  const items = sources.filter((s) => s.type === 'item');
  for (const s of items) {
    if (mode === 'small') { s.shown = s.text; continue; }
    if (s.readFull) continue;   // already read in full this question
    const per = Math.min(ITEM_WHOLE_MAX, Math.max(3500, Math.floor(EXCERPT_BUDGET / Math.max(1, items.length))));
    const b = budgetText(s.body_text ?? s.text, s.terms || [], per, s.chunk);
    s.shown = b.text; s.whole = b.whole;
  }
}
function line(s, i, tz, mode = 'full') {
    const n = `[${i + 1}]`;
    const part = mode === 'full' && s.type === 'item' && !s.whole ? ` (excerpt; read_item ${i + 1} reads all of it)` : '';
    if (s.type === 'item') return `${n} ${({ wiki: 'wiki page', whiteboard: 'whiteboard', table: 'table', spreadsheet: 'spreadsheet', tasklist: 'task list', poll: 'poll', form: 'form', linklist: 'link list', addressbook: 'address book', decisionlog: 'decision log', qa: 'Q and A board (questions and answers; prefer the accepted answer, then the most upvoted)', checklist: 'checklist (its steps, then recent runs: how far each got and what was not done)', expenselist: 'expense list (who paid what for the group; the balances and the settle-up list are worked out by the database, so quote them rather than adding up yourself)', inventory: 'inventory (the things a group owns, where each is kept and who has it now)', goalset: 'goal set (goals with their key results, each as current of target and percent done; updated by hand, or counted as done tasks out of all tasks in a task list)', retro: 'retrospective (notes on what went well, what to improve and actions for a period; some notes are anonymous, so never guess who wrote a note)', ideaboard: 'ideas board (ideas people suggested, each with its status: new, planned, done or declined, how many votes it has, whether the task a planned idea became is open or done, and why a declined one was declined)', glossary: 'glossary (the words this group uses and what each means; use it to understand the question and the other items, and to explain a term)', meeting: 'meeting notes', file: 'file' })[s.kind] || 'document'} "${s.title}" in ${where(s.space)}${part}: ${(mode === 'full' ? s.shown : s.text) || '(empty)'}`;
    if (s.type === 'record') {
      if (s.kind === 'profile') return `${n} profile of ${s.title} (someone the person shares a space with): ${s.text || '(empty)'}`;
      if (s.kind === 'journal') return `${n} ${RLABEL.journal} "${s.title}": ${s.text || '(empty)'}`;
      return `${n} ${RLABEL[s.kind] || 'record'} "${s.title}" in ${where(s.space)}: ${s.text || '(empty)'}`;
    }
    if (s.type === 'event') return `${n} event "${s.title}" in ${where(s.space)}${s.project?.name ? ` (project ${s.project.name})` : ''}, ${fmtTime(s.starts_at, tz)} to ${fmtTime(s.ends_at, tz)}${s.location ? `, at ${s.location}` : ''}`;
    return `${n} message in ${where(s.space)}, ${s.author?.display_name}, ${s.created_at.slice(0, 16).replace('T', ' ')}: ${s.body}`;
}
function prompt(question, sources, tz, mode = 'full') {
  sizeItems(sources, mode);
  const lines = sources.map((s, i) => line(s, i, tz, mode));
  return `Sources:\n${lines.join('\n') || '(none)'}\n\nThe person's time zone is ${tz}. Question: ${question}`;
}

const label = (s) => (s.type === 'record' ? (RCITE[s.kind] ? `${RCITE[s.kind]}: ${s.title}` : s.title) : s.type === 'item' ? `${({ wiki: 'Wiki', whiteboard: 'Whiteboard', table: 'Table', file: 'File' })[s.kind] || 'Document'}: ${s.title}`
  : s.type === 'event' ? `Event: ${s.title}` : `${where(s.space)}, ${s.author?.display_name}`);

function tools(channels, creatable = [], itemKinds = ['document', 'wiki', 'table', 'tasklist']) {
  const nullable = (desc) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description: desc });
  return [
    {
      name: 'read_item', strict: true,
      description: 'Read the whole of a document, wiki page, table, spreadsheet, task list or other item among the numbered items (they may be shown only as an excerpt). Returns its full text.',
      input_schema: { type: 'object', additionalProperties: false, required: ['source'], properties: {
        source: { type: 'integer', description: 'The [n] number of the item.' } } },
    },
    {
      name: 'search',
      strict: true,
      description: 'Search everything the person can see (in a channel: only that channel) for more messages, documents, events and records. Use a few distinctive words. The results are added as new numbered items.',
      input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string', description: 'A few words to look for.' } } },
    },
    {
      name: 'send_message', strict: true,
      description: 'Propose posting a message in a channel. Nothing is sent until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['channel', 'text'], properties: {
        channel: { type: 'string', enum: channels.length ? channels : ['(none)'], description: 'Channel name, without #.' },
        text: { type: 'string', description: 'The message to post.' } } },
    },
    {
      name: 'change_event', strict: true,
      description: 'Propose changing a calendar event that appears in the sources. Nothing changes until the person confirms. Use null for anything that stays the same.',
      input_schema: { type: 'object', additionalProperties: false, required: ['source', 'title', 'location', 'starts_at', 'ends_at'], properties: {
        source: { type: 'integer', description: 'The [n] number of the event in the sources.' },
        title: nullable('New title, or null.'), location: nullable('New location, or null.'),
        starts_at: nullable('New start as ISO 8601 with offset, or null.'), ends_at: nullable('New end as ISO 8601 with offset, or null.') } },
    },
    ...(creatable.length ? [{
      name: 'create_event', strict: true,
      description: 'Propose adding a new calendar event. Nothing is created until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['space', 'title', 'starts_at', 'ends_at', 'location'], properties: {
        space: { type: 'string', enum: creatable, description: 'Where the event goes: a channel name without #, or "personal".' },
        title: { type: 'string', description: 'Event title.' },
        starts_at: { type: 'string', description: 'Start as ISO 8601 with offset.' },
        ends_at: { type: 'string', description: 'End as ISO 8601 with offset.' },
        location: nullable('Location, or null.') } },
    }, {
      name: 'create_item', strict: true,
      description: 'Propose creating a new document, wiki page, spreadsheet, table or task list, with its content. Nothing is created until the person confirms. Fill in only the fields for the kind you choose; give empty values for the rest.',
      input_schema: { type: 'object', additionalProperties: false, required: ['space', 'kind', 'title', 'markdown', 'columns', 'rows', 'tasks'], properties: {
        space: { type: 'string', enum: creatable, description: 'Where it goes: a channel name without #, or "personal".' },
        kind: { type: 'string', enum: itemKinds, description: 'document or wiki: Markdown text. spreadsheet or table: columns and rows. tasklist: tasks.' },
        title: { type: 'string', description: 'Its title.' },
        markdown: { type: 'string', description: 'Document or wiki page content in Markdown (headings, lists, tables). Empty for other kinds.' },
        columns: { type: 'array', description: 'Spreadsheet or table columns, in order. Empty for other kinds.', items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: {
          name: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'date', 'checkbox'], description: 'date as YYYY-MM-DD; checkbox as true or false.' } } } },
        rows: { type: 'array', description: 'Spreadsheet or table rows: one array of cell values per row, in column order. Empty for other kinds.', items: { type: 'array', items: { type: 'string' } } },
        tasks: { type: 'array', description: 'Task list tasks. Empty for other kinds.', items: { type: 'object', additionalProperties: false, required: ['title', 'due_on'], properties: {
          title: { type: 'string' }, due_on: nullable('Due date as YYYY-MM-DD, or null.') } } } } },
    }, {
      name: 'edit_page', strict: true,
      description: 'Propose adding Markdown to the end of a document or wiki page among the numbered items, replacing its whole content, and/or renaming it. Nothing changes until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['source', 'mode', 'markdown', 'title'], properties: {
        source: { type: 'integer', description: 'The [n] number of the document or wiki page.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append adds to the end; replace rewrites the whole page (give all of it).' },
        markdown: { type: 'string', description: 'The Markdown to add or the whole new content; empty to only rename.' },
        title: nullable('A new title, or null to keep it.') } },
    }, {
      name: 'add_table_rows', strict: true,
      description: 'Propose adding rows to a table among the numbered items. Nothing changes until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['source', 'rows'], properties: {
        source: { type: 'integer', description: 'The [n] number of the table.' },
        rows: { type: 'array', description: 'One array of cell values per row, in the table\'s column order.', items: { type: 'array', items: { type: 'string' } } } } },
    }, {
      name: 'add_tasks', strict: true,
      description: 'Propose adding tasks to a task list among the numbered items. Nothing changes until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['source', 'tasks'], properties: {
        source: { type: 'integer', description: 'The [n] number of the task list.' },
        tasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'due_on'], properties: {
          title: { type: 'string' }, due_on: nullable('Due date as YYYY-MM-DD, or null.') } } } } },
    }] : []),
  ];
}

// ---------------------------------------------------------------- providers
class Unavailable extends Error {}

// opts.history: earlier turns of this conversation ([{role, content}], oldest first, starting with 'user').
// opts.runTool(name, input) -> string for reading tools (read_item, search), or null for an action tool, which
// becomes a proposal (collected in calls) after the run. opts.deadline: epoch ms the whole run must end by.
const READ_TOOLS = new Set(['read_item', 'search']);
async function callProvider(p, system, user, toolDefs = null, opts = {}) {
  const t0 = Date.now();
  const history = opts.history || [];
  const key = p.key_ciphertext ? decrypt(p.key_ciphertext) : null;
  if (p.kind === 'anthropic') {
    if (!key) throw new Unavailable('no key set');
    const client = new Anthropic({ apiKey: key, timeout: CALL_TIMEOUT_MS, maxRetries: 1, ...(p.base_url ? { baseURL: p.base_url } : {}) });
    try {
      // A few rounds: the model may read items in full or search before it answers or proposes. Each round's
      // whole response (thinking blocks included) goes back unchanged. Prompt caching keeps the repeated prefix cheap.
      const messages = [...history, { role: 'user', content: user }];
      const calls = []; let text = ''; let model = p.model; let rounds = 0;
      const web = new Map();   // url -> title, from the citations of the model's text
      const searched = [];     // every result of its searches, for when nothing was quoted (e.g. a spreadsheet it wrote)
      let useWeb = !!opts.web;
      const tok = { in: 0, out: 0, cost: 0 };
      const deadline = opts.deadline || (Date.now() + CALL_TIMEOUT_MS);
      for (;;) {
        rounds++;
        const left = deadline - Date.now();
        if (left < 5000) break;
        // Server-side refusal fallback on by default, per Anthropic's guidance for this model family.
        const send = () => client.beta.messages.create({
          model: p.model, max_tokens: MAX_OUT, system: useWeb ? system + WEB : system,
          output_config: { effort: p.effort || 'low' },
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
          // Cached only once the model has started reading: most questions are one round, where a cache write
          // would only add 25 %; from the second round on the long shared prefix is read back at a tenth.
          ...(rounds > 1 ? { cache_control: { type: 'ephemeral' } } : {}),
          messages,
          ...(toolDefs ? { tools: useWeb ? [...toolDefs, WEB_TOOL] : toolDefs, tool_choice: { type: 'auto' } } : {}),
        }, { timeout: Math.min(CALL_TIMEOUT_MS, left) });
        let r;
        try { r = await send(); } catch (e) {
          // If the account cannot use web search (turned off in the Anthropic console, say), answer without it
          // rather than failing over to the local model.
          if (!(useWeb && e instanceof Anthropic.BadRequestError && /web.?search|server tool/i.test(e.message))) throw e;
          log('web search refused by the API; answering without it:', e.message.slice(0, 160));
          useWeb = false; r = await send();
        }
        model = r.model;
        const u = r.usage || {};
        const cw = u.cache_creation_input_tokens || 0; const cr = u.cache_read_input_tokens || 0;
        tok.in += (u.input_tokens || 0) + cw + cr; tok.out += u.output_tokens || 0;
        tok.cost += (u.input_tokens || 0) + 1.25 * cw + 0.1 * cr;   // input-price equivalents
        tok.searches = (tok.searches || 0) + (u.server_tool_use?.web_search_requests || 0);
        if (r.stop_reason === 'refusal') return { refused: true, text: '', model, inTok: tok.in, outTok: tok.out, inCost: tok.cost, ms: Date.now() - t0 };
        const said = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        if (said) text = said;
        for (const b of r.content) for (const c of (b.type === 'text' && b.citations) || []) {
          if (c.type === 'web_search_result_location' && /^https?:\/\//.test(c.url || '') && !web.has(c.url)) web.set(c.url, String(c.title || '').slice(0, 120));
        }
        for (const b of r.content) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          for (const x of b.content) if (x.type === 'web_search_result' && /^https?:\/\//.test(x.url || '')) searched.push({ url: x.url, title: String(x.title || '').slice(0, 120) });
        }
        // A server tool (web search) that ran long: send the turn back as it is and let the model continue.
        if (r.stop_reason === 'pause_turn' && rounds < MAX_ROUNDS) { messages.push({ role: 'assistant', content: r.content }); continue; }
        const uses = r.content.filter((b) => b.type === 'tool_use');
        if (r.stop_reason !== 'tool_use' || !uses.length) break;
        const results = [];
        for (const b of uses) {
          const got = READ_TOOLS.has(b.name) && opts.runTool ? await opts.runTool(b.name, b.input || {}) : null;
          if (got === null) {
            calls.push({ name: b.name, input: b.input });
            results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Proposed. Nothing happens until the person confirms it.' });
          } else results.push({ type: 'tool_result', tool_use_id: b.id, content: got });
        }
        // Only proposals this round, or out of rounds: stop; the answer is what was said, plus the proposal cards.
        if (rounds >= MAX_ROUNDS || uses.every((b) => !READ_TOOLS.has(b.name))) break;
        messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: results });
      }
      return { searches: tok.searches || 0, text, calls, model, rounds, web: (web.size ? [...web].slice(0, 8).map(([url, title]) => ({ url, title })) : [...new Map(searched.map((x) => [x.url, x])).values()].slice(0, 3)), inTok: tok.in, outTok: tok.out, inCost: tok.cost, ms: Date.now() - t0 };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new Unavailable('rate limited');
      if (e instanceof Anthropic.AuthenticationError) throw new Unavailable('key rejected');
      if (e instanceof Anthropic.APIConnectionError) throw new Unavailable('could not connect');
      if (e instanceof Anthropic.APIError) throw new Unavailable(`API error ${e.status}`);
      throw new Unavailable(e.message);
    }
  }
  // Ollama and OpenAI-compatible endpoints: plain HTTP.
  const ctl = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: user }];
  let r;
  try {
    r = p.kind === 'ollama'
      ? await fetch(`${p.base_url}/api/chat`, { method: 'POST', signal: ctl, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.model, messages, stream: false }) })
      : await fetch(`${p.base_url}/chat/completions`, { method: 'POST', signal: ctl, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: p.model, messages }) });
  } catch (e) { throw new Unavailable(e.name === 'TimeoutError' ? 'timed out' : 'could not connect'); }
  if (!r.ok) throw new Unavailable(`HTTP ${r.status}`);
  const d = await r.json();
  return p.kind === 'ollama'
    ? { text: (d.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), model: p.model, inTok: d.prompt_eval_count || 0, outTok: d.eval_count || 0, ms: Date.now() - t0 }
    : { text: (d.choices?.[0]?.message?.content || '').trim(), model: d.model || p.model, inTok: d.usage?.prompt_tokens || 0, outTok: d.usage?.completion_tokens || 0, ms: Date.now() - t0 };
}

const WEB_SEARCH_USD = Number(env('ASSIST_WEB_SEARCH_USD', '0.01'));   // per search (Anthropic: $10 per 1,000)
const cost = (p, r) => ((r.inCost ?? r.inTok) * Number(p.price_in) + r.outTok * Number(p.price_out)) / 1e6 + (r.searches || 0) * WEB_SEARCH_USD;

// The asker's own key (if allowed and set), then primary, then secondary. Failover on unavailability
// (no key, cap reached, timeouts, rate limits, server errors), never on a refusal: a declined question
// is not re-asked elsewhere.
const slotName = (p) => (p.slot === 'personal' ? 'your own key' : p.slot);
async function answer(ctx, system, user, toolDefs = null, opts = {}) {
  const { rows: providers } = await db.query('select * from weft_private.providers_for_call()');
  const { rows: [mine] } = await db.query('select * from weft_private.personal_for_call($1)', [ctx.asker]);
  if (mine) providers.unshift({ ...mine, slot: 'personal', base_url: mine.kind === 'anthropic' ? (PERSONAL_ANTHROPIC_URL || null) : PERSONAL_OPENAI_URL });
  let reason = null;
  for (const p of providers) {
    if (!p.enabled) { reason = reason || `${slotName(p)} disabled`; continue; }
    if (p.monthly_cap_usd !== null) {
      const { rows } = p.slot === 'personal'
        ? await db.query('select weft_private.personal_month_cost($1) as c', [ctx.asker])
        : await db.query('select weft_private.month_cost($1) as c', [p.slot]);
      if (Number(rows[0].c) >= Number(p.monthly_cap_usd)) { reason = reason || `${slotName(p)} reached its monthly cap`; continue; }
    }
    try {
      // Only Anthropic models get the action tools; the fallback answers read-only.
      // user may be a function of the provider kind: Anthropic models get the large prompt, others short excerpts.
      const u = typeof user === 'function' ? user(p.kind) : user;
      const r = await callProvider(p, p.kind === 'anthropic' && toolDefs ? system + ACT : system, u, p.kind === 'anthropic' ? toolDefs : null,
        p.kind === 'anthropic' ? opts : { history: opts.history });
      const c = cost(p, r);
      await db.query('select weft_private.run_log($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,null)',
        [ctx.asker, ctx.space, ctx.question, p.slot, p.kind, r.model, reason, r.inTok, r.outTok, c, r.ms]);
      return { ...r, slot: p.slot, kind: p.kind, fallback: reason };
    } catch (e) {
      if (!(e instanceof Unavailable)) throw e;
      await db.query('select weft_private.run_log($1,$2,$3,$4,$5,$6,false,null,null,null,null,null,$7)',
        [ctx.asker, ctx.space, ctx.question, p.slot, p.kind, p.model, e.message]);
      reason = reason || `${slotName(p)}: ${e.message}`;
    }
  }
  return { unavailable: true, fallback: reason };
}

// Whether new spreadsheets can be made (the optional office engine is up). Cached for a minute.
let officeCache = { at: 0, ready: false };
async function officeReady(userToken) {
  if (Date.now() - officeCache.at < 60000) return officeCache.ready;
  const ready = await fetch(`${FILES_URL}/files/office`, { headers: { Authorization: `Bearer ${userToken}` }, signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : {})).then((d) => d.enabled === true && d.ready === true).catch(() => false);
  officeCache = { at: Date.now(), ready };
  return ready;
}

// ---------------------------------------------------------------- conversation memory and reading
// The earlier turns of this conversation, so follow-ups ("make it a table instead") work. In the person's own Weft
// conversation, every message; elsewhere, only @Weft questions and Weft's answers, in the same chat (general or
// project). Read with the same (scoped) token as everything else. Old citation numbers are dropped: they pointed
// at that answer's own numbered items.
async function conversation(token, q, inAssistant, asker) {
  if (!HISTORY) return [];
  const proj = q.project_id ? `eq.${q.project_id}` : 'is.null';
  const only = inAssistant ? '' : `&or=(author_id.eq.${ASSISTANT_ID},body.ilike.*@weft*)`;
  const rows = (await rest(token, `/messages?select=author_id,body,meta,author:users(display_name)&space_id=eq.${q.space_id}&project_id=${proj}&created_at=lt.${encodeURIComponent(q.created_at)}&id=neq.${q.id}${only}&order=created_at.desc&limit=${HISTORY}`).catch(() => [])).reverse();
  const turns = [];
  for (const m of rows) {
    const role = m.author_id === ASSISTANT_ID ? 'assistant' : 'user';
    let text = String(m.body || '').replace(/\[\d{1,2}\]/g, '').trim().slice(0, 4000);
    if (role === 'user' && m.author_id !== asker) text = `${m.author?.display_name || 'Someone'} asked: ${text}`;
    if (role === 'assistant' && m.meta?.proposals?.length) text += `\n(I proposed: ${m.meta.proposals.map((x) => x.summary).join('; ')})`;
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last?.role === role) last.content += `\n\n${text}`; else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  while (turns.length && turns[turns.length - 1].role !== 'assistant') turns.pop();
  return turns;
}

// read_item and search for the model, bounded by READ_BUDGET characters per question. Everything is read with the
// question's token, so the model can only reach what the asker (in a channel: that channel) can see.
function makeReader(token, q, inAssistant, sources, tz) {
  let used = 0;
  const key = (x) => `${x.type}${x.kind || ''}${x.id}`;
  return async (name, input) => {
    const left = READ_BUDGET - used;
    if (left <= 0) return 'The reading limit for this question is used up. Answer with what you have, and say what you could not read.';
    if (name === 'read_item') {
      const n = Number(input.source); const it = sources[n - 1];
      if (!it) return `There is no item [${n}].`;
      const full = it.type === 'item' ? String(it.body_text ?? it.text ?? '') : it.type === 'record' ? String(it.body ?? it.text ?? '') : line(it, n - 1, tz);
      const text = full.slice(0, left); used += text.length;
      if (it.type === 'item' && text.length === full.length) { it.readFull = true; it.whole = true; it.shown = full; }
      return `[${n}] all of "${it.title || it.type}"${text.length < full.length ? ` (the first ${text.length} of ${full.length} characters: the reading limit)` : ''}:\n${text || '(empty)'}`;
    }
    if (name === 'search') {
      const query = String(input.query || '').trim().slice(0, 200);
      if (!query) return 'Give a few words to search for.';
      const have = new Set(sources.map(key));
      const found = (await retrieve(token, query, q.space_id, !inAssistant, q.id, q.project_id)).filter((x) => !have.has(key(x))).slice(0, 12);
      if (!found.length) return 'Nothing more found for that.';
      const per = Math.max(3500, Math.floor(Math.min(left, 120000) / found.length));
      const lines = found.map((x) => {
        if (x.type === 'item') { const b = budgetText(x.body_text ?? x.text, x.terms || [], per, x.chunk); x.shown = b.text; x.whole = b.whole; }
        sources.push(x);
        return line(x, sources.length - 1, tz);
      });
      const out = lines.join('\n'); used += out.length;
      return `New numbered items:\n${out}`;
    }
    return null;
  };
}

// ---------------------------------------------------------------- ask
const inflight = new Set();
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; } };

async function ask(user, messageId, tzIn) {
  if (!/^[0-9a-f-]{36}$/.test(messageId || '')) return [400, { error: 'message_id required' }];
  const tz = validTz(tzIn || 'UTC');
  // Read the question as the asker: RLS decides whether it exists for them.
  const started = Date.now();
  const [q] = await rest(user.token, `/messages?id=eq.${messageId}&select=id,space_id,project_id,author_id,body,created_at,space:spaces(kind,name)`);
  if (!q) return [404, { error: 'no such message' }];
  if (q.author_id !== user.id) return [403, { error: 'you can only ask with your own message' }];
  const inAssistant = q.space.kind === 'assistant';
  if (!inAssistant && !/@weft\b/i.test(q.body)) return [400, { error: 'mention @Weft to ask in a channel' }];
  if (inflight.has(user.id)) return [429, { error: 'Weft is still answering your last question' }];
  inflight.add(user.id);
  try {
    // In a channel the whole channel reads the answer, so everything is scoped to that channel.
    const scope = inAssistant ? null : q.space_id;
    const token = await assistantToken(user.id, scope);
    const question = q.body.replace(/@weft\b/gi, '').trim() || q.body;
    let sources = await retrieve(token, question, q.space_id, !inAssistant, q.id, q.project_id);
    const guide = await guidance(user, token, q, inAssistant);
    if (guide.pinned.length) {   // pinned items always come first, and are never cut
      const ids = new Set(guide.pinned.map((x) => x.id));
      sources = [...guide.pinned, ...sources.filter((x) => !(x.type === 'item' && ids.has(x.id)))].slice(0, 30);
    }
    // Channels a proposal may post to: in a channel, only that channel; in your Weft conversation,
    // the channels you are in. (Execution re-checks membership and scope in the database.)
    const chans = await rest(token, '/spaces?kind=eq.channel&select=id,name&order=name');
    // Where a new event could go: spaces in scope where the asker is an owner or editor.
    const mineRoles = await rest(token, `/members?user_id=eq.${user.id}&role=in.(owner,editor)&select=space_id,space:spaces(id,kind,name)`);
    const creatable = mineRoles.map((m) => m.space).filter((s) => s && (s.kind === 'channel' || s.kind === 'personal'))
      .map((s) => ({ id: s.id, name: s.kind === 'personal' ? 'personal' : s.name }))
      .sort((a, b) => (b.name === 'personal') - (a.name === 'personal'));   // personal first: the safe default
    const itemKinds = ['document', 'wiki', ...(await officeReady(user.token) ? ['spreadsheet'] : []), 'table', 'tasklist'];
    const history = await conversation(token, q, inAssistant, user.id);
    const reader = makeReader(token, q, inAssistant, sources, tz);
    const result = await answer({ asker: user.id, space: q.space_id, question: q.id }, SYSTEM + guide.text,
      (kind) => prompt(question, sources, tz, kind === 'anthropic' ? 'full' : 'small'),
      tools(chans.map((c) => c.name), creatable.map((c) => c.name), itemKinds),
      { history, runTool: reader, deadline: started + DEADLINE_MS, web: (await db.query('select weft_private.web_search_get() as w')).rows[0].w });

    let body; let citations = []; const proposals = [];
    if (result.unavailable) {
      body = `I can't answer right now: no model is available (${result.fallback}).`;
    } else if (result.refused) {
      body = "I can't help with that one.";
    } else {
      for (const c of result.calls || []) {
        const prop = await proposalFrom(c, sources, chans, user.id, q.space_id, scope, tz, creatable, guide.project, { token, itemKinds });
        if (prop) proposals.push(prop);
      }
      const notFound = /^\W*NOT_FOUND\W*$/i.test(result.text) || result.text.includes('NOT_FOUND');
      const used = notFound ? [] : [...new Set([...result.text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= sources.length);
      const order = new Map(used.map((n, i) => [n, i + 1]));
      const webCites = notFound ? [] : (result.web || []).map((w) => ({ type: 'web', id: w.url, url: w.url, label: w.title || new URL(w.url).hostname }));
      if (!used.length && webCites.length) {
        // Answered from the web: the links are the citations.
        body = result.text.replace(/\[\d{1,2}\]/g, '').trim();
        citations = webCites;
      } else if (used.length) {
        body = result.text.replace(/\[(\d{1,2})\]/g, (all, n) => (order.has(Number(n)) ? `[${order.get(Number(n))}]` : ''));
        if (!/[a-z]{3,}/i.test(body.replace(/\[\d+\]/g, ''))) body = `Here is what I found: ${used.map((n) => `[${order.get(n)}]`).join(' ')}`;
        citations = used.map((n) => { const s = sources[n - 1]; return { type: s.type, id: s.id, space_id: s.space_id, label: label(s), ...(s.type === 'record' ? { kind: s.kind, ref: s.ref } : {}) }; });
        citations.push(...webCites);
      } else if (proposals.length) {
        body = result.text && !notFound ? result.text.replace(/\[\d{1,2}\]/g, '').trim() : 'Here is what I can do. Nothing happens until you confirm.';
      } else if (!notFound && result.text && result.kind === 'anthropic' && history.length) {
        // A follow-up answered from the conversation itself ("what did I just ask you?", "say that shorter"): there
        // is nothing new to cite. Only for the main model, and only with earlier turns; otherwise no citation, no answer.
        body = result.text.replace(/\[\d{1,2}\]/g, '').trim();
      } else if (CAPABILITY.test(question)) {
        // The model holds to NOT_FOUND for questions about itself; answer those plainly instead.
        body = CAN_DO;
      } else {
        body = "I couldn't find anything about that in what you can see.";
      }
    }
    const meta = {
      citations, asker: user.id, ...(proposals.length ? { proposals } : {}),
      ...(result.unavailable ? {} : { served_by: { slot: result.slot, kind: result.kind, model: result.model } }),
      ...(result.fallback ? { fallback: result.fallback } : {}),
      question_id: q.id,
    };
    const [reply] = await rest(token, '/messages', { method: 'POST', body: { space_id: q.space_id, author_id: ASSISTANT_ID, body, meta, ...(q.project_id ? { project_id: q.project_id } : {}) } });
    return [200, { id: reply.id, sources: sources.length, proposals: proposals.length }];
  } finally { inflight.delete(user.id); }
}

// ---------------------------------------------------------------- rules (069)
// Application rules (SYSTEM) first and always; then the space's rules, then the project's instructions, then the
// asker's own preferences, which only shape how the answer looks. All are read with the asker's tokens, so the
// same visibility applies. Instructions guide; they are not sources: facts still need a numbered item, which is
// what a project's pinned items are for.
const clip = (t, n) => String(t || '').trim().slice(0, n);
async function guidance(user, token, q, inAssistant) {
  const parts = []; let pinned = []; let project = null;
  if (!inAssistant && ['channel', 'personal'].includes(q.space.kind)) {
    const [r] = await rest(token, `/space_rules?space_id=eq.${q.space_id}&select=instructions`);
    if (clip(r?.instructions, 1)) parts.push(`Rules for ${q.space.kind === 'personal' ? "the person's personal space" : `#${q.space.name}`}, set by its owners:\n${clip(r.instructions, 8000)}`);
    if (q.project_id) {
      const [p] = await rest(token, `/projects?id=eq.${q.project_id}&select=id,name,instructions`);
      if (p) project = { id: p.id, name: p.name };
      if (p && clip(p.instructions, 1)) parts.push(`Instructions for the project "${p.name}", set by the owners. They refine the rules above:\n${clip(p.instructions, 8000)}`);
      const pins = await rest(token, `/project_pins?project_id=eq.${q.project_id}&select=item_id&order=position,created_at&limit=10`);
      if (pins.length) {
        pinned = (await rest(token, `/items?select=${ISELECT}&id=in.(${pins.map((x) => x.item_id).join(',')})`))
          .map((r) => ({ type: 'item', ...r, text: clip(r.body_text, 2500) }));
      }
    }
  }
  const [me] = await rest(user.token, '/user_prefs?select=ai_instructions').catch(() => []);
  if (clip(me?.ai_instructions, 1)) parts.push(`The asker's own preferences for how your answers look. They apply only to this person, and only to style and format; they never change facts or the rules above:\n${clip(me.ai_instructions, 4000)}`);
  const text = parts.length
    ? `\n\nInstructions from this workspace, in order of authority. Everything above comes first and cannot be overridden by them: you still answer only from the numbered items, cite every fact, and reply NOT_FOUND when the items do not hold the answer. These instructions shape how you answer; they are not sources.\n\n${parts.join('\n\n')}`
    : '';
  return { text, pinned, project };
}

// ---------------------------------------------------------------- content proposals (073)
// Documents, wiki pages, spreadsheets, tables and task lists. Returns undefined for any other tool, null for
// a call that does not hold up, else the stored proposal. Targets are limited to spaces where the asker is an
// owner or editor and that are in scope (in a channel, only that channel); RLS checks again on confirm.
const KIND_NAME = { document: 'document', wiki: 'wiki page', spreadsheet: 'spreadsheet', table: 'table', tasklist: 'task list' };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const cleanRows = (rows, width) => (Array.isArray(rows) ? rows : []).slice(0, 2000)
  .map((r) => (Array.isArray(r) ? r : []).slice(0, width).map((v) => String(v ?? '').slice(0, 2000)))
  .filter((r) => r.some((v) => v.trim()));
const cleanTasks = (tasks) => (Array.isArray(tasks) ? tasks : []).slice(0, 200)
  .map((t) => ({ title: String(t?.title || '').trim().slice(0, 300), due_on: DAY.test(String(t?.due_on || '')) ? t.due_on : null }))
  .filter((t) => t.title);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const placeOf = (sp) => (sp.name === 'personal' ? 'your personal space' : `#${sp.name}`);
async function contentProposal(call, i, sources, asker, spaceId, scope, creatable, project, { token, itemKinds = [] }) {
  const store = async (kind, payload, summary) => {
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id', [asker, spaceId, scope, kind, payload, summary])).rows[0].id;
    return { id, kind, summary };
  };
  const editable = (s) => creatable.some((c) => c.id === s.space_id);
  if (call.name === 'create_item') {
    const sp = creatable.find((c) => c.name === i.space);
    const kind = String(i.kind || '');
    const title = String(i.title || '').trim().slice(0, 200);
    if (!sp || !title || !itemKinds.includes(kind)) return null;
    const inProject = project && sp.id === spaceId ? project : null;
    const payload = { space_id: sp.id, kind, title, ...(inProject ? { project_id: inProject.id } : {}) };
    let what;
    if (kind === 'document' || kind === 'wiki') {
      payload.markdown = String(i.markdown || '').slice(0, 200000);
      what = payload.markdown.trim() ? `${plural(payload.markdown.split(/\n/).filter((x) => x.trim()).length, 'line')} of content` : 'empty';
    } else if (kind === 'spreadsheet' || kind === 'table') {
      payload.columns = (Array.isArray(i.columns) ? i.columns : []).slice(0, 50)
        .map((c) => ({ name: String(c?.name || '').trim().slice(0, 80), type: ['text', 'number', 'date', 'checkbox'].includes(c?.type) ? c.type : 'text' }))
        .filter((c) => c.name);
      if (!payload.columns.length) return null;
      payload.rows = cleanRows(i.rows, payload.columns.length);
      what = `columns ${payload.columns.map((c) => c.name).join(', ')}; ${plural(payload.rows.length, 'row')}`;
    } else {
      payload.tasks = cleanTasks(i.tasks);
      what = plural(payload.tasks.length, 'task');
    }
    return store('create_item', payload, `Create the ${KIND_NAME[kind]} "${title}" in ${placeOf(sp)}${inProject ? ` › ${inProject.name}` : ''} (${what})`);
  }
  if (call.name === 'edit_page') {
    const s = sources[Number(i.source) - 1];
    if (!s || s.type !== 'item' || !['document', 'wiki'].includes(s.kind) || s.managed || !editable(s)) return null;
    const markdown = String(i.markdown || '').slice(0, 200000);
    const mode = i.mode === 'replace' ? 'replace' : 'append';
    // A rewrite only from a page seen whole (shown whole, or read with read_item): never rebuilt from an excerpt.
    if (mode === 'replace' && markdown.trim() && !s.whole) return null;
    const title = i.title ? String(i.title).trim().slice(0, 200) : null;
    if (!markdown.trim() && !title) return null;
    const parts = [];
    if (markdown.trim()) parts.push(mode === 'replace' ? `replace its content (${plural(markdown.split(/\n/).filter((x) => x.trim()).length, 'line')})` : `add ${plural(markdown.split(/\n/).filter((x) => x.trim()).length, 'line')} at the end`);
    if (title && title !== s.title) parts.push(`rename it "${title}"`);
    if (!parts.length) return null;
    return store('edit_page', { item_id: s.id, mode, markdown, title }, `Change the ${KIND_NAME[s.kind]} "${s.title}": ${parts.join(', ')}`);
  }
  if (call.name === 'add_table_rows') {
    const s = sources[Number(i.source) - 1];
    if (!s || s.type !== 'item' || s.kind !== 'table' || !editable(s)) return null;
    const cols = await rest(token, `/table_columns?table_id=eq.${s.id}&select=id,name&order=position,created_at`);
    const rows = cleanRows(i.rows, cols.length);
    if (!cols.length || !rows.length) return null;
    return store('add_rows', { item_id: s.id, rows }, `Add ${plural(rows.length, 'row')} to the table "${s.title}"`);
  }
  if (call.name === 'add_tasks') {
    const s = sources[Number(i.source) - 1];
    if (!s || s.type !== 'item' || s.kind !== 'tasklist' || !editable(s)) return null;
    const tasks = cleanTasks(i.tasks);
    if (!tasks.length) return null;
    return store('add_tasks', { item_id: s.id, tasks }, `Add ${plural(tasks.length, 'task')} to "${s.title}": ${tasks.slice(0, 3).map((t) => t.title).join('; ')}${tasks.length > 3 ? '; …' : ''}`);
  }
  return undefined;
}

// Carry out a confirmed content proposal with the asker's own token (they confirmed it, so it is their action,
// and row-level security decides as if they had done it by hand). Returns [status, result, before].
const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const cellValue = (type, v) => {
  const t = String(v ?? '').trim();
  if (type === 'number') { const n = Number(t.replace(/[$,]/g, '')); return t && Number.isFinite(n) ? n : (t || null); }
  if (type === 'checkbox') return /^(true|yes|y|x|1|done|✓)$/i.test(t);
  return t || null;
};
async function runContent(p, userToken) {
  const pl = p.payload;
  const editErr = "Not allowed: you can only change things in spaces where you are an editor or owner.";
  if (p.kind === 'create_item') {
    let item;
    if (pl.kind === 'spreadsheet') {
      const csv = [pl.columns.map((c) => c.name), ...pl.rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      const r = await fetch(`${FILES_URL}/files/spreadsheets?space=${pl.space_id}&name=${encodeURIComponent(`${pl.title}.csv`)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'text/csv' }, body: csv,
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 403) return ['failed', editErr];
      if (!r.ok) return ['failed', d.error || 'The spreadsheet could not be made.'];
      item = d;
      if (pl.project_id) await rest(userToken, `/items?id=eq.${item.id}`, { method: 'PATCH', body: { project_id: pl.project_id } }).catch(() => null);
    } else {
      const row = { space_id: pl.space_id, kind: pl.kind, title: pl.title, ...(pl.project_id ? { project_id: pl.project_id } : {}),
        ...(pl.kind === 'document' || pl.kind === 'wiki' ? { body_text: pl.markdown || null } : {}) };
      [item] = await rest(userToken, '/items?select=id', { method: 'POST', body: row }).catch(() => [null]);
      if (!item) return ['failed', editErr];
      try {
        if (pl.kind === 'table') {
          const cols = await rest(userToken, '/table_columns?select=id,type', { method: 'POST', body: pl.columns.map((c, n) => ({ table_id: item.id, name: c.name, type: c.type, position: n + 1 })) });
          if (pl.rows.length) await rest(userToken, '/table_rows?select=id', { method: 'POST', body: pl.rows.map((r, n) => ({ table_id: item.id, position: n + 1,
            cells: Object.fromEntries(cols.map((c, k) => [c.id, cellValue(c.type, r[k])]).filter(([, v]) => v !== null && v !== '')) })) });
        }
        if (pl.kind === 'tasklist' && pl.tasks.length) {
          await rest(userToken, '/tasks?select=id', { method: 'POST', body: pl.tasks.map((t, n) => ({ list_id: item.id, title: t.title, due_on: t.due_on, position: n + 1 })) });
        }
      } catch (e) {
        await rest(userToken, `/items?id=eq.${item.id}`, { method: 'DELETE' }).catch(() => null);
        log('content create failed', e.message);
        return ['failed', 'Something went wrong; nothing was created.'];
      }
    }
    return ['done', `Created the ${KIND_NAME[pl.kind]}.`, { item_id: item.id }];
  }
  if (p.kind === 'edit_page') {
    const [it] = await rest(userToken, `/items?id=eq.${pl.item_id}&select=id,title,body_text,managed`);
    if (!it) return ['failed', 'That page is gone, or you can no longer see it.'];
    if (it.managed) return ['failed', 'That page is managed and cannot be changed in Weft.'];
    if (pl.title && pl.title !== it.title) {
      const r = await rest(userToken, `/items?id=eq.${it.id}&select=id`, { method: 'PATCH', body: { title: pl.title } }).catch(() => null);
      if (!r?.length) return ['failed', editErr];
    }
    if (pl.markdown.trim()) {
      const r = await fetch(`${COLLAB_EDIT}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: userToken, id: it.id, mode: pl.mode, markdown: pl.markdown }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (pl.title && pl.title !== it.title) await rest(userToken, `/items?id=eq.${it.id}`, { method: 'PATCH', body: { title: it.title } }).catch(() => null);
        return ['failed', d.error || 'The page could not be changed.'];
      }
    }
    return ['done', 'Changed.', { item_id: it.id, title: it.title, markdown: it.body_text || '' }];
  }
  if (p.kind === 'add_rows') {
    const cols = await rest(userToken, `/table_columns?table_id=eq.${pl.item_id}&select=id,type&order=position,created_at`);
    if (!cols.length) return ['failed', 'That table is gone, or you can no longer see it.'];
    const [last] = await rest(userToken, `/table_rows?table_id=eq.${pl.item_id}&select=position&order=position.desc&limit=1`);
    const base = Number(last?.position || 0);
    const made = await rest(userToken, '/table_rows?select=id', { method: 'POST', body: pl.rows.map((r, n) => ({ table_id: pl.item_id, position: base + n + 1,
      cells: Object.fromEntries(cols.map((c, k) => [c.id, cellValue(c.type, r[k])]).filter(([, v]) => v !== null && v !== '')) })) }).catch(() => null);
    if (!made?.length) return ['failed', editErr];
    return ['done', `Added ${plural(made.length, 'row')}.`, { item_id: pl.item_id, row_ids: made.map((x) => x.id) }];
  }
  if (p.kind === 'add_tasks') {
    const [last] = await rest(userToken, `/tasks?list_id=eq.${pl.item_id}&select=position&order=position.desc&limit=1`).catch(() => []);
    const base = Number(last?.position || 0);
    const made = await rest(userToken, '/tasks?select=id', { method: 'POST', body: pl.tasks.map((t, n) => ({ list_id: pl.item_id, title: t.title, due_on: t.due_on, position: base + n + 1 })) }).catch(() => null);
    if (!made?.length) return ['failed', editErr];
    return ['done', `Added ${plural(made.length, 'task')}.`, { item_id: pl.item_id, task_ids: made.map((x) => x.id) }];
  }
  return null;
}

async function undoContent(p, userToken) {
  const b = p.before;
  if (p.kind === 'create_item') {
    const gone = await rest(userToken, `/items?id=eq.${b.item_id}`, { method: 'DELETE' }).catch(() => null);
    return gone?.length ? 'Removed.' : null;
  }
  if (p.kind === 'add_rows' || p.kind === 'add_tasks') {
    const ids = (p.kind === 'add_rows' ? b.row_ids : b.task_ids).join(',');
    const gone = await rest(userToken, `/${p.kind === 'add_rows' ? 'table_rows' : 'tasks'}?id=in.(${ids})`, { method: 'DELETE' }).catch(() => null);
    return gone?.length ? 'Removed.' : null;
  }
  if (p.kind === 'edit_page') {
    if (p.payload.title && p.payload.title !== b.title) await rest(userToken, `/items?id=eq.${b.item_id}`, { method: 'PATCH', body: { title: b.title } }).catch(() => null);
    if (p.payload.markdown.trim()) {
      const r = await fetch(`${COLLAB_EDIT}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: userToken, id: b.item_id, mode: 'replace', markdown: b.markdown.trim() ? b.markdown : ' ' }) });
      if (!r.ok) return null;
    }
    return 'Put back.';
  }
  return null;
}

// Turn a model tool call into a stored proposal, or drop it if it does not hold up.
// project: the project chat it was asked in (071), so a new event there goes into that project.
async function proposalFrom(call, sources, chans, asker, spaceId, scope, tz, creatable = [], project = null, extra = {}) {
  const i = call.input || {};
  const content = await contentProposal(call, i, sources, asker, spaceId, scope, creatable, project, extra);
  if (content !== undefined) return content;
  if (call.name === 'create_event') {
    const sp = creatable.find((c) => c.name === i.space);
    const title = String(i.title || '').trim().slice(0, 200);
    const s = new Date(i.starts_at); const e = new Date(i.ends_at);
    if (!sp || !title || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
    const location = i.location ? String(i.location).slice(0, 200) : null;
    const inProject = project && sp.id === spaceId ? project : null;   // only in the space it was asked in
    const summary = `Add "${title}" to ${sp.name === 'personal' ? 'your personal calendar' : `#${sp.name}`}${inProject ? ` › ${inProject.name}` : ''}: ${fmtTime(s.toISOString(), tz)} to ${fmtTime(e.toISOString(), tz)}${location ? `, at ${location}` : ''}`;
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id',
      [asker, spaceId, scope, 'create', { space_id: sp.id, title, starts_at: s.toISOString(), ends_at: e.toISOString(), location, ...(inProject ? { project_id: inProject.id } : {}) }, summary])).rows[0].id;
    return { id, kind: 'create', summary };
  }
  if (call.name === 'send_message') {
    const ch = chans.find((c) => c.name === i.channel);
    const text = String(i.text || '').trim().slice(0, 2000);
    if (!ch || !text) return null;
    const summary = `Post in #${ch.name}: "${text}"`;
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id',
      [asker, spaceId, scope, 'send', { space_id: ch.id, text }, summary])).rows[0].id;
    return { id, kind: 'send', summary };
  }
  if (call.name === 'change_event') {
    const s = sources[Number(i.source) - 1];
    if (!s || s.type !== 'event') return null;
    const set = {};
    if (i.title) set.title = String(i.title).slice(0, 200);
    if (i.location) set.location = String(i.location).slice(0, 200);
    for (const k of ['starts_at', 'ends_at']) if (i[k]) { const d = new Date(i[k]); if (Number.isNaN(d.getTime())) return null; set[k] = d.toISOString(); }
    if (!Object.keys(set).length) return null;
    const starts = set.starts_at || s.starts_at; let ends = set.ends_at || s.ends_at;
    if (set.starts_at && !set.ends_at) { ends = new Date(new Date(set.starts_at).getTime() + (new Date(s.ends_at) - new Date(s.starts_at))).toISOString(); set.ends_at = ends; }
    if (new Date(ends) < new Date(starts)) return null;
    const parts = [];
    if (set.title) parts.push(`rename it "${set.title}"`);
    if (set.starts_at) parts.push(`move it to ${fmtTime(set.starts_at, tz)} to ${fmtTime(ends, tz)}`);
    if (set.location) parts.push(`set the location to ${set.location}`);
    const summary = `Change "${s.title}": ${parts.join(', ')}`;
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id',
      [asker, spaceId, scope, 'change', { event_id: s.id, set }, summary])).rows[0].id;
    return { id, kind: 'change', summary };
  }
  return null;
}

// ---------------------------------------------------------------- proposals: confirm, dismiss, undo
// Only the asker may decide. Execution runs as the assistant acting for the asker, with the original
// scope, through PostgREST: row-level security decides whether the action is allowed at all.
const CONTENT_KINDS = new Set(['create_item', 'edit_page', 'add_rows', 'add_tasks']);
async function proposals(user, method, parts, url) {
  if (method === 'GET' && parts.length === 0) {
    const ids = (url.searchParams.get('ids') || '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 50);
    if (!ids.length) return [200, []];
    return [200, (await db.query('select * from weft_private.proposal_statuses($1, $2::uuid[])', [user.id, ids])).rows];
  }
  const [id, action] = parts;
  if (!/^[0-9a-f-]{36}$/.test(id || '') || method !== 'POST') return [404, { error: 'not found' }];
  const [p] = (await db.query('select * from weft_private.proposal_get($1)', [id])).rows;
  if (!p || p.asker !== user.id) return [403, { error: 'only the person who asked can decide this' }];
  const move = (from, to, result = null, before = null) =>
    db.query('select weft_private.proposal_transition($1,$2,$3,$4,$5,$6) as ok', [id, user.id, from, to, result, before]).then((r) => r.rows[0].ok);

  if (action === 'dismiss') return (await move('pending', 'dismissed')) ? [200, { status: 'dismissed' }] : [409, { error: 'already decided' }];

  const token = await assistantToken(user.id, p.scope_space);
  if (action === 'confirm') {
    if (Date.now() - new Date(p.created_at).getTime() > 30 * 60 * 1000) { await move('pending', 'failed', 'expired'); return [409, { error: 'this proposal expired; ask again' }]; }
    if (!(await move('pending', 'done', 'running'))) return [409, { error: 'already decided' }];
    try {
      if (CONTENT_KINDS.has(p.kind)) {
        const [status, result, before] = await runContent(p, user.token);
        await move('done', status, result, before || null);
        return [200, { status }];
      }
      if (p.kind === 'send') {
        const r = await rest(token, '/messages', { method: 'POST', body: { space_id: p.payload.space_id, author_id: ASSISTANT_ID, body: p.payload.text, meta: { sent_for: user.id, proposal_id: id } } }).catch(() => null);
        if (!r?.length) { await move('done', 'failed', 'Not allowed: you can only post where you are a member.'); return [200, { status: 'failed' }]; }
        await move('done', 'done', 'Sent.');
        return [200, { status: 'done' }];
      }
      if (p.kind === 'create') {
        const r = await rest(token, '/events', { method: 'POST', body: p.payload }).catch(() => null);
        if (!r?.length) { await move('done', 'failed', "Not allowed: you can't add events there."); return [200, { status: 'failed' }]; }
        await move('done', 'done', 'Added.', { event_id: r[0].id });
        return [200, { status: 'done' }];
      }
      const [ev] = await rest(token, `/events?id=eq.${p.payload.event_id}&select=title,location,starts_at,ends_at`);
      if (!ev) { await move('done', 'failed', 'That event is gone, or you can no longer see it.'); return [200, { status: 'failed' }]; }
      const before = Object.fromEntries(Object.keys(p.payload.set).map((k) => [k, ev[k]]));
      const changed = await rest(token, `/events?id=eq.${p.payload.event_id}`, { method: 'PATCH', body: p.payload.set });
      if (!changed?.length) { await move('done', 'failed', "Not allowed: you can't change events in that space."); return [200, { status: 'failed' }]; }
      await move('done', 'done', 'Changed.', before);
      return [200, { status: 'done' }];
    } catch (e) { await move('done', 'failed', 'Something went wrong; nothing was changed.'); throw e; }
  }
  if (action === 'undo' && CONTENT_KINDS.has(p.kind)) {
    if (p.status !== 'done' || !p.before) return [409, { error: 'only a confirmed change can be undone' }];
    if (Date.now() - new Date(p.decided_at).getTime() > 24 * 3600 * 1000) return [409, { error: 'too late to undo (24 hours)' }];
    const done = await undoContent(p, user.token);
    if (!done) return [409, { error: 'could not undo; it may already be gone or changed' }];
    await move('done', 'undone', done);
    return [200, { status: 'undone' }];
  }
  if (action === 'undo') {
    if (!['change', 'create'].includes(p.kind) || p.status !== 'done' || !p.before) return [409, { error: 'only a confirmed event change or new event can be undone' }];
    if (p.kind === 'create') {
      // Removing it is a delete, which the assistant can never do; it runs with the person's own token.
      const gone = await rest(user.token, `/events?id=eq.${p.before.event_id}`, { method: 'DELETE' }).catch(() => null);
      if (!gone?.length) return [409, { error: 'could not remove it; it may already be gone' }];
      await move('done', 'undone', 'Removed.');
      return [200, { status: 'undone' }];
    }
    if (Date.now() - new Date(p.decided_at).getTime() > 24 * 3600 * 1000) return [409, { error: 'too late to undo (24 hours)' }];
    const reverted = await rest(token, `/events?id=eq.${p.payload.event_id}`, { method: 'PATCH', body: p.before }).catch(() => null);
    if (!reverted?.length) return [409, { error: 'could not undo; the event may be gone' }];
    await move('done', 'undone', 'Undone.');
    return [200, { status: 'undone' }];
  }
  return [404, { error: 'not found' }];
}

// ---------------------------------------------------------------- search: related by meaning
// Nearest neighbours of the search words, read with the person's own token (role weft_user), so only
// what they can open comes back. The search box shows these after the word matches.
async function related(user, q) {
  q = String(q || '').trim().slice(0, 200);
  if (!EMBED_URL) return [200, { enabled: false, results: [] }];
  if (q.length < 3) return [200, { enabled: true, results: [] }];
  let qv;
  try { [qv] = await embed([`search_query: ${q}`]); } catch (e) { return [200, { enabled: true, results: [], error: 'meaning search is unavailable' }]; }
  const hits = (await rest(user.token, '/rpc/semantic_search', { method: 'POST', body: { p_query: `[${qv.join(',')}]`, p_limit: 12 } }))
    .filter((h) => h.distance <= 0.6);
  const best = new Map();
  for (const h of hits) if (!best.has(h.source_id)) best.set(h.source_id, h);   // one result per source, its closest chunk
  const ids = (type) => [...best.values()].filter((h) => h.source_type === type).map((h) => h.source_id);
  const [ms, is, es] = await Promise.all([
    ids('message').length ? rest(user.token, `/messages?id=in.(${ids('message').join(',')})&select=id,space_id,body,created_at,space:spaces(name,kind)`) : [],
    ids('item').length ? rest(user.token, `/items?id=in.(${ids('item').join(',')})&select=id,space_id,kind,title,updated_at,space:spaces(name,kind)`) : [],
    ids('event').length ? rest(user.token, `/events?id=in.(${ids('event').join(',')})&select=id,space_id,title,location,starts_at,space:spaces(name,kind)`) : [],
  ]);
  // Records (048): read through the view as the person; then the names of their spaces.
  const rIds = [...best.values()].filter((h) => RKINDS.includes(h.source_type));
  const rs = rIds.length ? (await rest(user.token, `/records?id=in.(${[...new Set(rIds.map((h) => h.source_id))].join(',')})&select=${RSELECT}`))
    .filter((r) => best.get(r.id)?.source_type === r.kind) : [];
  const rsp = [...new Set(rs.map((r) => r.space_id).filter(Boolean))];
  const spaceOf = new Map(rsp.length ? (await rest(user.token, `/spaces?id=in.(${rsp.join(',')})&select=id,name,kind`)).map((x) => [x.id, x]) : []);
  const snip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const out = [
    // Your own questions to Weft are not "related" results (they echo the search); word search still finds them.
    ...ms.filter((m) => m.space?.kind !== 'assistant' && !/@weft\b/i.test(m.body)).map((m) => ({ kind: 'message', id: m.id, space_id: m.space_id, space_name: m.space?.name, space_kind: m.space?.kind, title: null, snippet: snip(m.body), at: m.created_at })),
    ...is.map((i) => ({ kind: i.kind, id: i.id, space_id: i.space_id, space_name: i.space?.name, space_kind: i.space?.kind, title: i.title,
      snippet: snip(best.get(i.id)?.content.replace(/^[^\n]*\n/, '')), at: i.updated_at })),
    ...es.map((e) => ({ kind: 'event', id: e.id, space_id: e.space_id, space_name: e.space?.name, space_kind: e.space?.kind, title: e.title, snippet: e.location, at: e.starts_at })),
    ...rs.map((r) => ({ kind: r.kind, id: r.id, space_id: r.space_id, space_name: spaceOf.get(r.space_id)?.name, space_kind: spaceOf.get(r.space_id)?.kind, title: r.title,
      snippet: snip(best.get(r.id)?.content.replace(/^[^\n]*\n/, '')), at: r.at, ref: r.ref })),
  ].sort((a, b) => best.get(a.id).distance - best.get(b.id).distance).slice(0, 6);
  return [200, { enabled: true, results: out }];
}

// ---------------------------------------------------------------- your own key
const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
async function mine(user, method, parts, body) {
  const { rows: [s] } = await db.query('select * from weft_private.settings_get()');
  const allowed = s.allow_personal_keys;
  if (method === 'GET' && parts.length === 0) {
    const { rows: [p] } = await db.query('select * from weft_private.personal_get($1)', [user.id]);
    return [200, { allowed, provider: p || null }];
  }
  if (method === 'DELETE' && parts.length === 0) {   // removing your own key always works
    await db.query('select weft_private.personal_delete($1)', [user.id]);
    return [200, { ok: true }];
  }
  if (!allowed) return [403, { error: 'Your admin has not turned on personal keys.' }];
  if (method === 'PUT' && parts.length === 0) {
    const b = body || {};
    if (!['anthropic', 'openai'].includes(b.kind)) return [400, { error: 'Choose Anthropic or OpenAI.' }];
    if (!MODEL_RE.test(String(b.model || ''))) return [400, { error: 'Give the model name, like claude-opus-5-5.' }];
    if (b.effort && !EFFORTS.has(b.effort)) return [400, { error: 'bad effort' }];
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    for (const v of [b.monthly_cap_usd, b.price_in, b.price_out]) if (num(v) !== null && !(num(v) >= 0)) return [400, { error: 'Amounts must be zero or more.' }];
    await db.query('select weft_private.personal_save($1,$2,$3,$4,$5,$6,$7,$8)',
      [user.id, b.kind, String(b.model), b.kind === 'anthropic' ? (b.effort || 'low') : null, num(b.monthly_cap_usd), num(b.price_in) ?? 0, num(b.price_out) ?? 0, b.enabled !== false]);
    return [200, { ok: true }];
  }
  if (method === 'PUT' && parts[0] === 'key') {
    const key = String(body?.key || '').trim();
    if (key.length < 8 || key.length > 400) return [400, { error: 'That does not look like a key.' }];
    const { rows: [p] } = await db.query('select * from weft_private.personal_get($1)', [user.id]);
    if (!p) return [400, { error: 'Save the provider and model first.' }];
    await db.query('select weft_private.personal_set_key($1,$2,$3)', [user.id, encrypt(key), key.slice(-4)]);
    return [200, { ok: true, key_hint: key.slice(-4) }];
  }
  if (method === 'POST' && parts[0] === 'test') {
    const { rows: [p] } = await db.query('select * from weft_private.personal_for_call($1)', [user.id]);
    if (!p) return [200, { ok: false, error: 'Add your key and turn it on first.' }];
    try {
      const r = await callProvider({ ...p, base_url: p.kind === 'anthropic' ? (PERSONAL_ANTHROPIC_URL || null) : PERSONAL_OPENAI_URL }, 'Reply with the single word OK.', 'Say OK.');
      return [200, { ok: true, model: r.model, ms: r.ms }];
    } catch (e) { return [200, { ok: false, error: e.message }]; }
  }
  return [404, { error: 'not found' }];
}

async function adminSettings(user, method, body) {
  const { rows } = await db.query('select weft_private.assist_is_admin($1) as a', [user.id]);
  if (!rows[0].a) return [403, { error: 'admins only' }];
  // Each switch changes only when it is sent, so turning one on never turns the other off.
  if (method === 'PUT' && body && 'allow_personal_keys' in body) await db.query('select weft_private.settings_save($1,$2)', [user.id, !!body.allow_personal_keys]);
  if (method === 'PUT' && body && 'web_search' in body) await db.query('select weft_private.web_search_save($1,$2)', [user.id, !!body.web_search]);
  const { rows: [s] } = await db.query('select * from weft_private.settings_get()');
  const { rows: [w] } = await db.query('select weft_private.web_search_get() as on');
  return [200, { allow_personal_keys: s.allow_personal_keys, personal_keys: Number(s.personal_keys), web_search: w.on }];   // a count, never whose
}

// ---------------------------------------------------------------- admin
const SLOTS = new Set(['primary', 'secondary']);
const KINDS = new Set(['anthropic', 'openai', 'ollama']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function admin(user, method, parts, body) {
  const { rows } = await db.query('select weft_private.assist_is_admin($1) as a', [user.id]);
  if (!rows[0].a) return [403, { error: 'admins only' }];
  if (method === 'GET' && parts[0] === 'embeddings') {
    const { rows: c } = await db.query('select * from weft_private.embed_count()');
    return [200, { model: EMBED_MODEL, url: EMBED_URL, sources: Number(c[0].sources), chunks: Number(c[0].chunks), paused: embedFailures > 0, enabled: !!EMBED_URL }];
  }
  if (method === 'GET' && parts.length === 0) {
    const { rows: p } = await db.query('select * from weft_private.providers_public()');
    return [200, p];
  }
  const slot = parts[0];
  if (!SLOTS.has(slot)) return [404, { error: 'no such slot' }];
  if (method === 'PUT' && parts.length === 1) {
    const b = body || {};
    if (!KINDS.has(b.kind) || !b.model) return [400, { error: 'kind and model are required' }];
    if (b.kind !== 'anthropic' && !/^https?:\/\//.test(b.base_url || '')) return [400, { error: 'base URL required for this provider' }];
    if (b.effort && !EFFORTS.has(b.effort)) return [400, { error: 'bad effort' }];
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    await db.query('select weft_private.provider_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [slot, b.kind, b.base_url || null, String(b.model), b.kind === 'anthropic' ? (b.effort || 'low') : null,
        num(b.monthly_cap_usd), num(b.price_in) ?? 0, num(b.price_out) ?? 0, b.enabled !== false, user.id]);
    return [200, { ok: true }];
  }
  if (parts[1] === 'key' && method === 'PUT') {
    const key = String(body?.key || '').trim();
    if (key.length < 8) return [400, { error: 'that does not look like a key' }];
    await db.query('select weft_private.provider_set_key($1,$2,$3,$4)', [slot, encrypt(key), key.slice(-4), user.id]);
    return [200, { ok: true, key_hint: key.slice(-4) }];
  }
  if (parts[1] === 'key' && method === 'DELETE') {
    await db.query('select weft_private.provider_set_key($1,null,null,$2)', [slot, user.id]);
    return [200, { ok: true }];
  }
  if (parts[1] === 'test' && method === 'POST') {
    const { rows: ps } = await db.query('select * from weft_private.providers_for_call() where slot = $1', [slot]);
    try {
      const r = await callProvider(ps[0], 'Reply with the single word OK.', 'Say OK.');
      return [200, { ok: true, model: r.model, ms: r.ms, reply: r.text.slice(0, 40) }];
    } catch (e) { return [200, { ok: false, error: e.message }]; }
  }
  return [404, { error: 'not found' }];
}

// ---------------------------------------------------------------- personal agents (067)
// Someone's own agent (any OpenAI-compatible chat endpoint, such as Hermes Agent's API server). An admin
// sets its address; only its owner can ask it anything. Each Weft conversation (or channel) is its own
// thread on the agent's side: the agent is sent X-Hermes-Session-Id = weft-<space id> and keeps the
// history itself, so Weft sends only the new message (plus, in a channel, the recent messages there).
const AGENT_TIMEOUT_MS = Number(env('AGENT_TIMEOUT_MS', '600000'));
const AGENT_CONTEXT = 15;
const agentBusy = new Set();   // spaces with a question in flight
const AGENT_HANDLE = /^[a-z][a-z0-9-]{1,29}$/;
const agentUrlOk = (u) => { try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) && !x.username && !x.password && !x.search && !x.hash; } catch { return false; } };
const agentPublic = (a) => ({ id: a.id, display_name: a.display_name, handle: a.handle, owner_id: a.owner_id, owner_name: a.owner_name,
  base_url: a.base_url, model: a.model, enabled: a.enabled, has_key: !!a.key_ciphertext, key_hint: a.key_hint,
  last_used_at: a.last_used_at, last_error: a.last_error, updated_at: a.updated_at });
const agentsAll = async () => (await db.query('select * from weft_private.agents_list()')).rows;
const agentHeaders = (a, extra = {}) => ({ 'Content-Type': 'application/json', ...(a.key_ciphertext ? { Authorization: `Bearer ${decrypt(a.key_ciphertext)}` } : {}), ...extra });
const agentBase = (a) => a.base_url.replace(/\/+$/, '');

async function agentCall(a, sessionId, content) {
  const t0 = Date.now();
  const r = await fetch(`${agentBase(a)}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    // The same thread id three ways, so each conversation is its own session on the agent: Hermes Agent
    // reads X-Hermes-Session-Id, OpenClaw reads x-openclaw-session-key (or the OpenAI `user` field).
    headers: agentHeaders(a, { 'X-Hermes-Session-Id': sessionId, 'x-openclaw-session-key': sessionId }),
    body: JSON.stringify({ model: a.model, stream: false, user: sessionId, messages: [{ role: 'user', content }] }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('the reply was not JSON'); }
  const out = j.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) throw new Error('the reply was empty');
  return { text: out.trim().slice(0, 20000), ms: Date.now() - t0 };
}

async function agentAsk(user, messageId) {
  if (!/^[0-9a-f-]{36}$/.test(messageId || '')) return [400, { error: 'message_id required' }];
  const [q] = await rest(user.token, `/messages?id=eq.${messageId}&select=id,space_id,author_id,body,space:spaces(kind,name,agent_id)`);
  if (!q) return [404, { error: 'no such message' }];
  if (q.author_id !== user.id) return [403, { error: 'you can only ask with your own message' }];
  const mineAll = (await agentsAll()).filter((a) => a.owner_id === user.id && !a.owner_disabled);
  let agent;
  if (q.space.kind === 'agent') agent = mineAll.find((a) => a.id === q.space.agent_id);
  else if (['channel', 'dm', 'personal'].includes(q.space.kind)) {
    const handles = [...q.body.matchAll(/@([a-z][a-z0-9-]{1,29})\b/gi)].map((m) => m[1].toLowerCase());
    agent = handles.map((h) => mineAll.find((a) => a.handle === h)).find(Boolean);
  }
  if (!agent) return [q.space.kind === 'agent' ? 403 : 400, { error: q.space.kind === 'agent' ? 'that is not one of your agents' : 'mention one of your agents to ask it here' }];
  if (!agent.enabled) return [409, { error: `${agent.display_name} is turned off` }];
  if (q.space.kind !== 'agent') {
    // 070: an agent reads a channel only if its owners allow AI agents there (the agent claim hides it otherwise),
    // and it answers privately, in its owner's personal space.
    const [open] = await rest(await assistantToken(user.id, q.space_id, { agent: true }), `/spaces?id=eq.${q.space_id}&select=id`);
    if (!open) return [403, { error: `The owners of this channel have turned off AI agents here, so ${agent.display_name} cannot read it.` }];
    const [home] = await rest(user.token, `/spaces?kind=eq.personal&created_by=eq.${user.id}&select=id`);
    if (!home) return [409, { error: 'Weft could not find your personal space.' }];
    q.reply_space = home.id;
  }
  if (agentBusy.has(q.space_id)) return [429, { error: `${agent.display_name} is still answering here` }];
  agentBusy.add(q.space_id);
  agentRun(user, q, agent).catch((e) => log('agent run failed', e.message)).finally(() => agentBusy.delete(q.space_id));
  return [202, { agent: agent.id, name: agent.display_name }];
}

async function agentRun(user, q, agent) {
  let content = q.body;
  if (q.space.kind !== 'agent') {
    // In a channel or direct message the agent sees only that space, and only its recent messages.
    const token = await assistantToken(user.id, q.space_id, { agent: true });
    const recent = await rest(token, `/messages?space_id=eq.${q.space_id}&id=neq.${q.id}&select=body,created_at,author:users(display_name)&order=created_at.desc&limit=${AGENT_CONTEXT}`);
    const [me] = await rest(token, `/users?id=eq.${user.id}&select=display_name`);
    const where = q.space.kind === 'channel' ? `the #${q.space.name} channel` : q.space.kind === 'dm' ? 'a direct message' : 'their personal space';
    const ask = q.body.replace(new RegExp(`@${agent.handle}\\b`, 'gi'), '').trim() || q.body;
    content = `(Sent from Weft, a team workspace, in ${where}. Only ${me?.display_name ?? 'your owner'} will read your reply; they may share it there.)\n`
      + (recent.length ? `Recent messages there, oldest first:\n${recent.reverse().map((m) => `${m.author?.display_name ?? 'Someone'}: ${m.body}`).join('\n')}\n\n` : '\n')
      + `${me?.display_name ?? 'Your owner'} asks you: ${ask}`;
  }
  let body; let meta;
  try {
    const r = await agentCall(agent, `weft-${q.space_id}`, content);
    body = r.text; meta = { agent: true, asker: user.id, question_id: q.id, ms: r.ms };
    await db.query('update weft_private.agents set last_used_at = now(), last_error = null where id = $1', [agent.id]);
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'it took too long to answer' : e.message;
    log(`agent ${agent.handle}: ${why}`);
    body = `I couldn't answer that (${why}). Try again in a moment.`;
    meta = { agent: true, asker: user.id, question_id: q.id, error: true };
    await db.query('update weft_private.agents set last_used_at = now(), last_error = $2 where id = $1', [agent.id, why.slice(0, 300)]);
  }
  // Asked in a channel or direct message: the answer goes to the owner's personal space, with where it was asked;
  // they move it into the channel themselves if they want to share it (070).
  const target = q.reply_space || q.space_id;
  if (q.reply_space) {
    const where = q.space.kind === 'channel' ? `#${q.space.name}` : q.space.kind === 'dm' ? 'a direct message' : 'your personal space';
    meta = { ...meta, asked_in: q.space_id };
    body = `Answer to your question in ${where}:\n\n${body}`.slice(0, 20000);
  }
  const token = await assistantToken(user.id, target);   // fresh: the run may have taken minutes
  await rest(token, '/messages', { method: 'POST', body: { space_id: target, author_id: agent.id, body, meta } });
}

async function agentAdmin(user, method, parts, body) {
  const { rows } = await db.query('select weft_private.assist_is_admin($1) as a', [user.id]);
  if (!rows[0].a) return [403, { error: 'admins only' }];
  if (method === 'GET' && parts.length === 0) return [200, (await agentsAll()).map(agentPublic)];
  const save = async (id) => {
    const b = body || {};
    const handle = String(b.handle || '').trim().toLowerCase();
    if (!String(b.display_name || '').trim()) return [400, { error: 'Give the agent a name.' }];
    if (!AGENT_HANDLE.test(handle) || handle === 'weft') return [400, { error: 'The @name is 2 to 30 lowercase letters, numbers or dashes, starting with a letter (not "weft").' }];
    if (!agentUrlOk(String(b.base_url || '').trim())) return [400, { error: 'The address must start with http:// or https:// (for example http://host:8642/v1).' }];
    if (!/^[0-9a-f-]{36}$/.test(String(b.owner_id || ''))) return [400, { error: 'Choose whose agent it is.' }];
    try {
      const { rows: [r] } = await db.query('select weft_private.agent_save($1,$2,$3,$4,$5,$6,$7,$8) as id',
        [id, b.owner_id, String(b.display_name), handle, String(b.base_url).trim(), String(b.model || '').slice(0, 200), b.enabled !== false, user.id]);
      return [200, { ok: true, id: r.id }];
    } catch (e) {
      if (e.code === '23505') return [409, { error: `@${handle} is already taken.` }];
      if (e.code === 'WD005' || e.code === '22023' || e.code === '23514') return [400, { error: e.code === '23514' ? 'Check the @name and address.' : e.message }];
      throw e;
    }
  };
  if (method === 'POST' && parts.length === 0) return save(null);
  const id = parts[0];
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return [404, { error: 'not found' }];
  const a = (await agentsAll()).find((x) => x.id === id);
  if (!a) return [404, { error: 'no such agent' }];
  if (method === 'PUT' && parts.length === 1) return save(id);
  if (method === 'DELETE' && parts.length === 1) { await db.query('select weft_private.agent_delete($1)', [id]); return [200, { ok: true }]; }
  if (parts[1] === 'key' && method === 'PUT') {
    const key = String(body?.key || '').trim();
    if (key.length < 8 || key.length > 400) return [400, { error: 'That does not look like a key.' }];
    await db.query('update weft_private.agents set key_ciphertext = $2, key_hint = $3, updated_at = now() where id = $1', [id, encrypt(key), key.slice(-4)]);
    return [200, { ok: true, key_hint: key.slice(-4) }];
  }
  if (parts[1] === 'key' && method === 'DELETE') {
    await db.query('update weft_private.agents set key_ciphertext = null, key_hint = null, updated_at = now() where id = $1', [id]);
    return [200, { ok: true }];
  }
  if (parts[1] === 'test' && method === 'POST') {
    // Lists the endpoint's models: proves the address and key work without starting a conversation.
    const t0 = Date.now();
    try {
      const r = await fetch(`${agentBase(a)}/models`, { headers: agentHeaders(a), signal: AbortSignal.timeout(15000) });
      if (!r.ok) return [200, { ok: false, error: `HTTP ${r.status}` }];
      const j = await r.json().catch(() => ({}));
      const models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 10);
      return [200, { ok: true, ms: Date.now() - t0, models, has_model: models.includes(a.model) }];
    } catch (e) { return [200, { ok: false, error: e.name === 'TimeoutError' ? 'no answer in 15 seconds' : e.message }]; }
  }
  return [404, { error: 'not found' }];
}

// ---------------------------------------------------------------- embeddings
async function embed(texts) {
  if (!EMBED_URL) throw new Error('meaning search is off (no EMBED_URL)');
  const r = await fetch(`${EMBED_URL}/api/embed`, { method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: texts }) });
  if (!r.ok) throw new Error(`embedder HTTP ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d.embeddings) || d.embeddings.length !== texts.length || d.embeddings.some((v) => v.length !== EMBED_DIM)) throw new Error('embedder returned unexpected vectors');
  return d.embeddings;
}

// Split long text into chunks of about 1000 characters on paragraph (or row) boundaries.
function chunks(text) {
  // Lines longer than a chunk are cut at word boundaries first: the embedder rejects anything past its
  // context (nomic-embed-text: about 2,000 tokens), and one long table row once blocked every page.
  const lines = String(text).split(/\n+/).flatMap((l) => {
    if (l.length <= 1000) return [l];
    const parts = []; let rest = l;
    while (rest.length > 1000) {
      let cut = rest.lastIndexOf(' ', 1000); if (cut < 500) cut = 1000;
      parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
    }
    if (rest) parts.push(rest);
    return parts;
  });
  const out = []; let cur = '';
  for (const para of lines) {
    if ((cur + '\n' + para).length > 1000 && cur) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${para}` : para;
  }
  if (cur.trim()) out.push(cur);
  return out.slice(0, 40);
}

// Embed whatever is new or changed, every few seconds; back off while the embedder is unreachable.
let embedFailures = 0;
async function embedWorker() {
  try {
    const { rows } = await db.query('select * from weft_private.embed_pending($1, $2)', [24, EMBED_MODEL]);
    if (rows.length) {
      const items = rows.map((r) => {
        const title = r.source_type === 'item' ? r.body.split('\n')[0] : '';
        return { r, parts: (r.source_type === 'item' ? chunks(r.body).map((c, i) => (i === 0 ? c : `${title}\n${c}`)) : [r.body]).filter((x) => x.trim()) };
      });
      const store = (r, parts, vecs) => db.query('select weft_private.embed_store($1,$2,$3,$4,$5)', [r.source_type, r.source_id, r.hash, EMBED_MODEL,
        JSON.stringify(parts.map((p, i) => ({ content: p, embedding: `[${vecs[i].join(',')}]` })))]);
      const flat = items.flatMap((x) => x.parts.map((p) => `search_document: ${p}`));
      let vecs = null;
      try { vecs = flat.length ? await embed(flat) : []; } catch (e) {
        if (!/HTTP 4\d\d/.test(e.message)) throw e;   // unreachable or 5xx: back off and retry the batch later
        // The embedder refused the batch: one item must not block the rest. Go one by one; an item that is
        // still refused is stored with no chunks (so it is not retried until its text changes) and logged.
        for (const { r, parts } of items) {
          try { await store(r, parts, parts.length ? await embed(parts.map((p) => `search_document: ${p}`)) : []); }
          catch (e2) {
            if (!/HTTP 4\d\d/.test(e2.message)) throw e2;
            log(`embedding skipped for ${r.source_type} ${r.source_id}: ${e2.message}`);
            await db.query('select weft_private.embed_store($1,$2,$3,$4,$5)', [r.source_type, r.source_id, r.hash, EMBED_MODEL, '[]']);
          }
        }
      }
      if (vecs) {
        let k = 0;
        for (const { r, parts } of items) { await store(r, parts, vecs.slice(k, k + parts.length)); k += parts.length; }
      }
      if (embedFailures) log('embedder reachable again');
      embedFailures = 0;
      setTimeout(embedWorker, 200); // more may be waiting
      return;
    }
    embedFailures = 0;
  } catch (e) {
    if (embedFailures++ % 12 === 0) log('embedding paused:', e.message);
  }
  setTimeout(embedWorker, embedFailures ? 30000 : 5000);
}
if (EMBED_URL) setTimeout(embedWorker, 3000); else log('meaning search off: EMBED_URL is not set');

// ---------------------------------------------------------------- HTTP
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', (c) => { data += c; if (data.length > 8192) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    const user = await userFrom(req);
    if (!user) return send(res, 401, { error: 'sign in first' });
    if (user.agent && !(req.method === 'GET' && url.pathname === '/assistant/search/related')) return send(res, 403, { error: 'AI apps can only search here' });
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
    if (req.method === 'POST' && url.pathname === '/assistant/ask') return send(res, ...(await ask(user, body.message_id, body.tz)));
    if (req.method === 'POST' && url.pathname === '/assistant/agents/ask') return send(res, ...(await agentAsk(user, body.message_id)));
    const am = /^\/assistant\/admin\/agents(?:\/(.*))?$/.exec(url.pathname);
    if (am) return send(res, ...(await agentAdmin(user, req.method, (am[1] || '').split('/').filter(Boolean), body)));
    const pm = /^\/assistant\/proposals(?:\/(.*))?$/.exec(url.pathname);
    if (pm) return send(res, ...(await proposals(user, req.method, (pm[1] || '').split('/').filter(Boolean), url)));
    if (req.method === 'GET' && url.pathname === '/assistant/search/related') return send(res, ...(await related(user, url.searchParams.get('q'))));
    const me = /^\/assistant\/me\/provider(?:\/(.*))?$/.exec(url.pathname);
    if (me) return send(res, ...(await mine(user, req.method, (me[1] || '').split('/').filter(Boolean), body)));
    if (url.pathname === '/assistant/admin/settings' && ['GET', 'PUT'].includes(req.method)) return send(res, ...(await adminSettings(user, req.method, body)));
    const m = /^\/assistant\/admin\/providers(?:\/(.*))?$/.exec(url.pathname);
    if (m) return send(res, ...(await admin(user, req.method, (m[1] || '').split('/').filter(Boolean), body)));
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', url.pathname, e.message);
    send(res, e.status === 404 ? 404 : 500, { error: 'the assistant hit an error' });
  }
}).listen(8090, () => log('weft-assistant on :8090'));
