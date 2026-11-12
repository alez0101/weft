#!/usr/bin/env python3
"""SQL that creates the "help" channel (everyone can read it) and its wiki pages from docs/help/*.md.

Safe to run on the live database: it never overwrites a page that already exists, so edits made in
Weft survive. Every non-assistant user becomes a viewer; admins become owners.
Usage: python3 -I tools/seed_help.py | psql ...   (as the database owner)
"""
import glob
import os
import uuid

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NS = uuid.UUID("6f1c2a52-5a2f-4c9e-9a0e-7b1f0d3e5a11")   # same namespace as gen_seed.py
uid = lambda *p: str(uuid.uuid5(NS, "/".join(p)))
q = lambda v: "null" if v is None else "'" + str(v).replace("'", "''") + "'"

pages = []
for path in sorted(glob.glob(os.path.join(ROOT, "docs", "help", "*.md"))):
    text = open(path).read()
    _, front, body = text.split("---", 2)
    meta = dict((k.strip(), v.strip()) for k, v in (line.split(":", 1) for line in front.strip().splitlines()))
    pages.append((os.path.basename(path), meta["title"], meta.get("parent") or None, body.strip()))
ids = {title: uid("item", "help", name) for name, title, _, _ in pages}
space = uid("space", "help")

out = ["begin;", "set local search_path = weft;",
       f"insert into spaces (id, kind, name, created_by, everyone) select {q(space)}, 'channel', 'help', id, true "
       "from users where is_admin and not is_assistant order by email limit 1 on conflict (id) do update set everyone = true;",
       f"insert into members (space_id, user_id, role) select {q(space)}, id, case when is_admin then 'owner' else 'viewer' end "
       "from users where not is_assistant on conflict (space_id, user_id) do nothing;"]
creator = "(select id from users where is_admin and not is_assistant order by email limit 1)"
for name, title, parent, body in pages:   # parents first: files are numbered in tree order
    out.append(f"insert into items (id, space_id, kind, title, parent_id, body_text, created_by) values ({q(ids[title])}, {q(space)}, 'wiki', "
               f"{q(title)}, {q(ids[parent]) if parent else 'null'}, {q(body)}, {creator}) on conflict (id) do nothing;")
out.append("commit;")
print("\n".join(out))
