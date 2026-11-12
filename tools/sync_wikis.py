#!/usr/bin/env python3
"""SQL that publishes the repo's wikis into Weft: docs/help (the help channel, everyone reads) and
docs/admin (the Weft admin channel, admins only).

Every page in those folders is a managed wiki page: created if new, rewritten if its text, title or
place in the tree changed, and deleted if its file was removed. Managed pages are read-only in the app,
so nothing written in Weft is overwritten. Open editors of a changed page are closed and reopen on the
new text. Each wiki's index page lists its pages: the line "<!-- pages -->" in it is replaced with one
line per page, from each file's "summary:". Search and the assistant pick up the new text on their own.

Usage: python3 -I tools/sync_wikis.py [--root DIR] | psql ...   (as the database owner)
       tools/publish_wikis.sh [--live]                           (does that for you, then reports)
Each file: "---", then title / parent (title of the parent page) / summary, then "---", then markdown.
Files are numbered in tree order, so a parent always comes before its pages.
"""
import glob
import os
import sys
import uuid

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
if "--root" in sys.argv:
    ROOT = sys.argv[sys.argv.index("--root") + 1]
NS = uuid.UUID("6f1c2a52-5a2f-4c9e-9a0e-7b1f0d3e5a11")   # same namespace as gen_seed.py
uid = lambda *p: str(uuid.uuid5(NS, "/".join(p)))
q = lambda v: "null" if v is None else "'" + str(v).replace("'", "''") + "'"

# folder, space key (stable id), channel name, who reads it
WIKIS = [("help", "help", "help", "everyone"), ("admin", "weft-admin", "Weft admin", "admins")]
MARK = "<!-- pages -->"


def pages_of(folder):
    out = []
    for path in sorted(glob.glob(os.path.join(ROOT, "docs", folder, "*.md"))):
        text = open(path).read()
        _, front, body = text.split("---", 2)
        meta = dict((k.strip(), v.strip()) for k, v in (line.split(":", 1) for line in front.strip().splitlines()))
        out.append({"file": os.path.basename(path), "title": meta["title"], "parent": meta.get("parent") or None,
                    "summary": meta.get("summary", ""), "body": body.strip()})
    titles = [p["title"] for p in out]
    for p in out:
        if p["parent"] and p["parent"] not in titles[:titles.index(p["title"])]:
            sys.exit(f"{folder}/{p['file']}: parent '{p['parent']}' must be a page earlier in the folder")
    return out


def index_lines(pages, root):
    """One line per page under root (any depth), indented by depth below root."""
    def chain(p):
        up = []
        while p["parent"]:
            p = next(x for x in pages if x["title"] == p["parent"]); up.append(p["title"])
        return up
    lines = []
    for p in pages:
        up = chain(p)
        if root["title"] not in up:
            continue
        depth = up.index(root["title"])
        lines.append(f"{'  ' * depth}- **{p['title']}**" + (f": {p['summary']}" if p["summary"] else ""))
    return "\n".join(lines)


out = ["begin;", "set local search_path = weft;"]
# The first admin, or (on a brand-new database with no accounts yet) Weft's own assistant account.
creator = "(select coalesce((select id from users where is_admin and not is_assistant order by email limit 1), (select id from users where is_assistant limit 1)))"
for folder, key, name, audience in WIKIS:
    pages = pages_of(folder)
    if not pages:
        continue
    space = uid("space", key)
    ids = {p["title"]: uid("item", key, p["file"]) for p in pages}
    index = next((p for p in pages if not p["parent"]), None)
    for p in pages:
        if MARK in p["body"]:
            p["body"] = p["body"].replace(MARK, index_lines(pages, p))
    everyone, admins = ("true", "false") if audience == "everyone" else ("false", "true")
    out.append(f"insert into spaces (id, kind, name, created_by, everyone, admins_only) select {q(space)}, 'channel', {q(name)}, {creator}, "
               f"{everyone}, {admins} on conflict (id) do update set name = excluded.name, everyone = excluded.everyone, admins_only = excluded.admins_only;")
    out.append(f"delete from members m using users u where u.id = m.user_id and u.is_assistant and m.space_id = {q(space)};")
    if audience == "everyone":
        out.append(f"insert into members (space_id, user_id, role) select {q(space)}, id, case when is_admin then 'owner' else 'viewer' end "
                   "from users where not is_assistant on conflict (space_id, user_id) do nothing;")
    else:   # exactly the active admins, as editors (no owner: nobody manages it by hand)
        out.append(f"delete from members where space_id = {q(space)} and role = 'owner';")
        out.append("select count(*) from (select weft_private.sync_admin_spaces(id) from users where not is_assistant) s;")
    for p in pages:
        parent = q(ids[p["parent"]]) if p["parent"] else "null"
        out.append(
            "with ch as (insert into items as i (id, space_id, kind, title, parent_id, body_text, managed, created_by) values "
            f"({q(ids[p['title']])}, {q(space)}, 'wiki', {q(p['title'])}, {parent}, {q(p['body'])}, true, {creator}) "
            "on conflict (id) do update set title = excluded.title, parent_id = excluded.parent_id, body_text = excluded.body_text, "
            "ydoc = null, managed = true, space_id = excluded.space_id "
            "where (i.title, i.parent_id, i.body_text, i.managed, i.space_id) is distinct from "
            "(excluded.title, excluded.parent_id, excluded.body_text, true, excluded.space_id) "
            "returning i.id, i.title, i.space_id, (xmax <> 0) as updated) "
            "select case when updated then 'updated' else 'created' end || ': ' || title, "
            "pg_notify('weft_events', json_build_object('t', 'doc_reset', 'id', id, 'space', space_id)::text) from ch;")
    keep = ",".join(q(i) for i in ids.values())
    out.append(f"select 'removed: ' || title from items where space_id = {q(space)} and managed and id not in ({keep});")
    out.append(f"delete from items where space_id = {q(space)} and managed and id not in ({keep});")
out.append("commit;")
print("\n".join(out))
