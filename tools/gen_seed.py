#!/usr/bin/env python3
"""Write SQL that seeds the Weft data layer from data/sample (all synthetic).

IDs are deterministic (uuid5), so tests/permissions.py can name spaces and users.
Usage: python3 -I tools/gen_seed.py | psql ...   (run as the database owner)
"""
import csv
import os
import sys
import uuid

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data", "sample")
NS = uuid.UUID("6f1c2a52-5a2f-4c9e-9a0e-7b1f0d3e5a11")
ASSISTANT = "00000000-0000-4000-8000-00000000a001"   # matches weft_private.assistant_id()


def uid(*parts):
    return str(uuid.uuid5(NS, "/".join(parts)))


def rows(name):
    with open(os.path.join(DATA, f"{name}.csv"), newline="") as f:
        return list(csv.DictReader(f))


def q(v):
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def local(ts):  # dataset times are festival-local (America/Los_Angeles, PDT in April)
    return q(f"{ts}:00-07:00")


out = ["begin;", "set local search_path = weft;"]
users = rows("users")
user_id = {u["user_id"]: uid("user", u["user_id"]) for u in users}
alex, olive, vic = user_id["u-alex"], user_id["u-org"], user_id["u-vol"]

out.append(f"insert into users (id, email, display_name, is_assistant) values ({q(ASSISTANT)}, 'weft@example.com', 'Weft', true) on conflict (id) do nothing;")
for u in users:
    out.append(f"insert into users (id, email, display_name) values ({q(user_id[u['user_id']])}, {q(u['email'])}, {q(u['display_name'])});")

# Spaces. The add_creator trigger makes created_by an owner; members.csv then sets the real roles.
space_id = {}
for s in rows("spaces"):
    space_id[s["space_id"]] = uid("space", s["space_id"])
    out.append(f"insert into spaces (id, kind, name, created_by) values ({q(space_id[s['space_id']])}, 'channel', {q(s['space_id'])}, {q(alex)});")
for m in rows("members"):
    out.append(f"insert into members (space_id, user_id, role) values ({q(space_id[m['space_id']])}, {q(user_id[m['user_id']])}, {q(m['role'])}) on conflict (space_id, user_id) do update set role = excluded.role;")

dms = {"dm-alex-olive": (alex, olive), "dm-olive-vic": (olive, vic)}
for key, (a, b) in dms.items():
    space_id[key] = uid("space", key)
    out.append(f"insert into spaces (id, kind, name, created_by) values ({q(space_id[key])}, 'dm', {q(key)}, {q(a)});")
    out.append(f"insert into members (space_id, user_id, role) values ({q(space_id[key])}, {q(a)}, 'editor'), ({q(space_id[key])}, {q(b)}, 'editor') on conflict (space_id, user_id) do update set role = excluded.role;")
out.append(f"update users set is_admin = true where id = {q(alex)};")
for u in users:
    key = f"assistant-{u['user_id']}"
    space_id[key] = uid("space", key)
    out.append(f"insert into spaces (id, kind, name, created_by) values ({q(space_id[key])}, 'assistant', 'Weft', {q(user_id[u['user_id']])});")
for u in users:
    key = f"personal-{u['user_id']}"
    space_id[key] = uid("space", key)
    out.append(f"insert into spaces (id, kind, name, created_by) values ({q(space_id[key])}, 'personal', 'Personal', {q(user_id[u['user_id']])});")

# Messages (the mockup's conversations).
msgs = [
    ("festival", olive, "Schedule is locked for Saturday. Post here if a porch changes."),
    ("festival", vic, "@Weft which porches have no power?"),
    ("festival", ASSISTANT, "Eight porches have no power: P01, P03, P05, P06, P07, P09, P13 and P17."),
    ("festival", user_id["u-pub"], "Is the 13:00 set at P04 still on?"),
    ("volunteers", olive, "Check-in is at the info booth from 11:00. Captains, grab your signs."),
    ("organizers", olive, "Host contact sheet is updated. Only organizers can see it."),
    ("dm-alex-olive", olive, "Can you look over the run of show before Friday?"),
    ("dm-olive-vic", vic, "I put the porch map on the whiteboard."),
]
for i, (space, author, body) in enumerate(msgs):
    out.append(f"insert into messages (id, space_id, author_id, body, created_at) values ({q(uid('msg', str(i)))}, {q(space_id[space])}, {q(author)}, {q(body)}, now() - interval '{len(msgs) - i} minutes');")

# Items. Host contacts is the restricted target the tests look for.
porches = {p["porch_id"]: p for p in rows("porches")}
hosts_text = "\n".join(f"{h['porch_id']} {porches[h['porch_id']]['address']}: {h['host_name']}, {h['email']}, {h['phone']}. {h['private_notes']}".rstrip(". ") + "."
                       for h in rows("hosts"))
rain_text = "\n".join(f"{k} {p['address']} ({p['neighborhood']}): {p['rain_plan']}" for k, p in porches.items())
items = [
    ("run-of-show", "festival", "document", "Run of show", None,
     "Volunteers check in at the info booth from 11:00. Sets run on the hour from 12:00 to 17:00, 45 minutes each."),
    ("handbook", "festival", "wiki", "Festival handbook", None, "How Porchfest runs, porch by porch."),
    ("rain-plan", "festival", "wiki", "Rain plan", "handbook", "Captains decide by 10:30.\n" + rain_text),
    ("volunteer-roles", "volunteers", "wiki", "Volunteer roles", None, "Porch captain, info booth, setup, cleanup, photographer."),
    ("host-contacts", "organizers", "document", "Host contacts", None, hosts_text),
    ("alex-notes", "personal-u-alex", "document", "Draft: thank-you note", None, "Private draft."),
]
for key, space, kind, title, parent, text in items:
    parent_sql = q(uid("item", parent)) if parent else "null"
    out.append(f"insert into items (id, space_id, kind, title, parent_id, body_text, created_by) values ({q(uid('item', key))}, {q(space_id[space])}, {q(kind)}, {q(title)}, {parent_sql}, {q(text)}, {q(alex)});")

# Events: the schedule in Festival, volunteer shifts in Volunteers.
bands = {b["performer_id"]: b["name"] for b in rows("performers")}
for s in rows("slots"):
    title = f"{bands[s['performer_id']]} at {s['porch_id']}" + (" (cancelled)" if s["status"] == "cancelled" else "")
    out.append(f"insert into events (id, space_id, title, starts_at, ends_at, location, created_by) values ({q(uid('slot', s['slot_id']))}, {q(space_id['festival'])}, {q(title)}, {local(s['starts_at'])}, {local(s['ends_at'])}, {q(porches[s['porch_id']]['address'])}, {q(alex)});")
for v in rows("volunteers"):
    out.append(f"insert into events (id, space_id, title, starts_at, ends_at, location, created_by) values ({q(uid('shift', v['volunteer_id']))}, {q(space_id['volunteers'])}, {q(v['name'] + ', ' + v['role'])}, {local(v['shift_start'])}, {local(v['shift_end'])}, {q(v['assigned_porch_id'])}, {q(olive)});")

# Tables (version 1.5): Porches and Performers in Festival, a small Budget in Organizers.
import json
def table(key, space, title, cols, rows):
    tid = uid("item", key)
    out.append(f"insert into items (id, space_id, kind, title, created_by) values ({q(tid)}, {q(space_id[space])}, 'table', {q(title)}, {q(alex)});")
    cid = {}
    for n, (name, typ, opts) in enumerate(cols):
        cid[name] = uid("col", key, name)
        out.append(f"insert into table_columns (id, table_id, name, type, options, position) values ({q(cid[name])}, {q(tid)}, {q(name)}, {q(typ)}, {q(json.dumps(opts))}::jsonb, {n});")
    for n, r in enumerate(rows):
        cells = {cid[k]: v for k, v in r.items() if v not in (None, "")}
        out.append(f"insert into table_rows (id, table_id, cells, position, created_by) values ({q(uid('row', key, str(n)))}, {q(tid)}, {q(json.dumps(cells))}::jsonb, {n}, {q(alex)});")
    out.append(f"select weft_private.refresh_table_text({q(tid)});")
hoods = sorted({p["neighborhood"] for p in porches.values()})
table("porches", "festival", "Porches",
      [("Porch", "text", []), ("Address", "text", []), ("Neighborhood", "select", hoods), ("Capacity", "number", []),
       ("Accessible", "checkbox", []), ("Power", "checkbox", []), ("Rain plan", "text", [])],
      [{"Porch": k, "Address": p["address"], "Neighborhood": p["neighborhood"], "Capacity": int(p["capacity"]),
        "Accessible": p["accessible"] == "yes", "Power": p["power_available"] == "yes", "Rain plan": p["rain_plan"]} for k, p in porches.items()])
genres = sorted({b["genre"] for b in rows("performers")})
table("performers", "festival", "Performers",
      [("Name", "text", []), ("Genre", "select", genres), ("Members", "number", []), ("Needs power", "checkbox", [])],
      [{"Name": b["name"], "Genre": b["genre"], "Members": int(b["members"]), "Needs power": b["needs_power"] == "yes"} for b in rows("performers")])
table("budget", "organizers", "Budget",
      [("Item", "text", []), ("Amount", "number", []), ("Paid", "checkbox", [])],
      [{"Item": "Porch signs", "Amount": 180, "Paid": True}, {"Item": "PA rental (ORG-BUDGET-SECRET)", "Amount": 450, "Paid": False}])

out.append("commit;")
sys.stdout.write("\n".join(out) + "\n")
