/**
 * Weft Phase 1: load the synthetic Porchfest dataset into a Colanode server.
 *
 * Mirrors the dataset's permission model in Colanode's own primitives:
 *   dataset space  -> Colanode space, with per-user collaborator roles
 *   CSV table      -> Colanode database (+ table / board / calendar views)
 *   foreign key    -> relation field (including cross-space relations, a deliberate test)
 *
 * Adapted from Colanode's scripts/src/seed (v0.4.7). It must run inside a Colanode
 * checkout so @colanode/core and @colanode/crdt resolve; run.sh copies it there.
 *
 * Env: COLANODE_URL (default http://localhost:3000), DATA_DIR, ACCOUNTS_FILE (output).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  generateId,
  generateFractionalIndex,
  IdType,
  NodeAttributes,
  NodeModel,
  NodeRole,
  FieldAttributes,
  SelectOptionAttributes,
  FieldValue,
  Mutation,
  CreateNodeMutationData,
  ApiHeader,
  spaceModel,
  channelModel,
  databaseModel,
  databaseViewModel,
  recordModel,
} from '@colanode/core';
import { encodeState, YDoc } from '@colanode/crdt';

const SERVER = process.env.COLANODE_URL ?? 'http://localhost:3000';
const DATA_DIR = process.env.DATA_DIR!;
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE!;
const API = `${SERVER}/client/v1`;
const HEADERS = {
  'Content-Type': 'application/json',
  [ApiHeader.ClientType]: 'seed',
  [ApiHeader.ClientPlatform]: 'seed',
  [ApiHeader.ClientVersion]: '0.0.1',
};

// ---------- tiny helpers ----------

function readCsv(name: string): Record<string, string>[] {
  const text = fs.readFileSync(path.join(DATA_DIR, `${name}.csv`), 'utf8');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

async function call<T>(method: string, url: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function createNode(id: string, attributes: NodeAttributes, model: NodeModel): Mutation {
  const ydoc = new YDoc();
  const update = ydoc.update(model.attributesSchema, attributes);
  if (!update) throw new Error(`empty update for ${id}`);
  const data: CreateNodeMutationData = {
    nodeId: id,
    updateId: generateId(IdType.Update),
    createdAt: new Date().toISOString(),
    data: encodeState(update),
  };
  return { id: generateId(IdType.Mutation), type: 'node.create', data, createdAt: new Date().toISOString() };
}

const COLORS = ['blue', 'green', 'purple', 'pink', 'yellow', 'orange', 'red', 'gray'];

function field(type: string, name: string, after?: FieldAttributes, extra: Record<string, unknown> = {}): FieldAttributes {
  return {
    id: generateId(IdType.Field),
    type,
    name,
    index: generateFractionalIndex(after?.index),
    ...extra,
  } as FieldAttributes;
}

function selectField(type: 'select' | 'multi_select', name: string, values: string[], after?: FieldAttributes) {
  let prev: string | undefined;
  const options: Record<string, SelectOptionAttributes> = {};
  const byName: Record<string, string> = {};
  [...new Set(values)].sort().forEach((v, i) => {
    const opt: SelectOptionAttributes = {
      id: generateId(IdType.SelectOption),
      name: v,
      color: COLORS[i % COLORS.length]!,
      index: generateFractionalIndex(prev),
    };
    prev = opt.index;
    options[opt.id] = opt;
    byName[v] = opt.id;
  });
  return { field: field(type, name, after, { options }), byName };
}

const str = (v: string): FieldValue => ({ type: 'string', value: v });
const txt = (v: string): FieldValue => ({ type: 'text', value: v });
const num = (v: string): FieldValue => ({ type: 'number', value: Number(v) });
const bool = (v: string): FieldValue => ({ type: 'boolean', value: v === 'yes' });
const rel = (ids: string[]): FieldValue => ({ type: 'string_array', value: ids });
// Dataset times are local festival times (America/Los_Angeles, PDT in April = UTC-7).
const date = (local: string): FieldValue => ({ type: 'string', value: new Date(`${local}:00-07:00`).toISOString() });

// ---------- main ----------

type Login = { type: string; token: string; account: { id: string; email: string }; workspaces: { id: string; name: string; user: { id: string } }[] };

async function main() {
  const users = readCsv('users');
  const members = readCsv('members');

  // 1. Accounts. Passwords are random and written to ACCOUNTS_FILE (git-ignored, mode 600).
  const creds = users.map((u) => ({ ...u, password: crypto.randomBytes(12).toString('base64url') }));
  const admin = creds.find((u) => u.user_id === 'u-alex')!;
  const others = creds.filter((u) => u !== admin);

  console.log('registering', admin.email);
  const adminLogin = await call<Login>('POST', `${API}/auth/email/register`, { name: admin.display_name, email: admin.email, password: admin.password });
  const ws = adminLogin.workspaces[0]!;
  await call('PATCH', `${API}/workspaces/${ws.id}`, { name: 'Weft Porchfest (synthetic)', description: 'Weft Phase 1 baseline. All data is synthetic.' }, adminLogin.token);

  // Invite before register, as Colanode's own seed does. Workspace role "collaborator":
  // what each person can see is then decided by space membership, not workspace role.
  await call('POST', `${API}/workspaces/${ws.id}/users`, { users: others.map((u) => ({ email: u.email, role: 'collaborator' })) }, adminLogin.token);

  const userIdByKey: Record<string, string> = { [admin.user_id]: ws.user.id };
  for (const u of others) {
    console.log('registering', u.email);
    const login = await call<Login>('POST', `${API}/auth/email/register`, { name: u.display_name, email: u.email, password: u.password });
    const membership = login.workspaces.find((w) => w.id === ws.id);
    if (!membership) throw new Error(`${u.email} did not land in the shared workspace`);
    userIdByKey[u.user_id] = membership.user.id;
  }

  // 2. Spaces with per-user roles from members.csv.
  const roleMap: Record<string, NodeRole> = { owner: 'admin', editor: 'editor', viewer: 'viewer' };
  const spaceTitles: Record<string, [string, string]> = {
    festival: ['Festival', 'Porches, performers and the published schedule'],
    volunteers: ['Volunteers', 'Shifts and volunteer contact details'],
    organizers: ['Organizers', 'Host contacts and private notes'],
  };
  const mutations: Mutation[] = [];
  const spaceId: Record<string, string> = {};
  for (const [key, [name, description]] of Object.entries(spaceTitles)) {
    const collaborators: Record<string, NodeRole> = {};
    for (const m of members.filter((m) => m.space_id === key)) collaborators[userIdByKey[m.user_id]!] = roleMap[m.role]!;
    spaceId[key] = generateId(IdType.Space);
    mutations.push(createNode(spaceId[key]!, { type: 'space', name, description, collaborators, visibility: 'private' } as NodeAttributes, spaceModel));
    mutations.push(createNode(generateId(IdType.Channel), { type: 'channel', name: `${key}-chat`, parentId: spaceId[key]! } as NodeAttributes, channelModel));
  }

  // 3. Databases.
  const recordIds: Record<string, Record<string, string>> = {}; // table -> dataset id -> record id

  function database(
    space: string, name: string, fields: FieldAttributes[],
    views: { name: string; layout: 'table' | 'board' | 'calendar'; groupBy?: string }[],
  ) {
    const id = generateId(IdType.Database);
    mutations.push(createNode(id, { type: 'database', parentId: spaceId[space]!, name, fields: Object.fromEntries(fields.map((f) => [f.id, f])) } as NodeAttributes, databaseModel));
    let prev: string | undefined;
    for (const v of views) {
      const index = generateFractionalIndex(prev);
      prev = index;
      mutations.push(createNode(generateId(IdType.DatabaseView), { type: 'database_view', parentId: id, name: v.name, layout: v.layout, index, ...(v.groupBy ? { groupBy: v.groupBy } : {}) } as NodeAttributes, databaseViewModel));
    }
    return id;
  }

  function records(table: string, databaseId: string, rows: Record<string, string>[], idCol: string, build: (r: Record<string, string>) => [string, Record<string, FieldValue>]) {
    recordIds[table] = {};
    for (const r of rows) {
      const id = generateId(IdType.Record);
      recordIds[table]![r[idCol]!] = id;
      const [name, fields] = build(r);
      mutations.push(createNode(id, { type: 'record', parentId: databaseId, databaseId, name, fields } as NodeAttributes, recordModel));
    }
  }

  // Porches (festival)
  const porches = readCsv('porches');
  const pAddr = field('text', 'Address');
  const pHood = selectField('select', 'Neighborhood', porches.map((p) => p.neighborhood!), pAddr);
  const pCap = field('number', 'Capacity', pHood.field);
  const pAcc = field('boolean', 'Accessible', pCap);
  const pPow = field('boolean', 'Power available', pAcc);
  const pRain = field('text', 'Rain plan', pPow);
  const porchDb = database('festival', 'Porches', [pAddr, pHood.field, pCap, pAcc, pPow, pRain],
    [{ name: 'All porches', layout: 'table' }, { name: 'By neighborhood', layout: 'board', groupBy: pHood.field.id }]);
  records('porches', porchDb, porches, 'porch_id', (p) => [`${p.porch_id} · ${p.address}`, {
    [pAddr.id]: txt(p.address!), [pHood.field.id]: str(pHood.byName[p.neighborhood!]!), [pCap.id]: num(p.capacity!),
    [pAcc.id]: bool(p.accessible!), [pPow.id]: bool(p.power_available!), [pRain.id]: txt(p.rain_plan!),
  }]);

  // Performers (festival)
  const perf = readCsv('performers');
  const bGenre = selectField('select', 'Genre', perf.map((b) => b.genre!));
  const bMem = field('number', 'Members', bGenre.field);
  const bPow = field('boolean', 'Needs power', bMem);
  const bContact = field('text', 'Contact', bPow);
  const bEmail = field('email', 'Contact email', bContact);
  const perfDb = database('festival', 'Performers', [bGenre.field, bMem, bPow, bContact, bEmail],
    [{ name: 'All performers', layout: 'table' }, { name: 'By genre', layout: 'board', groupBy: bGenre.field.id }]);
  records('performers', perfDb, perf, 'performer_id', (b) => [b.name!, {
    [bGenre.field.id]: str(bGenre.byName[b.genre!]!), [bMem.id]: num(b.members!), [bPow.id]: bool(b.needs_power!),
    [bContact.id]: txt(b.contact_name!), [bEmail.id]: str(b.contact_email!),
  }]);

  // Schedule (festival) - the record that should show up in table, board and calendar alike.
  const slots = readCsv('slots');
  const sStart = field('date', 'Starts');
  const sStatus = selectField('select', 'Status', slots.map((s) => s.status!), sStart);
  const sPorch = field('relation', 'Porch', sStatus.field, { databaseId: porchDb });
  const sPerf = field('relation', 'Performer', sPorch, { databaseId: perfDb });
  const schedDb = database('festival', 'Schedule', [sStart, sStatus.field, sPorch, sPerf],
    [{ name: 'Calendar', layout: 'calendar', groupBy: sStart.id }, { name: 'Table', layout: 'table' }, { name: 'By status', layout: 'board', groupBy: sStatus.field.id }]);
  const bandName = Object.fromEntries(perf.map((b) => [b.performer_id!, b.name!]));
  records('slots', schedDb, slots, 'slot_id', (s) => [`${s.starts_at!.slice(11)} ${bandName[s.performer_id!]} @ ${s.porch_id}`, {
    [sStart.id]: date(s.starts_at!), [sStatus.field.id]: str(sStatus.byName[s.status!]!),
    [sPorch.id]: rel([recordIds.porches![s.porch_id!]!]), [sPerf.id]: rel([recordIds.performers![s.performer_id!]!]),
  }]);

  // Volunteer shifts (volunteers) - relation points across spaces into Festival/Porches.
  const vols = readCsv('volunteers');
  const vEmail = field('email', 'Email');
  const vRole = selectField('select', 'Role', vols.map((v) => v.role!), vEmail);
  const vPorch = field('relation', 'Assigned porch', vRole.field, { databaseId: porchDb });
  const vStart = field('date', 'Shift start', vPorch);
  const vEnd = field('date', 'Shift end', vStart);
  const volDb = database('volunteers', 'Volunteer shifts', [vEmail, vRole.field, vPorch, vStart, vEnd],
    [{ name: 'Table', layout: 'table' }, { name: 'Calendar', layout: 'calendar', groupBy: vStart.id }, { name: 'By role', layout: 'board', groupBy: vRole.field.id }]);
  records('volunteers', volDb, vols, 'volunteer_id', (v) => [v.name!, {
    [vEmail.id]: str(v.email!), [vRole.field.id]: str(vRole.byName[v.role!]!), [vPorch.id]: rel([recordIds.porches![v.assigned_porch_id!]!]),
    [vStart.id]: date(v.shift_start!), [vEnd.id]: date(v.shift_end!),
  }]);

  // Host contacts (organizers) - the restricted data. Pat and Vic must never see these.
  const hosts = readCsv('hosts');
  const hPorch = field('relation', 'Porch', undefined, { databaseId: porchDb });
  const hEmail = field('email', 'Email', hPorch);
  const hPhone = field('phone', 'Phone', hEmail);
  const hNotes = field('text', 'Private notes', hPhone);
  const hostDb = database('organizers', 'Host contacts', [hPorch, hEmail, hPhone, hNotes], [{ name: 'Table', layout: 'table' }]);
  records('hosts', hostDb, hosts, 'host_id', (h) => [h.host_name!, {
    [hPorch.id]: rel([recordIds.porches![h.porch_id!]!]), [hEmail.id]: str(h.email!), [hPhone.id]: str(h.phone!),
    ...(h.private_notes ? { [hNotes.id]: txt(h.private_notes) } : {}),
  }]);

  // 4. Send as the admin, in order (spaces before databases before records), 100 per batch.
  console.log(`sending ${mutations.length} mutations`);
  let failed = 0;
  for (let i = 0; i < mutations.length; i += 100) {
    const out = await call<{ results: { id: string; status: number }[] }>('POST', `${API}/workspaces/${ws.id}/mutations`, { mutations: mutations.slice(i, i + 100) }, adminLogin.token);
    const bad = out.results.filter((r) => r.status !== 200 && r.status !== 201);
    failed += bad.length;
    if (bad.length) console.log('  non-success:', JSON.stringify(bad.slice(0, 3)));
  }

  fs.writeFileSync(ACCOUNTS_FILE,
    `# Colanode test accounts for Weft Phase 1 (synthetic). Server: ${SERVER}\n# Generated ${new Date().toISOString()}\n` +
    creds.map((u) => `${u.display_name}\t${u.email}\t${u.password}`).join('\n') + '\n', { mode: 0o600 });
  console.log(`done: workspace ${ws.id}, ${mutations.length} mutations, ${failed} non-success. Accounts -> ${ACCOUNTS_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
