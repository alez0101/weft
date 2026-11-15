#!/usr/bin/env python3
"""Weft Phase 2 permission suite: every user, table and action against the expected answer.

Runs against PostgREST on 127.0.0.1:3100 with tokens minted locally. Run after db/reset.sh:
the write tests change data. Exit code 0 only if every check passes.

    python3 -I tests/permissions.py            # the matrix and the tricky cases
    python3 -I tests/permissions.py --teeth    # also prove the suite fails when a policy is loosened
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
from mint_token import mint, uid  # noqa: E402

API = os.environ.get("WEFT_API", "http://127.0.0.1:3200")   # the test stack
DC = (os.environ.get("WEFT_DOCKER") or ("docker" if subprocess.run(["docker", "info"], capture_output=True).returncode == 0 else "sudo docker")).split() + ["compose", "-p", "weft-test", "-f", os.path.join(ROOT, "stacks/weft/compose.yaml"),
      "-f", os.path.join(ROOT, "stacks/weft-test/compose.test.yaml"), "--env-file", os.path.join(ROOT, "stacks/weft-test/.env")]
ASSISTANT = "00000000-0000-4000-8000-00000000a001"
USERS = ["u-alex", "u-org", "u-vol", "u-pub"]
NAME = {"u-alex": "Alex", "u-org": "Olive", "u-vol": "Vic", "u-pub": "Pat"}

# Expected membership, from data/sample/members.csv plus the seeded DMs and personal spaces.
SPACES = {
    "u-alex": {"festival": "owner", "volunteers": "owner", "organizers": "owner", "dm-alex-olive": "editor", "personal-u-alex": "owner", "assistant-u-alex": "owner", "help": "owner", "weft-admin": "editor"},
    "u-org": {"festival": "editor", "volunteers": "editor", "organizers": "editor", "dm-alex-olive": "editor", "dm-olive-vic": "editor", "personal-u-org": "owner", "assistant-u-org": "owner", "help": "viewer"},
    "u-vol": {"festival": "viewer", "volunteers": "editor", "dm-olive-vic": "editor", "personal-u-vol": "owner", "assistant-u-vol": "owner", "help": "viewer"},
    "u-pub": {"festival": "viewer", "personal-u-pub": "owner", "assistant-u-pub": "owner", "help": "viewer"},
}
SID = {k: uid("space", k) for s in SPACES.values() for k in s}
KEY_OF = {v: k for k, v in SID.items()}
# Which spaces were seeded with rows of each kind.
SEEDED = {
    "messages": {"festival", "volunteers", "organizers", "dm-alex-olive", "dm-olive-vic"},
    "items": {"festival", "volunteers", "organizers", "personal-u-alex", "help", "weft-admin"},
    "events": {"festival", "volunteers"},
}
HOST_CONTACTS = uid("item", "host-contacts")
RUN_OF_SHOW = uid("item", "run-of-show")
VOL_ROLES = uid("item", "volunteer-roles")
ORG_MSG = uid("msg", "5")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))


def call(method, path, token=None, body=None, prefer="return=representation"):
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", prefer)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw


def refused(status):
    return status in (401, 403)


def owner_sql(sql):
    """Run SQL as the database owner, for verification and the teeth test only."""
    out = subprocess.run(DC + ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1",
                               "-At", "-U", "weft_owner", "-d", "weft", "-c", sql],
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


# ---------------------------------------------------------------- reads
def read_matrix():
    for u in USERS:
        t = mint(u)
        mine = set(SPACES[u])
        st, spaces = call("GET", "/spaces?select=id", t)
        got = {KEY_OF.get(r["id"], r["id"]) for r in spaces} if st == 200 else None
        check(f"read spaces: {NAME[u]} sees exactly their spaces", got == mine, f"got {sorted(got or [])}")
        for table in ("members", "messages", "items", "events", "audit"):
            st, rows = call("GET", f"/{table}?select=space_id", t)
            seen = {KEY_OF.get(r["space_id"], r["space_id"]) for r in rows} if st == 200 else None
            ok = st == 200 and seen <= mine
            if table in SEEDED:
                ok = ok and seen == (SEEDED[table] & mine)
            check(f"read {table}: {NAME[u]} sees only their spaces", ok, f"{st} {sorted(seen or [])}")
        st, users = call("GET", "/users?select=id", t)
        check(f"read users: {NAME[u]} sees only people who share a space", st == 200 and len(users) == 5 if u != "u-pub" else
              st == 200 and {r["id"] for r in users} == {uid('user', x) for x in USERS} | {ASSISTANT}, f"{st} {len(users or [])}")

    pat = mint("u-pub")
    for key in ("volunteers", "organizers", "dm-alex-olive"):
        for table in ("messages", "items", "events", "members", "audit"):
            st, rows = call("GET", f"/{table}?space_id=eq.{SID[key]}", pat)
            check(f"Pat filters {table} by {key}: zero rows", st == 200 and rows == [], f"{st} {rows if rows else ''}")
    st, rows = call("GET", "/items?title=eq.Host%20contacts", pat)
    check("Pat looks up Host contacts by title: zero rows", st == 200 and rows == [], str(st))
    st, rows = call("GET", f"/items?id=eq.{HOST_CONTACTS}", mint("u-vol"))
    check("Vic looks up Host contacts by id: zero rows", st == 200 and rows == [], str(st))
    st, rows = call("GET", "/items?title=eq.Host%20contacts&select=title", mint("u-org"))
    check("Olive (an organizer) does see Host contacts", st == 200 and len(rows) == 1, str(st))


# ---------------------------------------------------------------- writes
def writes():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    st, _ = call("POST", "/messages", pat, {"space_id": SID["festival"], "body": "test: Pat posts in festival"})
    check("Pat (viewer) can chat in festival", st == 201, str(st))
    st, _ = call("POST", "/messages", pat, {"space_id": SID["organizers"], "body": "test: should fail"})
    check("Pat cannot post in organizers", refused(st), str(st))
    st, _ = call("POST", "/messages", pat, {"space_id": SID["festival"], "body": "test: forged", "author_id": uid("user", "u-alex")})
    check("Pat cannot post as Alex (forged author)", refused(st), str(st))
    st, _ = call("POST", "/messages", pat, {"space_id": SID["festival"], "body": "test: thread", "thread_root_id": ORG_MSG})
    check("Pat cannot thread a reply onto an organizers message", refused(st), str(st))
    st, _ = call("POST", "/events", pat, {"space_id": SID["festival"], "title": "test", "starts_at": "2027-04-17T12:00:00Z", "ends_at": "2027-04-17T13:00:00Z"})
    check("Pat (viewer) cannot create events", refused(st), str(st))
    st, _ = call("POST", "/items", vic, {"space_id": SID["festival"], "kind": "document", "title": "test"})
    check("Vic (viewer in festival) cannot create documents there", refused(st), str(st))
    st, _ = call("POST", "/events", vic, {"space_id": SID["volunteers"], "title": "test: Vic shift", "starts_at": "2027-04-17T18:00:00Z", "ends_at": "2027-04-17T19:00:00Z"})
    check("Vic (editor in volunteers) can create events there", st == 201, str(st))
    st, _ = call("PATCH", f"/items?id=eq.{VOL_ROLES}", vic, {"space_id": SID["organizers"]})
    check("Vic cannot move a document into organizers", refused(st), str(st))
    st, _ = call("PATCH", f"/items?id=eq.{RUN_OF_SHOW}", olive, {"space_id": SID["personal-u-vol"]})
    check("Olive cannot move a document into Vic's personal space", refused(st), str(st))

    before = owner_sql(f"select md5(title || coalesce(body_text, '')) from weft.items where id = '{HOST_CONTACTS}'")
    st, rows = call("PATCH", f"/items?id=eq.{HOST_CONTACTS}", pat, {"title": "pwned"})
    check("Pat's update of Host contacts touches nothing", st == 200 and rows == [], f"{st} {rows}")
    st, rows = call("DELETE", f"/items?id=eq.{HOST_CONTACTS}", pat)
    check("Pat's delete of Host contacts touches nothing", st == 200 and rows == [], f"{st} {rows}")
    after = owner_sql(f"select md5(title || coalesce(body_text, '')) from weft.items where id = '{HOST_CONTACTS}'")
    check("Host contacts unchanged in the database afterwards", before == after and after != "", "")

    st, _ = call("POST", "/members", pat, {"space_id": SID["organizers"], "user_id": uid("user", "u-pub"), "role": "viewer"})
    check("Pat cannot add herself to organizers", refused(st), str(st))
    st, _ = call("POST", "/members", vic, {"space_id": SID["volunteers"], "user_id": uid("user", "u-pub"), "role": "viewer"})
    check("Vic (editor, not owner) cannot add members to volunteers", refused(st), str(st))
    st, _ = call("POST", "/spaces", pat, {"kind": "personal", "name": "second personal"}, prefer="return=minimal")
    check("Pat cannot create a personal space", refused(st), str(st))
    st, _ = call("POST", "/spaces", pat, {"kind": "channel", "name": "test-pat-channel"}, prefer="return=minimal")
    owned = owner_sql("select m.role from weft.spaces s join weft.members m on m.space_id = s.id "
                      f"where s.name = 'test-pat-channel' and m.user_id = '{uid('user', 'u-pub')}'")
    check("Pat can create a channel and becomes its owner", st == 201 and owned == "owner", f"{st} {owned}")
    st, _ = call("DELETE", f"/spaces?id=eq.{SID['personal-u-pub']}", pat)
    left = owner_sql(f"select count(*) from weft.spaces where id = '{SID['personal-u-pub']}'")
    check("Pat cannot delete her personal space", left == "1", f"{st}")


# ---------------------------------------------------------------- assistant and scope
def assistant_and_scope():
    a_pat = mint("u-pub", assistant=True)
    st, rows = call("GET", "/items?select=space_id,title", a_pat)
    seen = {KEY_OF[r["space_id"]] for r in rows} if st == 200 else None
    check("Assistant for Pat sees only what Pat sees", st == 200 and seen <= set(SPACES["u-pub"])
          and "Host contacts" not in {r["title"] for r in rows}, f"{st} {sorted(seen or [])}")

    a_olive = mint("u-org", assistant=True)
    st, _ = call("DELETE", f"/messages?id=eq.{uid('msg', '0')}", a_olive)
    check("Assistant cannot delete messages", refused(st), str(st))
    st, _ = call("DELETE", f"/events?id=eq.{uid('slot', 'S001')}", a_olive)
    check("Assistant cannot delete events", refused(st), str(st))
    st, _ = call("PATCH", f"/items?id=eq.{RUN_OF_SHOW}", a_olive, {"title": "assistant edit"})
    check("Assistant cannot edit documents", refused(st), str(st))
    st, _ = call("POST", "/messages", a_olive, {"space_id": SID["festival"], "author_id": ASSISTANT, "body": "test: assistant reply"})
    check("Assistant can post as Weft in a channel the user is in", st == 201, str(st))
    st, _ = call("POST", "/messages", a_olive, {"space_id": SID["festival"], "author_id": uid("user", "u-org"), "body": "test: as Olive"})
    check("Assistant cannot post as the user", refused(st), str(st))
    st, _ = call("POST", "/messages", mint("u-pub", assistant=True), {"space_id": SID["organizers"], "author_id": ASSISTANT, "body": "x"})
    check("Assistant for Pat cannot post in organizers", refused(st), str(st))
    st, rows = call("PATCH", f"/events?id=eq.{uid('slot', 'S001')}", a_olive, {"location": "test: moved by assistant"})
    check("Assistant can change an event where the user is an editor", st == 200 and len(rows) == 1, f"{st}")
    st, rows = call("PATCH", f"/events?id=eq.{uid('slot', 'S002')}", mint("u-pub", assistant=True), {"location": "x"})
    check("Assistant for Pat (viewer) cannot change events", st == 200 and rows == [], f"{st} {rows}")

    for label, tok in (("assistant", mint("u-org", assistant=True, scope="festival")), ("user", mint("u-org", scope="festival"))):
        st, rows = call("GET", "/spaces?select=id", tok)
        check(f"Festival-scoped {label} token sees only festival", st == 200 and {KEY_OF[r['id']] for r in rows} == {"festival"}, f"{st}")
        st, rows = call("GET", f"/items?id=eq.{HOST_CONTACTS}", tok)
        check(f"Festival-scoped {label} token cannot read Host contacts", st == 200 and rows == [], f"{st}")
    st, _ = call("POST", "/messages", mint("u-org", assistant=True, scope="festival"),
                 {"space_id": SID["organizers"], "author_id": ASSISTANT, "body": "x"})
    check("Festival-scoped assistant cannot post in organizers", refused(st), str(st))


# ---------------------------------------------------------------- audit and tokens
def audit_and_tokens():
    olive = mint("u-org")
    st, _ = call("PATCH", f"/items?id=eq.{HOST_CONTACTS}", olive, {"body_text": "test: updated by Olive"})
    check("Olive edits Host contacts", st == 200, str(st))
    st, rows = call("GET", f"/audit?row_id=eq.{HOST_CONTACTS}", olive)
    check("The edit is in the audit log, with old values, for Olive", st == 200 and len(rows) >= 1
          and rows[-1]["actor_role"] == "weft_user" and "old_row" in rows[-1], f"{st} {len(rows or [])}")
    for u in ("u-pub", "u-vol"):
        st, rows = call("GET", f"/audit?row_id=eq.{HOST_CONTACTS}", mint(u))
        check(f"{NAME[u]} cannot read that audit entry", st == 200 and rows == [], str(st))
    st, _ = call("POST", "/audit", olive, {"table_name": "items", "row_id": HOST_CONTACTS, "space_id": SID["festival"], "op": "UPDATE", "actor_role": "x", "old_row": {}})
    check("Nobody can write to the audit log directly", refused(st), str(st))
    st, _ = call("DELETE", "/audit?id=gt.0", mint("u-alex"))
    check("Not even an owner can delete audit entries", refused(st), str(st))

    st, _ = call("GET", "/messages")
    check("No token: refused", refused(st), str(st))
    st, _ = call("GET", "/messages", mint("u-alex", key="not-the-secret"))
    check("Token signed with the wrong secret: refused", st == 401, str(st))
    st, _ = call("GET", "/messages", mint("u-alex", ttl=-60))
    check("Expired token: refused", st == 401, str(st))


# ---------------------------------------------------------------- Phase 3b additions
def assistant_era():
    pat, olive = mint("u-pub"), mint("u-org")
    st, _ = call("POST", "/messages", pat, {"space_id": SID["festival"], "body": "forged answer", "meta": {"citations": []}})
    check("People cannot write answer metadata (meta)", refused(st), str(st))
    st, _ = call("POST", "/spaces", pat, {"kind": "assistant", "name": "second Weft"}, prefer="return=minimal")
    check("People cannot create assistant conversations", refused(st), str(st))
    st, _ = call("DELETE", f"/spaces?id=eq.{SID['assistant-u-pub']}", pat)
    left = owner_sql(f"select count(*) from weft.spaces where id = '{SID['assistant-u-pub']}'")
    check("Pat cannot delete her assistant conversation", left == "1", str(st))
    st, rows = call("GET", f"/messages?space_id=eq.{SID['assistant-u-org']}", pat)
    check("Pat cannot read Olive's assistant conversation", st == 200 and rows == [], str(st))
    st, _ = call("PATCH", f"/users?id=eq.{uid('user', 'u-pub')}", pat, {"is_admin": True})
    check("Pat cannot make herself admin", refused(st), str(st))
    st, rows = call("GET", "/providers", olive)
    check("Provider settings are not exposed through the API", st in (401, 403, 404), str(st))
    owner_sql(f"update weft.users set is_admin = true where id = '{uid('user', 'u-pub')}'")
    try:
        st, rows = call("GET", f"/items?id=eq.{HOST_CONTACTS}", pat)
        st2, rows2 = call("GET", f"/messages?space_id=eq.{SID['organizers']}", pat)
        check("Admin flag widens nothing: admin Pat still cannot see Organizers", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{st} {st2}")
    finally:
        owner_sql(f"update weft.users set is_admin = false where id = '{uid('user', 'u-pub')}'")


# ---------------------------------------------------------------- tables (version 1.5)
def tables():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    porches, budget = uid("item", "porches"), uid("item", "budget")
    col = lambda key, name: uid("col", key, name)
    row = lambda key, n: uid("row", key, str(n))
    st, rows = call("GET", f"/table_rows?table_id=eq.{porches}&select=id", pat)
    check("Tables: Pat reads the Porches rows (festival)", st == 200 and len(rows) == 20, f"{st} {len(rows or [])}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/table_rows?table_id=eq.{budget}&select=id", tok)
        check(f"Tables: {who} gets no Budget rows (organizers)", st == 200 and rows == [], str(st))
        st, rows = call("GET", f"/table_columns?table_id=eq.{budget}&select=id", tok)
        check(f"Tables: {who} gets no Budget columns", st == 200 and rows == [], str(st))
    st, rows = call("GET", "/items?title=eq.Budget&select=body_text", pat)
    check("Tables: Pat cannot read the Budget text summary", st == 200 and rows == [], str(st))
    st, rows = call("GET", "/items?title=eq.Budget&select=body_text", olive)
    check("Tables: Olive can, and it carries the rows", st == 200 and "ORG-BUDGET-SECRET" in (rows[0]["body_text"] if rows else ""), str(st))
    st, r = call("POST", "/rpc/set_cell", pat, {"p_row": row("porches", 0), "p_column": col("porches", "Rain plan"), "p_value": "pwned"})
    check("Tables: Pat (viewer) cannot change a cell", (st == 200 and r == 0) or refused(st), f"{st} {r}")
    st, r = call("POST", "/rpc/set_cell", olive, {"p_row": row("budget", 0), "p_column": col("budget", "Amount"), "p_value": 1})
    check("Tables: Olive (editor) changes a Budget cell", st == 200 and r == 1, f"{st} {r}")
    st, r = call("POST", "/rpc/set_cell", pat, {"p_row": row("budget", 0), "p_column": col("budget", "Amount"), "p_value": 999})
    check("Tables: Pat's set_cell on a Budget row changes nothing", (st == 200 and r == 0) or refused(st), f"{st} {r}")
    st, r = call("POST", "/rpc/set_cell", olive, {"p_row": row("porches", 1), "p_column": col("budget", "Amount"), "p_value": 5})
    check("Tables: a column from another table is refused", st == 200 and r == 0, f"{st} {r}")
    # Two editors, two different cells of the same row: both survive.
    call("POST", "/rpc/set_cell", olive, {"p_row": row("porches", 2), "p_column": col("porches", "Rain plan"), "p_value": "garage"})
    call("POST", "/rpc/set_cell", alex, {"p_row": row("porches", 2), "p_column": col("porches", "Capacity"), "p_value": 77})
    st, rows = call("GET", f"/table_rows?id=eq.{row('porches', 2)}&select=cells", pat)
    cells = rows[0]["cells"] if rows else {}
    check("Tables: two people editing different cells of one row both keep their change",
          cells.get(col("porches", "Rain plan")) == "garage" and cells.get(col("porches", "Capacity")) == 77, json.dumps(cells))
    st, rows = call("GET", "/items?title=eq.Porches&select=body_text", pat)
    check("Tables: the text summary follows the edits", "Capacity: 77" in (rows[0]["body_text"] if rows else ""))
    st, _ = call("POST", "/table_rows", pat, {"table_id": porches, "cells": {}})
    check("Tables: Pat cannot add rows", refused(st), str(st))
    st, _ = call("POST", "/table_rows", olive, {"table_id": porches, "cells": {}}, prefer="return=minimal")
    check("Tables: Olive adds a row", st == 201, str(st))
    st, _ = call("POST", "/table_rows", olive, {"table_id": porches, "cells": {}, "created_by": uid("user", "u-alex")})
    check("Tables: authorship of a row cannot be forged", refused(st), str(st))
    st, _ = call("POST", "/table_columns", vic, {"table_id": porches, "name": "x", "type": "text"})
    check("Tables: Vic (viewer in festival) cannot add columns", refused(st), str(st))
    st, rows = call("DELETE", f"/table_rows?table_id=eq.{budget}", pat)
    check("Tables: Pat's delete of Budget rows touches nothing", st == 200 and rows == [], str(st))
    st, _ = call("DELETE", f"/table_rows?id=eq.{row('porches', 3)}", mint("u-org", assistant=True))
    check("Tables: the assistant cannot delete rows", refused(st), str(st))
    st, _ = call("POST", "/rpc/set_cell", mint("u-org", assistant=True), {"p_row": row("porches", 3), "p_column": col("porches", "Porch"), "p_value": "x"})
    check("Tables: the assistant cannot change cells", refused(st), str(st))
    st, rows = call("GET", f"/audit?row_id=eq.{row('budget', 0)}&select=op", pat)
    check("Tables: Pat cannot read Budget audit rows", st == 200 and rows == [], str(st))
    st, rows = call("GET", f"/audit?row_id=eq.{row('budget', 0)}&select=op", olive)
    check("Tables: Olive's Budget edit is in the audit log", st == 200 and len(rows) >= 1, str(st))


# ---------------------------------------------------------------- tasks (022)
def tasks():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "tasklist", "title": "Org to-dos"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "tasklist", "title": "Festival to-dos"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Tasks: Olive (editor) makes task lists in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "tasklist", "title": "x"})
    check("Tasks: Pat (viewer) cannot make a task list in #festival", refused(st), str(st))
    st, rows = call("POST", "/tasks", olive, {"list_id": org, "title": "Sign the ORG-TASK-SECRET contract", "assignee_id": A, "due_on": "2026-11-20"})
    ot = rows[0]["id"] if st == 201 else None
    check("Tasks: Olive adds a task in Organizers, assigned to Alex (positive control)", ot and rows[0]["created_by"] == uid("user", "u-org") and rows[0]["done_at"] is None, f"{st} {rows}")
    st, rows = call("POST", "/tasks", olive, {"list_id": fest, "title": "Hang the bunting", "assignee_id": P, "due_on": "2026-11-21"})
    ft = rows[0]["id"] if st == 201 else None
    check("Tasks: Olive assigns a #festival task to Pat (a member there)", ft is not None, f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/tasks?list_id=eq.{org}&select=id", tok)
        check(f"Tasks: {who} gets no Organizers tasks", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/tasks?select=title&title=like.*ORG-TASK*", pat)
    check("Tasks: nor finds them by filtering every task", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Tasks: Pat cannot read the Organizers list summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = rows[0]["body_text"] if rows else ""
    check("Tasks: Olive can, and it carries the task, who and when", "[ ] Sign the ORG-TASK-SECRET contract (Alex" in (body or "") and "due 2026-11-20" in (body or ""), str(body))
    st, rows = call("GET", f"/tasks?list_id=eq.{fest}&select=id", pat)
    check("Tasks: Pat reads the #festival tasks (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("POST", "/tasks", pat, {"list_id": fest, "title": "pwned"})
    check("Tasks: Pat (viewer) cannot add a task in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True})
    check("Tasks: Pat (viewer) ticks off the task assigned to her", st == 200 and len(rows or []) == 1 and oq(f"select done and done_at is not null from weft.tasks where id = '{ft}'") == "t", f"{st} {rows}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": False})
    check("Tasks: and can reopen it", st == 200 and oq(f"select done or done_at is not null from weft.tasks where id = '{ft}'") == "f", f"{st} {rows}")
    st, body = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"title": "Pat renamed it"})
    st2, _ = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"due_on": "2027-01-01"})
    st3, _ = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"assignee_id": None})
    st4, _ = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True, "title": "sneaky"})
    check("Tasks: but cannot change its title, due date or assignee, not even alongside done", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select title || '|' || due_on || '|' || (assignee_id is not null) || '|' || done from weft.tasks where id = '{ft}'") == "Hang the bunting|2026-11-21|true|false", f"{st} {st2} {st3} {st4}")
    other = call("POST", "/tasks", olive, {"list_id": fest, "title": "Olive's own task", "assignee_id": uid("user", "u-org")})[1][0]["id"]
    st, rows = call("PATCH", f"/tasks?id=eq.{other}", pat, {"done": True})
    check("Tasks: Pat cannot tick off a task assigned to someone else", st == 200 and rows == [] and oq(f"select done from weft.tasks where id = '{other}'") == "f", f"{st} {rows}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", mint("u-pub", scope="volunteers"), {"done": True})
    check("Tasks: nor through a token scoped to another channel", rows == [] and oq(f"select done from weft.tasks where id = '{ft}'") == "f", f"{st} {rows}")
    st, rows = call("DELETE", f"/tasks?id=eq.{ft}", pat)
    check("Tasks: Pat cannot delete a #festival task", st == 200 and rows == [] and oq(f"select count(*) from weft.tasks where id = '{ft}'") == "1", f"{st} {rows}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ot}", pat, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/tasks?list_id=eq.{org}", vic)
    check("Tasks: Pat and Vic change and delete nothing in Organizers", rows == [] and rows2 == [] and oq(f"select title from weft.tasks where id = '{ot}'") == "Sign the ORG-TASK-SECRET contract", f"{st} {st2}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", olive, {"done": True})
    check("Tasks: Olive ticks a task off, and the database stamps when", st == 200 and rows and rows[0]["done"] and rows[0]["done_at"], f"{st} {rows}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", olive, {"done": False})
    check("Tasks: unticking clears the stamp", st == 200 and rows and rows[0]["done_at"] is None, f"{st} {rows}")
    st, _ = call("PATCH", f"/tasks?id=eq.{ft}", olive, {"done_at": "2020-01-01T00:00:00Z"})
    check("Tasks: nobody can set done_at directly", refused(st), str(st))
    st, _ = call("POST", "/tasks", olive, {"list_id": fest, "title": "forged", "created_by": A})
    check("Tasks: authorship of a task cannot be forged", refused(st), str(st))
    st, body = call("POST", "/tasks", olive, {"list_id": org, "title": "for Pat", "assignee_id": P})
    check("Tasks: a task cannot be assigned to someone outside its space", st == 400 and "assigned" in json.dumps(body), f"{st} {body}")
    st, body = call("PATCH", f"/tasks?id=eq.{ot}", olive, {"assignee_id": V})
    check("Tasks: nor reassigned to them", st == 400 and oq(f"select assignee_id from weft.tasks where id = '{ot}'") == A, f"{st} {body}")
    st, _ = call("PATCH", f"/tasks?id=eq.{ft}", olive, {"list_id": org})
    check("Tasks: a task cannot be moved into another list", refused(st) and oq(f"select list_id from weft.tasks where id = '{ft}'") == fest, str(st))
    st, _ = call("POST", "/tasks", olive, {"list_id": uid("item", "porches"), "title": "on a table"})
    check("Tasks: a task cannot hang off an item that is not a task list", refused(st), str(st))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/tasks?list_id=in.({org},{fest})&select=list_id", scoped)
    check("Tasks: a #festival-scoped token sees only #festival tasks", st == 200 and rows and {r["list_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/tasks", scoped, {"list_id": org, "title": "scoped"})
    check("Tasks: nor writes in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/tasks?list_id=eq.{org}&select=id", helper)
    check("Tasks: the assistant (for Olive) can read Organizers tasks (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/tasks?id=eq.{ot}", helper)
    st2, _ = call("PATCH", f"/tasks?id=eq.{ot}", helper, {"done": True})
    st3, _ = call("POST", "/tasks", helper, {"list_id": org, "title": "by the assistant"})
    check("Tasks: the assistant cannot delete, change or add tasks", refused(st) and refused(st2) and refused(st3) and oq(f"select done from weft.tasks where id = '{ot}'") == "f", f"{st} {st2} {st3}")
    call("PATCH", f"/tasks?id=eq.{ot}", olive, {"title": "Sign the ORG-TASK-SECRET contract today"})
    st, rows = call("GET", f"/audit?row_id=eq.{ot}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ot}&select=op", pat)
    check("Tasks: changes are in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-TASK-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-TASK-SECRET"})
    check("Tasks: search finds the list for Olive, not for Pat", any(r["id"] == org and r["kind"] == "tasklist" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Moves follow the space: the list moves, its tasks go with it, and assignees outside the new space are cleared.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/tasks?list_id=eq.{fest}&select=id", pat)
    check("Tasks: a list moved to Volunteers takes its tasks out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    check("Tasks: and Pat, not in Volunteers, is no longer assigned (nor named in the summary)",
          oq(f"select assignee_id is null from weft.tasks where id = '{ft}'") == "t" and "Pat" not in oq(f"select coalesce(body_text, '') from weft.items where id = '{fest}'"))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/tasks?list_id=eq.{org}&select=id", pat)
    check("Tasks: a list moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 1 and refused(call("POST", "/tasks", pat, {"list_id": org, "title": "x"})[0]), f"{st} {rows}")
    check("Tasks: Alex (in #festival) stays assigned after the move", oq(f"select assignee_id from weft.tasks where id = '{ot}'") == A)
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Tasks: Pat cannot delete the list", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Tasks: deleting a list deletes its tasks", st in (200, 204) and oq(f"select count(*) from weft.tasks where list_id = '{org}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


# ---------------------------------------------------------------- boards (028)
def boards():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    P, O = uid("user", "u-pub"), uid("user", "u-org")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "tasklist", "title": "Org board"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "tasklist", "title": "Festival board"})
    fest = rows[0]["id"] if st2 == 201 else None
    cols = lambda tok, lst: call("GET", f"/board_columns?list_id=eq.{lst}&select=id,name,position&order=position", tok)
    st, oc = cols(olive, org)
    st2, fc = cols(olive, fest)
    check("Boards: a new task list starts with the columns To do and Doing (positive control)",
          st == 200 and [c["name"] for c in oc] == ["To do", "Doing"] and [c["name"] for c in fc or []] == ["To do", "Doing"], f"{oc} {fc}")
    o_todo, o_doing = oc[0]["id"], oc[1]["id"]
    f_todo, f_doing = fc[0]["id"], fc[1]["id"]
    check("Boards: lists made before 028 got the same columns", oq("select count(*) from weft.items i where kind = 'tasklist' and (select count(*) from weft.board_columns c where c.list_id = i.id) < 1") == "0")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = cols(tok, org)
        check(f"Boards: {who} gets no Organizers columns", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/board_columns?id=eq.{o_doing}", pat)
    check("Boards: nor by asking for one by id", st == 200 and rows == [], str(rows))
    st, rows = cols(pat, fest)
    check("Boards: Pat reads the #festival columns (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("POST", "/board_columns", pat, {"list_id": fest, "name": "Pat's column", "position": 5})
    check("Boards: Pat (viewer) cannot add a column in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/board_columns?id=eq.{f_doing}", pat, {"name": "pwned"})
    st2, rows2 = call("DELETE", f"/board_columns?id=eq.{f_doing}", pat)
    check("Boards: nor rename or delete one", rows == [] and rows2 == [] and oq(f"select name from weft.board_columns where id = '{f_doing}'") == "Doing", f"{st} {st2}")
    st, rows = call("PATCH", f"/board_columns?list_id=eq.{org}", vic, {"name": "pwned"})
    st2, rows2 = call("DELETE", f"/board_columns?list_id=eq.{org}", vic)
    check("Boards: Vic changes and deletes no Organizers column", rows == [] and rows2 == [] and oq(f"select count(*) from weft.board_columns where list_id = '{org}' and name <> 'pwned'") == "2", f"{st} {st2}")
    st, rows = call("POST", "/board_columns", olive, {"list_id": fest, "name": "  Review  ", "position": 2})
    review = rows[0]["id"] if st == 201 else None
    check("Boards: Olive (editor) adds a column, name tidied (positive control)", review and rows[0]["name"] == "Review", f"{st} {rows}")
    st, rows = call("PATCH", f"/board_columns?id=eq.{review}", olive, {"name": "Checking", "position": 0.5})
    check("Boards: and renames and reorders it", st == 200 and rows and rows[0]["name"] == "Checking" and rows[0]["position"] == 0.5, f"{st} {rows}")
    st, _ = call("PATCH", f"/board_columns?id=eq.{review}", olive, {"list_id": org})
    check("Boards: a column cannot be moved to another board", refused(st) and oq(f"select list_id from weft.board_columns where id = '{review}'") == fest, str(st))
    st, _ = call("POST", "/board_columns", olive, {"list_id": uid("item", "porches"), "name": "x"})
    check("Boards: a column cannot hang off an item that is not a task list", refused(st), str(st))
    st, _ = call("POST", "/board_columns", olive, {"list_id": fest, "name": "   "})
    check("Boards: a column needs a name", st == 400, str(st))
    # Cards are tasks.
    st, rows = call("POST", "/tasks", olive, {"list_id": org, "title": "Book the ORG-BOARD-SECRET venue", "column_id": o_doing})
    ot = rows[0]["id"] if st == 201 else None
    check("Boards: Olive adds a card straight into Doing (positive control)", ot and rows[0]["column_id"] == o_doing, f"{st} {rows}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    check("Boards: the list summary says which column an open card is in", "Book the ORG-BOARD-SECRET venue in Doing" in (rows[0]["body_text"] or ""), str(rows))
    call("PATCH", f"/board_columns?id=eq.{o_doing}", olive, {"name": "Under way"})
    check("Boards: and follows a column rename", "venue in Under way" in oq(f"select body_text from weft.items where id = '{org}'"))
    st, body = call("POST", "/tasks", olive, {"list_id": fest, "title": "cross", "column_id": o_doing})
    check("Boards: a card cannot be put in another board's column", st == 400 and "column" in json.dumps(body), f"{st} {body}")
    st, rows = call("POST", "/tasks", olive, {"list_id": fest, "title": "Paint the signs", "assignee_id": P, "column_id": f_todo})
    ft = rows[0]["id"] if st == 201 else None
    st, body = call("PATCH", f"/tasks?id=eq.{ft}", olive, {"column_id": o_todo})
    check("Boards: nor moved into one", st == 400 and oq(f"select column_id from weft.tasks where id = '{ft}'") == f_todo, f"{st} {body}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", olive, {"column_id": f_doing, "position": 3})
    check("Boards: Olive drags a card to Doing (positive control)", st == 200 and rows and rows[0]["column_id"] == f_doing, f"{st} {rows}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"column_id": f_todo})
    st2, rows2 = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True, "column_id": f_todo})
    check("Boards: Pat (viewer) cannot move her own card between columns, not even alongside done", refused(st) and refused(st2)
          and oq(f"select column_id || '|' || done from weft.tasks where id = '{ft}'") == f"{f_doing}|false", f"{st} {st2}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True})
    check("Boards: but can still drop it in Done by ticking it off (positive control); its column is kept",
          st == 200 and len(rows or []) == 1 and oq(f"select done || '|' || column_id from weft.tasks where id = '{ft}'") == f"true|{f_doing}", f"{st} {rows}")
    call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": False})
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", vic, {"column_id": f_todo})
    check("Boards: Vic (viewer, not the assignee) cannot move it", rows == [] and oq(f"select column_id from weft.tasks where id = '{ft}'") == f_doing, f"{st} {rows}")
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/board_columns?list_id=in.({org},{fest})&select=list_id", scoped)
    check("Boards: a #festival-scoped token sees only #festival columns", st == 200 and rows and {r["list_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/board_columns", scoped, {"list_id": org, "name": "scoped"})
    st2, rows2 = call("PATCH", f"/tasks?id=eq.{ot}", scoped, {"column_id": o_todo})
    check("Boards: nor adds columns or moves cards in Organizers", refused(st) and rows2 == [] and oq(f"select column_id from weft.tasks where id = '{ot}'") == o_doing, f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = cols(helper, org)
    check("Boards: the assistant (for Olive) reads Organizers columns (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("DELETE", f"/board_columns?id=eq.{o_todo}", helper)
    st2, _ = call("POST", "/board_columns", helper, {"list_id": org, "name": "bot"})
    st3, _ = call("PATCH", f"/board_columns?id=eq.{o_todo}", helper, {"name": "bot"})
    st4, _ = call("PATCH", f"/tasks?id=eq.{ot}", helper, {"column_id": o_todo})
    check("Boards: the assistant cannot delete, add or rename columns, nor move cards", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select count(*) from weft.board_columns where list_id = '{org}'") == "2", f"{st} {st2} {st3} {st4}")
    st, _ = call("POST", "/board_columns", olive, {"list_id": fest, "name": "x", "created_at": "2020-01-01T00:00:00Z"})
    check("Boards: nobody can set a column's created_at", refused(st), str(st))
    st, rows = call("GET", f"/audit?row_id=eq.{o_doing}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{o_doing}&select=op", pat)
    check("Boards: column changes are in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Limit: at most 10 open columns.
    n = int(oq(f"select count(*) from weft.board_columns where list_id = '{fest}'"))
    for k in range(10 - n):
        call("POST", "/board_columns", olive, {"list_id": fest, "name": f"Extra {k}", "position": 10 + k}, prefer="return=minimal")
    st, body = call("POST", "/board_columns", olive, {"list_id": fest, "name": "One too many", "position": 99})
    check("Boards: a board has at most 10 columns besides Done", st == 400 and oq(f"select count(*) from weft.board_columns where list_id = '{fest}'") == "10", f"{st} {body}")
    call("DELETE", f"/board_columns?list_id=eq.{fest}&name=like.Extra*", olive)
    # Deleting a column sends its cards to the first column (column_id null); the tasks stay.
    st, _ = call("DELETE", f"/board_columns?id=eq.{f_doing}", olive)
    check("Boards: Olive deletes a column; its cards stay, with no column (shown in the first)", st in (200, 204)
          and oq(f"select count(*) || '|' || coalesce(max(column_id::text), 'none') from weft.tasks where id = '{ft}'") == "1|none", str(st))
    # Moves follow the space.
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = cols(pat, org)
    check("Boards: a list moved into #festival shows its columns to Pat, still read-only", st == 200 and len(rows) == 2
          and refused(call("POST", "/board_columns", pat, {"list_id": org, "name": "x"})[0]), f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = cols(pat, fest)
    check("Boards: and one moved to Volunteers takes its columns out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    st2, _ = call("DELETE", f"/items?id=eq.{fest}", olive)
    check("Boards: deleting a list deletes its columns and cards", st in (200, 204) and st2 in (200, 204)
          and oq(f"select count(*) from weft.board_columns where list_id in ('{org}', '{fest}')") == "0"
          and oq(f"select count(*) from weft.tasks where list_id in ('{org}', '{fest}')") == "0", f"{st} {st2}")


# ---------------------------------------------------------------- links (026)
def links():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "linklist", "title": "Org links"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "linklist", "title": "Festival links"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Links: Olive (editor) makes link lists in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "linklist", "title": "x"})
    check("Links: Pat (viewer) cannot make a link list in #festival", refused(st), str(st))
    st, rows = call("POST", "/links", olive, {"list_id": org, "url": "https://example.org/caterer", "title": "ORG-LINK-SECRET caterer price list",
                                               "note": "Ask for the volunteer rate", "tags": [" Food ", "food", "Budget", ""]})
    ol = rows[0]["id"] if st == 201 else None
    check("Links: Olive adds a link in Organizers (positive control), created_by set by the database", ol and rows[0]["created_by"] == O, f"{st} {rows}")
    check("Links: tags are trimmed, lowercased and de-duplicated, in order", ol and rows[0]["tags"] == ["food", "budget"], str(rows))
    st, rows = call("POST", "/links", olive, {"list_id": fest, "url": "https://example.org/map", "title": "Site map", "tags": ["map"]})
    fl = rows[0]["id"] if st == 201 else None
    check("Links: Olive adds a link in #festival", fl is not None, f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/links?list_id=eq.{org}&select=id", tok)
        check(f"Links: {who} gets no Organizers links", st == 200 and rows == [], str(rows))
    st, rows = call("GET", "/links?select=title&title=like.*ORG-LINK*", pat)
    check("Links: nor finds them by filtering every link", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Links: Pat cannot read the Organizers list summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Links: Olive can, and it carries the title, address, tags and note",
          "ORG-LINK-SECRET caterer price list <https://example.org/caterer> [food, budget]" in body and "volunteer rate" in body, body)
    st, rows = call("GET", f"/links?list_id=eq.{fest}&select=id", pat)
    check("Links: Pat reads the #festival links (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("POST", "/links", pat, {"list_id": fest, "url": "https://example.org/x", "title": "pwned"})
    check("Links: Pat (viewer) cannot add a link in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/links?id=eq.{fl}", pat, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/links?id=eq.{fl}", pat)
    check("Links: Pat cannot change or delete a #festival link", rows == [] and rows2 == [] and oq(f"select title from weft.links where id = '{fl}'") == "Site map", f"{st} {st2}")
    st, rows = call("PATCH", f"/links?id=eq.{ol}", vic, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/links?list_id=eq.{org}", vic)
    check("Links: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) from weft.links where list_id = '{org}'") == "1", f"{st} {st2}")
    st, rows = call("PATCH", f"/links?id=eq.{fl}", olive, {"title": "Site map (new)", "note": "Gate B is closed", "tags": ["Map", "gates"]})
    check("Links: Olive changes a link (positive control)", st == 200 and rows and rows[0]["title"] == "Site map (new)" and rows[0]["tags"] == ["map", "gates"], f"{st} {rows}")
    for bad in ("javascript:alert(1)", "data:text/html,hi", "ftp://example.org/x", "https://exa mple.org", "example.org"):
        st, _ = call("POST", "/links", olive, {"list_id": fest, "url": bad, "title": "bad"})
        check(f"Links: an address that is not http(s) is refused ({bad.split(':')[0]})", st == 400, str(st))
    st, _ = call("PATCH", f"/links?id=eq.{fl}", olive, {"url": "javascript:alert(1)"})
    check("Links: nor can a link be changed to one", st == 400 and oq(f"select url from weft.links where id = '{fl}'") == "https://example.org/map", str(st))
    st, _ = call("POST", "/links", olive, {"list_id": fest, "url": "https://example.org/", "title": "   "})
    st2, _ = call("POST", "/links", olive, {"list_id": fest, "url": "https://example.org/", "title": "t", "tags": [str(i) for i in range(11)]})
    st3, _ = call("POST", "/links", olive, {"list_id": fest, "url": "https://example.org/", "title": "t", "tags": ["x" * 31]})
    check("Links: an empty title, more than 10 tags or a tag over 30 characters are refused", all(x == 400 for x in (st, st2, st3)), f"{st} {st2} {st3}")
    st, _ = call("POST", "/links", olive, {"list_id": fest, "url": "https://example.org/", "title": "forged", "created_by": A})
    check("Links: authorship of a link cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/links?id=eq.{fl}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/links?id=eq.{fl}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Links: nor changed afterwards, nor the time it was added", refused(st) and refused(st2) and oq(f"select created_by from weft.links where id = '{fl}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/links?id=eq.{fl}", olive, {"list_id": org})
    check("Links: a link cannot be moved into another list", refused(st) and oq(f"select list_id from weft.links where id = '{fl}'") == fest, str(st))
    st, _ = call("POST", "/links", olive, {"list_id": uid("item", "porches"), "url": "https://example.org/", "title": "on a table"})
    check("Links: a link cannot hang off an item that is not a link list", refused(st), str(st))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/links?list_id=in.({org},{fest})&select=list_id", scoped)
    check("Links: a #festival-scoped token sees only #festival links", st == 200 and rows and {r["list_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/links", scoped, {"list_id": org, "url": "https://example.org/", "title": "scoped"})
    check("Links: nor writes in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/links?list_id=eq.{org}&select=id", helper)
    check("Links: the assistant (for Olive) can read Organizers links (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/links?id=eq.{ol}", helper)
    st2, _ = call("PATCH", f"/links?id=eq.{ol}", helper, {"title": "by the assistant"})
    st3, _ = call("POST", "/links", helper, {"list_id": org, "url": "https://example.org/", "title": "by the assistant"})
    check("Links: the assistant cannot delete, change or add links", refused(st) and refused(st2) and refused(st3) and oq(f"select count(*) from weft.links where list_id = '{org}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/audit?row_id=eq.{fl}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{fl}&select=op", vic)
    check("Links: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1 and len(rows2 or []) >= 1, f"{rows} {rows2}")
    call("PATCH", f"/links?id=eq.{ol}", olive, {"note": "Ask for the volunteer rate, by Friday"})
    st, rows = call("GET", f"/audit?row_id=eq.{ol}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ol}&select=op", pat)
    check("Links: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-LINK-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-LINK-SECRET"})
    check("Links: search finds the list for Olive, not for Pat", any(r["id"] == org and r["kind"] == "linklist" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Moves follow the space: the list moves and its links go with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/links?list_id=eq.{fest}&select=id", pat)
    check("Links: a list moved to Volunteers takes its links out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/links?list_id=eq.{org}&select=id", pat)
    check("Links: a list moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 1
          and refused(call("POST", "/links", pat, {"list_id": org, "url": "https://example.org/", "title": "x"})[0]), f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Links: Pat cannot delete the list", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Links: deleting a list deletes its links", st in (200, 204) and oq(f"select count(*) from weft.links where list_id = '{org}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


# ---------------------------------------------------------------- contacts (033)
def contacts():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "addressbook", "title": "Org contacts"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "addressbook", "title": "Festival contacts"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Contacts: Olive (editor) makes address books in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "addressbook", "title": "x"})
    check("Contacts: Pat (viewer) cannot make an address book in #festival", refused(st), str(st))
    st, rows = call("POST", "/contacts", olive, {"book_id": org, "name": "  Dana ORG-CONTACT-SECRET  ", "organisation": " Sponsor Ltd ",
                                                  "phone": "+44 (0)20 7946-0123", "email": " Dana@Example.ORG ", "notes": "Prefers calls before noon"})
    oc = rows[0]["id"] if st == 201 else None
    check("Contacts: Olive adds a contact in Organizers (positive control), created_by set by the database", oc and rows[0]["created_by"] == O, f"{st} {rows}")
    check("Contacts: fields are trimmed and the email lowercased", oc and rows[0]["name"] == "Dana ORG-CONTACT-SECRET"
          and rows[0]["organisation"] == "Sponsor Ltd" and rows[0]["email"] == "dana@example.org", str(rows))
    st, rows = call("POST", "/contacts", olive, {"book_id": fest, "name": "Sam Stage", "phone": "0123 456"})
    fc = rows[0]["id"] if st == 201 else None
    check("Contacts: Olive adds a contact in #festival with only a name and phone", fc is not None and rows[0]["email"] == "", f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/contacts?book_id=eq.{org}&select=id", tok)
        check(f"Contacts: {who} gets no Organizers contacts", st == 200 and rows == [], str(rows))
    st, rows = call("GET", "/contacts?select=name&name=like.*ORG-CONTACT*", pat)
    st2, rows2 = call("GET", "/contacts?select=email&email=eq.dana@example.org", vic)
    check("Contacts: nor finds them by filtering every contact by name or email", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Contacts: Pat cannot read the Organizers address book summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Contacts: Olive can, and it carries the name, organisation, phone, email and notes",
          "Dana ORG-CONTACT-SECRET, Sponsor Ltd, +44 (0)20 7946-0123, dana@example.org" in body and "before noon" in body, body)
    st, rows = call("GET", f"/contacts?book_id=eq.{fest}&select=id,name,phone", pat)
    check("Contacts: Pat reads the #festival contacts (positive control)", st == 200 and len(rows) == 1 and rows[0]["phone"] == "0123 456", str(rows))
    st, _ = call("POST", "/contacts", pat, {"book_id": fest, "name": "pwned"})
    check("Contacts: Pat (viewer) cannot add a contact in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/contacts?id=eq.{fc}", pat, {"phone": "999"})
    st2, rows2 = call("DELETE", f"/contacts?id=eq.{fc}", pat)
    check("Contacts: Pat cannot change or delete a #festival contact", rows == [] and rows2 == [] and oq(f"select phone from weft.contacts where id = '{fc}'") == "0123 456", f"{st} {st2}")
    st, rows = call("PATCH", f"/contacts?id=eq.{oc}", vic, {"name": "pwned"})
    st2, rows2 = call("DELETE", f"/contacts?book_id=eq.{org}", vic)
    check("Contacts: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) from weft.contacts where book_id = '{org}'") == "1", f"{st} {st2}")
    st, rows = call("PATCH", f"/contacts?id=eq.{fc}", olive, {"organisation": "Stage crew", "email": "sam@example.org", "notes": "Has the gate keys"})
    check("Contacts: Olive changes a contact (positive control)", st == 200 and rows and rows[0]["organisation"] == "Stage crew" and rows[0]["email"] == "sam@example.org", f"{st} {rows}")
    for bad in ("not-an-email", "a@b", "x@example.org?subject=hi", "<x@example.org>", "a b@example.org"):
        st, _ = call("POST", "/contacts", olive, {"book_id": fest, "name": "bad", "email": bad})
        check(f"Contacts: an email that is not a plain address is refused ({bad})", st == 400, str(st))
    for bad in ("javascript:alert(1)", "call me", "123;456", "1" * 41):
        st, _ = call("POST", "/contacts", olive, {"book_id": fest, "name": "bad", "phone": bad})
        check(f"Contacts: a phone with other characters or over 40 is refused ({bad[:12]})", st == 400, str(st))
    st, _ = call("PATCH", f"/contacts?id=eq.{fc}", olive, {"email": "javascript:alert(1)//@x.y"})
    check("Contacts: nor can a contact be changed to one", st == 400 and oq(f"select email from weft.contacts where id = '{fc}'") == "sam@example.org", str(st))
    st, _ = call("POST", "/contacts", olive, {"book_id": fest, "name": "   "})
    st2, _ = call("POST", "/contacts", olive, {"book_id": fest, "name": "n", "notes": "x" * 2001})
    check("Contacts: an empty name or notes over 2000 characters are refused", st == 400 and st2 == 400, f"{st} {st2}")
    st, _ = call("POST", "/contacts", olive, {"book_id": fest, "name": "forged", "created_by": A})
    check("Contacts: authorship of a contact cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/contacts?id=eq.{fc}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/contacts?id=eq.{fc}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Contacts: nor changed afterwards, nor the time it was added", refused(st) and refused(st2) and oq(f"select created_by from weft.contacts where id = '{fc}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/contacts?id=eq.{fc}", olive, {"book_id": org})
    check("Contacts: a contact cannot be moved into another address book", refused(st) and oq(f"select book_id from weft.contacts where id = '{fc}'") == fest, str(st))
    st, _ = call("POST", "/contacts", olive, {"book_id": uid("item", "porches"), "name": "on a table"})
    check("Contacts: a contact cannot hang off an item that is not an address book", refused(st), str(st))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/contacts?book_id=in.({org},{fest})&select=book_id", scoped)
    check("Contacts: a #festival-scoped token sees only #festival contacts", st == 200 and rows and {r["book_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/contacts", scoped, {"book_id": org, "name": "scoped"})
    check("Contacts: nor writes in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/contacts?book_id=eq.{org}&select=id", helper)
    check("Contacts: the assistant (for Olive) can read Organizers contacts (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/contacts?id=eq.{oc}", helper)
    st2, _ = call("PATCH", f"/contacts?id=eq.{oc}", helper, {"name": "by the assistant"})
    st3, _ = call("POST", "/contacts", helper, {"book_id": org, "name": "by the assistant"})
    check("Contacts: the assistant cannot delete, change or add contacts", refused(st) and refused(st2) and refused(st3) and oq(f"select count(*) from weft.contacts where book_id = '{org}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/audit?row_id=eq.{fc}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{fc}&select=op", vic)
    check("Contacts: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1 and len(rows2 or []) >= 1, f"{rows} {rows2}")
    call("PATCH", f"/contacts?id=eq.{oc}", olive, {"notes": "Prefers calls before noon, not Fridays"})
    st, rows = call("GET", f"/audit?row_id=eq.{oc}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{oc}&select=op", pat)
    check("Contacts: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-CONTACT-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-CONTACT-SECRET"})
    check("Contacts: search finds the address book for Olive, not for Pat", any(r["id"] == org and r["kind"] == "addressbook" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Moves follow the space: the book moves and its contacts go with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/contacts?book_id=eq.{fest}&select=id", pat)
    check("Contacts: a book moved to Volunteers takes its contacts out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/contacts?book_id=eq.{org}&select=id", pat)
    check("Contacts: a book moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 1
          and refused(call("POST", "/contacts", pat, {"book_id": org, "name": "x"})[0]), f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Contacts: Pat cannot delete the address book", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Contacts: deleting an address book deletes its contacts", st in (200, 204) and oq(f"select count(*) from weft.contacts where book_id = '{org}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


# ---------------------------------------------------------------- decisions (035)
def decisions():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "decisionlog", "title": "Org decisions"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "decisionlog", "title": "Festival decisions"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Decisions: Olive (editor) makes decision logs in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "decisionlog", "title": "x"})
    check("Decisions: Pat (viewer) cannot make a decision log in #festival", refused(st), str(st))
    st, rows = call("POST", "/decisions", olive, {"log_id": org, "title": "  Budget cap ORG-DECISION-SECRET  ", "context": " Sponsor money is late \n",
                                                   "decided_by": " Organizers meeting ", "decided_on": "2026-10-01"})
    od = rows[0]["id"] if st == 201 else None
    check("Decisions: Olive adds a decision in Organizers (positive control), created_by set by the database", od and rows[0]["created_by"] == O, f"{st} {rows}")
    check("Decisions: fields are trimmed and the date kept", od and rows[0]["title"] == "Budget cap ORG-DECISION-SECRET" and rows[0]["context"] == "Sponsor money is late"
          and rows[0]["decided_by"] == "Organizers meeting" and rows[0]["decided_on"] == "2026-10-01", str(rows))
    st, rows = call("POST", "/decisions", olive, {"log_id": fest, "title": "Gates open at 10"})
    f1 = rows[0]["id"] if st == 201 else None
    check("Decisions: only a title is needed; the date defaults to today", f1 is not None and rows[0]["decided_on"] and rows[0]["replaces_id"] is None, f"{st} {rows}")
    st, rows = call("POST", "/decisions", olive, {"log_id": fest, "title": "Gates open at 9", "decided_by": "Olive", "replaces_id": f1})
    f2 = rows[0]["id"] if st == 201 else None
    check("Decisions: a decision can replace an earlier one in the same log (positive control)", f2 and rows[0]["replaces_id"] == f1, f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/decisions?log_id=eq.{org}&select=id", tok)
        check(f"Decisions: {who} gets no Organizers decisions", st == 200 and rows == [], str(rows))
    st, rows = call("GET", "/decisions?select=title&title=like.*ORG-DECISION*", pat)
    st2, rows2 = call("GET", "/decisions?select=id&decided_by=eq.Organizers%20meeting", vic)
    check("Decisions: nor finds them by filtering every decision", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Decisions: Pat cannot read the Organizers log summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Decisions: Olive can, and it carries the date, decision, who and context",
          "2026-10-01: Budget cap ORG-DECISION-SECRET (decided by Organizers meeting)" in body and "Sponsor money is late" in body, body)
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Decisions: the #festival summary says what replaces what, and Pat reads it", "Replaces: Gates open at 10" in body and "Replaced by: Gates open at 9" in body, body)
    st, rows = call("GET", f"/decisions?log_id=eq.{fest}&select=id,replaces_id", pat)
    check("Decisions: Pat reads the #festival decisions (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("POST", "/decisions", pat, {"log_id": fest, "title": "pwned"})
    check("Decisions: Pat (viewer) cannot add a decision in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/decisions?id=eq.{f1}", pat, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/decisions?id=eq.{f1}", pat)
    check("Decisions: Pat cannot change or delete a #festival decision", rows == [] and rows2 == [] and oq(f"select title from weft.decisions where id = '{f1}'") == "Gates open at 10", f"{st} {st2}")
    st, rows = call("PATCH", f"/decisions?id=eq.{od}", vic, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/decisions?log_id=eq.{org}", vic)
    check("Decisions: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) from weft.decisions where log_id = '{org}'") == "1", f"{st} {st2}")
    st, rows = call("PATCH", f"/decisions?id=eq.{f1}", olive, {"context": "Neighbours asked for a later start", "decided_by": "Council"})
    check("Decisions: Olive changes a decision (positive control)", st == 200 and rows and rows[0]["decided_by"] == "Council", f"{st} {rows}")
    # Replacements stay inside the log, never point at themselves, never loop, and replace a decision once.
    st, _ = call("POST", "/decisions", olive, {"log_id": fest, "title": "reach across", "replaces_id": od})
    check("Decisions: a decision cannot replace one in another log (or space)", st >= 400 and oq("select count(*) from weft.decisions where title = 'reach across'") == "0", str(st))
    st, _ = call("PATCH", f"/decisions?id=eq.{f2}", olive, {"replaces_id": od})
    check("Decisions: nor be changed to", st >= 400 and oq(f"select replaces_id from weft.decisions where id = '{f2}'") == f1, str(st))
    st, _ = call("PATCH", f"/decisions?id=eq.{f1}", olive, {"replaces_id": f1})
    check("Decisions: a decision cannot replace itself", st == 400, str(st))
    st, _ = call("PATCH", f"/decisions?id=eq.{f1}", olive, {"replaces_id": f2})
    check("Decisions: nor make a loop (A replaces B replaces A)", st == 400 and oq(f"select replaces_id is null from weft.decisions where id = '{f1}'") == "t", str(st))
    st, _ = call("POST", "/decisions", olive, {"log_id": fest, "title": "second replacement", "replaces_id": f1})
    check("Decisions: a decision is replaced by at most one other", st == 409, str(st))
    for bad, why in (({"title": "   "}, "an empty title"), ({"title": "x" * 201}, "a title over 200"), ({"title": "t", "context": "x" * 4001}, "context over 4000"),
                     ({"title": "t", "decided_by": "x" * 121}, "who decided over 120"), ({"title": "t", "decided_on": "not a date"}, "a date that is not one")):
        st, _ = call("POST", "/decisions", olive, {"log_id": fest, **bad})
        check(f"Decisions: {why} is refused", st == 400, str(st))
    st, _ = call("POST", "/decisions", olive, {"log_id": fest, "title": "forged", "created_by": A})
    check("Decisions: authorship of a decision cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/decisions?id=eq.{f1}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/decisions?id=eq.{f1}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Decisions: nor changed afterwards, nor the time it was written down", refused(st) and refused(st2) and oq(f"select created_by from weft.decisions where id = '{f1}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/decisions?id=eq.{f1}", olive, {"log_id": org})
    check("Decisions: a decision cannot be moved into another log", refused(st) and oq(f"select log_id from weft.decisions where id = '{f1}'") == fest, str(st))
    st, _ = call("POST", "/decisions", olive, {"log_id": uid("item", "porches"), "title": "on a table"})
    check("Decisions: a decision cannot hang off an item that is not a decision log", refused(st), str(st))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/decisions?log_id=in.({org},{fest})&select=log_id", scoped)
    check("Decisions: a #festival-scoped token sees only #festival decisions", st == 200 and rows and {r["log_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/decisions", scoped, {"log_id": org, "title": "scoped"})
    check("Decisions: nor writes in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/decisions?log_id=eq.{org}&select=id", helper)
    check("Decisions: the assistant (for Olive) can read Organizers decisions (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/decisions?id=eq.{od}", helper)
    st2, _ = call("PATCH", f"/decisions?id=eq.{od}", helper, {"title": "by the assistant"})
    st3, _ = call("POST", "/decisions", helper, {"log_id": org, "title": "by the assistant"})
    check("Decisions: the assistant cannot delete, change or add decisions", refused(st) and refused(st2) and refused(st3) and oq(f"select count(*) from weft.decisions where log_id = '{org}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/audit?row_id=eq.{f1}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{f1}&select=op", vic)
    check("Decisions: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1 and len(rows2 or []) >= 1, f"{rows} {rows2}")
    call("PATCH", f"/decisions?id=eq.{od}", olive, {"context": "Sponsor money is late; review in December"})
    st, rows = call("GET", f"/audit?row_id=eq.{od}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{od}&select=op", pat)
    check("Decisions: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-DECISION-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-DECISION-SECRET"})
    check("Decisions: search finds the log for Olive, not for Pat", any(r["id"] == org and r["kind"] == "decisionlog" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Deleting the replaced decision un-links the one that replaced it.
    st, _ = call("DELETE", f"/decisions?id=eq.{f1}", olive)
    check("Decisions: deleting a replaced decision keeps the newer one, no longer pointing at it", st in (200, 204)
          and oq(f"select coalesce(replaces_id::text, 'none') from weft.decisions where id = '{f2}'") == "none", str(st))
    # Moves follow the space: the log moves and its decisions go with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/decisions?log_id=eq.{fest}&select=id", pat)
    check("Decisions: a log moved to Volunteers takes its decisions out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/decisions?log_id=eq.{org}&select=id", pat)
    check("Decisions: a log moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 1
          and refused(call("POST", "/decisions", pat, {"log_id": org, "title": "x"})[0]), f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Decisions: Pat cannot delete the decision log", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Decisions: deleting a decision log deletes its decisions", st in (200, 204) and oq(f"select count(*) from weft.decisions where log_id = '{org}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def qa():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, O, A, V = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex"), uid("user", "u-vol")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "qa", "title": "Org questions"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "qa", "title": "Festival questions"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Q and A: Olive (editor) makes boards in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "qa", "title": "x"})
    check("Q and A: Pat (viewer) cannot make a board in #festival", refused(st), str(st))
    # Asking and answering.
    st, rows = call("POST", "/questions", olive, {"board_id": org, "title": "  Who signs ORG-QA-SECRET contracts?  ", "details": " The sponsor one \n"})
    oqid = rows[0]["id"] if st == 201 else None
    check("Q and A: Olive asks in Organizers (positive control), created_by set by the database, text trimmed",
          oqid and rows[0]["created_by"] == O and rows[0]["title"] == "Who signs ORG-QA-SECRET contracts?" and rows[0]["details"] == "The sponsor one", f"{st} {rows}")
    st, rows = call("POST", "/answers", alex, {"question_id": oqid, "body": "The treasurer ORG-ANSWER-SECRET"})
    oa = rows[0]["id"] if st == 201 else None
    check("Q and A: Alex answers in Organizers (positive control)", oa and rows[0]["created_by"] == A, f"{st} {rows}")
    st, rows = call("POST", "/questions", olive, {"board_id": fest, "title": "Where do volunteers park?"})
    fq = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/answers", olive, {"question_id": fq, "body": "  Behind the school.  "})
    fa1 = rows[0]["id"] if st2 == 201 else None
    st3, rows3 = call("POST", "/answers", alex, {"question_id": fq, "body": "On the field, unless it rained."})
    fa2 = rows3[0]["id"] if st3 == 201 else None
    check("Q and A: a #festival question with two answers (positive control)", fq and fa1 and fa2 and rows[0]["body"] == "Behind the school.", f"{st} {st2} {st3}")
    # Outsiders see nothing.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/questions?board_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/answers?question_id=eq.{oqid}&select=id", tok)
        check(f"Q and A: {who} gets no Organizers questions or answers", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", "/questions?select=title&title=like.*ORG-QA*", pat)
    st2, rows2 = call("GET", "/answers?select=body&body=like.*ORG-ANSWER*", vic)
    check("Q and A: nor finds them by filtering every question and answer", rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Q and A: Pat cannot read the Organizers board summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/questions?board_id=eq.{fest}&select=id,answers!answers_question_id_fkey(id)", pat)
    check("Q and A: Pat reads the #festival question and its answers (positive control)", st == 200 and len(rows) == 1 and len(rows[0]["answers"]) == 2, str(rows))
    # Viewers do not ask, answer, change or delete.
    st, _ = call("POST", "/questions", pat, {"board_id": fest, "title": "pwned"})
    st2, _ = call("POST", "/answers", pat, {"question_id": fq, "body": "pwned"})
    check("Q and A: Pat (viewer) cannot ask or answer in #festival", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/questions?id=eq.{fq}", pat, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/answers?id=eq.{fa1}", pat)
    st3, rows3 = call("PATCH", f"/questions?id=eq.{fq}", pat, {"accepted_id": fa1})
    check("Q and A: Pat cannot change a question, accept an answer or delete an answer", rows == [] and rows2 == [] and rows3 == []
          and oq(f"select title || coalesce(accepted_id::text, '-') from weft.questions where id = '{fq}'") == "Where do volunteers park?-"
          and oq(f"select count(*) from weft.answers where question_id = '{fq}'") == "2", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/questions?id=eq.{oqid}", vic, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/questions?board_id=eq.{org}", vic)
    check("Q and A: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) from weft.questions where board_id = '{org}'") == "1", f"{st} {st2}")
    # Upvotes: every member, viewers included, only for themselves, never their own answer.
    st, rows = call("POST", "/answer_votes", pat, {"answer_id": fa1})
    check("Q and A: Pat (viewer) upvotes a #festival answer (positive control), voter set by the database", st == 201 and rows[0]["voter_id"] == P, f"{st} {rows}")
    st, _ = call("POST", "/answer_votes", pat, {"answer_id": fa1})
    check("Q and A: one upvote per person per answer", st == 409, str(st))
    st, _ = call("POST", "/answer_votes", pat, {"answer_id": fa2, "voter_id": V})
    check("Q and A: an upvote cannot be cast for someone else", refused(st) and oq(f"select count(*) from weft.answer_votes where voter_id = '{V}'") == "0", str(st))
    st, rows = call("POST", "/answer_votes", olive, {"answer_id": fa1})
    check("Q and A: nobody upvotes their own answer, and the database says why", st == 403 and "own answer" in json.dumps(rows), f"{st} {rows}")
    st, _ = call("POST", "/answer_votes", olive, {"answer_id": fa2})
    st2, _ = call("POST", "/answer_votes", vic, {"answer_id": fa2})
    check("Q and A: Olive and Vic upvote Alex's answer (positive control)", st == 201 and st2 == 201, f"{st} {st2}")
    st, rows = call("POST", "/answer_votes", pat, {"answer_id": oa})
    check("Q and A: Pat cannot upvote an Organizers answer, and is told nothing about it", refused(st) and "own answer" not in json.dumps(rows)
          and oq(f"select count(*) from weft.answer_votes where answer_id = '{oa}'") == "0", f"{st} {rows}")
    st, rows = call("DELETE", f"/answer_votes?answer_id=eq.{fa2}&voter_id=eq.{O}", pat)
    check("Q and A: Pat cannot withdraw Olive's upvote", rows == [] and oq(f"select count(*) from weft.answer_votes where answer_id = '{fa2}'") == "2", str(st))
    st, rows = call("PATCH", f"/answer_votes?answer_id=eq.{fa1}", pat, {"answer_id": fa2})
    check("Q and A: an upvote cannot be moved to another answer", refused(st), str(st))
    # Changing text: only your own.
    st, rows = call("PATCH", f"/answers?id=eq.{fa2}", olive, {"body": "rewritten by Olive"})
    check("Q and A: Olive cannot rewrite Alex's answer", rows == [] and oq(f"select body from weft.answers where id = '{fa2}'") == "On the field, unless it rained.", f"{st} {rows}")
    st, rows = call("PATCH", f"/answers?id=eq.{fa1}", olive, {"body": "Behind the school, entrance on Mill Lane."})
    check("Q and A: Olive edits her own answer (positive control)", st == 200 and rows and rows[0]["body"].endswith("Mill Lane."), f"{st} {rows}")
    st, rows = call("PATCH", f"/questions?id=eq.{fq}", alex, {"title": "rewritten by Alex"})
    check("Q and A: even an owner cannot reword someone else's question", st == 403 and "only the person who asked" in json.dumps(rows), f"{st} {rows}")
    # Accepting: the asker or an owner, and only an answer to the same question.
    st, rows = call("PATCH", f"/questions?id=eq.{oqid}", olive, {"accepted_id": fa1})
    check("Q and A: an answer to another question cannot be accepted", st >= 400 and oq(f"select accepted_id is null from weft.questions where id = '{oqid}'") == "t", f"{st} {rows}")
    st, rows = call("PATCH", f"/questions?id=eq.{fq}", olive, {"accepted_id": fa2})
    check("Q and A: the asker (Olive) accepts an answer (positive control)", st == 200 and rows and rows[0]["accepted_id"] == fa2, f"{st} {rows}")
    st, rows = call("POST", "/questions", alex, {"board_id": fest, "title": "Is there a cloakroom?"})
    aq = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/answers", olive, {"question_id": aq, "body": "Yes, by gate B."})
    aqa = rows[0]["id"] if st == 201 else None
    st, rows = call("PATCH", f"/questions?id=eq.{aq}", olive, {"accepted_id": aqa})
    check("Q and A: an editor who did not ask cannot accept, and is told why", st == 403 and "accept an answer" in json.dumps(rows)
          and oq(f"select accepted_id is null from weft.questions where id = '{aq}'") == "t", f"{st} {rows}")
    st, rows = call("PATCH", f"/questions?id=eq.{oqid}", alex, {"accepted_id": oa})
    check("Q and A: an owner (Alex) accepts on someone else's question (positive control)", st == 200 and rows and rows[0]["accepted_id"] == oa, f"{st} {rows}")
    st, _ = call("POST", "/questions", olive, {"board_id": fest, "title": "pre-accepted", "accepted_id": fa1})
    check("Q and A: a question cannot be made with an answer already accepted", refused(st), str(st))
    # Bad input.
    for path, bad, why in (("/questions", {"board_id": fest, "title": "   "}, "an empty question"), ("/questions", {"board_id": fest, "title": "x" * 201}, "a question over 200"),
                           ("/questions", {"board_id": fest, "title": "t", "details": "x" * 4001}, "details over 4000"),
                           ("/answers", {"question_id": fq, "body": "  \n "}, "an empty answer"), ("/answers", {"question_id": fq, "body": "x" * 8001}, "an answer over 8000")):
        st, _ = call("POST", path, olive, bad)
        check(f"Q and A: {why} is refused", st == 400, str(st))
    # Authorship and links cannot be forged or moved.
    st, _ = call("POST", "/questions", olive, {"board_id": fest, "title": "forged", "created_by": A})
    st2, _ = call("POST", "/answers", olive, {"question_id": fq, "body": "forged", "created_by": A})
    check("Q and A: authorship of a question or answer cannot be forged", refused(st) and refused(st2), f"{st} {st2}")
    st, _ = call("PATCH", f"/answers?id=eq.{fa1}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/questions?id=eq.{fq}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Q and A: nor changed afterwards, nor the time", refused(st) and refused(st2) and oq(f"select created_by from weft.answers where id = '{fa1}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/questions?id=eq.{fq}", olive, {"board_id": org})
    st2, _ = call("PATCH", f"/answers?id=eq.{fa1}", olive, {"question_id": oqid})
    check("Q and A: a question never jumps boards, nor an answer questions", refused(st) and refused(st2)
          and oq(f"select board_id from weft.questions where id = '{fq}'") == fest and oq(f"select question_id from weft.answers where id = '{fa1}'") == fq, f"{st} {st2}")
    st, _ = call("POST", "/questions", olive, {"board_id": uid("item", "porches"), "title": "on a table"})
    check("Q and A: a question cannot hang off an item that is not a board", refused(st), str(st))
    # Weft can answer from it: the summary has the accepted answer first, with upvotes and names.
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    i_acc, i_other = body.find("Accepted answer (2 upvotes, by Alex"), body.find("Answer (1 upvote, by Olive")
    check("Q and A: the board summary has each question, the accepted answer first, upvotes and who, and Pat reads it",
          "Question: Where do volunteers park? (asked by Olive" in body and 0 <= i_acc < i_other and "Mill Lane" in body and "No answers yet" not in body.split("Question: Is there")[0], body)
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Q and A: Olive reads the Organizers summary, with the accepted answer", "Accepted answer (0 upvotes, by Alex" in body and "ORG-ANSWER-SECRET" in body, body)
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-ANSWER-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-ANSWER-SECRET"})
    check("Q and A: search finds the board by an answer's words for Olive, not for Pat", any(r["id"] == org and r["kind"] == "qa" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/questions?board_id=in.({org},{fest})&select=board_id", scoped)
    st2, rows2 = call("GET", f"/answers?question_id=in.({oqid},{fq})&select=question_id", scoped)
    check("Q and A: a #festival-scoped token sees only #festival questions and answers", rows and {r["board_id"] for r in rows} == {fest}
          and rows2 and {r["question_id"] for r in rows2} == {fq}, f"{rows} {rows2}")
    st, _ = call("POST", "/answers", scoped, {"question_id": oqid, "body": "scoped"})
    st2, _ = call("POST", "/answer_votes", scoped, {"answer_id": oa})
    check("Q and A: nor answers or upvotes in Organizers", refused(st) and refused(st2), f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/answers?question_id=eq.{oqid}&select=id", helper)
    check("Q and A: the assistant (for Olive) can read Organizers answers (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/answers?id=eq.{oa}", helper)
    st2, _ = call("DELETE", f"/questions?id=eq.{oqid}", helper)
    st3, _ = call("POST", "/answers", helper, {"question_id": oqid, "body": "by the assistant"})
    st4, _ = call("POST", "/answer_votes", helper, {"answer_id": oa})
    check("Q and A: the assistant cannot delete, answer or upvote", refused(st) and refused(st2) and refused(st3) and refused(st4)
          and oq(f"select count(*) from weft.answers where question_id = '{oqid}'") == "1", f"{st} {st2} {st3} {st4}")
    # Audit under the board's space.
    st, rows = call("GET", f"/audit?row_id=eq.{fa1}&select=op", vic)
    check("Q and A: #festival changes are in the audit log, readable by its members (positive control)", len(rows or []) >= 1, str(rows))
    st, rows = call("GET", f"/audit?row_id=eq.{oqid}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{oqid}&select=op", pat)
    check("Q and A: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Withdrawing, and deletes that follow the question.
    st, _ = call("DELETE", f"/answer_votes?answer_id=eq.{fa1}&voter_id=eq.{P}", pat)
    check("Q and A: Pat withdraws her own upvote (positive control)", st in (200, 204) and oq(f"select count(*) from weft.answer_votes where answer_id = '{fa1}'") == "0", str(st))
    st, _ = call("DELETE", f"/answers?id=eq.{fa2}", olive)
    check("Q and A: an editor deletes someone else's answer (tidying up); the accepted mark and its upvotes go with it", st in (200, 204)
          and oq(f"select accepted_id is null from weft.questions where id = '{fq}'") == "t" and oq(f"select count(*) from weft.answer_votes where answer_id = '{fa2}'") == "0", str(st))
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Q and A: the summary follows the delete", "unless it rained" not in body and "Accepted answer" not in body, body)
    st, _ = call("DELETE", f"/questions?id=eq.{aq}", olive)
    check("Q and A: deleting a question deletes its answers", st in (200, 204) and oq(f"select count(*) from weft.answers where question_id = '{aq}'") == "0", str(st))
    # Moves follow the space: the board moves and everything on it goes with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/answers?question_id=eq.{fq}&select=id", pat)
    check("Q and A: a board moved to Volunteers takes its questions and answers out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("POST", "/answer_votes", pat, {"answer_id": fa1})
    check("Q and A: nor can Pat upvote there any more", refused(st), str(st))
    st, _ = call("POST", "/answers", vic, {"question_id": fq, "body": "Vic, now an editor here"})
    check("Q and A: Vic (editor in Volunteers) can answer on the moved board (positive control)", st == 201, str(st))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/answers?question_id=eq.{oqid}&select=id", pat)
    check("Q and A: a board moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 1
          and refused(call("POST", "/answers", pat, {"question_id": oqid, "body": "x"})[0]), f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Q and A: Pat cannot delete the board", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Q and A: deleting a board deletes its questions and answers", st in (200, 204)
          and oq(f"select count(*) from weft.questions where board_id = '{org}'") == "0" and oq(f"select count(*) from weft.answers where id = '{oa}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def ideas():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, O, A, V = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex"), uid("user", "u-vol")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "ideaboard", "title": "Org ideas"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "ideaboard", "title": "Festival ideas"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Ideas: Olive (editor) makes boards in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "ideaboard", "title": "x"})
    check("Ideas: Pat (viewer) cannot make a board in #festival", refused(st), str(st))
    # Suggesting.
    st, rows = call("POST", "/ideas", olive, {"board_id": org, "title": "  Raise   ORG-IDEA-SECRET ticket prices  ", "details": " By five pounds \n"})
    oi = rows[0]["id"] if st == 201 else None
    check("Ideas: Olive suggests in Organizers (positive control), created_by set by the database, text tidied, status new",
          oi and rows[0]["created_by"] == O and rows[0]["title"] == "Raise ORG-IDEA-SECRET ticket prices" and rows[0]["details"] == "By five pounds"
          and rows[0]["status"] == "new", f"{st} {rows}")
    st, rows = call("POST", "/ideas", olive, {"board_id": fest, "title": "Water refill point by the main stage"})
    f1 = rows[0]["id"] if st == 201 else None
    st2, rows2 = call("POST", "/ideas", alex, {"board_id": fest, "title": "Quiet tent for families", "details": "With beanbags."})
    f2 = rows2[0]["id"] if st2 == 201 else None
    check("Ideas: Olive and Alex suggest in #festival (positive control)", f1 and f2 and rows2[0]["created_by"] == A, f"{st} {st2}")
    st, _ = call("POST", "/ideas", olive, {"board_id": fest, "title": "Pre-planned", "status": "planned"})
    check("Ideas: an idea cannot be made with a status already set", refused(st) and oq(f"select count(*) from weft.ideas where title = 'Pre-planned'") == "0", str(st))
    st, rows = call("POST", "/ideas", olive, {"board_id": fest, "title": "Pre-planned"})
    f3 = rows[0]["id"] if st == 201 else None
    check("Ideas: a new idea starts as new (positive control)", f3 and rows[0]["status"] == "new", f"{st} {rows}")
    # Outsiders see nothing.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/ideas?board_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/idea_votes?idea_id=eq.{oi}&select=idea_id", tok)
        check(f"Ideas: {who} gets no Organizers ideas or votes", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", "/ideas?select=title&title=like.*ORG-IDEA*", pat)
    check("Ideas: nor finds them by filtering every idea", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Ideas: Pat cannot read the Organizers board summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/ideas?board_id=eq.{fest}&select=id", pat)
    check("Ideas: Pat reads the #festival ideas (positive control)", st == 200 and len(rows) == 3, str(rows))
    # Viewers do not suggest, change, set status or delete.
    st, _ = call("POST", "/ideas", pat, {"board_id": fest, "title": "pwned"})
    st2, _ = call("POST", "/ideas", vic, {"board_id": fest, "title": "pwned"})
    check("Ideas: Pat and Vic (viewers) cannot suggest in #festival", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f1}", pat, {"title": "pwned"})
    st2, rows2 = call("PATCH", f"/ideas?id=eq.{f1}", pat, {"status": "declined"})
    st3, rows3 = call("DELETE", f"/ideas?id=eq.{f1}", pat)
    check("Ideas: Pat cannot change an idea, its status, or delete it", rows == [] and rows2 == [] and rows3 == []
          and oq(f"select title || '/' || status from weft.ideas where id = '{f1}'") == "Water refill point by the main stage/new", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/ideas?id=eq.{oi}", vic, {"status": "done"})
    st2, rows2 = call("DELETE", f"/ideas?board_id=eq.{org}", vic)
    check("Ideas: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) || status from weft.ideas where board_id = '{org}' group by status") == "1new", f"{st} {st2}")
    # Votes: every member, viewers included, only for themselves, once.
    st, rows = call("POST", "/idea_votes", pat, {"idea_id": f1})
    check("Ideas: Pat (viewer) votes for a #festival idea (positive control), voter set by the database", st == 201 and rows[0]["voter_id"] == P, f"{st} {rows}")
    st, _ = call("POST", "/idea_votes", pat, {"idea_id": f1})
    check("Ideas: one vote per person per idea", st == 409, str(st))
    st, _ = call("POST", "/idea_votes", pat, {"idea_id": f2, "voter_id": V})
    check("Ideas: a vote cannot be cast for someone else", refused(st) and oq(f"select count(*) from weft.idea_votes where voter_id = '{V}'") == "0", str(st))
    st, _ = call("POST", "/idea_votes", olive, {"idea_id": f1})
    st2, _ = call("POST", "/idea_votes", vic, {"idea_id": f1})
    st3, _ = call("POST", "/idea_votes", alex, {"idea_id": f2})
    check("Ideas: Olive votes for her own idea, Vic and Alex vote too (positive control)", st == 201 and st2 == 201 and st3 == 201, f"{st} {st2} {st3}")
    st, rows = call("POST", "/idea_votes", pat, {"idea_id": oi})
    check("Ideas: Pat cannot vote for an Organizers idea, and is told nothing about it", refused(st) and "closed" not in json.dumps(rows)
          and oq(f"select count(*) from weft.idea_votes where idea_id = '{oi}'") == "0", f"{st} {rows}")
    st, rows = call("DELETE", f"/idea_votes?idea_id=eq.{f1}&voter_id=eq.{O}", pat)
    check("Ideas: Pat cannot take back Olive's vote", rows == [] and oq(f"select count(*) from weft.idea_votes where idea_id = '{f1}'") == "3", str(st))
    st, _ = call("PATCH", f"/idea_votes?idea_id=eq.{f1}", pat, {"idea_id": f2})
    check("Ideas: a vote cannot be moved to another idea", refused(st), str(st))
    # Changing text: only your own, owners included.
    st, rows = call("PATCH", f"/ideas?id=eq.{f2}", olive, {"title": "rewritten by Olive"})
    check("Ideas: Olive cannot reword Alex's idea, and is told why", st == 403 and "only the person who suggested" in json.dumps(rows)
          and oq(f"select title from weft.ideas where id = '{f2}'") == "Quiet tent for families", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f1}", alex, {"details": "rewritten by Alex"})
    check("Ideas: even an owner cannot reword someone else's idea", st == 403, f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f1}", olive, {"details": "Next to the first aid tent."})
    check("Ideas: Olive edits her own idea (positive control)", st == 200 and rows and rows[0]["details"] == "Next to the first aid tent.", f"{st} {rows}")
    # Status: owners only.
    st, rows = call("PATCH", f"/ideas?id=eq.{f1}", olive, {"status": "planned"})
    check("Ideas: an editor, even the one who suggested it, cannot change the status, and is told why", st == 403 and "owner of the space" in json.dumps(rows)
          and oq(f"select status from weft.ideas where id = '{f1}'") == "new", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f1}", alex, {"status": "planned"})
    check("Ideas: an owner (Alex) marks an idea planned (positive control)", st == 200 and rows and rows[0]["status"] == "planned", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f3}", alex, {"status": "maybe"})
    check("Ideas: only the four statuses exist", st == 400 and oq(f"select status from weft.ideas where id = '{f3}'") == "new", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f3}", alex, {"status": "declined"})
    check("Ideas: an owner declines an idea (positive control)", st == 200 and rows and rows[0]["status"] == "declined", f"{st} {rows}")
    # Voting is closed on done and declined ideas (told only to members); votes there are kept.
    st, rows = call("POST", "/idea_votes", pat, {"idea_id": f3})
    check("Ideas: nobody votes for a declined idea, and the database says why", st == 403 and "voting is closed" in json.dumps(rows), f"{st} {rows}")
    st, _ = call("POST", "/idea_votes", pat, {"idea_id": f2})
    st2, _ = call("PATCH", f"/ideas?id=eq.{f2}", alex, {"status": "done"})
    check("Ideas: an idea marked done keeps its votes", st == 201 and st2 == 200 and oq(f"select count(*) from weft.idea_votes where idea_id = '{f2}'") == "2", f"{st} {st2}")
    st, _ = call("DELETE", f"/idea_votes?idea_id=eq.{f2}&voter_id=eq.{P}", pat)
    check("Ideas: a vote can still be taken back after it is done (positive control)", st in (200, 204) and oq(f"select count(*) from weft.idea_votes where idea_id = '{f2}'") == "1", str(st))
    st, _ = call("PATCH", f"/ideas?id=eq.{oi}", alex, {"status": "done"})
    st2, rows2 = call("POST", "/idea_votes", vic, {"idea_id": oi})
    check("Ideas: an outsider gets the plain refusal on a closed idea too, not the reason", st == 200 and refused(st2) and "closed" not in json.dumps(rows2), f"{st} {st2} {rows2}")
    call("PATCH", f"/ideas?id=eq.{oi}", alex, {"status": "new"})
    # Bad input.
    for bad, why in (({"board_id": fest, "title": "   "}, "an empty idea"), ({"board_id": fest, "title": "x" * 201}, "an idea over 200"),
                     ({"board_id": fest, "title": "t", "details": "x" * 4001}, "details over 4000")):
        st, _ = call("POST", "/ideas", olive, bad)
        check(f"Ideas: {why} is refused", st == 400, str(st))
    st, rows = call("POST", "/ideas", olive, {"board_id": fest, "title": "two\n  lines"})
    check("Ideas: an idea typed on two lines is kept on one", st == 201 and rows[0]["title"] == "two lines", f"{st} {rows}")
    if st == 201:
        call("DELETE", f"/ideas?id=eq.{rows[0]['id']}", olive)
    # Authorship and links cannot be forged or moved.
    st, _ = call("POST", "/ideas", olive, {"board_id": fest, "title": "forged", "created_by": A})
    check("Ideas: authorship cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/ideas?id=eq.{f1}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/ideas?id=eq.{f1}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Ideas: nor changed afterwards, nor the time", refused(st) and refused(st2) and oq(f"select created_by from weft.ideas where id = '{f1}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/ideas?id=eq.{f1}", olive, {"board_id": org})
    check("Ideas: an idea never jumps boards", refused(st) and oq(f"select board_id from weft.ideas where id = '{f1}'") == fest, str(st))
    st, _ = call("POST", "/ideas", olive, {"board_id": uid("item", "porches"), "title": "on a table"})
    check("Ideas: an idea cannot hang off an item that is not an ideas board", refused(st), str(st))
    # Weft can answer from it: the summary has open ideas first, with status, votes and names.
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    i1, i2, i3 = body.find("Idea: Water refill point by the main stage (planned, 3 votes, suggested by Olive"), body.find("Idea: Quiet tent for families (done, 1 vote, suggested by Alex"), body.find("Idea: Pre-planned (declined, 0 votes")
    check("Ideas: the board summary lists planned, then done, then declined, with votes and who, and Pat reads it",
          body.startswith("Ideas, 3 ideas") and 0 <= i1 < i2 < i3 and "first aid tent" in body, body)
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-IDEA-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-IDEA-SECRET"})
    check("Ideas: search finds the board by an idea's words for Olive, not for Pat", any(r["id"] == org and r["kind"] == "ideaboard" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/ideas?board_id=in.({org},{fest})&select=board_id", scoped)
    check("Ideas: a #festival-scoped token sees only #festival ideas", rows and {r["board_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/ideas", scoped, {"board_id": org, "title": "scoped"})
    st2, _ = call("POST", "/idea_votes", scoped, {"idea_id": oi})
    check("Ideas: nor suggests or votes in Organizers", refused(st) and refused(st2), f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/ideas?board_id=eq.{org}&select=id", helper)
    check("Ideas: the assistant (for Olive) can read Organizers ideas (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/ideas?id=eq.{oi}", helper)
    st2, _ = call("POST", "/ideas", helper, {"board_id": org, "title": "by the assistant"})
    st3, _ = call("POST", "/idea_votes", helper, {"idea_id": oi})
    st4, _ = call("PATCH", f"/ideas?id=eq.{oi}", helper, {"status": "done"})
    check("Ideas: the assistant cannot delete, suggest, vote or change the status", refused(st) and refused(st2) and refused(st3) and refused(st4)
          and oq(f"select count(*) || status from weft.ideas where board_id = '{org}' group by status") == "1new", f"{st} {st2} {st3} {st4}")
    # Audit under the board's space.
    st, rows = call("GET", f"/audit?row_id=eq.{f1}&select=op", vic)
    check("Ideas: #festival changes are in the audit log, readable by its members (positive control)", len(rows or []) >= 1, str(rows))
    st, rows = call("GET", f"/audit?row_id=eq.{oi}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{oi}&select=op", pat)
    check("Ideas: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Withdrawing, and deletes.
    st, _ = call("DELETE", f"/idea_votes?idea_id=eq.{f1}&voter_id=eq.{P}", pat)
    check("Ideas: Pat takes back her own vote (positive control)", st in (200, 204) and oq(f"select count(*) from weft.idea_votes where idea_id = '{f1}' and voter_id = '{P}'") == "0", str(st))
    st, _ = call("DELETE", f"/ideas?id=eq.{f2}", olive)
    check("Ideas: an editor deletes someone else's idea (tidying up), with its votes", st in (200, 204)
          and oq(f"select count(*) from weft.ideas where id = '{f2}'") == "0" and oq(f"select count(*) from weft.idea_votes where idea_id = '{f2}'") == "0", str(st))
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Ideas: the summary follows the delete and the withdrawn vote", "Quiet tent" not in body and "(planned, 2 votes" in body, body)
    # Moves follow the space: the board moves and everything on it goes with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/ideas?board_id=eq.{fest}&select=id", pat)
    check("Ideas: a board moved to Volunteers takes its ideas out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("POST", "/idea_votes", pat, {"idea_id": f1})
    check("Ideas: nor can Pat vote there any more", refused(st), str(st))
    st, _ = call("POST", "/ideas", vic, {"board_id": fest, "title": "Vic, now an editor here"})
    check("Ideas: Vic (editor in Volunteers) can suggest on the moved board (positive control)", st == 201, str(st))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/ideas?board_id=eq.{org}&select=id", pat)
    st3, _ = call("POST", "/idea_votes", pat, {"idea_id": oi})
    check("Ideas: a board moved into #festival becomes readable to Pat, who may now vote but not suggest", st == 200 and len(rows) == 1 and st3 == 201
          and refused(call("POST", "/ideas", pat, {"board_id": org, "title": "x"})[0]), f"{st} {rows} {st3}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Ideas: Pat cannot delete the board", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Ideas: deleting a board deletes its ideas and votes", st in (200, 204)
          and oq(f"select count(*) from weft.ideas where board_id = '{org}'") == "0" and oq(f"select count(*) from weft.idea_votes where idea_id = '{oi}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def checklists():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "checklist", "title": "Org packing"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "checklist", "title": "Opening up"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Checklists: Olive (editor) makes checklists in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "checklist", "title": "x"})
    check("Checklists: Pat (viewer) cannot make a checklist in #festival", refused(st), str(st))
    # A template with no steps cannot be run (a plain answer, for editors only).
    st, rows = call("POST", "/checklist_runs", olive, {"checklist_id": fest})
    check("Checklists: a checklist with no steps cannot be run", st == 400 and "add a step" in json.dumps(rows), f"{st} {rows}")
    st, rows = call("POST", "/checklist_runs", pat, {"checklist_id": fest})
    check("Checklists: Pat gets a refusal, not that answer", refused(st) and "add a step" not in json.dumps(rows), f"{st} {rows}")
    st, rows = call("POST", "/checklist_steps", olive, {"checklist_id": org, "label": "  Pack the ORG-CHECKLIST-SECRET cash box  ", "position": 0})
    os1 = rows[0]["id"] if st == 201 else None
    check("Checklists: Olive adds a step in Organizers (positive control), created_by set by the database, label trimmed",
          os1 and rows[0]["created_by"] == O and rows[0]["label"] == "Pack the ORG-CHECKLIST-SECRET cash box", f"{st} {rows}")
    fs = []
    for i, label in enumerate(["Unlock the side gate", "Lights on", "Float in the till"]):
        st, rows = call("POST", "/checklist_steps", olive, {"checklist_id": fest, "label": label, "position": i})
        fs.append(rows[0]["id"] if st == 201 else None)
    check("Checklists: Olive adds three steps in #festival", all(fs), str(fs))
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/checklist_steps?checklist_id=eq.{org}&select=id", tok)
        check(f"Checklists: {who} gets no Organizers steps", st == 200 and rows == [], str(rows))
    st, rows = call("GET", "/checklist_steps?select=label&label=like.*ORG-CHECKLIST*", pat)
    check("Checklists: nor finds them by filtering every step", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/checklist_steps?checklist_id=eq.{fest}&select=id", pat)
    check("Checklists: Pat reads the #festival steps (positive control)", st == 200 and len(rows) == 3, str(rows))
    st, _ = call("POST", "/checklist_steps", pat, {"checklist_id": fest, "label": "pwned"})
    st2, rows2 = call("PATCH", f"/checklist_steps?id=eq.{fs[0]}", pat, {"label": "pwned"})
    st3, rows3 = call("DELETE", f"/checklist_steps?id=eq.{fs[0]}", pat)
    check("Checklists: Pat cannot add, change or delete #festival steps", refused(st) and rows2 == [] and rows3 == []
          and oq(f"select label from weft.checklist_steps where id = '{fs[0]}'") == "Unlock the side gate", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/checklist_steps?id=eq.{os1}", vic, {"label": "pwned"})
    st2, rows2 = call("DELETE", f"/checklist_steps?checklist_id=eq.{org}", vic)
    check("Checklists: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) from weft.checklist_steps where checklist_id = '{org}'") == "1", f"{st} {st2}")
    for bad, why in (({"label": "   "}, "an empty step"), ({"label": "x" * 201}, "a step over 200 characters")):
        st, _ = call("POST", "/checklist_steps", olive, {"checklist_id": fest, **bad})
        check(f"Checklists: {why} is refused", st == 400, str(st))
    st, _ = call("POST", "/checklist_steps", olive, {"checklist_id": fest, "label": "forged", "created_by": A})
    check("Checklists: authorship of a step cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/checklist_steps?id=eq.{fs[0]}", olive, {"checklist_id": org})
    check("Checklists: a step cannot be moved into another checklist", refused(st) and oq(f"select checklist_id from weft.checklist_steps where id = '{fs[0]}'") == fest, str(st))
    st, _ = call("POST", "/checklist_steps", olive, {"checklist_id": uid("item", "porches"), "label": "on a table"})
    check("Checklists: a step cannot hang off an item that is not a checklist", refused(st), str(st))

    # Runs: a fresh copy of the steps, made by the database.
    st, rows = call("POST", "/checklist_runs", olive, {"checklist_id": fest, "label": " Saturday "})
    r1 = rows[0]["id"] if st == 201 else None
    check("Checklists: Olive starts a run (positive control), started_by set by the database", r1 and rows[0]["started_by"] == O and rows[0]["label"] == "Saturday"
          and rows[0]["finished"] is False, f"{st} {rows}")
    st, rows = call("GET", f"/checklist_run_steps?run_id=eq.{r1}&select=id,label,position,done&order=position", pat)
    rs = [r["id"] for r in rows or []]
    check("Checklists: the run is a copy of the steps, in order, and Pat reads it", st == 200 and [r["label"] for r in rows] == ["Unlock the side gate", "Lights on", "Float in the till"]
          and not any(r["done"] for r in rows), str(rows))
    st, _ = call("POST", "/checklist_runs", olive, {"checklist_id": fest, "started_by": A})
    st2, _ = call("POST", "/checklist_runs", olive, {"checklist_id": fest, "finished": True})
    check("Checklists: who started a run cannot be forged, nor a run started finished", refused(st) and refused(st2), f"{st} {st2}")
    st, _ = call("POST", "/checklist_runs", pat, {"checklist_id": fest})
    check("Checklists: Pat (viewer) cannot start a run in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/checklist_run_steps?id=eq.{rs[0]}", pat, {"done": True})
    check("Checklists: Pat cannot tick a #festival step", rows == [] and oq(f"select done from weft.checklist_run_steps where id = '{rs[0]}'") == "f", f"{st} {rows}")
    st, rows = call("PATCH", f"/checklist_run_steps?id=eq.{rs[0]}", olive, {"done": True})
    check("Checklists: Olive ticks a step (positive control); who and when are set by the database", st == 200 and rows and rows[0]["done"] is True
          and rows[0]["done_by"] == O and rows[0]["done_at"], f"{st} {rows}")
    st, _ = call("PATCH", f"/checklist_run_steps?id=eq.{rs[1]}", olive, {"done_by": A})
    st2, _ = call("PATCH", f"/checklist_run_steps?id=eq.{rs[1]}", olive, {"label": "rewritten"})
    st3, _ = call("PATCH", f"/checklist_run_steps?id=eq.{rs[1]}", olive, {"run_id": r1})
    check("Checklists: nobody sets who ticked, rewrites a run's step or moves it", refused(st) and refused(st2) and refused(st3)
          and oq(f"select label from weft.checklist_run_steps where id = '{rs[1]}'") == "Lights on", f"{st} {st2} {st3}")
    st, _ = call("POST", "/checklist_run_steps", olive, {"run_id": r1, "label": "extra", "position": 9})
    st2, _ = call("DELETE", f"/checklist_run_steps?id=eq.{rs[2]}", olive)
    check("Checklists: a run's steps are never added or removed by hand", refused(st) and refused(st2)
          and oq(f"select count(*) from weft.checklist_run_steps where run_id = '{r1}'") == "3", f"{st} {st2}")
    # Changing the template never rewrites a run.
    call("PATCH", f"/checklist_steps?id=eq.{fs[1]}", olive, {"label": "All lights on"})
    st, _ = call("DELETE", f"/checklist_steps?id=eq.{fs[2]}", olive)
    check("Checklists: changing and removing template steps leaves the run as it was",
          oq(f"select string_agg(label, '|' order by position) from weft.checklist_run_steps where run_id = '{r1}'") == "Unlock the side gate|Lights on|Float in the till", str(st))
    st, rows = call("PATCH", f"/checklist_runs?id=eq.{r1}", alex, {"finished": True})
    check("Checklists: Alex (owner) finishes the run; who and when are set by the database", st == 200 and rows and rows[0]["finished"] is True
          and rows[0]["finished_by"] == A and rows[0]["finished_at"], f"{st} {rows}")
    st, rows = call("PATCH", f"/checklist_run_steps?id=eq.{rs[1]}", olive, {"done": True})
    check("Checklists: a finished run's ticks are fixed, with the database's answer", st == 400 and "finished" in json.dumps(rows)
          and oq(f"select done from weft.checklist_run_steps where id = '{rs[1]}'") == "f", f"{st} {rows}")
    st, _ = call("PATCH", f"/checklist_runs?id=eq.{r1}", olive, {"finished_by": O})
    st2, _ = call("PATCH", f"/checklist_runs?id=eq.{r1}", olive, {"checklist_id": org})
    check("Checklists: who finished a run cannot be forged, nor a run moved to another checklist", refused(st) and refused(st2)
          and oq(f"select finished_by from weft.checklist_runs where id = '{r1}'") == A, f"{st} {st2}")
    st, rows = call("PATCH", f"/checklist_runs?id=eq.{r1}", pat, {"finished": False})
    check("Checklists: Pat cannot reopen it", rows == [] and oq(f"select finished from weft.checklist_runs where id = '{r1}'") == "t", f"{st} {rows}")
    st, rows = call("PATCH", f"/checklist_runs?id=eq.{r1}", olive, {"finished": False})
    st2, rows2 = call("PATCH", f"/checklist_run_steps?id=eq.{rs[1]}", olive, {"done": True})
    check("Checklists: Olive reopens it and ticks again (positive control)", st == 200 and rows[0]["finished_at"] is None and st2 == 200 and rows2[0]["done"] is True, f"{st} {st2}")
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Checklists: the #festival summary lists the steps and the run, and Pat reads it",
          "1. Unlock the side gate" in body and "2. All lights on" in body and "Saturday, started" in body and "2 of 3 done, in progress" in body and "Not done: Float in the till" in body, body)
    # Outsiders, scoped tokens and the assistant.
    st, rows = call("POST", "/checklist_runs", olive, {"checklist_id": org, "label": "Org run"})
    r2 = rows[0]["id"] if st == 201 else None
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/checklist_runs?checklist_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/checklist_run_steps?run_id=eq.{r2}&select=id", tok)
        check(f"Checklists: {who} sees no Organizers runs or their steps", rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", "/checklist_run_steps?select=label&label=like.*ORG-CHECKLIST*", vic)
    check("Checklists: nor finds an Organizers run's steps by filtering", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Checklists: Pat cannot read the Organizers summary", st == 200 and rows == [], str(rows))
    st, rows = call("POST", "/checklist_runs", pat, {"checklist_id": org})
    check("Checklists: nor start a run there", refused(st), str(st))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/checklist_runs?checklist_id=in.({org},{fest})&select=checklist_id", scoped)
    st2, rows2 = call("GET", f"/checklist_steps?checklist_id=in.({org},{fest})&select=checklist_id", scoped)
    check("Checklists: a #festival-scoped token sees only #festival runs and steps", rows and {r["checklist_id"] for r in rows} == {fest}
          and rows2 and {r["checklist_id"] for r in rows2} == {fest}, f"{rows} {rows2}")
    st, _ = call("POST", "/checklist_runs", scoped, {"checklist_id": org})
    st2, rows2 = call("PATCH", f"/checklist_runs?id=eq.{r2}", scoped, {"finished": True})
    check("Checklists: nor starts or finishes runs in Organizers", refused(st) and rows2 == [], f"{st} {rows2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/checklist_run_steps?run_id=eq.{r2}&select=id", helper)
    check("Checklists: the assistant (for Olive) can read Organizers runs (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/checklist_runs?id=eq.{r2}", helper)
    st2, _ = call("DELETE", f"/checklist_steps?id=eq.{os1}", helper)
    st3, _ = call("PATCH", f"/checklist_run_steps?run_id=eq.{r2}", helper, {"done": True})
    st4, _ = call("POST", "/checklist_runs", helper, {"checklist_id": org})
    check("Checklists: the assistant cannot delete, tick or start anything", refused(st) and refused(st2) and refused(st3) and refused(st4)
          and oq(f"select count(*) from weft.checklist_runs where checklist_id = '{org}'") == "1", f"{st} {st2} {st3} {st4}")
    # Audit and search follow the space.
    st, rows = call("GET", f"/audit?row_id=eq.{rs[0]}&select=op", vic)
    check("Checklists: #festival ticks are in the audit log, readable by its members (positive control)", len(rows or []) >= 1, str(rows))
    call("PATCH", f"/checklist_runs?id=eq.{r2}", olive, {"label": "Org run, renamed"})
    st, rows = call("GET", f"/audit?row_id=eq.{r2}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{r2}&select=op", pat)
    check("Checklists: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-CHECKLIST-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-CHECKLIST-SECRET"})
    check("Checklists: search finds the checklist for Olive, not for Pat", any(r["id"] == org and r["kind"] == "checklist" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Deletes and moves follow the checklist.
    st, rows = call("DELETE", f"/checklist_runs?id=eq.{r1}", pat)
    check("Checklists: Pat cannot delete a run", rows == [] and oq(f"select count(*) from weft.checklist_runs where id = '{r1}'") == "1", str(st))
    st, _ = call("DELETE", f"/checklist_runs?id=eq.{r1}", olive)
    check("Checklists: Olive deletes a run and its ticks go with it (positive control)", st in (200, 204)
          and oq(f"select count(*) from weft.checklist_run_steps where run_id = '{r1}'") == "0", str(st))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/checklist_runs?checklist_id=eq.{org}&select=id,steps:checklist_run_steps(id)", pat)
    check("Checklists: a checklist moved into #festival takes its runs with it, readable to Pat", st == 200 and len(rows) == 1 and len(rows[0]["steps"]) == 1, f"{st} {rows}")
    st, rows = call("PATCH", f"/checklist_run_steps?run_id=eq.{r2}", pat, {"done": True})
    check("Checklists: still read-only for Pat", rows == [], str(rows))
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    st2, rows = call("GET", f"/checklist_steps?checklist_id=eq.{fest}&select=id", pat)
    check("Checklists: a checklist moved to Organizers takes its steps out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Checklists: Pat cannot delete a checklist", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Checklists: deleting a checklist deletes its steps, runs and ticks", st in (200, 204)
          and oq(f"select count(*) from weft.checklist_steps where checklist_id = '{org}'") == "0"
          and oq(f"select count(*) from weft.checklist_runs where checklist_id = '{org}'") == "0"
          and oq(f"select count(*) from weft.checklist_run_steps where run_id = '{r2}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def expenses():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    save = lambda tok, **kw: call("POST", "/rpc/save_expense", tok, kw)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "expenselist", "title": "Org costs"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "expenselist", "title": "Festival costs"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Expenses: Olive (editor) makes expense lists in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "expenselist", "title": "x"})
    check("Expenses: Pat (viewer) cannot make an expense list in #festival", refused(st), str(st))
    st, oe = save(olive, p_list=org, p_title="  ORG-EXPENSE-SECRET dinner  ", p_amount_cents=3000, p_paid_by=O, p_people=[O, A])
    check("Expenses: Olive adds an Organizers expense (positive control), split evenly by the database, created_by set by the database",
          st == 200 and oq(f"select title || '|' || created_by || '|' || split from weft.expenses where id = '{oe}'") == f"ORG-EXPENSE-SECRET dinner|{O}|even"
          and oq(f"select string_agg(share_cents::text, ',' order by share_cents) from weft.expense_shares where expense_id = '{oe}'") == "1500,1500", f"{st} {oe}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/expenses?list_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/expense_shares?expense_id=eq.{oe}&select=user_id", tok)
        st3, rows3 = call("GET", f"/expense_balances?list_id=eq.{org}", tok)
        check(f"Expenses: {who} gets no Organizers expenses, shares or balances", rows == [] and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
    st, rows = call("GET", "/expenses?select=title&title=like.*ORG-EXPENSE*", pat)
    st2, rows2 = call("GET", f"/expense_balances?user_id=eq.{A}", pat)
    check("Expenses: nor finds them by filtering every expense or every balance", rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")

    # #festival: an even split (the odd cent goes to the first person) and a split by amounts.
    st, fe = save(olive, p_list=fest, p_title="Van hire", p_amount_cents=10000, p_paid_by=O, p_people=[O, V, P], p_spent_on="2026-11-01")
    check("Expenses: Olive adds an even split in #festival; the shares add up, the odd cent to the first person", st == 200
          and oq(f"select string_agg(share_cents::text, ',' order by share_cents desc) from weft.expense_shares where expense_id = '{fe}'") == "3334,3333,3333"
          and oq(f"select share_cents from weft.expense_shares where expense_id = '{fe}' and user_id = '{O}'") == "3334", f"{st} {fe}")
    st, fe2 = save(alex, p_list=fest, p_title="Ice", p_amount_cents=2500, p_paid_by=A, p_people=[P, V], p_split="amounts", p_amounts=[1000, 1500])
    check("Expenses: Alex (owner) adds a split by amounts (positive control)", st == 200
          and oq(f"select string_agg(share_cents::text, ',' order by share_cents) from weft.expense_shares where expense_id = '{fe2}'") == "1000,1500", f"{st} {fe2}")
    st, rows = call("GET", f"/expenses?list_id=eq.{fest}&select=id,shares:expense_shares(user_id,share_cents)", pat)
    check("Expenses: Pat reads the #festival expenses and their shares (positive control)", st == 200 and len(rows) == 2 and sum(len(r["shares"]) for r in rows) == 5, str(rows))
    st, rows = call("GET", f"/expense_balances?list_id=eq.{fest}&select=user_id,paid_cents,share_cents,net_cents", pat)
    net = {r["user_id"]: r["net_cents"] for r in rows or []}
    check("Expenses: Pat reads the running balances: Olive is owed 66.66, Alex 25.00, Pat owes 43.33, Vic 48.33",
          net == {O: 6666, A: 2500, P: -4333, V: -4833}, str(rows))
    # Viewers and outsiders cannot write.
    st, _ = save(pat, p_list=fest, p_title="pwned", p_amount_cents=100, p_paid_by=P, p_people=[P])
    st2, _ = call("POST", "/expenses", pat, {"list_id": fest, "title": "pwned", "amount_cents": 100, "paid_by": P})
    check("Expenses: Pat cannot add an expense in #festival", refused(st) and refused(st2) and oq(f"select count(*) from weft.expenses where list_id = '{fest}'") == "2", f"{st} {st2}")
    st, rows = call("PATCH", f"/expenses?id=eq.{fe}", pat, {"title": "pwned"})
    st2, rows2 = call("PATCH", f"/expense_shares?expense_id=eq.{fe}&user_id=eq.{P}", pat, {"share_cents": 1})
    st3, rows3 = call("DELETE", f"/expenses?id=eq.{fe}", pat)
    st4, _ = call("POST", "/expense_shares", pat, {"expense_id": fe, "user_id": P, "share_cents": 5})
    check("Expenses: Pat cannot change, re-split or delete a #festival expense, nor add a share", rows == [] and rows2 == [] and rows3 == [] and refused(st4)
          and oq(f"select title from weft.expenses where id = '{fe}'") == "Van hire" and oq(f"select share_cents from weft.expense_shares where expense_id = '{fe}' and user_id = '{P}'") == "3333",
          f"{st} {st2} {st3} {st4}")
    st, rows = call("PATCH", f"/expenses?id=eq.{oe}", vic, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/expenses?list_id=eq.{org}", vic)
    st3, rows3 = save(vic, p_list=org, p_title="pwned", p_amount_cents=100, p_paid_by=V, p_people=[V], p_id=oe)
    check("Expenses: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and not (st3 == 200)
          and oq(f"select title from weft.expenses where id = '{oe}'") == "ORG-EXPENSE-SECRET dinner", f"{st} {st2} {st3} {rows3}")
    # The database keeps the sums right.
    st, rows = save(olive, p_list=fest, p_title="Bad", p_amount_cents=2500, p_paid_by=O, p_people=[O, V], p_split="amounts", p_amounts=[1000, 1000])
    check("Expenses: shares that do not add up to the amount are refused, with the database's answer", st == 400 and "add up" in json.dumps(rows), f"{st} {rows}")
    st, rows = call("POST", "/expenses", olive, {"list_id": fest, "title": "No shares", "amount_cents": 500, "paid_by": O})
    check("Expenses: an expense without a split is refused, nothing saved", st == 400 and "who shares" in json.dumps(rows)
          and oq(f"select count(*) from weft.expenses where list_id = '{fest}'") == "2", f"{st} {rows}")
    st, rows = call("PATCH", f"/expense_shares?expense_id=eq.{fe}&user_id=eq.{O}", olive, {"share_cents": 5000})
    st2, rows2 = call("PATCH", f"/expenses?id=eq.{fe}", olive, {"amount_cents": 12000})
    st3, rows3 = call("DELETE", f"/expense_shares?expense_id=eq.{fe}&user_id=eq.{P}", olive)
    check("Expenses: changing a share, the amount or dropping a person on their own is refused (the sums must still add up)",
          st == 400 and st2 == 400 and st3 == 400 and oq(f"select sum(share_cents) from weft.expense_shares where expense_id = '{fe}'") == "10000", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/expenses?id=eq.{fe2}", olive, {"split": "even"})
    check("Expenses: an uneven split cannot be marked even", st == 400 and "even split" in json.dumps(rows), f"{st} {rows}")
    for bad, why in (({"p_amount_cents": 0}, "a zero amount"), ({"p_amount_cents": -500}, "a negative amount"), ({"p_title": "   "}, "an empty title"),
                     ({"p_people": []}, "nobody in the split"), ({"p_people": [O, O]}, "the same person twice"),
                     ({"p_split": "amounts", "p_amounts": [600, -100]}, "a negative share")):
        args = {"p_list": fest, "p_title": "Bad", "p_amount_cents": 500, "p_paid_by": O, "p_people": [O, V], **bad}
        st, _ = save(olive, **args)
        check(f"Expenses: {why} is refused", st == 400, str(st))
    # Who paid and who shares must be in the space; Pat gets a refusal, not that answer.
    st, rows = save(olive, p_list=org, p_title="x", p_amount_cents=100, p_paid_by=P, p_people=[O])
    st2, rows2 = save(olive, p_list=org, p_title="x", p_amount_cents=100, p_paid_by=O, p_people=[O, V])
    check("Expenses: the payer and everyone in a split must be members of the list's space", st == 400 and "member" in json.dumps(rows)
          and st2 == 400 and "member" in json.dumps(rows2) and oq(f"select count(*) from weft.expenses where list_id = '{org}'") == "1", f"{st} {rows} {st2} {rows2}")
    st, rows = save(pat, p_list=org, p_title="x", p_amount_cents=100, p_paid_by=V, p_people=[V])
    check("Expenses: Pat gets a refusal there, not that answer", refused(st) and "member" not in json.dumps(rows), f"{st} {rows}")
    # Authorship and links are fixed.
    st, _ = call("POST", "/expenses", olive, {"list_id": fest, "title": "forged", "amount_cents": 100, "paid_by": O, "created_by": A})
    check("Expenses: authorship of an expense cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/expenses?id=eq.{fe}", olive, {"list_id": org})
    st2, _ = call("PATCH", f"/expense_shares?expense_id=eq.{fe}&user_id=eq.{P}", olive, {"user_id": A})
    st3, _ = call("PATCH", f"/expense_shares?expense_id=eq.{fe}&user_id=eq.{P}", olive, {"expense_id": oe})
    check("Expenses: an expense cannot jump lists, nor a share change person or expense", refused(st) and refused(st2) and refused(st3)
          and oq(f"select list_id from weft.expenses where id = '{fe}'") == fest, f"{st} {st2} {st3}")
    st, rows = save(olive, p_list=fest, p_title="x", p_amount_cents=100, p_paid_by=O, p_people=[O], p_id=oe)
    check("Expenses: save_expense cannot change an expense through another list", st == 403 and oq(f"select title from weft.expenses where id = '{oe}'") == "ORG-EXPENSE-SECRET dinner", f"{st} {rows}")
    st, _ = save(olive, p_list=uid("item", "porches"), p_title="on a table", p_amount_cents=100, p_paid_by=O, p_people=[O])
    check("Expenses: an expense cannot hang off an item that is not an expense list", refused(st), str(st))
    # Changing an expense through save_expense (positive control): Pat leaves the split.
    st, rows = save(olive, p_list=fest, p_title="Van hire (half day)", p_amount_cents=9000, p_paid_by=O, p_people=[O, V], p_id=fe)
    check("Expenses: Olive changes the amount and the split in one go (positive control)", st == 200
          and oq(f"select string_agg(user_id || ':' || share_cents, ',' order by share_cents) from weft.expense_shares where expense_id = '{fe}'") == f"{O}:4500,{V}:4500", f"{st} {rows}")
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Expenses: the #festival summary has the total, balances, who pays whom and the expenses, and Pat reads it",
          "2 expenses, total 115.00" in body and "Olive Organizer is owed 45.00" in body and "Vic Volunteer owes 60.00" in body and "To settle up:" in body
          and "Vic Volunteer pays Olive Organizer 45.00" in body and "Van hire (half day), 90.00, paid by Olive Organizer, split evenly" in body
          and "Ice, 25.00, paid by Alex (test admin), split by amounts: " in body, body)
    # Someone who leaves the space stays in the record; the expense can still be changed.
    st, _ = call("POST", "/members", alex, {"space_id": SID["organizers"], "user_id": V, "role": "viewer"})
    st2, oe2 = save(olive, p_list=org, p_title="Taxi", p_amount_cents=1000, p_paid_by=V, p_people=[O, V])
    st3, _ = call("DELETE", f"/members?space_id=eq.{SID['organizers']}&user_id=eq.{V}", alex)
    st4, _ = save(olive, p_list=org, p_title="Taxi to the venue", p_amount_cents=1200, p_paid_by=V, p_people=[O, V], p_id=oe2)
    check("Expenses: someone who left stays in the record, and the expense can still be changed", st == 201 and st2 == 200 and st3 in (200, 204) and st4 == 200
          and oq(f"select count(*) from weft.expense_shares where expense_id = '{oe2}'") == "2", f"{st} {st2} {st3} {st4}")
    st, rows = call("GET", f"/expenses?list_id=eq.{org}&select=id", vic)
    check("Expenses: and once they left, they no longer read it", rows == [], str(rows))
    # Scoped tokens and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/expenses?list_id=in.({org},{fest})&select=list_id", scoped)
    st2, rows2 = call("GET", f"/expense_balances?list_id=in.({org},{fest})&select=list_id", scoped)
    check("Expenses: a #festival-scoped token sees only #festival expenses and balances", rows and {r["list_id"] for r in rows} == {fest}
          and rows2 and {r["list_id"] for r in rows2} == {fest}, f"{rows} {rows2}")
    st, _ = save(scoped, p_list=org, p_title="x", p_amount_cents=100, p_paid_by=O, p_people=[O])
    st2, rows2 = call("DELETE", f"/expenses?id=eq.{oe}", scoped)
    check("Expenses: nor adds or deletes in Organizers", refused(st) and rows2 == [], f"{st} {rows2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/expense_shares?expense_id=eq.{oe}&select=share_cents", helper)
    check("Expenses: the assistant (for Olive) can read Organizers shares (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("DELETE", f"/expenses?id=eq.{oe}", helper)
    st2, _ = call("DELETE", f"/expense_shares?expense_id=eq.{oe}", helper)
    st3, _ = save(helper, p_list=org, p_title="x", p_amount_cents=100, p_paid_by=O, p_people=[O])
    st4, _ = call("PATCH", f"/expenses?id=eq.{oe}", helper, {"title": "x"})
    check("Expenses: the assistant cannot delete, add or change anything", refused(st) and refused(st2) and refused(st3) and refused(st4)
          and oq(f"select count(*) from weft.expenses where list_id = '{org}'") == "2", f"{st} {st2} {st3} {st4}")
    # Audit and search follow the space.
    st, rows = call("GET", f"/audit?row_id=eq.{fe}&select=op", vic)
    check("Expenses: #festival changes are in the audit log, readable by its members (positive control)", len(rows or []) >= 1, str(rows))
    st, rows = call("GET", f"/audit?row_id=eq.{oe2}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{oe2}&select=op", pat)
    check("Expenses: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-EXPENSE-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-EXPENSE-SECRET"})
    check("Expenses: search finds the list for Olive, not for Pat", any(r["id"] == org and r["kind"] == "expenselist" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Deletes and moves follow the list.
    st, _ = call("DELETE", f"/expenses?id=eq.{fe2}", olive)
    check("Expenses: Olive deletes an expense and its shares go with it (positive control)", st in (200, 204)
          and oq(f"select count(*) from weft.expense_shares where expense_id = '{fe2}'") == "0", str(st))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/expenses?list_id=eq.{org}&select=id,shares:expense_shares(user_id)", pat)
    check("Expenses: a list moved into #festival takes its expenses with it, readable to Pat", st == 200 and len(rows) == 2 and sum(len(r["shares"]) for r in rows) == 4, f"{st} {rows}")
    st, rows = call("PATCH", f"/expenses?list_id=eq.{org}", pat, {"title": "pwned"})
    check("Expenses: still read-only for Pat", rows == [], str(rows))
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    st2, rows = call("GET", f"/expenses?list_id=eq.{fest}&select=id", pat)
    st3, rows3 = call("GET", f"/expense_balances?list_id=eq.{fest}", pat)
    check("Expenses: a list moved to Organizers takes its expenses and balances out of Pat's sight", st == 200 and rows == [] and rows3 == [], f"{st} {rows} {rows3}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Expenses: Pat cannot delete an expense list", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Expenses: deleting a list deletes its expenses and shares", st in (200, 204)
          and oq(f"select count(*) from weft.expenses where list_id = '{org}'") == "0"
          and oq(f"select count(*) from weft.expense_shares where expense_id in ('{oe}', '{oe2}')") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def inventory():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    things = lambda inv: oq(f"select count(*) from weft.inventory_things where inventory_id = '{inv}'")
    holder = lambda t: oq(f"select coalesce(holder_id::text, '') from weft.inventory_things where id = '{t}'")
    moves = lambda t: oq(f"select coalesce(string_agg(action || ':' || holder_id || ':' || coalesce(by_id::text, ''), ',' order by at), '') from weft.inventory_moves where thing_id = '{t}'")
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "inventory", "title": "Org gear"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "inventory", "title": "Festival gear"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Inventory: Olive (editor) makes inventories in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "inventory", "title": "x"})
    check("Inventory: Pat (viewer) cannot make an inventory in #festival", refused(st), str(st))

    st, rows = call("POST", "/inventory_things", olive, {"inventory_id": org, "name": "  ORG-THING-SECRET projector ", "location": " Office cupboard ", "note": "with HDMI"})
    ot = rows[0]["id"] if st == 201 else None
    check("Inventory: Olive adds an Organizers thing (positive control), tidied, created_by set by the database",
          st == 201 and oq(f"select name || '|' || location || '|' || created_by from weft.inventory_things where id = '{ot}'") == f"ORG-THING-SECRET projector|Office cupboard|{O}", f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/inventory_things?inventory_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/inventory_moves?inventory_id=eq.{org}&select=id", tok)
        check(f"Inventory: {who} gets no Organizers things or record", rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", "/inventory_things?select=name&name=like.*ORG-THING*", pat)
    st2, rows2 = call("GET", f"/inventory_things?holder_id=is.null&select=id", pat)
    check("Inventory: nor finds them by filtering every thing", rows == [] and st2 == 200 and ot not in [r["id"] for r in rows2 or []], f"{rows}")

    st, rows = call("POST", "/inventory_things", olive, {"inventory_id": fest, "name": "Tent", "location": "Shed"})
    tent = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/inventory_things", alex, {"inventory_id": fest, "name": "Extension lead", "location": "Shed"})
    lead = rows[0]["id"] if st2 == 201 else None
    check("Inventory: Olive and Alex (owner) add things in #festival (positive control)", tent and lead, f"{st} {st2}")
    st, rows = call("GET", f"/inventory_things?inventory_id=eq.{fest}&select=id", pat)
    check("Inventory: Pat reads the #festival things (positive control)", st == 200 and len(rows) == 2, str(rows))
    # Viewers do not add, change or delete things.
    st, _ = call("POST", "/inventory_things", pat, {"inventory_id": fest, "name": "pwned"})
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{tent}", pat, {"name": "pwned"})
    st3, rows3 = call("PATCH", f"/inventory_things?id=eq.{tent}", pat, {"location": "Pat's car"})
    st4, rows4 = call("DELETE", f"/inventory_things?id=eq.{tent}", pat)
    check("Inventory: Pat cannot add, rename, re-place or delete a #festival thing", refused(st) and not (st2 == 200 and rows2) and not (st3 == 200 and rows3) and rows4 == []
          and things(fest) == "2" and oq(f"select name || '|' || location from weft.inventory_things where id = '{tent}'") == "Tent|Shed", f"{st} {st2} {rows2} {st3} {rows3} {st4}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", pat, {"holder_id": P, "note": "mine now"})
    check("Inventory: Pat cannot change a note while checking out", st in (401, 403) and holder(tent) == "", f"{st} {rows}")
    # Viewers check out to themselves and check in what they have.
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}&holder_id=is.null", pat, {"holder_id": P})
    check("Inventory: Pat (viewer) checks the tent out to herself (positive control), since set by the database", st == 200 and len(rows) == 1 and holder(tent) == P
          and rows[0]["held_since"] and moves(tent) == f"out:{P}:{P}", f"{st} {rows} {moves(tent)}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lead}", pat, {"holder_id": V})
    check("Inventory: Pat cannot check out to someone else", refused(st) and holder(lead) == "", f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", pat, {"holder_id": V})
    check("Inventory: nor hand what she has to someone else", refused(st) and holder(tent) == P, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}&holder_id=is.null", vic, {"holder_id": V})
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{tent}", vic, {"holder_id": None})
    check("Inventory: Vic (viewer) cannot take or check in a thing Pat has", rows == [] and rows2 == [] and holder(tent) == P, f"{st} {rows} {st2} {rows2}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", pat, {"holder_id": None})
    check("Inventory: Pat checks the tent back in (positive control)", st == 200 and len(rows) == 1 and holder(tent) == "" and rows[0]["held_since"] is None
          and moves(tent) == f"out:{P}:{P},in:{P}:{P}", f"{st} {rows} {moves(tent)}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{ot}", pat, {"holder_id": P})
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{ot}", vic, {"holder_id": V})
    check("Inventory: outsiders cannot check out an Organizers thing", rows == [] and rows2 == [] and holder(ot) == "", f"{st} {rows} {st2} {rows2}")
    # Editors check out to anyone in the space and in from anyone; the holder must be a member.
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lead}", olive, {"holder_id": V})
    check("Inventory: Olive checks the lead out to Vic (positive control); the record says Olive did it", st == 200 and holder(lead) == V and moves(lead) == f"out:{V}:{O}", f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lead}", olive, {"holder_id": P})
    check("Inventory: Olive hands it from Vic to Pat; the record has both", st == 200 and holder(lead) == P and moves(lead) == f"out:{V}:{O},in:{V}:{O},out:{P}:{O}", f"{st} {moves(lead)}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{ot}", olive, {"holder_id": P})
    check("Inventory: things can be checked out only to members of the space", st == 400 and "member" in json.dumps(rows) and holder(ot) == "", f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{ot}", pat, {"holder_id": V})
    check("Inventory: Pat gets a refusal there, not that answer", "member" not in json.dumps(rows) and holder(ot) == "", f"{st} {rows}")
    st, rows = call("POST", "/inventory_things", olive, {"inventory_id": fest, "name": "Radio", "holder_id": V})
    radio = rows[0]["id"] if st == 201 else None
    check("Inventory: a thing can be added already checked out, and that is in the record", radio and holder(radio) == V and moves(radio) == f"out:{V}:{O}", f"{st} {rows}")
    # Authorship, times and links are fixed; the record is never written by hand.
    st, _ = call("POST", "/inventory_things", olive, {"inventory_id": fest, "name": "forged", "created_by": A})
    st2, _ = call("POST", "/inventory_things", olive, {"inventory_id": fest, "name": "forged", "held_since": "2020-01-01T00:00:00Z"})
    st3, _ = call("PATCH", f"/inventory_things?id=eq.{lead}", olive, {"held_since": "2020-01-01T00:00:00Z"})
    check("Inventory: authorship and since-when cannot be forged", refused(st) and refused(st2) and refused(st3)
          and oq(f"select held_since > now() - interval '1 hour' from weft.inventory_things where id = '{lead}'") == "t", f"{st} {st2} {st3}")
    st, _ = call("POST", "/inventory_moves", olive, {"thing_id": tent, "inventory_id": fest, "action": "out", "holder_id": A})
    st2, _ = call("PATCH", f"/inventory_moves?thing_id=eq.{tent}", olive, {"holder_id": A})
    st3, rows3 = call("DELETE", f"/inventory_moves?thing_id=eq.{tent}", alex)
    check("Inventory: nobody writes, changes or deletes the record by hand, owners included", refused(st) and refused(st2) and refused(st3) and moves(tent) == f"out:{P}:{P},in:{P}:{P}", f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"inventory_id": org})
    check("Inventory: a thing cannot jump inventories", refused(st) and oq(f"select inventory_id from weft.inventory_things where id = '{tent}'") == fest, str(st))
    st, _ = call("POST", "/inventory_things", olive, {"inventory_id": uid("item", "porches"), "name": "on a table"})
    check("Inventory: a thing cannot hang off an item that is not an inventory", refused(st), str(st))
    for bad, why in (({"name": "   "}, "an empty name"), ({"name": "x" * 201}, "a name that is too long"), ({"name": "ok", "location": "x" * 201}, "a place that is too long")):
        st, _ = call("POST", "/inventory_things", olive, {"inventory_id": fest, **bad})
        check(f"Inventory: {why} is refused", st == 400, str(st))
    # The summary for search and the assistant.
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Inventory: the #festival summary has each thing, where it is kept and who has it, and Pat reads it",
          "Inventory, 3 things, 2 checked out" in body and "- Tent, kept in Shed, in its place" in body and "- Extension lead, kept in Shed, checked out to Pat Public since" in body
          and "- Radio, checked out to Vic Volunteer" in body, body)
    # Someone who leaves keeps what they have until it is checked in; an editor checks it in.
    st, _ = call("POST", "/members", alex, {"space_id": SID["organizers"], "user_id": V, "role": "viewer"})
    st2, _ = call("PATCH", f"/inventory_things?id=eq.{ot}&holder_id=is.null", vic, {"holder_id": V})
    st3, _ = call("DELETE", f"/members?space_id=eq.{SID['organizers']}&user_id=eq.{V}", alex)
    st4, rows4 = call("PATCH", f"/inventory_things?id=eq.{ot}", vic, {"holder_id": None})
    check("Inventory: someone who left keeps the thing in the record, and can no longer check it in themselves", st == 201 and st2 == 200 and st3 in (200, 204)
          and rows4 == [] and holder(ot) == V, f"{st} {st2} {st3} {st4} {rows4}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{ot}", olive, {"holder_id": None})
    check("Inventory: an editor checks it in from someone who left (positive control)", st == 200 and holder(ot) == "", f"{st} {rows}")
    # Scoped tokens and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/inventory_things?inventory_id=in.({org},{fest})&select=inventory_id", scoped)
    st2, rows2 = call("GET", f"/inventory_moves?inventory_id=in.({org},{fest})&select=inventory_id", scoped)
    check("Inventory: a #festival-scoped token sees only #festival things and record", rows and {r["inventory_id"] for r in rows} == {fest}
          and rows2 and {r["inventory_id"] for r in rows2} == {fest}, f"{rows} {rows2}")
    st, _ = call("POST", "/inventory_things", scoped, {"inventory_id": org, "name": "x"})
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{ot}", scoped, {"holder_id": O})
    st3, rows3 = call("DELETE", f"/inventory_things?id=eq.{ot}", scoped)
    check("Inventory: nor adds, checks out or deletes in Organizers", refused(st) and rows2 == [] and rows3 == [] and holder(ot) == "", f"{st} {rows2} {rows3}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/inventory_moves?thing_id=eq.{ot}&select=action", helper)
    check("Inventory: the assistant (for Olive) can read the Organizers record (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("DELETE", f"/inventory_things?id=eq.{ot}", helper)
    st2, _ = call("PATCH", f"/inventory_things?id=eq.{ot}", helper, {"holder_id": O})
    st3, _ = call("POST", "/inventory_things", helper, {"inventory_id": org, "name": "x"})
    check("Inventory: the assistant cannot delete, check out or add anything", refused(st) and refused(st2) and refused(st3) and things(org) == "1" and holder(ot) == "", f"{st} {st2} {st3}")
    # Audit and search follow the space.
    st, rows = call("GET", f"/audit?row_id=eq.{tent}&select=op", vic)
    check("Inventory: #festival check outs are in the audit log, readable by its members (positive control)", len(rows or []) >= 2, str(rows))
    st, rows = call("GET", f"/audit?row_id=eq.{ot}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ot}&select=op", pat)
    check("Inventory: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-THING-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-THING-SECRET"})
    check("Inventory: search finds the inventory for Olive, not for Pat", any(r["id"] == org and r["kind"] == "inventory" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Deletes and moves follow the inventory.
    st, _ = call("DELETE", f"/inventory_things?id=eq.{radio}", olive)
    check("Inventory: Olive deletes a thing and its record goes with it (positive control)", st in (200, 204)
          and oq(f"select count(*) from weft.inventory_moves where thing_id = '{radio}'") == "0", str(st))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/inventory_things?inventory_id=eq.{org}&select=id", pat)
    st3, rows3 = call("GET", f"/inventory_moves?inventory_id=eq.{org}&select=id", pat)
    check("Inventory: an inventory moved into #festival takes its things and record with it, readable to Pat", st == 200 and len(rows) == 1 and len(rows3) == 2, f"{st} {rows} {rows3}")
    st, rows = call("PATCH", f"/inventory_things?inventory_id=eq.{org}&holder_id=is.null", pat, {"holder_id": P})
    check("Inventory: and Pat may now check it out to herself", st == 200 and holder(ot) == P, f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    st2, rows = call("GET", f"/inventory_things?inventory_id=eq.{fest}&select=id", pat)
    st3, rows3 = call("GET", f"/inventory_things?holder_id=eq.{P}&select=id", pat)
    check("Inventory: an inventory moved to Organizers takes its things out of Pat's sight, even the lead she has", st == 200 and rows == [] and lead not in [r["id"] for r in rows3 or []], f"{st} {rows} {rows3}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lead}", pat, {"holder_id": None})
    check("Inventory: and she cannot check it in there", rows == [] and holder(lead) == P, f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Inventory: Pat cannot delete an inventory", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Inventory: deleting an inventory deletes its things and record", st in (200, 204) and things(org) == "0"
          and oq(f"select count(*) from weft.inventory_moves where inventory_id = '{org}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def due_back_dates():
    """055: a back-by date on a checked-out thing. Same space rules as Inventory; editors set it for anyone,
    a viewer only on what they have; checking in clears it; no dates in the past; the summary carries it."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org")
    oq = lambda sql: owner_sql(sql)
    due = lambda t: oq(f"select coalesce(due_back::text, '') from weft.inventory_things where id = '{t}'")
    holder = lambda t: oq(f"select coalesce(holder_id::text, '') from weft.inventory_things where id = '{t}'")
    d = lambda n: oq(f"select (current_date + {n})::text")
    D3, D7, D10, PAST, FAR = d(3), d(7), d(10), d(-5), d(6 * 366)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "inventory", "title": "DB org gear"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "inventory", "title": "DB festival gear"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Due back: Olive makes inventories in Organizers and #festival", org and fest, f"{st} {st2}")
    mk = lambda inv, name, **kw: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/inventory_things", olive, {"inventory_id": inv, "name": name, **kw}))
    ot = mk(org, "DB-SECRET drill", holder_id=O, due_back=D7)
    tent, lamp, saw = mk(fest, "DB tent"), mk(fest, "DB lamp"), mk(fest, "DB saw")
    check("Due back: Olive adds a thing already checked out with a date (positive control)", ot and due(ot) == D7 and holder(ot) == O, f"{ot} {due(ot) if ot else ''}")
    st, rows = call("POST", "/inventory_things", olive, {"inventory_id": fest, "name": "DB in-thing", "due_back": D7})
    inn = rows[0]["id"] if st == 201 else None
    check("Due back: a thing added in (nobody has it) gets no date, whatever is sent", inn and due(inn) == "", f"{st} {rows}")

    # Reading: members only.
    st, rows = call("GET", f"/inventory_things?inventory_id=eq.{org}&select=due_back", pat)
    st2, rows2 = call("GET", f"/inventory_things?due_back=not.is.null&select=id", pat)
    check("Due back: Pat sees no Organizers dates, not even by filtering on the date", rows == [] and ot not in [r["id"] for r in rows2 or []], f"{rows} {rows2}")
    st, rows = call("GET", f"/inventory_things?id=eq.{ot}&select=due_back", olive)
    check("Due back: Olive reads the Organizers date (positive control)", st == 200 and rows and rows[0]["due_back"] == D7, f"{st} {rows}")

    # Editors: check out with a date, change it, clear it.
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}&holder_id=is.null", olive, {"holder_id": V, "due_back": D7})
    check("Due back: Olive checks the tent out to Vic, back in a week (positive control)", st == 200 and rows and rows[0]["due_back"] == D7 and holder(tent) == V, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"due_back": D10})
    check("Due back: Olive moves Vic's date (positive control)", st == 200 and due(tent) == D10, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"due_back": None})
    check("Due back: Olive clears it (positive control)", st == 200 and due(tent) == "", f"{st} {rows}")
    call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"due_back": D3})

    # Viewers: only on what they have.
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", vic, {"due_back": D10})
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{tent}", pat, {"due_back": D10})
    check("Due back: Vic (viewer, has the tent) sets his own date (positive control)", st == 200 and rows, f"{st} {rows}")
    check("Due back: Pat (viewer) cannot change the date of a thing Vic has", rows2 == [] and due(tent) == D10, f"{st2} {rows2} {due(tent)}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lamp}", pat, {"due_back": D3})
    check("Due back: Pat cannot put a date on a thing that is in", (st == 200 or refused(st)) and due(lamp) == "", f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lamp}&holder_id=is.null", pat, {"holder_id": P, "due_back": D3})
    check("Due back: Pat checks the lamp out to herself with a date (positive control)", st == 200 and holder(lamp) == P and due(lamp) == D3, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lamp}", pat, {"due_back": D7})
    check("Due back: and moves her own date (positive control)", st == 200 and due(lamp) == D7, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lamp}", pat, {"due_back": D10, "note": "keeping it"})
    check("Due back: but cannot change a note along with it", refused(st) and due(lamp) == D7, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{saw}", pat, {"holder_id": V, "due_back": D3})
    check("Due back: nor check out to someone else with a date", refused(st) and holder(saw) == "" and due(saw) == "", f"{st} {rows}")

    # The dates themselves.
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lamp}", pat, {"due_back": PAST})
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"due_back": PAST})
    check("Due back: a date in the past is refused, for viewers and editors", st == 400 and st2 == 400 and "past" in json.dumps(rows2) and due(lamp) == D7 and due(tent) == D10, f"{st} {st2} {rows2}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"due_back": FAR})
    check("Due back: a date more than five years ahead is refused", st == 400 and due(tent) == D10, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"due_back": "not a date"})
    check("Due back: something that is not a date is refused", st == 400 and due(tent) == D10, f"{st} {rows}")
    # Nobody may set a past date, so make one overdue as the owner with triggers off, then refresh its summary.
    oq(f"begin; set local session_replication_role = replica; update weft.inventory_things set due_back = current_date - 3 where id = '{tent}'; commit;")
    oq(f"select weft_private.refresh_inventory_text('{fest}')")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"note": "two poles"})
    check("Due back: an overdue thing can still be edited (its old date stays)", st == 200 and due(tent) == d(-3), f"{st} {rows}")
    st, rows = call("GET", f"/inventory_things?inventory_id=eq.{fest}&due_back=lt.{d(0)}&holder_id=not.is.null&select=name", pat)
    check("Due back: Pat can find what is overdue in #festival (positive control)", st == 200 and [r["name"] for r in rows] == ["DB tent"], f"{st} {rows}")

    # Text summary for search and the assistant.
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Due back: the #festival summary says when things are due back", f"- DB lamp, checked out to Pat Public since {d(0)}, back by {D7}" in body and "back by " + d(-3) in body, body)
    st, rows = call("POST", "/rpc/search", pat, {"p_q": "DB-SECRET"})
    check("Due back: Pat does not find the Organizers summary in search", rows == [], f"{rows}")

    # Checking in clears the date.
    st, rows = call("PATCH", f"/inventory_things?id=eq.{lamp}", pat, {"holder_id": None})
    check("Due back: Pat checks the lamp in and its date is cleared (positive control)", st == 200 and holder(lamp) == "" and due(lamp) == "", f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{tent}", olive, {"holder_id": None, "due_back": D3})
    check("Due back: checking in clears the date even if one is sent", st == 200 and due(tent) == "", f"{st} {rows}")

    # Authorship and times still cannot be forged; the assistant and scoped tokens.
    st, _ = call("PATCH", f"/inventory_things?id=eq.{ot}", olive, {"due_back": D10, "held_since": "2020-01-01T00:00:00Z"})
    check("Due back: held_since still cannot be set along with a date", refused(st) and due(ot) == D7, str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/inventory_things?id=eq.{ot}&select=due_back", helper)
    st2, _ = call("PATCH", f"/inventory_things?id=eq.{ot}", helper, {"due_back": D10})
    st3, _ = call("DELETE", f"/inventory_things?id=eq.{ot}", helper)
    check("Due back: the assistant reads the date (positive control) but cannot change it or delete", st == 200 and rows and rows[0]["due_back"] == D7
          and refused(st2) and refused(st3) and due(ot) == D7, f"{st} {st2} {st3}")
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/inventory_things?inventory_id=in.({org},{fest})&due_back=not.is.null&select=inventory_id", scoped)
    st2, rows2 = call("PATCH", f"/inventory_things?id=eq.{ot}", scoped, {"due_back": D10})
    check("Due back: a #festival-scoped token sees no Organizers date and cannot change one", st == 200 and org not in {r["inventory_id"] for r in rows or []}
          and rows2 == [] and due(ot) == D7, f"{rows} {rows2}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{saw}&holder_id=is.null", scoped, {"holder_id": O, "due_back": D3})
    check("Due back: and checks out in #festival with a date (positive control)", st == 200 and due(saw) == D3, f"{st} {rows}")

    # Audit and moves follow the space.
    st, _ = call("PATCH", f"/inventory_things?id=eq.{ot}", olive, {"due_back": D10})
    st2, _ = call("PATCH", f"/inventory_things?id=eq.{ot}", olive, {"due_back": D7})
    check("Due back: Olive moves her own Organizers date and back (positive control)", st == 200 and st2 == 200 and due(ot) == D7, f"{st} {st2}")
    st, rows = call("GET", f"/audit?row_id=eq.{ot}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ot}&select=op", pat)
    check("Due back: date changes in Organizers are audited for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/inventory_things?id=eq.{ot}&select=due_back", pat)
    check("Due back: an inventory moved into #festival brings its dates into Pat's sight", st == 200 and rows and rows[0]["due_back"] == D7, f"{st} {rows}")
    st, rows = call("PATCH", f"/inventory_things?id=eq.{ot}", pat, {"due_back": D10})
    check("Due back: and Pat still cannot change a date on what Olive has", rows == [] and due(ot) == D7, f"{st} {rows}")
    for i in (org, fest):
        call("DELETE", f"/items?id=eq.{i}", olive)
    check("Due back: tidied up", oq("select count(*) from weft.items where title in ('DB org gear', 'DB festival gear')") == "0")


def goals():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    O, A, P = uid("user", "u-org"), uid("user", "u-alex"), uid("user", "u-pub")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "goalset", "title": "Org goals"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "goalset", "title": "Festival goals"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Goals: Olive (editor) makes goal sets in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "goalset", "title": "x"})
    check("Goals: Pat (viewer) cannot make a goal set in #festival", refused(st), str(st))
    # Goals and key results: Olive adds them (positive controls), the database fills in authorship and stamps.
    st, rows = call("POST", "/goals", olive, {"set_id": org, "title": "  Raise ORG-GOAL-SECRET sponsorship ", "note": " Board wants it \n", "due_on": "2027-03-31"})
    og = rows[0]["id"] if st == 201 else None
    check("Goals: Olive adds a goal in Organizers (positive control), created_by set by the database, text trimmed",
          og and rows[0]["created_by"] == O and rows[0]["title"] == "Raise ORG-GOAL-SECRET sponsorship" and rows[0]["note"] == "Board wants it", f"{st} {rows}")
    st, rows = call("POST", "/key_results", olive, {"goal_id": og, "title": " Sponsors signed ", "start_value": 0, "target_value": 8, "current_value": 2, "unit": " deals "})
    okr = rows[0]["id"] if st == 201 else None
    check("Goals: Olive adds a key result; progress worked out by the database (2 of 8 = 0.25), value stamped by her",
          okr and float(rows[0]["progress"]) == 0.25 and rows[0]["value_updated_by"] == O and rows[0]["created_by"] == O
          and rows[0]["title"] == "Sponsors signed" and rows[0]["unit"] == "deals", f"{st} {rows}")
    st, rows = call("POST", "/goals", olive, {"set_id": fest, "title": "Sell out the festival"})
    fg = rows[0]["id"] if st == 201 else None
    st2, rows2 = call("POST", "/key_results", olive, {"goal_id": fg, "title": "Tickets sold", "target_value": 400, "current_value": 120, "unit": "tickets"})
    fk = rows2[0]["id"] if st2 == 201 else None
    st3, rows3 = call("POST", "/key_results", olive, {"goal_id": fg, "title": "Waste", "start_value": 500, "target_value": 300, "current_value": 450, "unit": "kg"})
    fk2 = rows3[0]["id"] if st3 == 201 else None
    check("Goals: a target lower than the start counts down (500 to 300, now 450 = 0.25)", fk2 and float(rows3[0]["progress"]) == 0.25, f"{st3} {rows3}")
    check("Goals: a goal needs only a title; a key result only a title and a target (positive control)", fg and fk and float(rows2[0]["progress"]) == 0.3, f"{st} {st2} {rows2}")
    # Outsiders see nothing, not by id and not by filtering.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/goals?set_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/key_results?goal_id=eq.{og}&select=id", tok)
        check(f"Goals: {who} gets no Organizers goals or key results", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", "/goals?select=title&title=like.*ORG-GOAL*", pat)
    st2, rows2 = call("GET", "/key_results?select=id&unit=eq.deals", vic)
    check("Goals: nor finds them by filtering every goal and key result", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Goals: Pat cannot read the Organizers goal set summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Goals: Olive can, and it carries the goal, its progress, due date and each key result",
          "Raise ORG-GOAL-SECRET sponsorship (25% done), due 2027-03-31" in body and "- Sponsors signed: 2 of 8 deals (from 0), 25%" in body and "Board wants it" in body, body)
    st, rows = call("GET", f"/goals?set_id=eq.{fest}&select=id,krs:key_results(id,progress)", pat)
    check("Goals: Pat reads the #festival goals and key results with progress (positive control)", st == 200 and len(rows) == 1 and len(rows[0]["krs"]) == 2, str(rows))
    # Viewers read only.
    st, _ = call("POST", "/goals", pat, {"set_id": fest, "title": "pwned"})
    st2, _ = call("POST", "/key_results", pat, {"goal_id": fg, "title": "pwned", "target_value": 1})
    check("Goals: Pat (viewer) cannot add a goal or key result in #festival", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", pat, {"current_value": 400})
    st2, rows2 = call("PATCH", f"/goals?id=eq.{fg}", pat, {"title": "pwned"})
    st3, rows3 = call("DELETE", f"/key_results?id=eq.{fk}", pat)
    st4, rows4 = call("DELETE", f"/goals?id=eq.{fg}", pat)
    check("Goals: Pat cannot update progress, change or delete in #festival", rows == [] and rows2 == [] and rows3 == [] and rows4 == []
          and oq(f"select current_value::int from weft.key_results where id = '{fk}'") == "120" and oq(f"select count(*) from weft.goals where id = '{fg}'") == "1", f"{st} {st2} {st3} {st4}")
    st, rows = call("PATCH", f"/key_results?id=eq.{okr}", vic, {"current_value": 8})
    st2, rows2 = call("DELETE", f"/goals?set_id=eq.{org}", vic)
    check("Goals: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == []
          and oq(f"select current_value::int from weft.key_results where id = '{okr}'") == "2" and oq(f"select count(*) from weft.goals where set_id = '{org}'") == "1", f"{st} {st2}")
    # Updating by hand: Alex (owner) updates; the stamp moves to him, only when the value changes.
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", alex, {"current_value": 200})
    check("Goals: Alex (owner) updates a key result's value (positive control); progress and stamp follow",
          st == 200 and rows and float(rows[0]["progress"]) == 0.5 and rows[0]["value_updated_by"] == A, f"{st} {rows}")
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"title": "Tickets sold online"})
    check("Goals: renaming a key result keeps who last updated its value", st == 200 and rows and rows[0]["value_updated_by"] == A, f"{st} {rows}")
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"current_value": 999})
    check("Goals: progress never goes over 100%", st == 200 and rows and float(rows[0]["progress"]) == 1, f"{st} {rows}")
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"current_value": -5})
    check("Goals: nor under 0%", st == 200 and rows and float(rows[0]["progress"]) == 0, f"{st} {rows}")
    call("PATCH", f"/key_results?id=eq.{fk}", olive, {"current_value": 200})
    st, rows = call("PATCH", f"/goals?id=eq.{fg}", olive, {"note": "Last year 310", "due_on": "2027-06-01"})
    check("Goals: Olive changes a goal (positive control)", st == 200 and rows and rows[0]["due_on"] == "2027-06-01", f"{st} {rows}")
    # Values the database refuses.
    for bad, why in (({"title": "t", "target_value": 0}, "a target equal to the start"), ({"title": "   ", "target_value": 1}, "an empty title"),
                     ({"title": "x" * 201, "target_value": 1}, "a title over 200"), ({"title": "t", "target_value": 1e13}, "a number too large"),
                     ({"title": "t", "target_value": 1, "unit": "x" * 21}, "a unit over 20"), ({"title": "t"}, "no target")):
        st, _ = call("POST", "/key_results", olive, {"goal_id": fg, **bad})
        check(f"Goals: {why} is refused", st == 400, str(st))
    for bad, why in (({"title": "   "}, "a goal with an empty title"), ({"title": "t", "note": "x" * 2001}, "a note over 2000"), ({"title": "t", "due_on": "not a date"}, "a due date that is not one")):
        st, _ = call("POST", "/goals", olive, {"set_id": fest, **bad})
        check(f"Goals: {why} is refused", st == 400, str(st))
    # Authorship, stamps and progress cannot be forged; nothing jumps between sets or goals.
    st, _ = call("POST", "/goals", olive, {"set_id": fest, "title": "forged", "created_by": A})
    st2, _ = call("POST", "/key_results", olive, {"goal_id": fg, "title": "forged", "target_value": 1, "created_by": A})
    check("Goals: authorship of a goal or key result cannot be forged", refused(st) and refused(st2), f"{st} {st2}")
    st, _ = call("PATCH", f"/goals?id=eq.{fg}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"value_updated_by": P})
    st3, _ = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"value_updated_at": "2020-01-01T00:00:00Z"})
    st4, _ = call("POST", "/key_results", olive, {"goal_id": fg, "title": "forged", "target_value": 1, "value_updated_by": P})
    check("Goals: nor who last updated a value, or when", refused(st) and refused(st2) and refused(st3) and refused(st4)
          and oq(f"select value_updated_by from weft.key_results where id = '{fk}'") == O, f"{st} {st2} {st3} {st4}")
    st, _ = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"progress": 1})
    check("Goals: progress cannot be written, only worked out", st >= 400 and float(oq(f"select progress from weft.key_results where id = '{fk}'")) == 0.5, str(st))
    st, _ = call("PATCH", f"/goals?id=eq.{fg}", olive, {"set_id": org})
    st2, _ = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"goal_id": og})
    check("Goals: a goal cannot move to another set, nor a key result to another goal", refused(st) and refused(st2)
          and oq(f"select set_id from weft.goals where id = '{fg}'") == fest and oq(f"select goal_id from weft.key_results where id = '{fk}'") == fg, f"{st} {st2}")
    st, _ = call("POST", "/goals", olive, {"set_id": uid("item", "porches"), "title": "on a table"})
    check("Goals: a goal cannot hang off an item that is not a goal set", refused(st), str(st))
    st, _ = call("POST", "/goals", pat, {"set_id": org, "title": "x"})
    st2, _ = call("POST", "/key_results", pat, {"goal_id": og, "title": "x", "target_value": 1})
    check("Goals: Pat cannot add to an Organizers set or goal", refused(st) and refused(st2), f"{st} {st2}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/goals?set_id=in.({org},{fest})&select=set_id", scoped)
    st2, rows2 = call("GET", f"/key_results?goal_id=in.({og},{fg})&select=goal_id", scoped)
    check("Goals: a #festival-scoped token sees only #festival goals and key results", st == 200 and rows and {r["set_id"] for r in rows} == {fest}
          and rows2 and {r["goal_id"] for r in rows2} == {fg}, f"{rows} {rows2}")
    st, _ = call("POST", "/goals", scoped, {"set_id": org, "title": "scoped"})
    st2, rows2 = call("PATCH", f"/key_results?id=eq.{okr}", scoped, {"current_value": 7})
    check("Goals: nor writes in Organizers", refused(st) and rows2 == [] and oq(f"select current_value::int from weft.key_results where id = '{okr}'") == "2", f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/key_results?goal_id=eq.{og}&select=id", helper)
    check("Goals: the assistant (for Olive) can read Organizers key results (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/goals?id=eq.{og}", helper)
    st2, _ = call("DELETE", f"/key_results?id=eq.{okr}", helper)
    st3, _ = call("PATCH", f"/key_results?id=eq.{okr}", helper, {"current_value": 8})
    st4, _ = call("POST", "/goals", helper, {"set_id": org, "title": "by the assistant"})
    check("Goals: the assistant cannot delete, update or add goals or key results", refused(st) and refused(st2) and refused(st3) and refused(st4)
          and oq(f"select count(*) || '|' || min(current_value::int) from weft.key_results where goal_id = '{og}'") == "1|2", f"{st} {st2} {st3} {st4}")
    # Audit under the set's space.
    st, rows = call("GET", f"/audit?row_id=eq.{fk}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{fk}&select=op", pat)
    check("Goals: #festival key result updates are in the audit log, readable by its members, Pat included (positive control)", len(rows or []) >= 1 and len(rows2 or []) >= 1, f"{rows} {rows2}")
    call("PATCH", f"/key_results?id=eq.{okr}", olive, {"current_value": 3})
    st, rows = call("GET", f"/audit?row_id=eq.{okr}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{okr}&select=op", pat)
    check("Goals: an Organizers update is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Search.
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-GOAL-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-GOAL-SECRET"})
    check("Goals: search finds the set for Olive, not for Pat", any(r["id"] == org and r["kind"] == "goalset" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Deleting a goal deletes its key results and updates the summary.
    st, rows = call("POST", "/goals", olive, {"set_id": fest, "title": "Short-lived goal"})
    tmp = rows[0]["id"] if st == 201 else None
    call("POST", "/key_results", olive, {"goal_id": tmp, "title": "Short-lived result", "target_value": 3})
    st, _ = call("DELETE", f"/goals?id=eq.{tmp}", olive)
    check("Goals: deleting a goal deletes its key results and drops it from the summary", st in (200, 204)
          and oq(f"select count(*) from weft.key_results where goal_id = '{tmp}'") == "0"
          and "Short-lived" not in (oq(f"select body_text from weft.items where id = '{fest}'") or ""), str(st))
    st, _ = call("DELETE", f"/key_results?id=eq.{fk2}", olive)
    check("Goals: Olive deletes a key result (positive control)", st in (200, 204) and oq(f"select count(*) from weft.key_results where id = '{fk2}'") == "0", str(st))
    # Moves follow the space: the set moves and everything in it goes with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/goals?set_id=eq.{fest}&select=id", pat)
    st3, rows3 = call("GET", f"/key_results?goal_id=eq.{fg}&select=id", pat)
    check("Goals: a set moved to Volunteers takes its goals and key results out of Pat's sight", st == 200 and rows == [] and rows3 == [], f"{st} {rows} {rows3}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/key_results?goal_id=eq.{og}&select=id", pat)
    check("Goals: a set moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 1
          and call("PATCH", f"/key_results?id=eq.{okr}", pat, {"current_value": 8})[1] == [], f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Goals: Pat cannot delete the goal set", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Goals: deleting a goal set deletes its goals and key results", st in (200, 204)
          and oq(f"select count(*) from weft.goals where set_id = '{org}'") == "0" and oq(f"select count(*) from weft.key_results where id = '{okr}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


# ---------------------------------------------------------------- glossary (043)
def glossary():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "glossary", "title": "Org glossary"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "glossary", "title": "Festival glossary"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Glossary: Olive (editor) makes glossaries in Organizers and #festival", org and fest, f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "glossary", "title": "x"})
    check("Glossary: Pat (viewer) cannot make a glossary in #festival", refused(st), str(st))
    st, rows = call("POST", "/glossary_terms", olive, {"glossary_id": org, "term": "  BUDGET   CAP  ", "definition": "  ORG-GLOSSARY-SECRET: the most we spend on the headliner.  "})
    ot = rows[0]["id"] if st == 201 else None
    check("Glossary: Olive adds a term in Organizers (positive control), created_by set by the database", ot and rows[0]["created_by"] == O, f"{st} {rows}")
    check("Glossary: the term is trimmed with its spaces squeezed, the meaning trimmed", ot and rows[0]["term"] == "BUDGET CAP"
          and rows[0]["definition"] == "ORG-GLOSSARY-SECRET: the most we spend on the headliner.", str(rows))
    st, rows = call("POST", "/glossary_terms", olive, {"glossary_id": fest, "term": "FOH", "definition": "Front of house: everything the audience sees."})
    ft = rows[0]["id"] if st == 201 else None
    check("Glossary: Olive adds a term in #festival (positive control)", ft is not None, f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/glossary_terms?glossary_id=eq.{org}&select=id", tok)
        check(f"Glossary: {who} gets no Organizers terms", st == 200 and rows == [], str(rows))
    st, rows = call("GET", "/glossary_terms?select=term&definition=like.*ORG-GLOSSARY*", pat)
    st2, rows2 = call("GET", "/glossary_terms?select=term&term=ilike.budget*", vic)
    check("Glossary: nor finds them by filtering every term by meaning or term", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Glossary: Pat cannot read the Organizers glossary summary", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Glossary: Olive can, and it reads 'Term: meaning'", "BUDGET CAP: ORG-GLOSSARY-SECRET: the most we spend" in body, body)
    st, rows = call("GET", f"/glossary_terms?glossary_id=eq.{fest}&select=id,term,definition", pat)
    check("Glossary: Pat reads the #festival terms (positive control)", st == 200 and len(rows) == 1 and rows[0]["term"] == "FOH", str(rows))
    st, _ = call("POST", "/glossary_terms", pat, {"glossary_id": fest, "term": "pwned", "definition": "x"})
    st2, _ = call("POST", "/glossary_terms", vic, {"glossary_id": fest, "term": "pwned", "definition": "x"})
    check("Glossary: viewers (Pat, Vic) cannot add a term in #festival", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/glossary_terms?id=eq.{ft}", pat, {"definition": "pwned"})
    st2, rows2 = call("DELETE", f"/glossary_terms?id=eq.{ft}", pat)
    check("Glossary: Pat cannot change or delete a #festival term", rows == [] and rows2 == []
          and oq(f"select definition from weft.glossary_terms where id = '{ft}'") == "Front of house: everything the audience sees.", f"{st} {st2}")
    st, rows = call("PATCH", f"/glossary_terms?id=eq.{ot}", vic, {"term": "pwned"})
    st2, rows2 = call("DELETE", f"/glossary_terms?glossary_id=eq.{org}", vic)
    check("Glossary: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == [] and oq(f"select count(*) from weft.glossary_terms where glossary_id = '{org}'") == "1", f"{st} {st2}")
    st, rows = call("PATCH", f"/glossary_terms?id=eq.{ft}", olive, {"definition": "Front of house: the gate, the bar and the info booth."})
    check("Glossary: Olive changes a term (positive control)", st == 200 and rows and rows[0]["definition"].endswith("info booth."), f"{st} {rows}")
    # One term once per glossary, whatever its case; the same term is fine in another glossary.
    st, rows = call("POST", "/glossary_terms", olive, {"glossary_id": fest, "term": "foh", "definition": "again"})
    check("Glossary: a term already in the glossary (any case) is refused with a plain reason", st == 409 and "already in this glossary" in str(rows), f"{st} {rows}")
    st, rows = call("POST", "/glossary_terms", olive, {"glossary_id": fest, "term": "Gate B", "definition": "The volunteer entrance."})
    gb = rows[0]["id"] if st == 201 else None
    st2, rows2 = call("PATCH", f"/glossary_terms?id=eq.{gb}", olive, {"term": "Foh"})
    check("Glossary: nor can another term be renamed to it", gb and st2 == 409 and oq(f"select term from weft.glossary_terms where id = '{gb}'") == "Gate B", f"{st} {st2}")
    st, rows = call("PATCH", f"/glossary_terms?id=eq.{ft}", olive, {"term": "FoH"})
    check("Glossary: a term can change its own case (positive control)", st == 200 and rows and rows[0]["term"] == "FoH", f"{st} {rows}")
    call("PATCH", f"/glossary_terms?id=eq.{ft}", olive, {"term": "FOH"})
    st, rows = call("POST", "/glossary_terms", olive, {"glossary_id": org, "term": "FOH", "definition": "Organizers' own meaning"})
    check("Glossary: the same term in another glossary is fine (positive control)", st == 201, f"{st} {rows}")
    st, rows = call("POST", "/glossary_terms", pat, {"glossary_id": org, "term": "budget cap", "definition": "x"})
    st2, rows2 = call("POST", "/glossary_terms", pat, {"glossary_id": org, "term": "not there", "definition": "x"})
    check("Glossary: an outsider gets the same refusal whether a term exists in a glossary they cannot read",
          refused(st) and st == st2 and "already" not in str(rows), f"{st} {rows} / {st2} {rows2}")
    for bad, why in (({"term": "   ", "definition": "x"}, "an empty term"), ({"term": "x", "definition": "  "}, "an empty meaning"),
                     ({"term": "x" * 81, "definition": "x"}, "a term over 80"),
                     ({"term": "long", "definition": "x" * 2001}, "a meaning over 2000")):
        st, _ = call("POST", "/glossary_terms", olive, {"glossary_id": fest, **bad})
        check(f"Glossary: {why} is refused", st == 400, str(st))
    st, rows = call("POST", "/glossary_terms", olive, {"glossary_id": fest, "term": "two\n  lines", "definition": "x"})
    check("Glossary: a term typed over two lines is kept on one line", st == 201 and rows[0]["term"] == "two lines", f"{st} {rows}")
    if st == 201: call("DELETE", f"/glossary_terms?id=eq.{rows[0]['id']}", olive)
    st, _ = call("POST", "/glossary_terms", olive, {"glossary_id": fest, "term": "forged", "definition": "x", "created_by": A})
    check("Glossary: authorship of a term cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/glossary_terms?id=eq.{ft}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/glossary_terms?id=eq.{ft}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Glossary: nor changed afterwards, nor the time it was added", refused(st) and refused(st2) and oq(f"select created_by from weft.glossary_terms where id = '{ft}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/glossary_terms?id=eq.{gb}", olive, {"glossary_id": org})
    check("Glossary: a term cannot be moved into another glossary", refused(st) and oq(f"select glossary_id from weft.glossary_terms where id = '{gb}'") == fest, str(st))
    st, _ = call("POST", "/glossary_terms", olive, {"glossary_id": uid("item", "porches"), "term": "on a table", "definition": "x"})
    check("Glossary: a term cannot hang off an item that is not a glossary", refused(st), str(st))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/glossary_terms?glossary_id=in.({org},{fest})&select=glossary_id", scoped)
    check("Glossary: a #festival-scoped token sees only #festival terms", st == 200 and rows and {r["glossary_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("POST", "/glossary_terms", scoped, {"glossary_id": org, "term": "scoped", "definition": "x"})
    check("Glossary: nor writes in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/glossary_terms?glossary_id=eq.{org}&select=id", helper)
    st2, rows2 = call("GET", f"/items?id=eq.{org}&select=body_text", helper)
    check("Glossary: the assistant (for Olive) reads Organizers terms and the summary (positive control)", st == 200 and len(rows) == 2
          and "ORG-GLOSSARY-SECRET" in ((rows2[0]["body_text"] if rows2 else "") or ""), f"{rows} {rows2}")
    helper_pat = mint("u-pub", assistant=True)
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", helper_pat)
    st2, rows2 = call("GET", f"/glossary_terms?glossary_id=eq.{org}&select=id", helper_pat)
    check("Glossary: the assistant for Pat reads neither", rows == [] and rows2 == [], f"{rows} {rows2}")
    st, _ = call("DELETE", f"/glossary_terms?id=eq.{ot}", helper)
    st2, _ = call("PATCH", f"/glossary_terms?id=eq.{ot}", helper, {"definition": "by the assistant"})
    st3, _ = call("POST", "/glossary_terms", helper, {"glossary_id": org, "term": "by the assistant", "definition": "x"})
    check("Glossary: the assistant cannot delete, change or add terms", refused(st) and refused(st2) and refused(st3)
          and oq(f"select count(*) from weft.glossary_terms where glossary_id = '{org}'") == "2", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/audit?row_id=eq.{ft}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ft}&select=op", vic)
    check("Glossary: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1 and len(rows2 or []) >= 1, f"{rows} {rows2}")
    call("PATCH", f"/glossary_terms?id=eq.{ot}", olive, {"definition": "ORG-GLOSSARY-SECRET: the most we spend on all acts."})
    st, rows = call("GET", f"/audit?row_id=eq.{ot}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ot}&select=op", pat)
    check("Glossary: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-GLOSSARY-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-GLOSSARY-SECRET"})
    check("Glossary: search finds the glossary for Olive, not for Pat", any(r["id"] == org and r["kind"] == "glossary" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    st, _ = call("DELETE", f"/glossary_terms?id=eq.{gb}", olive)
    st2, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    check("Glossary: a deleted term leaves the summary (positive control: Olive deletes)", st in (200, 204) and rows and "Gate B" not in (rows[0]["body_text"] or "")
          and "FOH: Front of house" in (rows[0]["body_text"] or ""), f"{st} {rows}")
    # Moves follow the space: the glossary moves and its terms go with it.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/glossary_terms?glossary_id=eq.{fest}&select=id", pat)
    check("Glossary: a glossary moved to Volunteers takes its terms out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/glossary_terms?glossary_id=eq.{org}&select=id", pat)
    check("Glossary: a glossary moved into #festival becomes readable to Pat, still read-only", st == 200 and len(rows) == 2
          and refused(call("POST", "/glossary_terms", pat, {"glossary_id": org, "term": "x", "definition": "x"})[0]), f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Glossary: Pat cannot delete the glossary", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Glossary: deleting a glossary deletes its terms", st in (200, 204) and oq(f"select count(*) from weft.glossary_terms where glossary_id = '{org}'") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


def announcements():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    P, O, A = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    soon = oq("select to_char(now() + interval '3 days', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    later = oq("select to_char(now() + interval '10 days', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    past = oq("select to_char(now() - interval '1 hour', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    too_far = oq("select to_char(now() + interval '400 days', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    st, rows = call("POST", "/announcements", olive, {"space_id": SID["organizers"], "title": "  ORG-NOTICE-SECRET budget freeze ", "body": "No new spending", "expires_at": soon})
    org = rows[0]["id"] if st == 201 else None
    check("Announcements: Olive (editor) posts in Organizers (positive control), created_by set by the database, title trimmed",
          org and rows[0]["created_by"] == O and rows[0]["title"] == "ORG-NOTICE-SECRET budget freeze", f"{st} {rows}")
    st, rows = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "Gates open at 10", "expires_at": soon})
    fest = rows[0]["id"] if st == 201 else None
    check("Announcements: Olive posts in #festival", fest is not None, f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/announcements?space_id=eq.{SID['organizers']}&select=id", tok)
        st2, rows2 = call("GET", "/announcements?title=like.*ORG-NOTICE*&select=id", tok)
        check(f"Announcements: {who} gets no Organizers notices, by space or by title", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/announcements?id=eq.{fest}&select=id,title", pat)
    check("Announcements: Pat (viewer) reads the #festival notice (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("POST", "/announcements", pat, {"space_id": SID["festival"], "title": "pwned", "expires_at": soon})
    check("Announcements: Pat (viewer) cannot post in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/announcements?id=eq.{fest}", pat, {"title": "pwned"})
    st2, rows2 = call("PATCH", f"/announcements?id=eq.{fest}", pat, {"expires_at": past})
    st3, rows3 = call("DELETE", f"/announcements?id=eq.{fest}", pat)
    check("Announcements: Pat cannot change, end or delete the #festival notice", rows == [] and rows2 == [] and rows3 == []
          and oq(f"select title || (expires_at > now())::text from weft.announcements where id = '{fest}'") == "Gates open at 10true", f"{st} {st2} {st3}")
    st, _ = call("POST", "/announcements", pat, {"space_id": SID["organizers"], "title": "pwned", "expires_at": soon})
    st2, _ = call("POST", "/announcements", vic, {"space_id": SID["organizers"], "title": "pwned", "expires_at": soon})
    check("Announcements: Pat and Vic cannot post in Organizers", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/announcements?id=eq.{org}", vic, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/announcements?space_id=eq.{SID['organizers']}", vic)
    check("Announcements: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == []
          and oq(f"select count(*) from weft.announcements where space_id = '{SID['organizers']}'") == "1", f"{st} {st2}")
    st, rows = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"title": "Gates open at 9", "body": " Bring your badge ", "expires_at": later})
    check("Announcements: Olive changes a notice and its end (positive control)", st == 200 and rows and rows[0]["title"] == "Gates open at 9"
          and rows[0]["body"] == "Bring your badge" and rows[0]["created_by"] == O, f"{st} {rows}")
    # Only channels.
    for key in ("personal-u-org", "dm-alex-olive", "assistant-u-org"):
        st, body = call("POST", "/announcements", olive, {"space_id": SID[key], "title": "not a channel", "expires_at": soon})
        check(f"Announcements: only channels have them ({key.split('-')[0]} refused)", st == 400 and "channel" in json.dumps(body), f"{st} {body}")
    # Sensible content and end times.
    st, _ = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "ended already", "expires_at": past})
    st2, _ = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "forever", "expires_at": too_far})
    st3, _ = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "   ", "expires_at": soon})
    st4, _ = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "x" * 121, "expires_at": soon})
    st5, _ = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "long", "body": "x" * 1001, "expires_at": soon})
    check("Announcements: an end in the past or over a year ahead, an empty or long title, or long text are refused",
          all(x == 400 for x in (st, st2, st3, st4, st5)), f"{st} {st2} {st3} {st4} {st5}")
    st, rows = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "Default end"})
    days = oq(f"select round(extract(epoch from expires_at - created_at) / 86400) from weft.announcements where id = '{rows[0]['id']}'") if st == 201 else None
    check("Announcements: without an end, a notice shows for a week", days == "7", f"{st} {days}")
    if st == 201:
        call("DELETE", f"/announcements?id=eq.{rows[0]['id']}", olive)
    st, _ = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"expires_at": too_far})
    st2, _ = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"expires_at": "2020-01-01T00:00:00Z"})
    check("Announcements: nor can a notice be changed to end over a year ahead, or before it was posted", st == 400 and st2 == 400, f"{st} {st2}")
    # Authorship and the channel are fixed.
    st, _ = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "forged", "expires_at": soon, "created_by": A})
    check("Announcements: authorship cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Announcements: nor changed afterwards, nor the time it was posted", refused(st) and refused(st2)
          and oq(f"select created_by from weft.announcements where id = '{fest}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    check("Announcements: a notice cannot be moved to another channel", refused(st)
          and oq(f"select space_id from weft.announcements where id = '{fest}'") == SID["festival"], str(st))
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/announcements?id=in.({org},{fest})&select=space_id", scoped)
    check("Announcements: a #festival-scoped token sees only #festival notices", st == 200 and rows and {r["space_id"] for r in rows} == {SID["festival"]}, str(rows))
    st, _ = call("POST", "/announcements", scoped, {"space_id": SID["organizers"], "title": "scoped", "expires_at": soon})
    check("Announcements: nor posts in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/announcements?id=eq.{org}&select=id", helper)
    check("Announcements: the assistant (for Olive) reads Organizers notices (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/announcements?id=eq.{org}", helper)
    st2, _ = call("PATCH", f"/announcements?id=eq.{org}", helper, {"title": "by the assistant"})
    st3, _ = call("POST", "/announcements", helper, {"space_id": SID["organizers"], "title": "by the assistant", "expires_at": soon})
    check("Announcements: the assistant cannot delete, change or post notices", refused(st) and refused(st2) and refused(st3)
          and oq(f"select title from weft.announcements where id = '{org}'") == "ORG-NOTICE-SECRET budget freeze", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/announcements?id=eq.{org}&select=id", mint("u-pub", assistant=True))
    check("Announcements: the assistant for Pat reads no Organizers notices", st == 200 and rows == [], str(rows))
    # Audit.
    st, rows = call("GET", f"/audit?row_id=eq.{fest}&select=op", vic)
    check("Announcements: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1, str(rows))
    call("PATCH", f"/announcements?id=eq.{org}", olive, {"body": "No new spending until Friday"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Announcements: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Ending early keeps the notice (members still read it, the app lists it as ended).
    st, rows = call("PATCH", f"/announcements?id=eq.{fest}", olive, {"expires_at": oq("select to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF')")})
    st2, rows2 = call("GET", f"/announcements?id=eq.{fest}&expires_at=gt.now&select=id", pat)
    st3, rows3 = call("GET", f"/announcements?id=eq.{fest}&select=id", pat)
    check("Announcements: Olive ends a notice early; Pat no longer sees it as current, but can still read it", st == 200 and rows and rows2 == [] and len(rows3 or []) == 1, f"{st} {rows2} {rows3}")
    # Notices follow the channel: membership decides, and deleting the channel deletes them.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "notice test"})
    st, rows = call("POST", "/announcements", olive, {"space_id": ch, "title": "Channel notice", "expires_at": soon})
    cn = rows[0]["id"] if st == 201 else None
    st, rows = call("GET", f"/announcements?id=eq.{cn}&select=id", pat)
    check("Announcements: Pat cannot read a notice in a channel she is not in", cn and st == 200 and rows == [], f"{st} {rows}")
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("GET", f"/announcements?id=eq.{cn}&select=id", pat)
    st2, _ = call("POST", "/announcements", pat, {"space_id": ch, "title": "x", "expires_at": soon})
    check("Announcements: added as a viewer, she reads it (positive control) and still cannot post", len(rows or []) == 1 and refused(st2), f"{rows} {st2}")
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, rows = call("GET", f"/announcements?id=eq.{cn}&select=id", pat)
    check("Announcements: removed from the channel, she reads it no more", st == 200 and rows == [], str(rows))
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", pat)
    check("Announcements: Pat cannot delete the channel or its notices", oq(f"select count(*) from weft.announcements where id = '{cn}'") == "1", str(st))
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Announcements: deleting the channel deletes its notices", st in (200, 204) and oq(f"select count(*) from weft.announcements where id = '{cn}'") == "0", str(st))
    st, _ = call("DELETE", f"/announcements?id=eq.{org}", olive)
    check("Announcements: Olive deletes a notice (positive control)", st in (200, 204) and oq(f"select count(*) from weft.announcements where id = '{org}'") == "0", str(st))
    call("DELETE", f"/announcements?id=eq.{fest}", olive)


def kudos():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/kudos", olive, {"space_id": SID["organizers"], "to_user": A, "message": "  KUDOS-ORG-SECRET thanks for the budget \n"})
    org = rows[0]["id"] if st == 201 else None
    check("Kudos: Olive (editor) thanks Alex in Organizers (positive control), created_by set by the database, text trimmed",
          org and rows[0]["created_by"] == O and rows[0]["message"] == "KUDOS-ORG-SECRET thanks for the budget", f"{st} {rows}")
    st, rows = call("POST", "/kudos", olive, {"space_id": SID["festival"], "to_user": P, "message": "Thanks for handing out maps"})
    fest = rows[0]["id"] if st == 201 else None
    check("Kudos: Olive thanks Pat in #festival", fest is not None, f"{st} {rows}")
    # Reading follows membership.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/kudos?space_id=eq.{SID['organizers']}&select=id", tok)
        st2, rows2 = call("GET", "/kudos?message=like.*KUDOS-ORG*&select=id", tok)
        check(f"Kudos: {who} gets no Organizers kudos, by space or by text", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/kudos?id=eq.{fest}&select=id,message,to:users!kudos_to_user_fkey(display_name)", pat)
    check("Kudos: Pat (viewer) reads the #festival wall, with names (positive control)", st == 200 and len(rows) == 1 and rows[0]["to"]["display_name"], str(rows))
    # Viewers read only.
    st, _ = call("POST", "/kudos", pat, {"space_id": SID["festival"], "to_user": O, "message": "pwned"})
    st2, _ = call("POST", "/kudos", vic, {"space_id": SID["festival"], "to_user": O, "message": "pwned"})
    check("Kudos: Pat and Vic (viewers in #festival) cannot give kudos there", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/kudos?id=eq.{fest}", pat, {"message": "pwned"})
    st2, rows2 = call("DELETE", f"/kudos?id=eq.{fest}", pat)
    check("Kudos: Pat cannot change or delete a kudos, even one for her", rows == [] and rows2 == []
          and oq(f"select message from weft.kudos where id = '{fest}'") == "Thanks for handing out maps", f"{st} {st2}")
    st, _ = call("POST", "/kudos", pat, {"space_id": SID["organizers"], "to_user": O, "message": "pwned"})
    st2, _ = call("POST", "/kudos", vic, {"space_id": SID["organizers"], "to_user": O, "message": "pwned"})
    check("Kudos: Pat and Vic cannot give kudos in Organizers", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/kudos?id=eq.{org}", vic, {"message": "pwned"})
    st2, rows2 = call("DELETE", f"/kudos?space_id=eq.{SID['organizers']}", vic)
    check("Kudos: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == []
          and oq(f"select count(*) from weft.kudos where space_id = '{SID['organizers']}'") == "1", f"{st} {st2}")
    # An outsider learns nothing from the guard's answers (no 'not a member' or 'not a channel' message).
    st, body = call("POST", "/kudos", pat, {"space_id": SID["organizers"], "to_user": uid("user", "nobody"), "message": "probe"})
    check("Kudos: an outsider's attempt gets the plain refusal, not the guard's reason", refused(st) and "member" not in json.dumps(body), f"{st} {body}")
    # Rewording: only your own.
    st, rows = call("PATCH", f"/kudos?id=eq.{fest}", olive, {"message": " Thanks for handing out maps all day "})
    check("Kudos: Olive rewords her own kudos (positive control)", st == 200 and rows and rows[0]["message"] == "Thanks for handing out maps all day"
          and rows[0]["updated_at"] > rows[0]["created_at"], f"{st} {rows}")
    st, rows = call("POST", "/kudos", alex, {"space_id": SID["festival"], "to_user": O, "message": "Thanks for the signs"})
    ak = rows[0]["id"] if st == 201 else None
    st, rows = call("PATCH", f"/kudos?id=eq.{ak}", olive, {"message": "pwned"})
    check("Kudos: Olive (editor) cannot reword Alex's kudos", rows == [] and oq(f"select message from weft.kudos where id = '{ak}'") == "Thanks for the signs", f"{st} {rows}")
    st, rows = call("PATCH", f"/kudos?id=eq.{fest}", alex, {"message": "pwned"})
    check("Kudos: nor can Alex (owner) reword Olive's", rows == [] and oq(f"select message from weft.kudos where id = '{fest}'") == "Thanks for handing out maps all day", f"{st} {rows}")
    # Deleting: your own, or any as an owner.
    st, rows = call("DELETE", f"/kudos?id=eq.{ak}", olive)
    check("Kudos: Olive (editor) cannot delete Alex's kudos", rows == [] and oq(f"select count(*) from weft.kudos where id = '{ak}'") == "1", f"{st} {rows}")
    st, rows = call("POST", "/kudos", olive, {"space_id": SID["festival"], "to_user": A, "message": "Thanks, to be tidied"})
    tidy = rows[0]["id"] if st == 201 else None
    st, rows = call("DELETE", f"/kudos?id=eq.{tidy}", alex)
    check("Kudos: Alex (owner of #festival) deletes Olive's kudos (positive control)", st == 200 and len(rows or []) == 1
          and oq(f"select count(*) from weft.kudos where id = '{tidy}'") == "0", f"{st} {rows}")
    st, rows = call("DELETE", f"/kudos?id=eq.{ak}", alex)
    check("Kudos: Alex deletes his own kudos (positive control)", st == 200 and len(rows or []) == 1, f"{st} {rows}")
    # What a kudos may be.
    st, b1 = call("POST", "/kudos", olive, {"space_id": SID["festival"], "to_user": O, "message": "me, me"})
    check("Kudos: nobody thanks themselves", st == 400 and "yourself" in json.dumps(b1), f"{st} {b1}")
    st, b1 = call("POST", "/kudos", olive, {"space_id": SID["organizers"], "to_user": P, "message": "not here"})
    check("Kudos: only for a member of the channel (Pat is not in Organizers)", st == 400 and "member" in json.dumps(b1), f"{st} {b1}")
    for key in ("personal-u-org", "dm-alex-olive", "assistant-u-org"):
        st, body = call("POST", "/kudos", olive, {"space_id": SID[key], "to_user": A, "message": "not a channel"})
        check(f"Kudos: only channels have a wall ({key.split('-')[0]} refused)", st == 400 and "channel" in json.dumps(body), f"{st} {body}")
    st, _ = call("POST", "/kudos", olive, {"space_id": SID["festival"], "to_user": P, "message": "   "})
    st2, _ = call("POST", "/kudos", olive, {"space_id": SID["festival"], "to_user": P, "message": "x" * 501})
    st3, _ = call("PATCH", f"/kudos?id=eq.{fest}", olive, {"message": ""})
    check("Kudos: an empty or over-long message is refused, also when rewording", st == 400 and st2 == 400 and st3 == 400, f"{st} {st2} {st3}")
    # Authorship, recipient and channel are fixed.
    st, _ = call("POST", "/kudos", olive, {"space_id": SID["festival"], "to_user": P, "message": "forged", "created_by": A})
    check("Kudos: authorship cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/kudos?id=eq.{fest}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/kudos?id=eq.{fest}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    st3, _ = call("PATCH", f"/kudos?id=eq.{fest}", olive, {"to_user": V})
    check("Kudos: nor changed afterwards, nor the time, nor who it is for", refused(st) and refused(st2) and refused(st3)
          and oq(f"select created_by::text || to_user::text from weft.kudos where id = '{fest}'") == O + P, f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/kudos?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    check("Kudos: a kudos cannot be moved to another channel", refused(st)
          and oq(f"select space_id from weft.kudos where id = '{fest}'") == SID["festival"], str(st))
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/kudos?id=in.({org},{fest})&select=space_id", scoped)
    check("Kudos: a #festival-scoped token sees only #festival kudos", st == 200 and rows and {r["space_id"] for r in rows} == {SID["festival"]}, str(rows))
    st, _ = call("POST", "/kudos", scoped, {"space_id": SID["organizers"], "to_user": A, "message": "scoped"})
    st2, rows2 = call("PATCH", f"/kudos?id=eq.{org}", scoped, {"message": "scoped"})
    check("Kudos: nor gives or rewords kudos in Organizers", refused(st) and rows2 == [], f"{st} {st2} {rows2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/kudos?id=eq.{org}&select=id", helper)
    check("Kudos: the assistant (for Olive) reads Organizers kudos (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/kudos?id=eq.{org}", helper)
    st2, _ = call("PATCH", f"/kudos?id=eq.{org}", helper, {"message": "by the assistant"})
    st3, _ = call("POST", "/kudos", helper, {"space_id": SID["organizers"], "to_user": A, "message": "by the assistant"})
    check("Kudos: the assistant cannot delete, change or give kudos", refused(st) and refused(st2) and refused(st3)
          and oq(f"select message from weft.kudos where id = '{org}'") == "KUDOS-ORG-SECRET thanks for the budget", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/kudos?id=eq.{org}&select=id", mint("u-pub", assistant=True))
    check("Kudos: the assistant for Pat reads no Organizers kudos", st == 200 and rows == [], str(rows))
    # Audit.
    st, rows = call("GET", f"/audit?row_id=eq.{fest}&select=op", vic)
    check("Kudos: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1, str(rows))
    call("PATCH", f"/kudos?id=eq.{org}", olive, {"message": "KUDOS-ORG-SECRET thanks for the budget, again"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Kudos: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Kudos follow the channel: membership decides, and deleting the channel deletes them.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "kudos test"})
    call("POST", "/members", olive, {"space_id": ch, "user_id": V, "role": "editor"}, prefer="return=minimal")
    st, rows = call("POST", "/kudos", olive, {"space_id": ch, "to_user": V, "message": "Channel kudos"})
    cn = rows[0]["id"] if st == 201 else None
    st, rows = call("GET", f"/kudos?id=eq.{cn}&select=id", pat)
    check("Kudos: Pat cannot read kudos in a channel she is not in", cn and st == 200 and rows == [], f"{st} {rows}")
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("GET", f"/kudos?id=eq.{cn}&select=id", pat)
    st2, _ = call("POST", "/kudos", pat, {"space_id": ch, "to_user": O, "message": "x"})
    check("Kudos: added as a viewer, she reads them (positive control) and still cannot give one", len(rows or []) == 1 and refused(st2), f"{rows} {st2}")
    st, rows = call("POST", "/kudos", vic, {"space_id": ch, "to_user": P, "message": "Welcome, Pat"})
    vk = rows[0]["id"] if st == 201 else None
    check("Kudos: Vic (editor there) thanks Pat, a viewer (positive control)", vk is not None, f"{st} {rows}")
    call("PATCH", f"/members?space_id=eq.{ch}&user_id=eq.{V}", olive, {"role": "viewer"})
    st, rows = call("PATCH", f"/kudos?id=eq.{vk}", vic, {"message": "changed"})
    st2, rows2 = call("DELETE", f"/kudos?id=eq.{vk}", vic)
    check("Kudos: made a viewer, Vic can no longer reword or delete his own kudos", rows == [] and rows2 == []
          and oq(f"select message from weft.kudos where id = '{vk}'") == "Welcome, Pat", f"{st} {st2}")
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, rows = call("GET", f"/kudos?id=eq.{cn}&select=id", pat)
    check("Kudos: removed from the channel, she reads them no more", st == 200 and rows == [], str(rows))
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Kudos: deleting the channel deletes its kudos", st in (200, 204) and oq(f"select count(*) from weft.kudos where space_id = '{ch}'") == "0", str(st))
    st, _ = call("DELETE", f"/kudos?id=eq.{org}", olive)
    check("Kudos: Olive deletes her own kudos (positive control)", st in (200, 204) and oq(f"select count(*) from weft.kudos where id = '{org}'") == "0", str(st))
    call("DELETE", f"/kudos?id=eq.{fest}", olive)


# ---------------------------------------------------------------- journal
def journal():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, O, A = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex")
    OS, PS = SID["personal-u-org"], SID["personal-u-pub"]
    oq = lambda sql: owner_sql(sql)
    day = oq("select current_date::text")
    body = lambda i: oq(f"select body from weft.journal_entries where id = '{i}'")
    st, rows = call("POST", "/journal_entries", olive, {"day": day, "body": "\nJOURNAL-SECRET slept badly before the budget meeting  \n"})
    oj = rows[0]["id"] if st == 201 else None
    check("Journal: Olive writes today's page (positive control); author and personal space set by the database, text tidied",
          oj and rows[0]["author_id"] == O and rows[0]["space_id"] == OS and rows[0]["body"] == "JOURNAL-SECRET slept badly before the budget meeting", f"{st} {rows}")
    st, _ = call("POST", "/journal_entries", olive, {"day": day, "body": "a second page today"})
    check("Journal: one page per person per day (a second one is refused)", st == 409 and oq(f"select count(*) from weft.journal_entries where author_id = '{O}'") == "1", str(st))
    st, rows = call("POST", "/journal_entries", pat, {"day": day, "body": "Pat's own day"})
    pj = rows[0]["id"] if st == 201 else None
    check("Journal: Pat (a viewer everywhere) writes her own journal too, in her personal space (positive control)",
          pj and rows[0]["space_id"] == PS and rows[0]["author_id"] == P, f"{st} {rows}")
    st, rows = call("GET", f"/journal_entries?select=id,body&order=day.desc", olive)
    st2, rows2 = call("GET", f"/journal_entries?body=ilike.*JOURNAL-SECRET*&select=id", olive)
    check("Journal: Olive reads and searches her own pages, and only hers (positive control)",
          st == 200 and [r["id"] for r in rows] == [oj] and rows2 == [{"id": oj}], f"{rows} {rows2}")
    # Nobody else reads them: not Pat, not Vic, not Alex (admin, owner of every channel Olive is in).
    for who, tok in (("Pat", pat), ("Vic", vic), ("Alex (admin)", alex)):
        st, rows = call("GET", f"/journal_entries?id=eq.{oj}&select=id", tok)
        st2, rows2 = call("GET", "/journal_entries?body=ilike.*JOURNAL-SECRET*&select=id", tok)
        st3, rows3 = call("GET", f"/journal_entries?space_id=eq.{OS}&select=id", tok)
        check(f"Journal: {who} gets none of Olive's pages, by id, text or space", st == 200 and rows == [] and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
        st, rows = call("PATCH", f"/journal_entries?id=eq.{oj}", tok, {"body": "pwned"})
        st2, rows2 = call("DELETE", f"/journal_entries?id=eq.{oj}", tok)
        check(f"Journal: {who} cannot change or delete Olive's page", rows == [] and rows2 == [] and body(oj).startswith("JOURNAL-SECRET"), f"{st} {st2}")
    # Where a page lives and who wrote it cannot be chosen or changed.
    st, _ = call("POST", "/journal_entries", pat, {"day": "2026-01-02", "body": "into Olive's space", "space_id": OS})
    st2, _ = call("POST", "/journal_entries", pat, {"day": "2026-01-02", "body": "into #festival", "space_id": SID["festival"]})
    st3, _ = call("POST", "/journal_entries", pat, {"day": "2026-01-02", "body": "forged", "author_id": O})
    check("Journal: nobody picks the space or the author of a page (never granted)", refused(st) and refused(st2) and refused(st3)
          and oq(f"select count(*) from weft.journal_entries where day = '2026-01-02'") == "0", f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", olive, {"author_id": P})
    st2, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", olive, {"space_id": SID["festival"]})
    st3, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", olive, {"day": "2026-01-01"})
    st4, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Journal: a page never moves to another person, space or day, nor are its times set", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select author_id::text || space_id::text || day::text from weft.journal_entries where id = '{oj}'") == O + OS + day, f"{st} {st2} {st3} {st4}")
    # What a page may be.
    st, b1 = call("POST", "/journal_entries", olive, {"day": "2999-01-01", "body": "the future"})
    st2, _ = call("POST", "/journal_entries", olive, {"day": "2026-01-03", "body": "  \n "})
    st3, _ = call("POST", "/journal_entries", olive, {"day": "2026-01-03", "body": "x" * 20001})
    st4, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", olive, {"body": ""})
    check("Journal: a page for a future day, an empty one or one over 20,000 characters is refused", st == 400 and "day" in json.dumps(b1)
          and st2 == 400 and st3 == 400 and st4 == 400, f"{st} {st2} {st3} {st4}")
    st, rows = call("POST", "/journal_entries", olive, {"day": "2026-01-03", "body": "A past day, written later"})
    old = rows[0]["id"] if st == 201 else None
    check("Journal: Olive writes a page for a past day (positive control)", old is not None, f"{st} {rows}")
    st, rows = call("PATCH", f"/journal_entries?id=eq.{oj}", olive, {"body": "JOURNAL-SECRET slept badly, then the meeting went fine"})
    check("Journal: Olive rewrites her page (positive control); updated_at moves", st == 200 and rows and rows[0]["updated_at"] > rows[0]["created_at"], f"{st} {rows}")
    # Someone the owner adds to her personal space still sees nothing: every rule also needs author = you.
    st, _ = call("POST", "/members", olive, {"space_id": OS, "user_id": A, "role": "editor"}, prefer="return=minimal")
    added = oq(f"select count(*) from weft.members where space_id = '{OS}' and user_id = '{A}'") == "1"
    st2, rows2 = call("GET", f"/journal_entries?space_id=eq.{OS}&select=id", alex)
    st3, rows3 = call("PATCH", f"/journal_entries?id=eq.{oj}", alex, {"body": "pwned"})
    st4, rows4 = call("GET", f"/audit?space_id=eq.{OS}&table_name=eq.journal_entries&select=old_row", alex)
    check("Journal: Alex, added to Olive's personal space as an editor, reads and changes none of her pages",
          added and rows2 == [] and rows3 == [] and body(oj).startswith("JOURNAL-SECRET"), f"{st} {rows2} {rows3}")
    check("Journal: the audit log he can read there holds no page text", st4 == 200 and len(rows4) >= 1 and "JOURNAL-SECRET" not in json.dumps(rows4)
          and "slept" not in json.dumps(rows4), str(rows4))
    call("DELETE", f"/members?space_id=eq.{OS}&user_id=eq.{A}", olive)
    # Channel scope, a personal-space token and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", "/journal_entries?select=id", scoped)
    st2, _ = call("POST", "/journal_entries", scoped, {"day": "2026-01-04", "body": "scoped"})
    st3, rows3 = call("PATCH", f"/journal_entries?id=eq.{oj}", scoped, {"body": "scoped"})
    st4, rows4 = call("DELETE", f"/journal_entries?id=eq.{oj}", scoped)
    check("Journal: a #festival-scoped token of Olive's reads, writes, changes and deletes none of her pages",
          st == 200 and rows == [] and refused(st2) and rows3 == [] and rows4 == [] and body(oj).startswith("JOURNAL-SECRET"), f"{rows} {st2} {rows3} {rows4}")
    st, rows = call("GET", "/journal_entries?select=id", mint("u-org", scope="personal-u-org"))
    check("Journal: a token scoped to her own personal space reads her pages (positive control)", st == 200 and {r["id"] for r in rows} == {oj, old}, str(rows))
    # The assistant (since 048): reads her pages only in her own Weft conversation (an unscoped token), never
    # scoped to a channel, a direct message or her personal space, and never writes or deletes them.
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/journal_entries?select=id", helper)
    st2, _ = call("DELETE", f"/journal_entries?id=eq.{oj}", helper)
    st3, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", helper, {"body": "by the assistant"})
    st4, _ = call("POST", "/journal_entries", helper, {"day": "2026-01-05", "body": "by the assistant"})
    check("Journal: the assistant (for Olive) cannot delete, change or write her journal", refused(st2) and refused(st3) and refused(st4)
          and body(oj).startswith("JOURNAL-SECRET"), f"{st} {rows} {st2} {st3} {st4}")
    check("Journal: the assistant for Olive in her own Weft conversation reads only her pages", st == 200 and {r["id"] for r in rows} == {oj, old}, f"{st} {rows}")
    seen = [call("GET", "/journal_entries?select=id", mint(u, assistant=True, scope=sc))[1] for u, sc in
            (("u-org", "festival"), ("u-org", "personal-u-org"), ("u-org", "dm-alex-olive"), ("u-alex", None), ("u-pub", None))]
    check("Journal: the assistant reads no page of Olive's scoped to a channel, a DM or her personal space, nor for anyone else",
          all(isinstance(x, list) and not ({r["id"] for r in x} & {oj, old}) for x in seen) and all(x == [] for x in seen[:4]), str(seen))
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "JOURNAL-SECRET"})
    check("Journal: pages are in Weft search for their writer (since 048)", st == 200 and {r["id"] for r in rows if r["kind"] == "journal"} == {oj}, f"{st} {rows}"[:200])
    found = [any(r["kind"] == "journal" for r in (call("POST", "/rpc/search", t, {"p_q": "JOURNAL-SECRET"})[1] or [])) for t in (pat, vic, alex, scoped)]
    check("Journal: and for nobody else (Pat, Vic, Alex, her own #festival-scoped token)", not any(found), str(found))
    # Audit: under the personal space, no text, readable only by its members.
    st, rows = call("GET", f"/audit?row_id=eq.{oj}&select=space_id,old_row", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{oj}&select=op", pat)
    check("Journal: a change is in the audit log under Olive's personal space, with the day but not the text; Pat sees none",
          rows and {r["space_id"] for r in rows} == {OS} and rows[0]["old_row"].get("day") == day and "body" not in rows[0]["old_row"]
          and "JOURNAL-SECRET" not in json.dumps(rows) and rows2 == [], f"{rows} {rows2}")
    # Deleting: your own; the words are then gone from the database.
    st, rows = call("DELETE", f"/journal_entries?id=eq.{oj}", olive)
    check("Journal: Olive deletes her page (positive control) and its text is nowhere left, audit included",
          st == 200 and len(rows or []) == 1 and oq("select count(*) from weft.audit where old_row::text like '%JOURNAL-SECRET%'") == "0"
          and oq("select count(*) from weft.journal_entries where body like '%JOURNAL-SECRET%'") == "0", f"{st} {rows}")
    st, rows = call("DELETE", f"/journal_entries?id=eq.{pj}", olive)
    check("Journal: Olive cannot delete Pat's page", rows == [] and oq(f"select count(*) from weft.journal_entries where id = '{pj}'") == "1", f"{st} {rows}")
    # A disabled account reads nothing, its own journal included; enabling it again restores it.
    oq(f"update weft.users set disabled = true where id = '{P}'")
    try:
        st, rows = call("GET", "/journal_entries?select=id", pat)
        st2, _ = call("POST", "/journal_entries", pat, {"day": "2026-01-06", "body": "while disabled"})
    finally:
        oq(f"update weft.users set disabled = false where id = '{P}'")
    st3, rows3 = call("GET", "/journal_entries?select=id", mint("u-pub"))
    check("Journal: a disabled account reads and writes no journal, not even its own; enabled again, it is back",
          st == 200 and rows == [] and refused(st2) and rows3 == [{"id": pj}], f"{rows} {st2} {rows3}")
    for i in (old, pj):
        oq(f"delete from weft.journal_entries where id = '{i}'")


def timeline():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/milestones", olive, {"space_id": SID["organizers"], "title": "  MILESTONE-ORG-SECRET budget sign-off \n", "day": "2027-02-01", "note": " board meets "})
    org = rows[0]["id"] if st == 201 else None
    check("Timeline: Olive (editor) adds a milestone in Organizers (positive control), created_by set by the database, text trimmed",
          org and rows[0]["created_by"] == O and rows[0]["title"] == "MILESTONE-ORG-SECRET budget sign-off" and rows[0]["note"] == "board meets", f"{st} {rows}")
    st, rows = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "Gates open", "day": "2027-06-12"})
    fest = rows[0]["id"] if st == 201 else None
    check("Timeline: Olive adds a milestone in #festival, with no note (positive control)", fest is not None and rows[0]["note"] == "", f"{st} {rows}")
    # Reading follows membership.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/milestones?space_id=eq.{SID['organizers']}&select=id", tok)
        st2, rows2 = call("GET", "/milestones?title=like.*MILESTONE-ORG*&select=id", tok)
        check(f"Timeline: {who} gets no Organizers milestones, by space or by text", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/milestones?id=eq.{fest}&select=id,title,day,by:users!milestones_created_by_fkey(display_name)", pat)
    check("Timeline: Pat (viewer) reads the #festival timeline, with who added it (positive control)",
          st == 200 and len(rows) == 1 and rows[0]["day"] == "2027-06-12" and rows[0]["by"]["display_name"], str(rows))
    # Viewers read only.
    st, _ = call("POST", "/milestones", pat, {"space_id": SID["festival"], "title": "pwned", "day": "2027-01-01"})
    st2, _ = call("POST", "/milestones", vic, {"space_id": SID["festival"], "title": "pwned", "day": "2027-01-01"})
    check("Timeline: Pat and Vic (viewers in #festival) cannot add milestones there", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/milestones?id=eq.{fest}", pat, {"day": "2020-01-01"})
    st2, rows2 = call("DELETE", f"/milestones?id=eq.{fest}", pat)
    check("Timeline: Pat cannot move or delete a #festival milestone", rows == [] and rows2 == []
          and oq(f"select day::text || title from weft.milestones where id = '{fest}'") == "2027-06-12Gates open", f"{st} {st2}")
    st, _ = call("POST", "/milestones", pat, {"space_id": SID["organizers"], "title": "pwned", "day": "2027-01-01"})
    st2, _ = call("POST", "/milestones", vic, {"space_id": SID["organizers"], "title": "pwned", "day": "2027-01-01"})
    check("Timeline: Pat and Vic cannot add milestones in Organizers", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/milestones?id=eq.{org}", vic, {"title": "pwned"})
    st2, rows2 = call("DELETE", f"/milestones?space_id=eq.{SID['organizers']}", vic)
    check("Timeline: Vic changes and deletes nothing in Organizers", rows == [] and rows2 == []
          and oq(f"select count(*) from weft.milestones where space_id = '{SID['organizers']}'") == "1", f"{st} {st2}")
    # An outsider learns nothing from the guard's answer.
    st, body = call("POST", "/milestones", pat, {"space_id": SID["dm-alex-olive"], "title": "probe", "day": "2027-01-01"})
    check("Timeline: an outsider's attempt gets the plain refusal, not the guard's reason", refused(st) and "channel" not in json.dumps(body), f"{st} {body}")
    # Editors and owners change and delete any milestone in the channel, not only their own.
    st, rows = call("POST", "/milestones", alex, {"space_id": SID["festival"], "title": "Stage build", "day": "2027-06-10"})
    am = rows[0]["id"] if st == 201 else None
    st, rows = call("PATCH", f"/milestones?id=eq.{am}", olive, {"day": "2027-06-09", "note": " a day earlier "})
    check("Timeline: Olive (editor) moves Alex's milestone to another date (positive control); author and times kept",
          st == 200 and rows and rows[0]["day"] == "2027-06-09" and rows[0]["note"] == "a day earlier" and rows[0]["created_by"] == A
          and rows[0]["updated_at"] > rows[0]["created_at"], f"{st} {rows}")
    st, rows = call("PATCH", f"/milestones?id=eq.{fest}", alex, {"title": "Gates open at ten"})
    check("Timeline: Alex (owner) renames Olive's milestone (positive control)", st == 200 and rows and rows[0]["title"] == "Gates open at ten", f"{st} {rows}")
    st, rows = call("DELETE", f"/milestones?id=eq.{am}", olive)
    check("Timeline: Olive (editor) deletes Alex's milestone (positive control)", st == 200 and len(rows or []) == 1
          and oq(f"select count(*) from weft.milestones where id = '{am}'") == "0", f"{st} {rows}")
    # What a milestone may be.
    for key in ("personal-u-org", "dm-alex-olive", "assistant-u-org"):
        st, body = call("POST", "/milestones", olive, {"space_id": SID[key], "title": "not a channel", "day": "2027-01-01"})
        check(f"Timeline: only channels have a timeline ({key.split('-')[0]} refused)", st == 400 and "channel" in json.dumps(body), f"{st} {body}")
    st, _ = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "   ", "day": "2027-01-01"})
    st2, _ = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "x" * 121, "day": "2027-01-01"})
    st3, _ = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "long note", "day": "2027-01-01", "note": "x" * 301})
    st4, _ = call("PATCH", f"/milestones?id=eq.{fest}", olive, {"title": ""})
    check("Timeline: an empty or over-long title or note is refused, also when changing", st == 400 and st2 == 400 and st3 == 400 and st4 == 400, f"{st} {st2} {st3} {st4}")
    st, _ = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "no date"})
    st2, _ = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "far", "day": "2999-01-01"})
    st3, _ = call("PATCH", f"/milestones?id=eq.{fest}", olive, {"day": "1900-01-01"})
    check("Timeline: a milestone needs a date between 2000 and 2100", st == 400 and st2 == 400 and st3 == 400
          and oq(f"select day from weft.milestones where id = '{fest}'") == "2027-06-12", f"{st} {st2} {st3}")
    # Authorship, times and channel are fixed.
    st, _ = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "forged", "day": "2027-01-01", "created_by": A})
    check("Timeline: authorship cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/milestones?id=eq.{fest}", olive, {"created_by": A})
    st2, _ = call("PATCH", f"/milestones?id=eq.{fest}", olive, {"created_at": "2020-01-01T00:00:00Z"})
    check("Timeline: nor changed afterwards, nor the time it was added", refused(st) and refused(st2)
          and oq(f"select created_by from weft.milestones where id = '{fest}'") == O, f"{st} {st2}")
    st, _ = call("PATCH", f"/milestones?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    check("Timeline: a milestone cannot be moved to another channel", refused(st)
          and oq(f"select space_id from weft.milestones where id = '{fest}'") == SID["festival"], str(st))
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/milestones?id=in.({org},{fest})&select=space_id", scoped)
    check("Timeline: a #festival-scoped token sees only #festival milestones", st == 200 and rows and {r["space_id"] for r in rows} == {SID["festival"]}, str(rows))
    st, _ = call("POST", "/milestones", scoped, {"space_id": SID["organizers"], "title": "scoped", "day": "2027-01-01"})
    st2, rows2 = call("PATCH", f"/milestones?id=eq.{org}", scoped, {"title": "scoped"})
    st3, rows3 = call("DELETE", f"/milestones?id=eq.{org}", scoped)
    check("Timeline: nor adds, changes or deletes milestones in Organizers", refused(st) and rows2 == [] and rows3 == [], f"{st} {st2} {rows2} {st3}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/milestones?id=eq.{org}&select=id", helper)
    check("Timeline: the assistant (for Olive) reads Organizers milestones (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/milestones?id=eq.{org}", helper)
    st2, _ = call("PATCH", f"/milestones?id=eq.{org}", helper, {"title": "by the assistant"})
    st3, _ = call("POST", "/milestones", helper, {"space_id": SID["organizers"], "title": "by the assistant", "day": "2027-01-01"})
    check("Timeline: the assistant cannot delete, change or add milestones", refused(st) and refused(st2) and refused(st3)
          and oq(f"select title from weft.milestones where id = '{org}'") == "MILESTONE-ORG-SECRET budget sign-off", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/milestones?id=eq.{org}&select=id", mint("u-pub", assistant=True))
    check("Timeline: the assistant for Pat reads no Organizers milestones", st == 200 and rows == [], str(rows))
    # Audit.
    st, rows = call("GET", f"/audit?row_id=eq.{fest}&select=op", vic)
    check("Timeline: #festival changes are in the audit log, readable by its members, Vic included (positive control)", len(rows or []) >= 1, str(rows))
    call("PATCH", f"/milestones?id=eq.{org}", olive, {"title": "MILESTONE-ORG-SECRET budget sign-off, moved"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Timeline: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Milestones follow the channel: membership and role decide, and deleting the channel deletes them.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "timeline test"})
    call("POST", "/members", olive, {"space_id": ch, "user_id": V, "role": "editor"}, prefer="return=minimal")
    st, rows = call("POST", "/milestones", olive, {"space_id": ch, "title": "Kick-off", "day": "2027-03-01"})
    cn = rows[0]["id"] if st == 201 else None
    st, rows = call("GET", f"/milestones?id=eq.{cn}&select=id", pat)
    check("Timeline: Pat cannot read milestones in a channel she is not in", cn and st == 200 and rows == [], f"{st} {rows}")
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("GET", f"/milestones?id=eq.{cn}&select=id", pat)
    st2, _ = call("POST", "/milestones", pat, {"space_id": ch, "title": "x", "day": "2027-01-01"})
    check("Timeline: added as a viewer, she reads them (positive control) and still cannot add one", len(rows or []) == 1 and refused(st2), f"{rows} {st2}")
    st, rows = call("POST", "/milestones", vic, {"space_id": ch, "title": "Wrap-up", "day": "2027-04-01"})
    vm = rows[0]["id"] if st == 201 else None
    check("Timeline: Vic (editor there) adds a milestone (positive control)", vm is not None, f"{st} {rows}")
    call("PATCH", f"/members?space_id=eq.{ch}&user_id=eq.{V}", olive, {"role": "viewer"})
    st, rows = call("PATCH", f"/milestones?id=eq.{vm}", vic, {"title": "changed"})
    st2, rows2 = call("DELETE", f"/milestones?id=eq.{vm}", vic)
    check("Timeline: made a viewer, Vic can no longer change or delete even his own milestone", rows == [] and rows2 == []
          and oq(f"select title from weft.milestones where id = '{vm}'") == "Wrap-up", f"{st} {st2}")
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, rows = call("GET", f"/milestones?id=eq.{cn}&select=id", pat)
    check("Timeline: removed from the channel, she reads them no more", st == 200 and rows == [], str(rows))
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Timeline: deleting the channel deletes its milestones", st in (200, 204) and oq(f"select count(*) from weft.milestones where space_id = '{ch}'") == "0", str(st))
    st, _ = call("DELETE", f"/milestones?id=eq.{org}", olive)
    check("Timeline: Olive deletes an Organizers milestone (positive control)", st in (200, 204) and oq(f"select count(*) from weft.milestones where id = '{org}'") == "0", str(st))
    call("DELETE", f"/milestones?id=eq.{fest}", olive)


# ---------------------------------------------------------------- polls
def polls():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "poll", "title": "ORG-POLL-SECRET: which caterer?"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "poll", "title": "Festival poll: which day for the parade?"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Polls: Olive (editor) makes polls in Organizers and #festival", org and fest, f"{st} {st2}")
    check("Polls: each poll starts open", oq(f"select string_agg(closed::text, ',') from weft.polls where id in ('{org}', '{fest}')") == "false,false")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "poll", "title": "x"})
    check("Polls: Pat (viewer) cannot make a poll in #festival", refused(st), str(st))
    ch = {}
    for poll, labels in ((org, ["Bakery", "Taco truck"]), (fest, ["Saturday", "Sunday", "Monday"])):
        for i, label in enumerate(labels):
            st, rows = call("POST", "/poll_choices", olive, {"poll_id": poll, "label": f"  {label} ", "position": i})
            ch[label] = rows[0]["id"] if st == 201 else None
    check("Polls: Olive adds choices (positive control), trimmed", all(ch.values()) and oq(f"select label from weft.poll_choices where id = '{ch['Bakery']}'") == "Bakery", str(ch))
    st, _ = call("POST", "/poll_choices", pat, {"poll_id": fest, "label": "Pat's day"})
    st2, rows2 = call("PATCH", f"/poll_choices?id=eq.{ch['Sunday']}", pat, {"label": "pwned"})
    st3, rows3 = call("DELETE", f"/poll_choices?id=eq.{ch['Monday']}", pat)
    check("Polls: Pat (viewer) cannot add, rename or remove choices", refused(st) and rows2 == [] and rows3 == []
          and oq(f"select count(*) from weft.poll_choices where poll_id = '{fest}'") == "3", f"{st} {st2} {st3}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/poll_choices?poll_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/polls?id=eq.{org}&select=id", tok)
        check(f"Polls: {who} gets no Organizers choices or poll state", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/poll_votes", olive, {"poll_id": org, "choice_id": ch["Bakery"]})
    check("Polls: Olive votes in Organizers, and the database records her as the voter", st == 201 and rows[0]["voter_id"] == O, f"{st} {rows}")
    st, rows = call("GET", f"/poll_votes?poll_id=eq.{org}&select=voter_id", pat)
    st2, rows2 = call("GET", "/poll_votes?select=poll_id", pat)
    check("Polls: Pat sees no Organizers votes, not even by listing every vote", rows == [] and org not in {r["poll_id"] for r in rows2 or []}, f"{rows} {rows2}")
    st, _ = call("POST", "/poll_votes", pat, {"poll_id": org, "choice_id": ch["Taco truck"]})
    st2, _ = call("POST", "/poll_votes", vic, {"poll_id": org, "choice_id": ch["Taco truck"]})
    check("Polls: Pat and Vic cannot vote in Organizers", refused(st) and refused(st2) and oq(f"select count(*) from weft.poll_votes where poll_id = '{org}'") == "1", f"{st} {st2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    st2, rows2 = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows2[0]["body_text"] if rows2 else "") or ""
    check("Polls: the summary is hidden from Pat, and for Olive counts the votes without names",
          rows == [] and "Poll, open, 1 vote" in body and "Bakery: 1 vote" in body and "Taco truck: 0 votes" in body and "Olive" not in body, f"{rows} {body!r}")
    # Viewers vote: one vote each, their own only.
    st, rows = call("POST", "/poll_votes", pat, {"poll_id": fest, "choice_id": ch["Saturday"]})
    check("Polls: Pat (viewer) votes in #festival", st == 201 and rows[0]["voter_id"] == P, f"{st} {rows}")
    st, body = call("POST", "/poll_votes", pat, {"poll_id": fest, "choice_id": ch["Sunday"]})
    check("Polls: one vote per person: a second vote is refused", st == 409 and oq(f"select count(*) from weft.poll_votes where poll_id = '{fest}' and voter_id = '{P}'") == "1", f"{st} {body}")
    st, rows = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Sunday"]})
    check("Polls: Pat changes her vote", st == 200 and len(rows or []) == 1 and rows[0]["choice_id"] == ch["Sunday"], f"{st} {rows}")
    st, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Bakery"]})
    check("Polls: but not to a choice from another poll", st >= 400 and oq(f"select choice_id from weft.poll_votes where poll_id = '{fest}' and voter_id = '{P}'") == ch["Sunday"], str(st))
    st, _ = call("POST", "/poll_votes", vic, {"poll_id": fest, "choice_id": ch["Bakery"]})
    check("Polls: nor vote for another poll's choice", st >= 400 and oq(f"select count(*) from weft.poll_votes where voter_id = '{V}'") == "0", str(st))
    st, _ = call("POST", "/poll_votes", vic, {"poll_id": fest, "choice_id": ch["Monday"], "voter_id": P})
    check("Polls: a vote cannot be cast in someone else's name", refused(st), str(st))
    st, _ = call("POST", "/poll_votes", vic, {"poll_id": fest, "choice_id": ch["Monday"]})
    st2, rows = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", vic, {"choice_id": ch["Monday"]})
    st3, rows3 = call("DELETE", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", olive)
    check("Polls: Vic votes; nobody, editors included, changes or withdraws someone else's vote", st == 201 and rows == [] and rows3 == []
          and oq(f"select choice_id from weft.poll_votes where poll_id = '{fest}' and voter_id = '{P}'") == ch["Sunday"], f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"voter_id": V})
    st2, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"poll_id": org})
    check("Polls: a vote's voter and poll cannot be changed", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("GET", f"/poll_votes?poll_id=eq.{fest}&select=voter_id", pat)
    check("Polls: members see who voted (Pat sees both #festival votes)", st == 200 and {r["voter_id"] for r in rows} == {P, V}, str(rows))
    st, body = call("PATCH", f"/poll_choices?id=eq.{ch['Sunday']}", olive, {"label": "Sunday afternoon"})
    st2, _ = call("DELETE", f"/poll_choices?id=eq.{ch['Sunday']}", olive)
    check("Polls: a choice someone voted for cannot be renamed or removed, even by an editor", refused(st) and refused(st2)
          and oq(f"select label from weft.poll_choices where id = '{ch['Sunday']}'") == "Sunday", f"{st} {st2} {body}")
    st, _ = call("PATCH", f"/poll_choices?id=eq.{ch['Saturday']}", olive, {"label": "Saturday morning"})
    st2, _ = call("PATCH", f"/poll_choices?id=eq.{ch['Saturday']}", olive, {"position": 5})
    check("Polls: one nobody voted for can be renamed, and any choice reordered (positive control)", st == 200 and st2 == 200
          and oq(f"select label from weft.poll_choices where id = '{ch['Saturday']}'") == "Saturday morning", f"{st} {st2}")
    st, _ = call("POST", "/poll_choices", olive, {"poll_id": uid("item", "porches"), "label": "on a table"})
    check("Polls: a choice cannot hang off an item that is not a poll", refused(st), str(st))
    # Closing
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", pat, {"closed": True})
    check("Polls: Pat (viewer) cannot close the poll", st == 200 and rows == [] and oq(f"select closed from weft.polls where id = '{fest}'") == "f", f"{st} {rows}")
    st, _ = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closed_by": P})
    st2, _ = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closed_at": "2020-01-01T00:00:00Z"})
    check("Polls: who closed it and when cannot be set by hand", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closed": True})
    check("Polls: Olive closes it; the database stamps who and when", st == 200 and rows and rows[0]["closed"] and rows[0]["closed_at"] and rows[0]["closed_by"] == O, f"{st} {rows}")
    st, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Monday"]})
    st2, _ = call("DELETE", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{V}", vic)
    st3, _ = call("POST", "/poll_votes", olive, {"poll_id": fest, "choice_id": ch["Monday"]})
    check("Polls: once closed, nobody votes, changes or withdraws a vote", refused(st) and refused(st2) and refused(st3)
          and oq(f"select count(*) from weft.poll_votes where poll_id = '{fest}'") == "2", f"{st} {st2} {st3}")
    st, _ = call("POST", "/poll_choices", olive, {"poll_id": fest, "label": "Late choice"})
    st2, _ = call("DELETE", f"/poll_choices?id=eq.{ch['Monday']}", olive)
    check("Polls: nor are its choices changed", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    check("Polls: the summary says closed", rows and (rows[0]["body_text"] or "").startswith("Poll, closed, 2 votes"), str(rows))
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closed": False})
    st2, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Monday"]})
    check("Polls: reopened, votes can change again", st == 200 and rows[0]["closed_at"] is None and st2 == 200, f"{st} {st2} {rows}")
    # Scope and the assistant
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/poll_choices?poll_id=in.({org},{fest})&select=poll_id", scoped)
    check("Polls: a #festival-scoped token sees only #festival choices", st == 200 and rows and {r["poll_id"] for r in rows} == {fest}, str(rows))
    st, _ = call("PATCH", f"/poll_votes?poll_id=eq.{org}&voter_id=eq.{O}", scoped, {"choice_id": ch["Taco truck"]})
    st2, _ = call("POST", "/poll_choices", scoped, {"poll_id": org, "label": "scoped"})
    check("Polls: nor changes Olive's vote or the choices in Organizers", oq(f"select choice_id from weft.poll_votes where poll_id = '{org}'") == ch["Bakery"] and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", mint("u-pub", scope="volunteers"), {"choice_id": ch["Sunday"]})
    check("Polls: Pat cannot vote through a token scoped to another channel", rows == [], f"{st} {rows}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/poll_votes?poll_id=eq.{org}&select=choice_id", helper)
    check("Polls: the assistant (for Olive) reads Organizers votes (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/poll_votes?poll_id=eq.{org}", helper)
    st2, _ = call("POST", "/poll_votes", helper, {"poll_id": fest, "choice_id": ch["Monday"]})
    st3, _ = call("DELETE", f"/poll_choices?id=eq.{ch['Taco truck']}", helper)
    st4, _ = call("PATCH", f"/polls?id=eq.{org}", helper, {"closed": True})
    check("Polls: the assistant cannot delete, cast, remove choices or close", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select count(*) from weft.poll_votes where poll_id = '{org}'") == "1", f"{st} {st2} {st3} {st4}")
    st, rows = call("GET", f"/audit?space_id=eq.{SID['festival']}&table_name=eq.poll_votes&select=op", pat)
    st2, rows2 = call("GET", f"/audit?space_id=eq.{SID['organizers']}&table_name=like.poll*&select=op", pat)
    check("Polls: vote changes are in the audit log, for members of the space only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-POLL-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-POLL-SECRET"})
    check("Polls: search finds the poll for Olive, not for Pat", any(r["id"] == org and r["kind"] == "poll" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Moves and deletes follow the space.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/poll_votes?poll_id=eq.{fest}&select=voter_id", pat)
    st3, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Saturday"]})
    check("Polls: a poll moved to Volunteers takes its choices and votes out of Pat's sight, and she can no longer change her vote",
          st == 200 and rows == [] and oq(f"select choice_id from weft.poll_votes where poll_id = '{fest}' and voter_id = '{P}'") == ch["Monday"], f"{st} {rows} {st3}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/poll_choices?poll_id=eq.{org}&select=id", pat)
    st3, _ = call("POST", "/poll_votes", pat, {"poll_id": org, "choice_id": ch["Taco truck"]})
    check("Polls: a poll moved into #festival becomes readable to Pat, and she can vote in it", st == 200 and len(rows) == 2 and st3 == 201, f"{st} {rows} {st3}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Polls: Pat cannot delete the poll", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    call("PATCH", f"/polls?id=eq.{org}", olive, {"closed": True})
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Polls: deleting a poll, even a closed one, deletes its state, choices and votes", st in (200, 204)
          and oq(f"select (select count(*) from weft.polls where id = '{org}') + (select count(*) from weft.poll_choices where poll_id = '{org}') + (select count(*) from weft.poll_votes where poll_id = '{org}')") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


# ---------------------------------------------------------------- forms
def forms():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org")
    oq = lambda sql: owner_sql(sql)
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "form", "title": "ORG-FORM-SECRET: caterer quotes"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "form", "title": "Festival form: volunteer T-shirts"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Forms: Olive (editor) makes forms in Organizers and #festival", org and fest, f"{st} {st2}")
    check("Forms: each form starts open", oq(f"select string_agg(closed::text, ',') from weft.forms where id in ('{org}', '{fest}')") == "false,false")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "form", "title": "x"})
    check("Forms: Pat (viewer) cannot make a form in #festival", refused(st), str(st))
    q = {}
    for form, specs in ((org, [("Quote", "short", [], True)]),
                        (fest, [("Name on the shirt", "short", [], True), ("Size", "choice", [" S", "M", "L", "M", ""], True), ("Anything else?", "long", [], False)])):
        for i, (label, kind, opts, req) in enumerate(specs):
            st, rows = call("POST", "/form_questions", olive, {"form_id": form, "label": f"  {label} ", "kind": kind, "options": opts, "required": req, "position": i})
            q[label] = rows[0] if st == 201 else None
    check("Forms: Olive adds questions (positive control), trimmed, choices cleaned", all(q.values()) and q["Quote"]["label"] == "Quote"
          and q["Size"]["options"] == ["S", "M", "L"] and q["Name on the shirt"]["options"] == [], str(q.get("Size")))
    q = {k: v["id"] for k, v in q.items()}
    st, _ = call("POST", "/form_questions", olive, {"form_id": fest, "label": "Empty choice", "kind": "choice", "options": [" "]})
    check("Forms: a choice question needs at least one choice", st == 400, str(st))
    st, _ = call("POST", "/form_questions", pat, {"form_id": fest, "label": "Pat's question"})
    st2, rows2 = call("PATCH", f"/form_questions?id=eq.{q['Size']}", pat, {"label": "pwned"})
    st3, rows3 = call("DELETE", f"/form_questions?id=eq.{q['Anything else?']}", pat)
    check("Forms: Pat (viewer) cannot add, change or remove questions", refused(st) and rows2 == [] and rows3 == []
          and oq(f"select count(*) from weft.form_questions where form_id = '{fest}'") == "3", f"{st} {st2} {st3}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/form_questions?form_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/forms?id=eq.{org}&select=id", tok)
        check(f"Forms: {who} gets no Organizers questions or form state", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, _ = call("POST", "/form_questions", olive, {"form_id": uid("item", "porches"), "label": "on a table"})
    check("Forms: a question cannot hang off an item that is not a form", refused(st), str(st))
    # Answering
    st, rows = call("POST", "/form_responses", olive, {"form_id": org, "answers": {q["Quote"]: "ORG-ANSWER-SECRET 1200"}})
    check("Forms: Olive answers in Organizers, and the database records her as the respondent", st == 201 and rows[0]["respondent_id"] == O, f"{st} {rows}")
    st, rows = call("GET", f"/form_responses?form_id=eq.{org}&select=id", pat)
    st2, rows2 = call("GET", "/form_responses?select=form_id", vic)
    check("Forms: Pat and Vic see no Organizers answers, not even by listing every answer", rows == [] and org not in {r["form_id"] for r in rows2 or []}, f"{rows} {rows2}")
    st, _ = call("POST", "/form_responses", pat, {"form_id": org, "answers": {q["Quote"]: "x"}})
    st2, _ = call("POST", "/form_responses", vic, {"form_id": org, "answers": {q["Quote"]: "x"}})
    check("Forms: Pat and Vic cannot answer in Organizers", refused(st) and refused(st2) and oq(f"select count(*) from weft.form_responses where form_id = '{org}'") == "1", f"{st} {st2}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    st2, rows2 = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows2[0]["body_text"] if rows2 else "") or ""
    check("Forms: the summary is hidden from Pat, and for Olive lists the questions and the count but no answers",
          rows == [] and "Form, open, 1 answer" in body and "Quote (required)" in body and "ORG-ANSWER-SECRET" not in body, f"{rows} {body!r}")
    # Viewers answer: one answer each, their own only, checked against the questions.
    st, body = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Size"]: "M"}})
    check("Forms: a required question left out is refused, with its name", st == 400 and "Name on the shirt" in json.dumps(body), f"{st} {body}")
    st, body = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Name on the shirt"]: "Pat", q["Size"]: "XXL"}})
    check("Forms: an answer that is not one of the choices is refused", st == 400, f"{st} {body}")
    st, body = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Name on the shirt"]: "Pat", q["Size"]: "M", q["Quote"]: "sneaky"}})
    check("Forms: an answer to another form's question is refused", st == 400, f"{st} {body}")
    st, body = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Name on the shirt"]: "x" * 301, q["Size"]: "M"}})
    st2, body2 = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Name on the shirt"]: 5, q["Size"]: "M"}})
    st3, body3 = call("POST", "/form_responses", pat, {"form_id": fest, "answers": ["Pat", "M"]})
    check("Forms: over-long, non-text and malformed answers are refused", st == 400 and st2 == 400 and st3 == 400, f"{st} {st2} {st3}")
    st, rows = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Name on the shirt"]: "  Pat  ", q["Size"]: "M", q["Anything else?"]: "  "}})
    check("Forms: Pat (viewer) answers in #festival; trimmed, blanks dropped, she is the respondent",
          st == 201 and rows[0]["respondent_id"] == P and rows[0]["answers"] == {q["Name on the shirt"]: "Pat", q["Size"]: "M"}, f"{st} {rows}")
    pat_resp = rows[0]["id"] if st == 201 else None
    st, body = call("POST", "/form_responses", pat, {"form_id": fest, "answers": {q["Name on the shirt"]: "Pat again", q["Size"]: "S"}})
    check("Forms: one answer per person: a second is refused", st == 409 and oq(f"select count(*) from weft.form_responses where form_id = '{fest}' and respondent_id = '{P}'") == "1", f"{st} {body}")
    st, rows = call("PATCH", f"/form_responses?id=eq.{pat_resp}", pat, {"answers": {q["Name on the shirt"]: "Pat", q["Size"]: "L"}})
    check("Forms: Pat changes her answer", st == 200 and len(rows or []) == 1 and rows[0]["answers"][q["Size"]] == "L", f"{st} {rows}")
    st, _ = call("POST", "/form_responses", vic, {"form_id": fest, "answers": {q["Name on the shirt"]: "Vic", q["Size"]: "S"}, "respondent_id": P})
    check("Forms: an answer cannot be given in someone else's name", refused(st), str(st))
    st, rows = call("POST", "/form_responses", vic, {"form_id": fest, "answers": {q["Name on the shirt"]: "VIC-PRIVATE", q["Size"]: "S"}})
    vic_resp = rows[0]["id"] if st == 201 else None
    st2, rows2 = call("PATCH", f"/form_responses?id=eq.{pat_resp}", vic, {"answers": {q["Name on the shirt"]: "pwned", q["Size"]: "S"}})
    st3, rows3 = call("DELETE", f"/form_responses?id=eq.{pat_resp}", olive)
    check("Forms: Vic answers; nobody, editors included, changes or withdraws someone else's answer", st == 201 and rows2 == [] and rows3 == []
          and oq(f"select answers->>'{q['Size']}' from weft.form_responses where id = '{pat_resp}'") == "L", f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/form_responses?id=eq.{pat_resp}", pat, {"respondent_id": V})
    st2, _ = call("PATCH", f"/form_responses?id=eq.{pat_resp}", pat, {"form_id": org})
    st3, _ = call("PATCH", f"/form_responses?id=eq.{pat_resp}", pat, {"created_at": "2020-01-01T00:00:00Z"})
    check("Forms: an answer's respondent, form and time cannot be changed", refused(st) and refused(st2) and refused(st3), f"{st} {st2} {st3}")
    # Who reads the answers: your own, or everyone's if you edit the space.
    st, rows = call("GET", f"/form_responses?form_id=eq.{fest}&select=respondent_id,answers", pat)
    check("Forms: Pat (viewer) reads only her own answer, not Vic's", st == 200 and [r["respondent_id"] for r in rows] == [P], str(rows))
    st, rows = call("GET", f"/form_responses?form_id=eq.{fest}&select=respondent_id", olive)
    st2, rows2 = call("GET", f"/form_responses?form_id=eq.{fest}&select=respondent_id", alex)
    check("Forms: Olive (editor) and Alex (owner) read every answer (positive control)", {r["respondent_id"] for r in rows} == {P, V} and len(rows2) == 2, f"{rows} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    check("Forms: the #festival summary Pat can read has the count, not Vic's answer", rows and "2 answers" in rows[0]["body_text"] and "VIC-PRIVATE" not in rows[0]["body_text"], str(rows))
    st, rows = call("POST", "/rpc/search", pat, {"p_q": "VIC-PRIVATE"})
    check("Forms: search does not find answers", st == 200 and rows == [], f"{st} {rows}")
    st, rows = call("GET", f"/audit?space_id=eq.{SID['festival']}&table_name=eq.form_responses&select=op,old_row", pat)
    check("Forms: answer changes are in the audit log, without the answers (members read it)", len(rows or []) >= 1
          and all("answers" not in r["old_row"] for r in rows) and "VIC-PRIVATE" not in json.dumps(rows), str(rows)[:300])
    st, rows = call("GET", f"/audit?space_id=eq.{SID['organizers']}&table_name=like.form*&select=op", pat)
    check("Forms: Pat reads no Organizers form audit", rows == [], str(rows))
    # Questions lock once answered.
    st, body = call("PATCH", f"/form_questions?id=eq.{q['Size']}", olive, {"options": ["S", "M"]})
    st2, _ = call("PATCH", f"/form_questions?id=eq.{q['Name on the shirt']}", olive, {"label": "Nickname"})
    st3, _ = call("DELETE", f"/form_questions?id=eq.{q['Anything else?']}", olive)
    check("Forms: once answered, questions cannot be changed or removed, even by an editor", refused(st) and refused(st2) and refused(st3)
          and oq(f"select count(*) from weft.form_questions where form_id = '{fest}'") == "3", f"{st} {st2} {st3} {body}")
    st, _ = call("PATCH", f"/form_questions?id=eq.{q['Size']}", olive, {"position": 9})
    st2, rows2 = call("POST", "/form_questions", olive, {"form_id": fest, "label": "Pick-up day", "kind": "choice", "options": ["Friday", "Saturday"], "position": 10})
    check("Forms: but they can be reordered and new ones added (positive control)", st == 200 and st2 == 201, f"{st} {st2}")
    # Closing
    st, rows = call("PATCH", f"/forms?id=eq.{fest}", pat, {"closed": True})
    check("Forms: Pat (viewer) cannot close the form", st == 200 and rows == [] and oq(f"select closed from weft.forms where id = '{fest}'") == "f", f"{st} {rows}")
    st, _ = call("PATCH", f"/forms?id=eq.{fest}", olive, {"closed_by": P})
    st2, _ = call("PATCH", f"/forms?id=eq.{fest}", olive, {"closed_at": "2020-01-01T00:00:00Z"})
    check("Forms: who closed it and when cannot be set by hand", refused(st) and refused(st2), f"{st} {st2}")
    st, rows = call("PATCH", f"/forms?id=eq.{fest}", olive, {"closed": True})
    check("Forms: Olive closes it; the database stamps who and when", st == 200 and rows and rows[0]["closed"] and rows[0]["closed_at"] and rows[0]["closed_by"] == O, f"{st} {rows}")
    st, _ = call("PATCH", f"/form_responses?id=eq.{pat_resp}", pat, {"answers": {q["Name on the shirt"]: "Pat", q["Size"]: "S"}})
    st2, _ = call("DELETE", f"/form_responses?id=eq.{vic_resp}", vic)
    st3, _ = call("POST", "/form_responses", olive, {"form_id": fest, "answers": {q["Name on the shirt"]: "Olive", q["Size"]: "S"}})
    st4, _ = call("POST", "/form_questions", olive, {"form_id": fest, "label": "Late question"})
    check("Forms: once closed, nobody answers, changes or withdraws an answer, nor adds a question", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select count(*) from weft.form_responses where form_id = '{fest}'") == "2", f"{st} {st2} {st3} {st4}")
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    check("Forms: the summary says closed", rows and (rows[0]["body_text"] or "").startswith("Form, closed, 2 answers"), str(rows))
    st, rows = call("PATCH", f"/forms?id=eq.{fest}", olive, {"closed": False})
    st2, _ = call("DELETE", f"/form_responses?id=eq.{vic_resp}", vic)
    check("Forms: reopened, Vic can withdraw his answer", st == 200 and rows[0]["closed_at"] is None and st2 in (200, 204)
          and oq(f"select count(*) from weft.form_responses where id = '{vic_resp}'") == "0", f"{st} {st2} {rows}")
    # Scope and the assistant
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/form_questions?form_id=in.({org},{fest})&select=form_id", scoped)
    st2, rows2 = call("GET", f"/form_responses?form_id=eq.{org}&select=id", scoped)
    check("Forms: a #festival-scoped token sees only #festival questions and no Organizers answers", st == 200 and rows and {r["form_id"] for r in rows} == {fest} and rows2 == [], f"{rows} {rows2}")
    st, rows = call("PATCH", f"/form_responses?form_id=eq.{org}&respondent_id=eq.{O}", scoped, {"answers": {q["Quote"]: "scoped"}})
    st2, _ = call("POST", "/form_questions", scoped, {"form_id": org, "label": "scoped"})
    check("Forms: nor changes Olive's Organizers answer or adds questions there", rows == [] and refused(st2)
          and oq(f"select answers->>'{q['Quote']}' from weft.form_responses where form_id = '{org}'") == "ORG-ANSWER-SECRET 1200", f"{st} {st2}")
    st, rows = call("PATCH", f"/form_responses?id=eq.{pat_resp}", mint("u-pub", scope="volunteers"), {"answers": {q["Name on the shirt"]: "Pat", q["Size"]: "S"}})
    check("Forms: Pat cannot answer through a token scoped to another channel", rows == [], f"{st} {rows}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/form_responses?form_id=eq.{org}&select=answers", helper)
    st2, rows2 = call("GET", f"/form_responses?form_id=eq.{fest}&select=respondent_id", mint("u-pub", assistant=True))
    check("Forms: the assistant reads answers as the person would: all for Olive (positive control), only her own for Pat",
          st == 200 and len(rows) == 1 and [r["respondent_id"] for r in rows2] == [P], f"{rows} {rows2}")
    st, _ = call("DELETE", f"/form_responses?form_id=eq.{org}", helper)
    st2, _ = call("POST", "/form_responses", helper, {"form_id": fest, "answers": {q["Name on the shirt"]: "Weft", q["Size"]: "S"}})
    st3, _ = call("DELETE", f"/form_questions?id=eq.{q['Quote']}", helper)
    st4, _ = call("PATCH", f"/forms?id=eq.{org}", helper, {"closed": True})
    check("Forms: the assistant cannot delete, answer, remove questions or close", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select count(*) from weft.form_responses where form_id = '{org}'") == "1", f"{st} {st2} {st3} {st4}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-FORM-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-FORM-SECRET"})
    check("Forms: search finds the form for Olive, not for Pat", any(r["id"] == org and r["kind"] == "form" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Moves and deletes follow the space.
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/form_responses?form_id=eq.{fest}&select=id", pat)
    st3, rows3 = call("PATCH", f"/form_responses?id=eq.{pat_resp}", pat, {"answers": {q["Name on the shirt"]: "Pat", q["Size"]: "S"}})
    st4, rows4 = call("GET", f"/form_responses?form_id=eq.{fest}&select=id", vic)
    check("Forms: a form moved to Volunteers takes even Pat's own answer out of her sight, and Vic (now an editor of it) reads it",
          st == 200 and rows == [] and rows3 == [] and len(rows4) == 1
          and oq(f"select answers->>'{q['Size']}' from weft.form_responses where id = '{pat_resp}'") == "L", f"{st} {rows} {st3} {rows4}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/form_questions?form_id=eq.{org}&select=id", pat)
    st3, rows3 = call("GET", f"/form_responses?form_id=eq.{org}&select=id", pat)
    st4, _ = call("POST", "/form_responses", pat, {"form_id": org, "answers": {q["Quote"]: "Pat's quote"}})
    check("Forms: a form moved into #festival: Pat reads its questions, not Olive's answer, and can answer", st == 200 and len(rows) == 1 and rows3 == [] and st4 == 201, f"{st} {rows} {rows3} {st4}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Forms: Pat cannot delete the form", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    call("PATCH", f"/forms?id=eq.{org}", olive, {"closed": True})
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Forms: deleting a form, even a closed one, deletes its state, questions and answers", st in (200, 204)
          and oq(f"select (select count(*) from weft.forms where id = '{org}') + (select count(*) from weft.form_questions where form_id = '{org}') + (select count(*) from weft.form_responses where form_id = '{org}')") == "0", str(st))
    call("DELETE", f"/items?id=eq.{fest}", olive)


# ---------------------------------------------------------------- people (channels, members, accounts)
TEST_SIGNIN = os.environ.get("WEFT_SIGNIN", "http://127.0.0.1:3211/auth/test-login")


def profiles():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = (uid("user", k) for k in ("u-pub", "u-vol", "u-org", "u-alex"))
    L, LS = uid("user", "u-lone"), uid("space", "personal-u-lone")
    oq = lambda sql: owner_sql(sql)
    up = "resolution=merge-duplicates,return=representation"
    prof = lambda who: oq(f"select coalesce(role, '') || '|' || array_to_string(skills, ',') from weft.profiles where user_id = '{who}'")
    # Your own profile: anyone writes theirs, whatever their role in any space.
    st, rows = call("POST", "/profiles?on_conflict=user_id", olive, {"role": "  Festival lead ", "skills": [" First Aid ", "first aid", "Van   licence", ""],
                                                                     "reach": " Message me in Weft ", "availability": "Weekday evenings"}, prefer=up)
    check("Profiles: Olive saves her own profile (positive control), user_id set by the database",
          st in (200, 201) and rows and rows[0]["user_id"] == O, f"{st} {rows}")
    check("Profiles: text is trimmed and skills tidied (lowercase, spaces collapsed, no repeats or blanks)",
          rows and rows[0]["role"] == "Festival lead" and rows[0]["skills"] == ["first aid", "van licence"] and rows[0]["reach"] == "Message me in Weft", str(rows))
    st, rows = call("POST", "/profiles?on_conflict=user_id", olive, {"role": "Festival lead", "skills": ["first aid", "van licence", "PROFILE-SECRET-SKILL"],
                                                                     "reach": "Message me in Weft", "availability": "Weekday evenings"}, prefer=up)
    check("Profiles: saving again updates the same row", st in (200, 201) and oq(f"select count(*) from weft.profiles where user_id = '{O}'") == "1"
          and "profile-secret-skill" in prof(O), f"{st} {rows}")
    st, rows = call("POST", "/profiles?on_conflict=user_id", pat, {"role": "Volunteer", "skills": ["spanish"]}, prefer=up)
    check("Profiles: Pat (a viewer everywhere) saves her own profile too (positive control)", st in (200, 201) and rows and rows[0]["user_id"] == P, f"{st} {rows}")
    # Forging the owner.
    st, _ = call("POST", "/profiles", pat, {"user_id": O, "role": "pwned"})
    st2, _ = call("POST", "/profiles", vic, {"user_id": V, "role": "explicit own id"})
    check("Profiles: nobody writes a profile with a user_id, not even their own (it is never granted)", refused(st) and refused(st2) and prof(O).startswith("Festival lead|"), f"{st} {st2}")
    st, _ = call("PATCH", f"/profiles?user_id=eq.{P}", pat, {"user_id": V})
    st2, _ = call("PATCH", f"/profiles?user_id=eq.{P}", pat, {"updated_at": "2020-01-01T00:00:00Z"})
    check("Profiles: nor can a profile be handed to someone else or its time set", refused(st) and refused(st2) and oq(f"select count(*) from weft.profiles where user_id = '{V}'") == "0", f"{st} {st2}")
    # Only the person changes it: not a co-member, not an owner of every space, not an admin.
    for who, tok in (("Pat", pat), ("Vic", vic), ("Alex (admin and owner)", alex)):
        st, rows = call("PATCH", f"/profiles?user_id=eq.{O}", tok, {"role": "pwned"})
        st2, rows2 = call("DELETE", f"/profiles?user_id=eq.{O}", tok)
        check(f"Profiles: {who} cannot change or clear Olive's profile", rows == [] and rows2 == [] and prof(O).startswith("Festival lead|"), f"{st} {rows} {st2} {rows2}")
    # Reading: people who share a space.
    st, rows = call("GET", f"/profiles?user_id=eq.{O}&select=role,skills", pat)
    check("Profiles: Pat reads Olive's profile (they share #festival; positive control)", st == 200 and len(rows) == 1 and "profile-secret-skill" in rows[0]["skills"], str(rows))
    st, rows = call("GET", "/users?id=eq." + P + "&select=display_name,profile:profiles(role)", olive)
    check("Profiles: Olive reads Pat's profile through users (as the app does)", st == 200 and rows and (rows[0]["profile"] or {}).get("role") == "Volunteer", str(rows))
    # Someone who shares no space: a fresh account outside every channel (not even help).
    oq(f"insert into weft.users (id, email, display_name) values ('{L}', 'lone.profile@example.com', 'Lone') on conflict do nothing")
    oq(f"insert into weft.spaces (id, kind, name, created_by) values ('{LS}', 'personal', 'Personal', '{L}') on conflict do nothing")
    oq(f"insert into weft.members (space_id, user_id, role) values ('{LS}', '{L}', 'owner') on conflict do nothing")
    lone = mint("u-lone")
    try:
        st, rows = call("POST", "/profiles?on_conflict=user_id", lone, {"role": "LONE-ROLE-SECRET", "skills": ["welding"]}, prefer=up)
        check("Profiles: an account in no channel still saves its own profile", st in (200, 201), f"{st} {rows}")
        st, rows = call("GET", "/profiles?select=user_id", lone)
        check("Profiles: it sees only its own profile, nobody else's", st == 200 and [r["user_id"] for r in rows] == [L], str(rows))
        hidden = []
        for who, tok in (("Olive", olive), ("Pat", pat), ("Alex", alex)):
            st, rows = call("GET", f"/profiles?or=(user_id.eq.{L},role.eq.LONE-ROLE-SECRET,skills.cs.{{welding}})&select=user_id", tok)
            hidden.append(st == 200 and rows == [])
        check("Profiles: nobody who shares no space with it sees its profile, by id, role or skill (Olive, Pat, Alex)", all(hidden), str(hidden))
        oq(f"insert into weft.members (space_id, user_id, role) values ('{SID['volunteers']}', '{L}', 'viewer')")
        st, rows = call("GET", f"/profiles?user_id=eq.{L}&select=role", olive)
        st2, rows2 = call("GET", f"/profiles?user_id=eq.{L}&select=role", pat)
        st3, rows3 = call("GET", f"/profiles?user_id=eq.{O}&select=role", lone)
        check("Profiles: once it joins Volunteers, Olive (in Volunteers) sees it and it sees Olive; Pat (not in Volunteers) still does not",
              len(rows or []) == 1 and rows2 == [] and len(rows3 or []) == 1, f"{rows} {rows2} {rows3}")
        oq(f"delete from weft.members where space_id = '{SID['volunteers']}' and user_id = '{L}'")
        st, rows = call("GET", f"/profiles?user_id=eq.{L}&select=role", olive)
        check("Profiles: after it leaves Volunteers, Olive no longer sees it", st == 200 and rows == [], str(rows))
    finally:
        oq(f"delete from weft.spaces where id = '{LS}'")
        oq(f"delete from weft.users where id = '{L}'")
    check("Profiles: deleting an account deletes its profile", oq(f"select count(*) from weft.profiles where user_id = '{L}'") == "0")
    # A channel-scoped token: only that channel's members, and no writes.
    scoped = mint("u-org", scope="organizers")
    st, rows = call("GET", "/profiles?select=user_id", scoped)
    check("Profiles: an Organizers-scoped token sees only Organizers members' profiles (Olive, not Pat)",
          st == 200 and O in {r["user_id"] for r in rows} and P not in {r["user_id"] for r in rows}, str(rows))
    pscoped = mint("u-pub", scope="festival")
    st, rows = call("GET", f"/profiles?user_id=eq.{O}&select=user_id", pscoped)
    check("Profiles: a #festival-scoped token for Pat still sees Olive (both in #festival; positive control)", st == 200 and len(rows) == 1, str(rows))
    st, rows = call("PATCH", f"/profiles?user_id=eq.{O}", scoped, {"role": "via a scoped token"})
    st2, _ = call("POST", "/profiles?on_conflict=user_id", pscoped, {"role": "via a scoped token"}, prefer=up)
    st3, rows3 = call("DELETE", f"/profiles?user_id=eq.{O}", scoped)
    check("Profiles: a channel-scoped token cannot change, save or clear even its own person's profile",
          rows == [] and refused(st2) and rows3 == [] and prof(O).startswith("Festival lead|") and prof(P).startswith("Volunteer|"), f"{st} {st2} {st3}")
    # The assistant reads, never writes.
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/profiles?user_id=eq.{P}&select=role", helper)
    check("Profiles: the assistant (for Olive) can read Pat's profile (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/profiles?user_id=eq.{O}", helper)
    st2, _ = call("PATCH", f"/profiles?user_id=eq.{O}", helper, {"role": "by the assistant"})
    st3, _ = call("POST", "/profiles", helper, {"role": "by the assistant"})
    check("Profiles: the assistant cannot delete, change or add a profile", refused(st) and refused(st2) and refused(st3) and prof(O).startswith("Festival lead|"), f"{st} {st2} {st3}")
    # A disabled account reads and writes nothing.
    oq(f"update weft.users set disabled = true where id = '{P}'")
    try:
        st, rows = call("GET", "/profiles?select=user_id", pat)
        st2, rows2 = call("PATCH", f"/profiles?user_id=eq.{P}", pat, {"role": "while disabled"})
        check("Profiles: a disabled account reads no profiles and cannot change its own", rows == [] and rows2 == [] and prof(P).startswith("Volunteer|"), f"{st} {rows} {st2}")
    finally:
        oq(f"update weft.users set disabled = false where id = '{P}'")
    # Limits.
    bad = [{"skills": [f"s{i}" for i in range(13)]}, {"skills": ["x" * 41]}, {"role": "r" * 81}, {"reach": "r" * 301}, {"availability": "a" * 301}]
    sts = [call("POST", "/profiles?on_conflict=user_id", vic, b, prefer=up)[0] for b in bad]
    check("Profiles: 13 skills, a skill over 40 characters, a role over 80 or reach or availability over 300 are refused", all(x == 400 for x in sts), str(sts))
    st, rows = call("POST", "/profiles?on_conflict=user_id", vic, {"skills": [f"s{i}" for i in range(12)] + ["s1", " S2 "]}, prefer=up)
    check("Profiles: 12 skills plus repeats are fine (repeats are dropped before counting)", st in (200, 201) and rows and len(rows[0]["skills"]) == 12, f"{st} {rows}")
    # Audit: under the person's personal space, so only they read the history.
    call("PATCH", f"/profiles?user_id=eq.{O}", olive, {"availability": "Weekends only"})
    st, rows = call("GET", f"/audit?table_name=eq.profiles&row_id=eq.{O}&select=op,space_id", olive)
    st2, rows2 = call("GET", f"/audit?table_name=eq.profiles&row_id=eq.{O}&select=op", alex)
    st3, rows3 = call("GET", f"/audit?table_name=eq.profiles&row_id=eq.{O}&select=op", pat)
    check("Profiles: a change is audited under Olive's personal space, readable by her (positive control) and not by Alex or Pat",
          len(rows or []) >= 1 and all(r["space_id"] == SID["personal-u-org"] for r in rows) and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
    # Clearing your own profile.
    st, _ = call("DELETE", f"/profiles?user_id=eq.{V}", vic)
    check("Profiles: Vic clears his own profile (positive control)", st in (200, 204) and oq(f"select count(*) from weft.profiles where user_id = '{V}'") == "0", str(st))
    oq(f"delete from weft.profiles where user_id in ('{O}', '{P}')")


def who_knows_what():
    """Who knows what: weft.skill_holders answers "who has this skill?" (and in which shared space) from profiles."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = (uid("user", k) for k in ("u-pub", "u-vol", "u-org", "u-alex"))
    R, RS = uid("user", "u-orla"), uid("space", "personal-u-orla")
    oq = lambda sql: owner_sql(sql)
    up = "resolution=merge-duplicates,return=minimal"
    ask = lambda tok, q: call("GET", f"/skill_holders?{q}&select=skill,user_id,space_id", tok)
    people = lambda rows: sorted({r["user_id"] for r in rows or []})
    # Profiles, written by their owners as the app does.
    for tok, body in ((olive, {"role": "Festival lead", "skills": ["first aid", "van licence"]}), (vic, {"skills": ["Van licence"]}),
                      (alex, {"skills": ["forklift"]}), (pat, {"skills": ["face painting"]})):
        call("POST", "/profiles?on_conflict=user_id", tok, body, prefer=up)
    # Orla: only in Organizers (with Alex and Olive), so Pat and Vic share no space with her.
    oq(f"insert into weft.users (id, email, display_name) values ('{R}', 'orla.skills@example.com', 'Orla') on conflict do nothing")
    oq(f"insert into weft.spaces (id, kind, name, created_by) values ('{RS}', 'personal', 'Personal', '{R}') on conflict do nothing")
    oq(f"insert into weft.members (space_id, user_id, role) values ('{RS}', '{R}', 'owner'), ('{SID['organizers']}', '{R}', 'viewer') on conflict do nothing")
    oq(f"insert into weft.profiles (user_id, skills) values ('{R}', '{{WKW-ORG-SECRET-SKILL,van licence}}') on conflict (user_id) do update set skills = excluded.skills")
    try:
        st, rows = ask(pat, "skill=eq.van%20licence")
        check("Who knows what: Pat asks who has a van licence and gets Olive and Vic (positive control), not Orla",
              st == 200 and people(rows) == sorted([O, V]), f"{st} {rows}")
        check("Who knows what: Pat's answer names only spaces she is in", rows and {KEY_OF.get(r["space_id"]) for r in rows} <= set(SPACES["u-pub"]), str(rows))
        st, rows = ask(pat, f"space_id=eq.{SID['organizers']}")
        st2, rows2 = ask(pat, "skill=eq.wkw-org-secret-skill")
        st3, rows3 = ask(pat, f"user_id=eq.{R}")
        check("Who knows what: Pat (not in Organizers) reads no Organizers row, by space, by skill or by person",
              st == 200 and rows == [] and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
        st, rows = ask(vic, "skill=eq.wkw-org-secret-skill")
        check("Who knows what: nor does Vic (Volunteers and #festival)", st == 200 and rows == [], str(rows))
        st, rows = ask(olive, f"skill=eq.wkw-org-secret-skill&space_id=eq.{SID['organizers']}")
        check("Who knows what: Olive (in Organizers) finds Orla there (positive control)", st == 200 and people(rows) == [R], str(rows))
        st, rows = ask(olive, f"skill=eq.van%20licence&space_id=eq.{SID['festival']}")
        check("Who knows what: by channel: in #festival, Olive finds herself and Vic with a van licence, not Orla (not in #festival)",
              st == 200 and people(rows) == sorted([O, V]), str(rows))
        st, rows = ask(olive, f"skill=eq.van%20licence&space_id=eq.{SID['volunteers']}")
        check("Who knows what: in Volunteers, the same two (Pat's face painting is not there)", st == 200 and people(rows) == sorted([O, V]), str(rows))
        st, rows = ask(olive, f"skill=eq.face%20painting&space_id=eq.{SID['volunteers']}")
        st2, rows2 = ask(olive, "skill=eq.face%20painting")
        check("Who knows what: Pat is not in Volunteers, so face painting is found only through a space she is in",
              rows == [] and people(rows2) == [P] and {KEY_OF.get(r["space_id"]) for r in rows2} <= set(SPACES["u-pub"]), f"{rows} {rows2}")
        # A channel-scoped token: only its channel.
        scoped = mint("u-org", scope="festival")
        st, rows = ask(scoped, "skill=eq.van%20licence")
        st2, rows2 = ask(scoped, "skill=eq.wkw-org-secret-skill")
        check("Who knows what: a #festival-scoped token for Olive sees only #festival rows (Olive and Vic), nothing of Organizers",
              st == 200 and people(rows) == sorted([O, V]) and {r["space_id"] for r in rows} == {SID["festival"]} and rows2 == [], f"{rows} {rows2}")
        # Nobody writes through the view; the assistant reads only. Postgres refuses before anything happens:
        # no write grant (42501) or "cannot change a view over several tables" (55000), as for weft.records.
        no = lambda r: r[0] in (401, 403, 500) and isinstance(r[1], dict) and r[1].get("code") in ("42501", "55000")
        w = [call("POST", "/skill_holders", olive, {"skill": "forged", "user_id": P, "space_id": SID["festival"]}),
             call("PATCH", f"/skill_holders?user_id=eq.{V}", olive, {"skill": "forged"}),
             call("DELETE", f"/skill_holders?user_id=eq.{V}", olive)]
        check("Who knows what: nobody adds, changes or removes a skill through the view (Olive, an editor)", all(no(r) for r in w)
              and oq(f"select array_to_string(skills, ',') from weft.profiles where user_id = '{V}'") == "van licence", str([(r[0], r[1].get("code") if isinstance(r[1], dict) else r[1]) for r in w]))
        helper = mint("u-pub", assistant=True)
        st, rows = ask(helper, "skill=eq.van%20licence")
        d = call("DELETE", f"/skill_holders?user_id=eq.{V}", helper)
        check("Who knows what: the assistant (for Pat) reads the same answer (positive control) and cannot delete",
              st == 200 and people(rows) == sorted([O, V]) and no(d) and oq(f"select count(*) from weft.profiles where user_id = '{V}'") == "1", f"{st} {rows} {d}")
        # Authorship: a skill shows only because its owner wrote it.
        call("PATCH", f"/profiles?user_id=eq.{O}", pat, {"skills": ["forged by pat"]})
        st, rows = ask(olive, "skill=eq.forged%20by%20pat")
        check("Who knows what: Pat cannot put a skill on Olive's profile, so none shows", st == 200 and rows == [], str(rows))
        # It follows the spaces and the accounts.
        oq(f"delete from weft.members where space_id = '{SID['organizers']}' and user_id = '{R}'")
        st, rows = ask(olive, "skill=eq.wkw-org-secret-skill")
        check("Who knows what: once Orla leaves Organizers, Olive no longer finds her", st == 200 and rows == [], str(rows))
        oq(f"update weft.users set disabled = true where id = '{V}'")
        try:
            st, rows = ask(pat, "skill=eq.van%20licence")
            st2, rows2 = ask(vic, "skill=eq.van%20licence")
            check("Who knows what: a disabled account is not listed, and reads nothing itself", people(rows) == [O] and rows2 == [], f"{rows} {rows2}")
        finally:
            oq(f"update weft.users set disabled = false where id = '{V}'")
        st, _ = call("DELETE", f"/profiles?user_id=eq.{O}", olive)
        st2, rows = ask(pat, "skill=eq.van%20licence")
        check("Who knows what: Olive clears her profile and her skills are gone from every answer (positive control for the delete)",
              st in (200, 204) and people(rows) == [V], f"{st} {rows}")
    finally:
        oq(f"delete from weft.spaces where id = '{RS}'")
        oq(f"delete from weft.users where id = '{R}'")
        oq(f"delete from weft.profiles where user_id in ('{O}', '{P}', '{V}', '{A}')")


def kudos_on_profiles():
    """Kudos on profiles: weft.kudos_received numbers and counts a person's kudos only from channels the caller is in."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = (uid("user", k) for k in ("u-pub", "u-vol", "u-org", "u-alex"))
    oq = lambda sql: owner_sql(sql)
    sel = "id,space_id,message,n,received,created_by"
    ask = lambda tok, q="": call("GET", f"/kudos_received?to_user=eq.{O}&n=lte.3&order=n&select={sel}{q}", tok)
    ids = lambda rows: [r["id"] for r in rows or []]
    check("Kudos on profiles: Olive starts with no kudos (the Kudos checks tidy up after themselves)",
          oq(f"select count(*) from weft.kudos where to_user = '{O}'") == "0")
    made = {}
    # Oldest first: one in #festival (Alex), one in Volunteers (Vic, an editor there), three in Organizers (Alex).
    for key, tok, space, msg in (("fest", alex, "festival", "Thanks for the stage plan"), ("vol", vic, "volunteers", "Thanks for the rota"),
                                 ("org1", alex, "organizers", "KOP-ORG-SECRET budget"), ("org2", alex, "organizers", "KOP-ORG-SECRET sponsors"),
                                 ("org3", alex, "organizers", "KOP-ORG-SECRET contract")):
        st, rows = call("POST", "/kudos", tok, {"space_id": SID[space], "to_user": O, "message": msg})
        made[key] = rows[0]["id"] if st == 201 else None
    check("Kudos on profiles: five kudos for Olive are given in three channels (setup)", all(made.values()), str(made))
    try:
        st, rows = ask(olive)
        check("Kudos on profiles: Olive sees her newest three (the Organizers ones) and 5 in all (positive control)",
              st == 200 and ids(rows) == [made["org3"], made["org2"], made["org1"]] and [r["n"] for r in rows] == [1, 2, 3]
              and {r["received"] for r in rows} == {5}, f"{st} {rows}")
        st, rows = ask(pat)
        check("Kudos on profiles: Pat (only #festival) sees only the #festival kudos, as her newest and 1 in all",
              st == 200 and ids(rows) == [made["fest"]] and rows[0]["n"] == 1 and rows[0]["received"] == 1, f"{st} {rows}")
        st, rows = call("GET", f"/kudos_received?message=like.*KOP-ORG*&select=id", pat)
        st2, rows2 = call("GET", f"/kudos_received?space_id=eq.{SID['organizers']}&select=id,received", pat)
        check("Kudos on profiles: Pat reads no Organizers kudos, by text or by channel, and no count of them", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
        st, rows = ask(vic)
        check("Kudos on profiles: Vic (#festival and Volunteers) sees those two, newest first, 2 in all",
              st == 200 and ids(rows) == [made["vol"], made["fest"]] and {r["received"] for r in rows} == {2}, f"{st} {rows}")
        st, rows = call("GET", f"/kudos_received?to_user=eq.{O}&select=id,from:users!created_by(display_name)&order=n&limit=1", pat)
        check("Kudos on profiles: Pat reads who gave hers (positive control for the name)",
              st == 200 and len(rows) == 1 and rows[0]["from"] and rows[0]["from"]["display_name"], f"{st} {rows}")
        # A channel-scoped token: only its channel.
        scoped = mint("u-org", scope="festival")
        st, rows = ask(scoped)
        check("Kudos on profiles: a #festival-scoped token for Olive sees only the #festival kudos, 1 in all",
              st == 200 and ids(rows) == [made["fest"]] and rows[0]["received"] == 1, f"{st} {rows}")
        # Nobody writes through the view; the assistant reads only.
        no = lambda r: r[0] in (401, 403, 500) and isinstance(r[1], dict) and r[1].get("code") in ("42501", "55000")
        w = [call("POST", "/kudos_received", alex, {"space_id": SID["festival"], "to_user": O, "message": "through the view"}),
             call("PATCH", f"/kudos_received?id=eq.{made['fest']}", alex, {"message": "pwned"}),
             call("DELETE", f"/kudos_received?id=eq.{made['fest']}", alex)]
        check("Kudos on profiles: nobody gives, rewords or deletes a kudos through the view (Alex, who gave it and owns #festival)",
              all(no(r) for r in w) and oq(f"select message from weft.kudos where id = '{made['fest']}'") == "Thanks for the stage plan",
              str([(r[0], r[1].get("code") if isinstance(r[1], dict) else r[1]) for r in w]))
        helper = mint("u-pub", assistant=True)
        st, rows = ask(helper)
        d = call("DELETE", f"/kudos_received?id=eq.{made['fest']}", helper)
        d2 = call("DELETE", f"/kudos?id=eq.{made['fest']}", helper)
        check("Kudos on profiles: the assistant (for Pat) reads the same one kudos (positive control) and cannot delete it",
              st == 200 and ids(rows) == [made["fest"]] and no(d) and refused(d2[0])
              and oq(f"select count(*) from weft.kudos where id = '{made['fest']}'") == "1", f"{st} {rows} {d} {d2[0]}")
        # Authorship: who gave it is the database's answer, not the client's.
        st, _ = call("POST", "/kudos", vic, {"space_id": SID["volunteers"], "to_user": O, "message": "forged", "created_by": A})
        st2, rows2 = ask(olive)
        check("Kudos on profiles: Vic cannot give one in Alex's name, so Olive's newest stay Alex's",
              refused(st) and {r["created_by"] for r in rows2} == {A} and {r["received"] for r in rows2} == {5}, f"{st} {rows2}")
        # Deletes follow: Alex deletes an Organizers kudos, and the next one moves up for Olive; Pat's view is unchanged.
        st, _ = call("DELETE", f"/kudos?id=eq.{made['org3']}", alex)
        st2, rows2 = ask(olive)
        st3, rows3 = ask(pat)
        check("Kudos on profiles: a deleted kudos leaves Olive's profile, the Volunteers one moves up, 4 in all; Pat still sees her one",
              st in (200, 204) and ids(rows2) == [made["org2"], made["org1"], made["vol"]] and {r["received"] for r in rows2} == {4}
              and ids(rows3) == [made["fest"]], f"{rows2} {rows3}")
        # Membership decides: a new channel with Pat in it, then without her.
        st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "kudos on profiles test"})
        call("POST", "/members", olive, {"space_id": ch, "user_id": A, "role": "editor"}, prefer="return=minimal")
        call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
        st, rows = call("POST", "/kudos", alex, {"space_id": ch, "to_user": O, "message": "Thanks for setting this up"})
        cn = rows[0]["id"] if st == 201 else None
        st, rows = ask(pat)
        check("Kudos on profiles: added to a new channel, Pat sees its kudos for Olive on top, 2 in all (positive control)",
              cn and ids(rows) == [cn, made["fest"]] and {r["received"] for r in rows} == {2}, f"{st} {rows}")
        call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
        st, rows = ask(pat)
        check("Kudos on profiles: removed from it, Pat no longer sees that kudos or counts it", st == 200 and ids(rows) == [made["fest"]]
              and rows[0]["received"] == 1, f"{st} {rows}")
        call("DELETE", f"/spaces?id=eq.{ch}", olive)
        st, rows = ask(olive)
        check("Kudos on profiles: deleting the channel takes its kudos off Olive's profile", st == 200 and cn not in ids(rows)
              and {r["received"] for r in rows} == {4}, f"{st} {rows}")
        # A disabled account reads nothing.
        oq(f"update weft.users set disabled = true where id = '{V}'")
        try:
            st, rows = ask(vic)
            check("Kudos on profiles: a disabled account reads no kudos", rows in ([], None) or refused(st), f"{st} {rows}")
        finally:
            oq(f"update weft.users set disabled = false where id = '{V}'")
    finally:
        oq(f"delete from weft.kudos where to_user = '{O}'")


def test_signin(email):
    req = urllib.request.Request(TEST_SIGNIN, method="POST", data=json.dumps({"email": email}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def people():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = (uid("user", k) for k in ("u-pub", "u-vol", "u-org", "u-alex"))
    # Channels and members
    st, ch = call("POST", "/rpc/create_channel", pat, {"p_name": "  Pat club "})
    check("People: anyone can create a channel", st == 200 and isinstance(ch, str), f"{st} {ch}")
    check("People: its name is trimmed", owner_sql(f"select name from weft.spaces where id = '{ch}'") == "Pat club")
    st, _ = call("POST", "/rpc/create_channel", pat, {"p_name": "x" * 61})
    check("People: a name over 60 characters is refused", st == 400, str(st))
    st, rows = call("GET", f"/members?space_id=eq.{ch}&select=user_id,role", pat)
    check("People: the creator becomes its owner", rows == [{"user_id": P, "role": "owner"}], str(rows))
    st, _ = call("POST", "/members", pat, {"space_id": ch, "user_id": V, "role": "viewer"}, prefer="return=minimal")
    check("People: the owner adds someone", st == 201, str(st))
    st, _ = call("POST", "/members", vic, {"space_id": ch, "user_id": O, "role": "viewer"}, prefer="return=minimal")
    check("People: a viewer cannot add people", refused(st), str(st))
    call("PATCH", f"/members?space_id=eq.{ch}&user_id=eq.{V}", vic, {"role": "owner"})
    check("People: a viewer cannot promote himself", owner_sql(f"select role from weft.members where space_id = '{ch}' and user_id = '{V}'") == "viewer")
    call("PATCH", f"/spaces?id=eq.{ch}", vic, {"name": "Vic club"})
    check("People: a viewer cannot rename the channel", owner_sql(f"select name from weft.spaces where id = '{ch}'") == "Pat club")
    st, body = call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", pat)
    check("People: the last owner cannot leave", st == 400 and "needs an owner" in json.dumps(body)
          and owner_sql(f"select count(*) from weft.members where space_id = '{ch}' and user_id = '{P}'") == "1", f"{st} {body}")
    st, body = call("PATCH", f"/members?space_id=eq.{ch}&user_id=eq.{P}", pat, {"role": "editor"})
    check("People: the last owner cannot demote herself", st == 400, f"{st} {body}")
    st, _ = call("PATCH", f"/members?space_id=eq.{ch}&user_id=eq.{V}", pat, {"role": "owner"})
    st2, _ = call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", pat)
    check("People: with another owner, she can leave", st == 200 and st2 in (200, 204)
          and owner_sql(f"select count(*) from weft.members where space_id = '{ch}' and user_id = '{P}'") == "0", f"{st} {st2}")
    st, rows = call("GET", f"/spaces?id=eq.{ch}", pat)
    check("People: after leaving she cannot see the channel", st == 200 and rows == [], str(rows))
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", vic)
    check("People: the owner deletes the channel, members and all", st in (200, 204)
          and owner_sql(f"select count(*) from weft.spaces where id = '{ch}'") == "0"
          and owner_sql(f"select count(*) from weft.members where space_id = '{ch}'") == "0", str(st))
    st, _ = call("POST", "/members", pat, {"space_id": SID["organizers"], "user_id": P, "role": "owner"}, prefer="return=minimal")
    check("People: Pat cannot add herself to Organizers", refused(st), str(st))
    call("PATCH", f"/spaces?id=eq.{SID['festival']}", pat, {"name": "Pat fest"})
    check("People: a viewer cannot rename #festival", owner_sql(f"select name from weft.spaces where id = '{SID['festival']}'") == "festival")
    st, _ = call("POST", "/spaces", mint("u-org", assistant=True), {"kind": "channel", "name": "bot channel"})
    check("People: the assistant cannot create channels", refused(st), str(st))
    st, _ = call("POST", "/rpc/create_channel", mint("u-org", assistant=True), {"p_name": "bot channel"})
    st2, _ = call("POST", "/rpc/create_channel", mint("u-org", scope="festival"), {"p_name": "scoped channel"})
    check("People: nor through the function, nor a channel-scoped token", refused(st) and refused(st2), f"{st} {st2}")
    # What co-members can read about each other
    st, _ = call("GET", "/users?select=id,last_seen_at", pat)
    check("People: last sign-in is not readable by other people", refused(st), str(st))
    st, rows = call("GET", "/users?select=id,display_name,email&is_assistant=is.false", pat)
    check("People: names and emails of people you share a space with are", st == 200 and any(r["id"] == O for r in rows), str(st))
    # Admins
    st, _ = call("POST", "/rpc/admin_users", pat, {})
    check("Accounts: Pat (not admin) cannot list accounts", refused(st), str(st))
    st, rows = call("POST", "/rpc/admin_users", alex, {})
    check("Accounts: an admin lists every account, with last sign-in", st == 200 and {P, V, O, A} <= {r["id"] for r in rows}
          and "last_seen_at" in rows[0] and ASSISTANT not in {r["id"] for r in rows}, str(st))
    st, _ = call("POST", "/rpc/admin_users", mint("u-alex", scope="festival"), {})
    check("Accounts: a channel-scoped token cannot list accounts", refused(st), str(st))
    st, _ = call("POST", "/rpc/admin_users", mint("u-alex", assistant=True), {})
    check("Accounts: the assistant cannot list accounts", refused(st), str(st))
    st, _ = call("POST", "/rpc/admin_set_user", pat, {"p_user": V, "p_disabled": True})
    check("Accounts: Pat cannot disable Vic", refused(st) and owner_sql(f"select disabled from weft.users where id = '{V}'") == "f", str(st))
    st, _ = call("POST", "/rpc/admin_set_user", pat, {"p_user": P, "p_is_admin": True})
    check("Accounts: Pat cannot make herself admin through the function", refused(st), str(st))
    st, body = call("POST", "/rpc/admin_set_user", alex, {"p_user": A, "p_is_admin": False})
    check("Accounts: an admin cannot change their own account", st == 400 and owner_sql(f"select is_admin from weft.users where id = '{A}'") == "t", f"{st} {body}")
    st, _ = call("POST", "/rpc/admin_set_user", alex, {"p_user": ASSISTANT, "p_disabled": True})
    check("Accounts: the assistant account cannot be changed", st in (400, 404), str(st))
    # Disable Pat: she loses everything at once, keeps her memberships, and cannot sign in.
    st, _ = call("POST", "/rpc/admin_set_user", alex, {"p_user": P, "p_disabled": True})
    check("Accounts: an admin disables Pat", st == 200, str(st))
    try:
        st1, r1 = call("GET", f"/messages?space_id=eq.{SID['festival']}&limit=1", pat)
        st2, r2 = call("GET", "/spaces?select=id", pat)
        st3, r3 = call("GET", "/items?select=id&limit=1", pat)
        check("Accounts: a disabled account's existing token sees nothing", (st1, st2, st3) == (200, 200, 200) and r1 == [] and r2 == [] and r3 == [], f"{st1} {st2} {st3}")
        st, _ = call("POST", "/messages", pat, {"space_id": SID["festival"], "body": "still here?"})
        check("Accounts: a disabled account cannot post", refused(st), str(st))
        st, _ = call("POST", "/rpc/create_channel", pat, {"p_name": "disabled club"})
        st2, _ = call("POST", "/spaces", pat, {"kind": "channel", "name": "disabled club"}, prefer="return=minimal")
        check("Accounts: a disabled account cannot create channels", refused(st) and refused(st2), f"{st} {st2}")
        st, _ = call("POST", "/rpc/semantic_search", mint("u-pub", assistant=True), {"p_query": "[" + ",".join(["0.03"] * 768) + "]", "p_limit": 5})
        check("Accounts: the assistant acting for a disabled account finds nothing", st == 200 and _ == [], str(st))
        st, body = test_signin("pat.public@example.com")
        check("Accounts: a disabled account cannot sign in", st == 403 and "disabled" in str(body), f"{st} {body}")
        check("Accounts: her memberships are kept", owner_sql(f"select count(*) from weft.members where user_id = '{P}'") != "0")
    finally:
        st, _ = call("POST", "/rpc/admin_set_user", alex, {"p_user": P, "p_disabled": False})
    st1, r1 = call("GET", f"/messages?space_id=eq.{SID['festival']}&limit=1", pat)
    check("Accounts: enabled again, Pat sees #festival as before", st1 == 200 and len(r1) == 1, f"{st1}")
    st, body = test_signin("pat.public@example.com")
    check("Accounts: and can sign in", st == 200, str(st))
    # Admin changes are logged; a second admin can be made and unmade.
    st, _ = call("POST", "/rpc/admin_set_user", alex, {"p_user": O, "p_is_admin": True})
    st2, rows = call("POST", "/rpc/admin_users", olive, {})
    st3, _ = call("POST", "/rpc/admin_set_user", alex, {"p_user": O, "p_is_admin": False})
    st4, _ = call("POST", "/rpc/admin_users", olive, {})
    check("Accounts: an admin makes Olive admin, then not", (st, st2, st3) == (200, 200, 200) and refused(st4), f"{st} {st2} {st3} {st4}")
    check("Accounts: admin changes are logged", int(owner_sql(f"select count(*) from weft_private.admin_log where actor_id = '{A}'")) >= 4)


# ---------------------------------------------------------------- sub-pages and thread replies (positive controls)
def trees():
    olive = mint("u-org")
    st, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "wiki", "title": "Tree parent"})
    parent = rows[0]["id"] if st == 201 else None
    st, _ = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "wiki", "title": "Tree child", "parent_id": parent}, prefer="return=minimal")
    check("Trees: a sub-page under a page in the same space is allowed", st == 201, str(st))
    st, _ = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "wiki", "title": "Cross child", "parent_id": parent}, prefer="return=minimal")
    check("Trees: a sub-page under a page in another space is refused", refused(st), str(st))
    st, rows = call("POST", "/messages", olive, {"space_id": SID["festival"], "body": "thread root"})
    root = rows[0]["id"] if st == 201 else None
    st, _ = call("POST", "/messages", olive, {"space_id": SID["festival"], "body": "a reply", "thread_root_id": root}, prefer="return=minimal")
    check("Trees: a thread reply in the same channel is allowed", st == 201, str(st))
    st, _ = call("POST", "/messages", olive, {"space_id": SID["organizers"], "body": "cross reply", "thread_root_id": root}, prefer="return=minimal")
    check("Trees: a reply in another channel to that thread is refused", refused(st), str(st))


# ---------------------------------------------------------------- widget layouts and file blobs
def prefs_and_files():
    pat, olive = mint("u-pub"), mint("u-org")
    P, O = uid("user", "u-pub"), uid("user", "u-org")
    st, _ = call("POST", "/user_prefs?on_conflict=user_id", pat, {"home": {"widgets": ["recent"]}}, prefer="resolution=merge-duplicates,return=minimal")
    st2, rows = call("GET", "/user_prefs?select=user_id,home", pat)
    check("Widgets: Pat saves her layout and reads it back", st in (200, 201) and rows == [{"user_id": P, "home": {"widgets": ["recent"]}}], f"{st} {rows}")
    st, rows = call("GET", "/user_prefs?select=user_id", olive)
    check("Widgets: Olive cannot read Pat's layout", st == 200 and all(r["user_id"] != P for r in rows), str(rows))
    st, _ = call("POST", "/user_prefs", pat, {"user_id": O, "home": {"widgets": []}}, prefer="return=minimal")
    check("Widgets: Pat cannot write a layout for Olive", refused(st) and owner_sql(f"select count(*) from weft.user_prefs where user_id = '{O}'") == "0", str(st))
    st, rows = call("GET", "/user_prefs?select=user_id", mint("u-pub", scope="festival"))
    check("Widgets: a channel-scoped token reads no layouts", st == 200 and rows == [], str(rows))
    # A file item in Organizers with its bytes, made by the owner (as the files service would for Olive).
    fid = owner_sql(f"insert into weft.items (space_id, kind, title, body_text, created_by) values ('{SID['organizers']}', 'file', 'Org file.txt', 'ORG-FILE-TEXT', '{O}') returning id").splitlines()[0]
    owner_sql(f"insert into weft.file_blobs (item_id, bytes, mime, size, sha256) values ('{fid}', 'ORG-FILE-TEXT', 'text/plain', 13, 'x')")
    st, rows = call("GET", f"/file_blobs?item_id=eq.{fid}&select=size", pat)
    check("Files: Pat cannot read the bytes of an Organizers file", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/file_blobs?item_id=eq.{fid}&select=size", olive)
    check("Files: Olive can (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, rows = call("GET", f"/file_blobs?item_id=eq.{fid}&select=size", mint("u-org", scope="festival"))
    check("Files: a festival-scoped token cannot read Organizers bytes", st == 200 and rows == [], str(rows))
    st, rows = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "file", "title": "fake"})
    st2, _ = call("POST", "/file_blobs", pat, {"item_id": fid, "bytes": "\\x00", "mime": "text/plain", "size": 1, "sha256": "x"}, prefer="return=minimal")
    check("Files: Pat (viewer) cannot add a file, nor bytes to someone else's", refused(st) and refused(st2), f"{st} {st2}")
    st, _ = call("PATCH", f"/file_blobs?item_id=eq.{fid}", olive, {"mime": "text/html"})
    check("Files: nobody can change stored bytes or their type", refused(st) and owner_sql(f"select mime from weft.file_blobs where item_id = '{fid}'") == "text/plain", str(st))
    st, rows = call("GET", f"/file_blobs?item_id=eq.{fid}&select=size", mint("u-org", assistant=True))
    check("Files: the assistant role cannot read file bytes (only the extracted text, through items)", refused(st) or rows == [], f"{st} {rows}")
    owner_sql(f"delete from weft.items where id = '{fid}'")
    check("Files: deleting the item deletes its bytes", owner_sql(f"select count(*) from weft.file_blobs where item_id = '{fid}'") == "0")


# ---------------------------------------------------------------- search
def search():
    pat, olive = mint("u-pub"), mint("u-org")
    s = lambda tok, q, n=6: call("POST", "/rpc/search", tok, {"p_q": q, "p_limit": n})
    st, rows = s(olive, "host contacts")
    check("Search: Olive finds Host contacts (Organizers)", st == 200 and any(r["id"] == HOST_CONTACTS for r in rows), str(rows)[:200])
    check("Search: results carry a highlighted snippet", any("\u00abHost\u00bb" in (r["snippet"] or "") for r in rows), str([r["snippet"] for r in rows])[:200])
    st, rows = s(pat, "host contacts")
    check("Search: Pat never finds Host contacts or anything in Organizers", st == 200 and all(r["space_id"] not in (SID["organizers"], SID["volunteers"]) for r in rows), str(rows)[:200])
    st, rows = s(mint("u-org", scope="festival"), "host contacts")
    check("Search: a festival-scoped token finds nothing outside #festival", st == 200 and all(r["space_id"] == SID["festival"] for r in rows), str(rows)[:200])
    st, rows = s(olive, "contac")
    check("Search: words match as you type (prefix)", st == 200 and any(r["id"] == HOST_CONTACTS for r in rows), str(rows)[:200])
    st, rows = s(olive, "organ")
    st2, rows2 = s(pat, "organ")
    check("Search: channel names match for members only", any(r["kind"] == "channel" and r["id"] == SID["organizers"] for r in rows)
          and not any(r["kind"] == "channel" and r["id"] == SID["organizers"] for r in rows2), f"{rows} {rows2}"[:200])
    bad = []
    for q in ["'; drop table weft.users; --", "a & | ! : * ( ) <-> \\", "%_%", "«»", "", "   ", "x" * 500]:
        st, rows = s(olive, q)
        if st != 200 or not isinstance(rows, list):
            bad.append((q[:20], st))
    check("Search: odd input never errors or changes the query", not bad and owner_sql("select count(*) > 0 from weft.users") == "t", str(bad))
    st, rows = s(olive, "")
    check("Search: empty search returns nothing", st == 200 and rows == [], str(rows))
    st, rows = s(olive, "%")
    check("Search: % and _ are not wildcards in channel names", st == 200 and not any(r["kind"] == "channel" for r in rows), str(rows))
    st, _ = call("POST", "/rpc/search", None, {"p_q": "host"})
    check("Search: no token, no search", refused(st), str(st))


# ---------------------------------------------------------------- wikis kept in the repo
def wikis():
    import shutil, tempfile
    pat, olive, alex = mint("u-pub"), mint("u-org"), mint("u-alex")
    P, O, A = (uid("user", k) for k in ("u-pub", "u-org", "u-alex"))
    ADMIN = SID["weft-admin"]
    help_index, admin_index = uid("item", "help", "01-weft-help.md"), uid("item", "weft-admin", "01-weft-admin.md")
    st, rows = call("GET", f"/members?space_id=eq.{ADMIN}&select=user_id,role", alex)
    check("Wikis: the admin wiki has exactly the active admins, as editors", rows == [{"user_id": A, "role": "editor"}], str(rows))
    for who, tok in (("Pat", pat), ("Olive", olive)):
        st, rows = call("GET", f"/items?space_id=eq.{ADMIN}&select=id", tok)
        check(f"Wikis: {who} (not admin) sees no admin pages", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{admin_index}&select=body_text,managed", alex)
    body = rows[0]["body_text"] if rows else ""
    check("Wikis: the admin index lists every admin page", rows and rows[0]["managed"] and all(t in body for t in ("Accounts and access", "Operations", "Technical specification", "Testing")), body[:200])
    st, rows = call("GET", f"/items?id=eq.{help_index}&select=body_text", pat)
    check("Wikis: the help index lists the help pages", rows and "People and channels" in rows[0]["body_text"] and "<!-- pages -->" not in rows[0]["body_text"], str(rows)[:200])
    check("Wikis: admin-only pages are no longer in help", owner_sql(f"select count(*) from weft.items where space_id = '{SID['help']}' and title like 'Assistant settings%'") == "0")
    # Managed pages are read-only for everyone, owners and admins included.
    st, body = call("PATCH", f"/items?id=eq.{help_index}", alex, {"title": "changed"})
    check("Wikis: even an owner cannot change a managed page", st == 400 and "Weft repo" in json.dumps(body), f"{st} {body}")
    st, body = call("DELETE", f"/items?id=eq.{admin_index}", alex)
    check("Wikis: nor delete one", st == 400 and owner_sql(f"select count(*) from weft.items where id = '{admin_index}'") == "1", f"{st}")
    st, body = call("PATCH", f"/items?id=eq.{help_index}", alex, {"space_id": SID["festival"]})
    check("Wikis: nor move one", st == 400, f"{st}")
    st, rows = call("POST", "/items", alex, {"space_id": ADMIN, "kind": "wiki", "title": "Alex notes", "parent_id": admin_index, "body_text": "mine"})
    mine = rows[0]["id"] if st == 201 else None
    st2, _ = call("PATCH", f"/items?id=eq.{mine}", alex, {"title": "Alex notes 2"})
    check("Wikis: an admin can add and edit their own page under a managed one", st == 201 and st2 == 200, f"{st} {st2}")
    # The kept channels cannot be renamed, deleted or have their members changed by hand.
    st, _ = call("PATCH", f"/spaces?id=eq.{SID['help']}", alex, {"name": "renamed"})
    st2, _ = call("DELETE", f"/spaces?id=eq.{SID['help']}", alex)
    check("Wikis: the help channel cannot be renamed or deleted", st == 400 and st2 == 400 and owner_sql(f"select name from weft.spaces where id = '{SID['help']}'") == "help", f"{st} {st2}")
    st, _ = call("POST", "/members", alex, {"space_id": ADMIN, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    check("Wikis: nobody can add a non-admin to the admin wiki", st in (400, 401, 403) and owner_sql(f"select count(*) from weft.members where space_id = '{ADMIN}' and user_id = '{P}'") == "0", str(st))
    st, _ = call("DELETE", f"/members?space_id=eq.{ADMIN}&user_id=eq.{A}", alex)
    check("Wikis: nor leave it", owner_sql(f"select count(*) from weft.members where space_id = '{ADMIN}' and user_id = '{A}'") == "1", str(st))
    # Membership follows the admin flag.
    call("POST", "/rpc/admin_set_user", alex, {"p_user": O, "p_is_admin": True})
    st, rows = call("GET", f"/items?space_id=eq.{ADMIN}&select=id", olive)
    check("Wikis: made admin, Olive joins the admin wiki", st == 200 and len(rows) >= 12, str(len(rows or [])))
    call("POST", "/rpc/admin_set_user", alex, {"p_user": O, "p_disabled": True})
    call("POST", "/rpc/admin_set_user", alex, {"p_user": O, "p_disabled": False})
    call("POST", "/rpc/admin_set_user", alex, {"p_user": O, "p_is_admin": False})
    st, rows = call("GET", f"/items?space_id=eq.{ADMIN}&select=id", olive)
    check("Wikis: no longer admin, she leaves it", st == 200 and rows == [] and owner_sql(f"select count(*) from weft.members where space_id = '{ADMIN}' and user_id = '{O}'") == "0", str(rows))
    # Publishing: a changed file rewrites its page (and drops the saved editor state); a removed file deletes it.
    tmp = tempfile.mkdtemp()
    try:
        shutil.copytree(os.path.join(ROOT, "docs"), os.path.join(tmp, "docs"))
        f = os.path.join(tmp, "docs", "admin", "06-troubleshooting.md")
        open(f, "a").write("\nPUBLISH-CHECK-7781\n")
        os.remove(os.path.join(tmp, "docs", "admin", "15-testing.md"))
        owner_sql(f"update weft.items set ydoc = '\\x00' where id = '{uid('item', 'weft-admin', '06-troubleshooting.md')}'")
        sql = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "sync_wikis.py"), "--root", tmp], capture_output=True, text=True, check=True).stdout
        res = subprocess.run(DC + ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", "weft_owner", "-d", "weft"], input=sql, capture_output=True, text=True, check=True).stdout
        tid = uid("item", "weft-admin", "06-troubleshooting.md")
        check("Wikis: publishing reports what changed", "updated: Troubleshooting" in res and "removed: Testing" in res, res.strip()[-200:])
        check("Wikis: the changed page has the new text and no stale editor state",
              owner_sql(f"select body_text like '%PUBLISH-CHECK-7781%' and ydoc is null from weft.items where id = '{tid}'") == "t")
        check("Wikis: the removed page is gone, and the index no longer lists it",
              owner_sql(f"select count(*) from weft.items where id = '{uid('item', 'weft-admin', '15-testing.md')}'") == "0"
              and owner_sql(f"select position('**Testing**' in body_text) from weft.items where id = '{uid('item', 'weft-admin', '10-technical-specification.md')}'") == "0")
        check("Wikis: an admin's own page survives publishing", owner_sql(f"select count(*) from weft.items where id = '{mine}'") == "1")
    finally:
        shutil.rmtree(tmp)
        sql = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "sync_wikis.py")], capture_output=True, text=True, check=True).stdout
        res = subprocess.run(DC + ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", "weft_owner", "-d", "weft"], input=sql, capture_output=True, text=True, check=True).stdout
    check("Wikis: publishing the repo again restores both pages", "updated: Troubleshooting" in res and "created: Testing" in res, res.strip()[-200:])
    res = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "sync_wikis.py")], capture_output=True, text=True, check=True).stdout
    res = subprocess.run(DC + ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-qAt", "-U", "weft_owner", "-d", "weft"], input=res, capture_output=True, text=True, check=True).stdout
    check("Wikis: publishing with nothing changed changes nothing", not any(l.startswith(("created", "updated", "removed")) for l in res.splitlines()), res[-200:])


# ---------------------------------------------------------------- meetings (029)
def meetings():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    P, O, A = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    mk = lambda tok, space, kind, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/items", tok, {"space_id": SID[space], "kind": kind, "title": title}))
    org, fest = mk(olive, "organizers", "meeting", "Org board meeting"), mk(olive, "festival", "meeting", "Festival stand-up")
    check("Meetings: Olive (editor) makes meetings in Organizers and #festival", org and fest)
    check("Meetings: each meeting gets its row with the item", oq(f"select count(*) from weft.meetings where id in ('{org}', '{fest}')") == "2")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "meeting", "title": "x"})
    check("Meetings: Pat (viewer) cannot make a meeting in #festival", refused(st), str(st))
    st, rows = call("PATCH", f"/meetings?id=eq.{org}", olive, {"agenda": "  Budget\nORG-MEET-SECRET venue  ", "notes": "We talked money", "decisions": "Raise the fee"})
    check("Meetings: Olive writes the agenda, notes and decisions (positive control), trimmed by the database",
          st == 200 and rows and rows[0]["agenda"] == "Budget\nORG-MEET-SECRET venue", f"{st} {rows}")
    call("PATCH", f"/meetings?id=eq.{fest}", olive, {"notes": "Gates at nine"})
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/meetings?id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/items?id=eq.{org}&select=body_text", tok)
        check(f"Meetings: {who} reads neither the Organizers meeting nor its text", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", "/meetings?select=id&agenda=like.*ORG-MEET*", pat)
    check("Meetings: nor finds it by filtering every meeting", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Meetings: Olive reads its text, with the agenda, notes and decisions", "Agenda:\nBudget\nORG-MEET-SECRET venue" in body and "Notes:\nWe talked money" in body and "Decisions:\nRaise the fee" in body, body)
    st, rows = call("GET", f"/meetings?id=eq.{fest}&select=notes", pat)
    check("Meetings: Pat reads the #festival meeting (positive control)", st == 200 and rows and rows[0]["notes"] == "Gates at nine", str(rows))
    st, rows = call("PATCH", f"/meetings?id=eq.{fest}", pat, {"notes": "pwned"})
    check("Meetings: Pat (viewer) cannot change it", rows == [] and oq(f"select notes from weft.meetings where id = '{fest}'") == "Gates at nine", f"{st} {rows}")
    st, rows = call("PATCH", f"/meetings?id=eq.{org}", vic, {"notes": "pwned"})
    check("Meetings: nor Vic the Organizers one", rows == [] and oq(f"select notes from weft.meetings where id = '{org}'") == "We talked money", f"{st} {rows}")
    st, _ = call("PATCH", f"/meetings?id=eq.{org}", olive, {"updated_at": "2020-01-01T00:00:00Z"})
    st2, _ = call("PATCH", f"/meetings?id=eq.{org}", olive, {"id": fest})
    check("Meetings: nobody sets updated_at or the id", refused(st) and refused(st2), f"{st} {st2}")
    st, _ = call("POST", "/meetings", olive, {"id": mk(olive, "festival", "document", "not a meeting")})
    st2, _ = call("DELETE", f"/meetings?id=eq.{fest}", olive)
    check("Meetings: meeting rows are not made or deleted directly", refused(st) and refused(st2) and oq(f"select count(*) from weft.meetings where id = '{fest}'") == "1", f"{st} {st2}")
    st, _ = call("PATCH", f"/meetings?id=eq.{org}", olive, {"notes": "x" * 20001})
    check("Meetings: a section over 20,000 characters is refused", st == 400, str(st))

    # Calendar events: only one in the meeting's own space.
    ev = lambda space, title: call("POST", "/events", olive, {"space_id": SID[space], "title": title, "starts_at": "2026-11-20T10:00:00Z", "ends_at": "2026-11-20T11:00:00Z"})[1][0]["id"]
    org_ev, fest_ev = ev("organizers", "Org board"), ev("festival", "Stand-up")
    st, body = call("PATCH", f"/meetings?id=eq.{org}", olive, {"event_id": fest_ev})
    st2, body2 = call("PATCH", f"/meetings?id=eq.{org}", olive, {"event_id": uid("event", "nope")})
    check("Meetings: an event in another space is refused, with the same answer as one that does not exist",
          st == 400 and st2 == 400 and body.get("message") == body2.get("message") and oq(f"select event_id is null from weft.meetings where id = '{org}'") == "t", f"{st} {st2} {body} {body2}")
    st, rows = call("PATCH", f"/meetings?id=eq.{org}", olive, {"event_id": org_ev})
    check("Meetings: an event in the same space links (positive control)", st == 200 and rows and rows[0]["event_id"] == org_ev, f"{st} {rows}")
    check("Meetings: and its title is in the meeting's text", "Calendar event: Org board" in oq(f"select body_text from weft.items where id = '{org}'"))
    st, rows = call("PATCH", f"/meetings?id=eq.{fest}", olive, {"event_id": fest_ev})
    st, rows = call("GET", f"/meetings?event_id=eq.{fest_ev}&select=id", pat)
    check("Meetings: Pat finds the #festival meeting from its event (what Calendar shows)", st == 200 and [r["id"] for r in rows] == [fest], str(rows))
    st, rows = call("GET", f"/meetings?event_id=eq.{org_ev}&select=id", pat)
    check("Meetings: but nothing from an Organizers event id", st == 200 and rows == [], str(rows))

    # Task lists and action items.
    org_list, fest_list = mk(olive, "organizers", "tasklist", "Org actions"), mk(olive, "festival", "tasklist", "Festival actions")
    st, body = call("PATCH", f"/meetings?id=eq.{org}", olive, {"task_list_id": fest_list})
    st2, _ = call("PATCH", f"/meetings?id=eq.{org}", olive, {"task_list_id": HOST_CONTACTS})
    check("Meetings: a task list in another space, or an item that is not a task list, is refused", st == 400 and st2 == 400, f"{st} {st2} {body}")
    st, rows = call("PATCH", f"/meetings?id=eq.{org}", olive, {"task_list_id": org_list})
    check("Meetings: a task list in the same space is chosen (positive control)", st == 200 and rows and rows[0]["task_list_id"] == org_list, f"{st} {rows}")
    call("PATCH", f"/meetings?id=eq.{fest}", olive, {"task_list_id": fest_list})
    st, task = call("POST", "/rpc/add_meeting_action", olive, {"p_meeting": org, "p_title": "Book the ORG-ACTION-SECRET hall", "p_assignee": A, "p_due": "2026-11-25"})
    ot = task.get("id") if st == 200 and isinstance(task, dict) else None
    check("Meetings: Olive adds an action item; it is a task in the chosen list, made by her",
          ot and task["list_id"] == org_list and task["created_by"] == O and oq(f"select meeting_id from weft.meeting_actions where task_id = '{ot}'") == org, f"{st} {task}")
    check("Meetings: the action item is in the meeting's text and the list's",
          "[ ] Book the ORG-ACTION-SECRET hall (Alex (test admin), due 2026-11-25)" in oq(f"select body_text from weft.items where id = '{org}'")
          and "ORG-ACTION-SECRET" in oq(f"select body_text from weft.items where id = '{org_list}'"))
    st, task = call("POST", "/rpc/add_meeting_action", olive, {"p_meeting": fest, "p_title": "Hang the gate signs", "p_assignee": P})
    ft = task.get("id") if st == 200 and isinstance(task, dict) else None
    check("Meetings: and one in #festival, assigned to Pat", ft is not None, f"{st} {task}")
    st, body = call("POST", "/rpc/add_meeting_action", olive, {"p_meeting": org, "p_title": "for Pat", "p_assignee": P})
    check("Meetings: an action item cannot be assigned to someone outside the space", st == 400 and oq(f"select count(*) from weft.tasks where list_id = '{org_list}'") == "1", f"{st} {body}")
    n_fest = oq(f"select count(*) from weft.tasks where list_id = '{fest_list}'")
    st, _ = call("POST", "/rpc/add_meeting_action", pat, {"p_meeting": fest, "p_title": "pwned"})
    st2, _ = call("POST", "/rpc/add_meeting_action", pat, {"p_meeting": org, "p_title": "pwned"})
    st3, _ = call("POST", "/rpc/add_meeting_action", vic, {"p_meeting": org, "p_title": "pwned"})
    check("Meetings: Pat (viewer) adds no action items in #festival, nor Pat or Vic in Organizers", all(refused(x) for x in (st, st2, st3))
          and oq(f"select count(*) from weft.tasks where list_id = '{fest_list}'") == n_fest and oq(f"select count(*) from weft.tasks where list_id = '{org_list}'") == "1", f"{st} {st2} {st3}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/meeting_actions?meeting_id=eq.{org}&select=task_id", tok)
        check(f"Meetings: {who} sees no Organizers action items", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/meeting_actions?meeting_id=eq.{fest}&select=task_id,task:tasks(title)", pat)
    check("Meetings: Pat sees the #festival action items (positive control)", st == 200 and len(rows) == 1 and rows[0]["task"]["title"] == "Hang the gate signs", str(rows))
    extra = call("POST", "/tasks", olive, {"list_id": fest_list, "title": "A plain festival task"})[1][0]["id"]
    st, body = call("POST", "/meeting_actions", olive, {"task_id": extra, "meeting_id": org})
    check("Meetings: a task in another space cannot be made an Organizers action item", st == 400 and oq(f"select count(*) from weft.meeting_actions where task_id = '{extra}'") == "0", f"{st} {body}")
    st, _ = call("POST", "/meeting_actions", pat, {"task_id": extra, "meeting_id": fest})
    check("Meetings: Pat cannot link a task to the #festival meeting", refused(st), str(st))
    st, _ = call("POST", "/meeting_actions", olive, {"task_id": extra, "meeting_id": fest, "created_by": A})
    check("Meetings: authorship of an action item cannot be forged", refused(st), str(st))
    st, rows = call("POST", "/meeting_actions", olive, {"task_id": extra, "meeting_id": fest})
    check("Meetings: an existing task in the same space can be linked (positive control)", st == 201 and rows and rows[0]["created_by"] == O, f"{st} {rows}")
    st, _ = call("PATCH", f"/meeting_actions?task_id=eq.{extra}", olive, {"meeting_id": org})
    check("Meetings: an action item cannot be moved to another meeting", refused(st) and oq(f"select meeting_id from weft.meeting_actions where task_id = '{extra}'") == fest, str(st))
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True})
    check("Meetings: Pat ticks off the action item assigned to her (the Tasks rule), and the meeting's text follows",
          st == 200 and len(rows or []) == 1 and "[x] Hang the gate signs" in oq(f"select body_text from weft.items where id = '{fest}'"), f"{st} {rows}")
    st, rows = call("DELETE", f"/meeting_actions?task_id=eq.{ft}", pat)
    check("Meetings: Pat cannot remove an action item", rows == [] and oq(f"select count(*) from weft.meeting_actions where task_id = '{ft}'") == "1", f"{st} {rows}")

    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/meetings?id=in.({org},{fest})&select=id", scoped)
    st2, rows2 = call("GET", f"/meeting_actions?meeting_id=in.({org},{fest})&select=meeting_id", scoped)
    check("Meetings: a #festival-scoped token sees only #festival meetings and action items",
          [r["id"] for r in rows or []] == [fest] and rows2 and {r["meeting_id"] for r in rows2} == {fest}, f"{rows} {rows2}")
    st, rows = call("PATCH", f"/meetings?id=eq.{org}", scoped, {"notes": "scoped"})
    st2, _ = call("POST", "/rpc/add_meeting_action", scoped, {"p_meeting": org, "p_title": "scoped"})
    check("Meetings: nor changes or adds anything in Organizers", rows == [] and refused(st2) and oq(f"select notes from weft.meetings where id = '{org}'") == "We talked money", f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/meetings?id=eq.{org}&select=notes", helper)
    st2, rows2 = call("GET", f"/meeting_actions?meeting_id=eq.{org}&select=task_id", helper)
    check("Meetings: the assistant (for Olive) reads the Organizers meeting and its action items (positive control)", st == 200 and len(rows) == 1 and len(rows2 or []) == 1, f"{rows} {rows2}")
    st, _ = call("PATCH", f"/meetings?id=eq.{org}", helper, {"notes": "by the assistant"})
    st2, _ = call("DELETE", f"/meeting_actions?task_id=eq.{ot}", helper)
    st3, _ = call("POST", "/rpc/add_meeting_action", helper, {"p_meeting": org, "p_title": "by the assistant"})
    check("Meetings: the assistant cannot change a meeting, remove or add action items", refused(st) and refused(st2) and refused(st3)
          and oq(f"select count(*) from weft.meeting_actions where meeting_id = '{org}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/audit?row_id=eq.{org}&table_name=eq.meetings&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Meetings: changes are in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-MEET-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-MEET-SECRET"})
    check("Meetings: search finds the meeting for Olive, not for Pat", any(r["id"] == org and r["kind"] == "meeting" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    st, rows = call("DELETE", f"/meeting_actions?task_id=eq.{extra}", olive)
    check("Meetings: Olive removes an action item; the task stays in its list", st == 200 and len(rows or []) == 1 and oq(f"select count(*) from weft.tasks where id = '{extra}'") == "1", f"{st} {rows}")

    # Moves follow the space.
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    check("Meetings: a meeting moved from Organizers into #festival drops its Organizers event, task list and action items",
          st == 200 and oq(f"select (event_id is null and task_list_id is null)::text || '|' || (select count(*) from weft.meeting_actions where meeting_id = '{org}') from weft.meetings where id = '{org}'") == "true|0", str(st))
    check("Meetings: and its text no longer names them", not any(x in oq(f"select coalesce(body_text, '') from weft.items where id = '{org}'") for x in ("ORG-ACTION-SECRET", "Org board")))
    check("Meetings: the task itself stays in the Organizers list", oq(f"select list_id from weft.tasks where id = '{ot}'") == org_list)
    st, rows = call("GET", f"/meetings?id=eq.{org}&select=id", pat)
    check("Meetings: Pat can now read the moved meeting, still read-only", st == 200 and len(rows) == 1 and call("PATCH", f"/meetings?id=eq.{org}", pat, {"notes": "x"})[1] == [], str(rows))
    st, _ = call("PATCH", f"/items?id=eq.{fest_list}", olive, {"space_id": SID["volunteers"]})
    check("Meetings: a task list moved out of #festival is no longer the meeting's list, and its tasks are no longer its action items",
          st == 200 and oq(f"select (task_list_id is null)::text || '|' || (select count(*) from weft.meeting_actions where meeting_id = '{fest}') from weft.meetings where id = '{fest}'") == "true|0", str(st))
    st, _ = call("PATCH", f"/events?id=eq.{fest_ev}", olive, {"space_id": SID["volunteers"]})
    check("Meetings: an event moved out of #festival is no longer linked", st == 200 and oq(f"select event_id is null from weft.meetings where id = '{fest}'") == "t", str(st))
    fest_ev2 = ev("festival", "Stand-up 2")
    call("PATCH", f"/meetings?id=eq.{fest}", olive, {"event_id": fest_ev2})
    call("DELETE", f"/events?id=eq.{fest_ev2}", olive)
    check("Meetings: deleting the linked event unlinks it, the meeting stays", oq(f"select event_id is null from weft.meetings where id = '{fest}'") == "t")
    st, _ = call("DELETE", f"/items?id=eq.{fest}", pat)
    check("Meetings: Pat cannot delete a meeting", oq(f"select count(*) from weft.items where id = '{fest}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{fest}", olive)
    check("Meetings: deleting a meeting deletes its row and links, never its tasks", st in (200, 204)
          and oq(f"select count(*) from weft.meetings where id = '{fest}'") == "0" and oq(f"select count(*) from weft.tasks where id = '{ft}'") == "1", str(st))
    for i in (org, org_list, fest_list):
        call("DELETE", f"/items?id=eq.{i}", olive)
    call("DELETE", f"/events?id=in.({org_ev},{fest_ev})", olive)


# ---------------------------------------------------------------- index the rest: the nine apps in search, meaning search and the assistant
def index_the_rest():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = (uid("user", k) for k in ("u-pub", "u-vol", "u-org", "u-alex"))
    OS = SID["personal-u-org"]
    oq = lambda sql: owner_sql(sql)
    ts = lambda iv: oq(f"select to_char(date_trunc('hour', now()) + interval '{iv}', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    day = oq("select current_date::text")
    s = lambda tok, q, n=20: call("POST", "/rpc/search", tok, {"p_q": q, "p_limit": n})
    items_before = oq("select count(*) from weft.items")
    made = {}   # kind -> {"fest": id, "org": id}
    # One row of each app in #festival (Pat and Vic read it) and one in Organizers (they do not), made through
    # the API by the people the apps allow, with a marker word in each.
    def mk(kind, path, tok, body, key="id"):
        st, rows = call("POST", path, tok, body)
        return rows[0][key] if st == 201 and rows else None
    for where in ("fest", "org"):
        sp = SID["festival" if where == "fest" else "organizers"]
        m = lambda k: f"ixr{k}{where}"
        made.setdefault("announcement", {})[where] = mk("announcement", "/announcements", olive, {"space_id": sp, "title": f"Notice {m('notice')}", "body": "Gates move"})
        ev = mk("event", "/events", olive, {"space_id": sp, "title": f"Dinner {m('rsvp')}", "starts_at": ts("4 days"), "ends_at": ts("4 days 2 hours")})
        call("POST", "/rsvps", olive, {"event_id": ev, "answer": "going"})
        made.setdefault("rsvps", {})[where] = ev
        res = mk("resource", "/resources", olive, {"space_id": sp, "name": f"Cart {m('cart')}", "note": "Charged overnight"})
        call("POST", "/bookings", olive, {"resource_id": res, "starts_at": ts("5 days"), "ends_at": ts("5 days 2 hours"), "note": f"Load-in {m('booking')}"})
        made.setdefault("resource", {})[where] = res
        sh = mk("shift", "/shifts", olive, {"space_id": sp, "title": f"Gate {m('shift')}", "starts_at": ts("6 days"), "ends_at": ts("6 days 3 hours"), "places": 3})
        call("POST", "/shift_signups", olive, {"shift_id": sh})
        made.setdefault("shift", {})[where] = sh
        made.setdefault("timeoff", {})[where] = mk("timeoff", "/time_off", olive, {"space_id": sp, "user_id": O, "starts_on": "2027-01-04", "ends_on": "2027-01-08", "note": f"Ski trip {m('away')}"})
        made.setdefault("kudos", {})[where] = mk("kudos", "/kudos", olive, {"space_id": sp, "to_user": P if where == "fest" else A, "message": f"Thanks for the {m('thanks')} help"})
        made.setdefault("milestone", {})[where] = mk("milestone", "/milestones", olive, {"space_id": sp, "title": f"Permit {m('milestone')}", "day": "2027-03-01", "note": "From the city"})
    words = {"announcement": "notice", "rsvps": "rsvp", "resource": "cart", "shift": "shift", "timeoff": "away", "kudos": "thanks", "milestone": "milestone"}
    check("Index: every test row was made through its app (positive control)", all(v.get("fest") and v.get("org") for v in made.values()), json.dumps(made))
    st, rows = call("POST", "/journal_entries", olive, {"day": day, "body": "IXRJOURNAL slept badly before the ixrjournalword meeting"})
    oj = rows[0]["id"] if st == 201 else None
    st, _ = call("POST", "/profiles?on_conflict=user_id", olive, {"role": "Gate lead", "skills": ["ixrskill"]}, prefer="resolution=merge-duplicates,return=minimal")
    st2, _ = call("POST", "/profiles?on_conflict=user_id", pat, {"role": "Runner", "skills": ["ixrpatskill"]}, prefer="resolution=merge-duplicates,return=minimal")
    check("Index: Olive writes a journal page and Olive and Pat save profiles (positive control)", oj and st in (200, 201) and st2 in (200, 201), f"{oj} {st} {st2}")

    # The search box, word by word.
    for kind, w in words.items():
        st, rows = s(olive, f"ixr{w}org")
        hit = [r for r in rows or [] if r["id"] == made[kind]["org"] and r["kind"] == kind]   # an event and its answers share an id
        check(f"Index search: Olive finds the Organizers {kind} by a word in it, with its channel and a highlighted snippet",
              st == 200 and len(hit) == 1 and hit[0]["kind"] == kind and hit[0]["space_id"] == SID["organizers"] and hit[0]["space_name"] == "organizers"
              and ("«" in (hit[0]["snippet"] or "") or f"ixr{w}org" in hit[0]["title"].lower()), str(rows)[:300])
        st, rows = s(pat, f"ixr{w}fest")
        check(f"Index search: Pat (viewer) finds the #festival {kind} (positive control)", st == 200 and any(r["id"] == made[kind]["fest"] for r in rows), str(rows)[:200])
        for who, tok in (("Pat", pat), ("Vic", vic), ("Olive's #festival-scoped token", mint("u-org", scope="festival"))):
            st, rows = s(tok, f"ixr{w}org")
            check(f"Index search: {who} never finds the Organizers {kind}", st == 200 and not any(r["id"] == made[kind]["org"] for r in rows)
                  and not any(r["space_id"] == SID["organizers"] for r in rows), str(rows)[:200])
    st, rows = s(olive, "ixrbookingorg")
    check("Index search: a booking's note finds its thing to book", any(r["id"] == made["resource"]["org"] for r in rows), str(rows)[:200])
    st, rows = s(pat, "Olive going ixrrsvpfest")
    check("Index search: who answered an event is searchable by name, for members", any(r["id"] == made["rsvps"]["fest"] for r in rows), str(rows)[:200])
    st, rows = s(pat, "ixrcartfest")
    st2, rows2 = s(pat, "ixrbookingorg")
    check("Index search: and a booking in Organizers stays hidden from Pat even by its note", not any(r["space_id"] == SID["organizers"] for r in rows2) and any(r["id"] == made["resource"]["fest"] for r in rows), f"{rows2}"[:200])
    # The view itself, read directly: only what each app shows.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/records?space_id=eq.{SID['organizers']}&select=kind,id", tok)
        st2, rows2 = call("GET", "/records?or=(title.match.ixr%5Ba-z%5D%2Borg,body.match.ixr%5Ba-z%5D%2Borg)&select=kind,id", tok)
        check(f"Index records: {who} reads no Organizers record, by space or by text", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}"[:200])
    st, rows = call("GET", f"/records?space_id=eq.{SID['organizers']}&select=kind", olive)
    check("Index records: Olive reads all seven Organizers kinds (positive control)", st == 200 and {r["kind"] for r in rows} >= set(words), str(rows)[:200])
    st, rows = call("GET", f"/records?space_id=eq.{SID['organizers']}&select=kind", mint("u-pub", assistant=True))
    st2, rows2 = call("GET", f"/records?space_id=eq.{SID['organizers']}&select=kind", mint("u-org", assistant=True, scope="festival"))
    st3, rows3 = call("GET", f"/records?space_id=eq.{SID['organizers']}&select=kind", mint("u-org", assistant=True))
    check("Index records: the assistant for Pat, and for Olive in #festival, reads no Organizers record; for Olive in her own conversation it does",
          rows == [] and rows2 == [] and len(rows3 or []) >= 7, f"{st} {rows} {st2} {rows2} {st3}")
    w = [call("DELETE", f"/records?id=eq.{made['kudos']['fest']}", mint("u-org", assistant=True)),
         call("DELETE", f"/records?id=eq.{made['kudos']['fest']}", olive),
         call("PATCH", f"/records?id=eq.{made['milestone']['fest']}", olive, {"title": "pwned"}),
         call("POST", "/records", olive, {"kind": "kudos", "title": "forged"})]
    # Postgres refuses before anything happens: no write grant (42501) or "cannot change a UNION view" (55000).
    check("Index records: the view cannot be written or deleted through, by the assistant or anyone",
          all(st in (401, 403, 500) and isinstance(b, dict) and b.get("code") in ("42501", "55000") for st, b in w)
          and oq(f"select count(*) from weft.kudos where id = '{made['kudos']['fest']}'") == "1"
          and oq(f"select title from weft.milestones where id = '{made['milestone']['fest']}'") != "pwned", str([(st, b.get("code") if isinstance(b, dict) else b) for st, b in w]))
    check("Index: nothing was copied into items (the view stores nothing)", oq("select count(*) from weft.items") == items_before)
    # Time off and kudos keep their names; announcements their end; shifts who is on them.
    st, rows = call("GET", f"/records?id=in.({made['shift']['fest']},{made['timeoff']['fest']},{made['kudos']['fest']})&select=kind,title,body", pat)
    txt = json.dumps(rows)
    check("Index records: a shift lists who signed up, time off names the person, kudos name both people", "Signed up (1 of 3): Olive" in txt
          and "Olive Organizer away" in txt and "Kudos for Pat" in txt and "From Olive" in txt and "ixrthanksfest" in txt, txt[:300])

    # Journal: only its writer, in her own search box and her own Weft conversation.
    st, rows = s(olive, "ixrjournalword")
    hit = [r for r in rows or [] if r["id"] == oj]
    check("Index journal: Olive finds her own page in Weft search, with its day to open it (positive control)",
          len(hit) == 1 and hit[0]["kind"] == "journal" and hit[0]["ref"] == day and hit[0]["space_id"] == OS, str(rows)[:300])
    for who, tok in (("Pat", pat), ("Vic", vic), ("Alex (admin)", alex), ("Olive's #festival-scoped token", mint("u-org", scope="festival"))):
        st, rows = s(tok, "ixrjournalword")
        st2, rows2 = call("GET", "/records?kind=eq.journal&select=id", tok)
        check(f"Index journal: {who} never finds Olive's page, in search or the view", st == 200 and not any(r["id"] == oj for r in rows) and oj not in {r["id"] for r in rows2 or []}, f"{rows} {rows2}"[:200])
    call("POST", "/members", olive, {"space_id": OS, "user_id": A, "role": "editor"}, prefer="return=minimal")
    try:
        st, rows = s(alex, "ixrjournalword")
        st2, rows2 = call("GET", f"/records?space_id=eq.{OS}&select=kind,id", alex)
        check("Index journal: Alex, added to Olive's personal space, still finds none of her pages", not any(r["id"] == oj for r in rows or []) and oj not in {r["id"] for r in rows2 or []}, f"{rows} {rows2}"[:200])
    finally:
        call("DELETE", f"/members?space_id=eq.{OS}&user_id=eq.{A}", olive)
    st, rows = call("GET", "/records?kind=eq.journal&select=id,body", mint("u-org", assistant=True))
    check("Index journal: the assistant for Olive, unscoped (her own Weft conversation), reads her page (positive control)", st == 200 and [r["id"] for r in rows] == [oj], f"{st} {rows}"[:200])
    for label, tok in (("in #festival", mint("u-org", assistant=True, scope="festival")), ("in her personal space", mint("u-org", assistant=True, scope="personal-u-org")),
                       ("in a direct message", mint("u-org", assistant=True, scope="dm-alex-olive"))):
        st, rows = call("GET", "/records?kind=eq.journal&select=id", tok)
        st2, rows2 = call("GET", "/journal_entries?select=id", tok)
        check(f"Index journal: the assistant for Olive {label} reads none of her pages (others could read the answer)", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    for who in ("u-alex", "u-pub"):
        st, rows = call("GET", "/journal_entries?select=id", mint(who, assistant=True))
        check(f"Index journal: the assistant for {NAME[who]} reads none of Olive's pages", st == 200 and oj not in {r["id"] for r in rows}, str(rows))
    helper = mint("u-org", assistant=True)
    st, _ = call("DELETE", f"/journal_entries?id=eq.{oj}", helper)
    st2, _ = call("PATCH", f"/journal_entries?id=eq.{oj}", helper, {"body": "by the assistant"})
    st3, _ = call("POST", "/journal_entries", helper, {"day": "2026-01-05", "body": "by the assistant"})
    check("Index journal: the assistant still cannot delete, change or write a page", refused(st) and refused(st2) and refused(st3)
          and oq(f"select body from weft.journal_entries where id = '{oj}'").startswith("IXRJOURNAL"), f"{st} {st2} {st3}")

    # Profiles: only people who share a space with the owner.
    st, rows = s(pat, "ixrskill")
    check("Index profiles: Pat finds Olive's profile by a skill (they share #festival; positive control)", any(r["id"] == O and r["kind"] == "profile" and r["title"].startswith("Olive") for r in rows or []), str(rows)[:200])
    st, rows = s(mint("u-org", scope="organizers"), "ixrpatskill")
    check("Index profiles: an Organizers-scoped token does not find Pat's profile (Pat is not in Organizers)", st == 200 and not any(r["id"] == P for r in rows), str(rows)[:200])
    L, LS = uid("user", "u-lone"), uid("space", "personal-u-lone")
    oq(f"insert into weft.users (id, email, display_name) values ('{L}', 'lone.index@example.com', 'Lone') on conflict do nothing")
    oq(f"insert into weft.spaces (id, kind, name, created_by) values ('{LS}', 'personal', 'Personal', '{L}') on conflict do nothing")
    oq(f"insert into weft.members (space_id, user_id, role) values ('{LS}', '{L}', 'owner') on conflict do nothing")
    try:
        call("POST", "/profiles?on_conflict=user_id", mint("u-lone"), {"role": "IXRLONEROLE"}, prefer="resolution=merge-duplicates,return=minimal")
        found = [any(r["id"] == L for r in (s(tok, "ixrlonerole")[1] or [])) for tok in (olive, pat, alex)]
        found.append(call("GET", f"/records?kind=eq.profile&id=eq.{L}&select=id", mint("u-org", assistant=True))[1] != [])
        st, rows = s(mint("u-lone"), "ixrlonerole")
        check("Index profiles: a profile of someone who shares no space is found by nobody (Olive, Pat, Alex, the assistant), only by its owner",
              not any(found) and any(r["id"] == L for r in rows or []), f"{found} {rows}"[:200])
    finally:
        oq(f"delete from weft.spaces where id = '{LS}'")
        oq(f"delete from weft.users where id = '{L}'")

    # Meaning search: embeddings of records are readable only while (and by whom) the record is.
    vec = "[" + ",".join("1" if i == 7 else "0" for i in range(768)) + "]"
    def emb(kind, i):
        oq(f"select weft_private.embed_store('{kind}', '{i}', 'h', 'test-model', '[{{\"content\": \"IXR {kind}\", \"embedding\": \"{vec}\"}}]'::jsonb)")
    for kind in words:
        emb(kind, made[kind]["org"]); emb(kind, made[kind]["fest"])
    emb("journal", oj); emb("profile", O)
    near = lambda tok: {(h["source_type"], h["source_id"]) for h in (call("POST", "/rpc/semantic_search", tok, {"p_query": vec, "p_limit": 50})[1] or [])}
    org_set = {(k, made[k]["org"]) for k in words}
    fest_set = {(k, made[k]["fest"]) for k in words}
    hp, ho, hos = near(pat), near(olive), near(mint("u-org", scope="festival"))
    check("Index meaning: Pat's vector search gets the #festival records (positive control) and none from Organizers", fest_set <= hp and not (org_set & hp), f"{len(hp)}")
    check("Index meaning: Olive gets the Organizers records (positive control); her #festival-scoped token does not", org_set <= ho and not (org_set & hos), f"{len(ho)} {len(hos)}")
    check("Index meaning: Olive's journal page is in her own vector search only (not Pat's, not a scoped token's)",
          ("journal", oj) in ho and ("journal", oj) not in hp and ("journal", oj) not in hos and ("journal", oj) not in near(alex), "")
    check("Index meaning: and in the assistant's only unscoped (her own conversation), never scoped to a channel or her personal space",
          ("journal", oj) in near(mint("u-org", assistant=True)) and ("journal", oj) not in near(mint("u-org", assistant=True, scope="festival"))
          and ("journal", oj) not in near(mint("u-org", assistant=True, scope="personal-u-org")), "")
    st, rows = call("GET", f"/embeddings?source_id=eq.{made['kudos']['org']}&select=content", pat)
    check("Index meaning: Pat cannot read the embedded text of an Organizers kudos", st == 200 and rows == [], str(rows))
    st, _ = call("POST", "/embeddings", olive, {"source_type": "kudos", "source_id": made["kudos"]["fest"], "content": "forged", "embedding": vec, "model": "x"})
    check("Index meaning: nobody writes embeddings through the API", refused(st), str(st))
    # Deleting a row deletes its embeddings: a journal page's words are gone everywhere.
    call("DELETE", f"/kudos?id=eq.{made['kudos']['fest']}", olive)
    call("DELETE", f"/journal_entries?id=eq.{oj}", olive)
    check("Index meaning: deleting a kudos or a journal page deletes its embeddings and embed state",
          oq(f"select count(*) from weft.embeddings where source_id in ('{made['kudos']['fest']}', '{oj}')") == "0"
          and oq(f"select count(*) from weft_private.embed_state where source_id in ('{made['kudos']['fest']}', '{oj}')") == "0"
          and oq("select count(*) from weft.audit where old_row::text like '%IXRJOURNAL%'") == "0")
    st, rows = s(olive, "ixrjournalword")
    check("Index journal: a deleted page is no longer found", st == 200 and not any(r["kind"] == "journal" for r in rows), str(rows)[:200])
    # The embed worker's queue includes the records (as the database owner sees them).
    check("Index meaning: the embedding worker's queue includes records of the new kinds",
          oq("select count(*) from weft_private.embed_pending(500, 'other-model') where source_type in ('announcement','rsvps','resource','shift','timeoff','kudos','milestone','profile')") != "0")
    # A disabled account finds none of it.
    oq(f"update weft.users set disabled = true where id = '{P}'")
    try:
        st, rows = s(pat, "ixrnoticefest")
        st2, rows2 = call("GET", "/records?select=id", pat)
        check("Index: a disabled account finds no records", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}"[:200])
    finally:
        oq(f"update weft.users set disabled = false where id = '{P}'")
    oq(f"delete from weft.profiles where user_id in ('{O}', '{P}')")
    oq("delete from weft.embeddings where model = 'test-model'")


# ---------------------------------------------------------------- teeth
# ---------------------------------------------------------------- rsvps
def rsvps():
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    P, V, O = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org")
    oq = lambda sql: owner_sql(sql)
    ts = lambda iv: oq(f"select to_char(now() + interval '{iv}', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    soon, soon_end = ts("3 days"), ts("3 days 2 hours")
    mine = lambda ev, who: oq(f"select coalesce((select answer from weft.rsvps where event_id = '{ev}' and user_id = '{who}'), 'none')")
    fest = uid("slot", "S008")   # a seeded #festival event (in the future)
    st, rows = call("POST", "/events", olive, {"space_id": SID["organizers"], "title": "ORG-RSVP-SECRET board dinner", "starts_at": soon, "ends_at": soon_end})
    org = rows[0]["id"] if st == 201 else None
    check("RSVPs: Olive (editor) makes an Organizers event to answer", org is not None, f"{st} {rows}")
    st, rows = call("POST", "/rsvps", olive, {"event_id": org, "answer": "going"})
    check("RSVPs: Olive answers Going in Organizers; the database records her as the person", st == 201 and rows[0]["user_id"] == O and rows[0]["answer"] == "going", f"{st} {rows}")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/rsvps?event_id=eq.{org}&select=user_id", tok)
        st2, rows2 = call("GET", "/rsvps?select=event_id", tok)
        st3, rows3 = call("GET", f"/events?id=eq.{org}&select=id,rsvps(user_id)", tok)
        check(f"RSVPs: {who} gets no Organizers answers, by event, by listing every answer, or through the event",
              st == 200 and rows == [] and org not in {r["event_id"] for r in rows2 or []} and rows3 == [], f"{rows} {rows3}")
        st, _ = call("POST", "/rsvps", tok, {"event_id": org, "answer": "going"})
        check(f"RSVPs: {who} cannot answer on an Organizers event", refused(st), str(st))
    check("RSVPs: so the Organizers event has only Olive's answer", oq(f"select count(*) from weft.rsvps where event_id = '{org}'") == "1")
    # Viewers answer for themselves.
    st, rows = call("POST", "/rsvps", pat, {"event_id": fest, "answer": "going"})
    check("RSVPs: Pat (viewer) answers Going on a #festival event (positive control)", st == 201 and rows[0]["user_id"] == P, f"{st} {rows}")
    st, _ = call("POST", "/rsvps", pat, {"event_id": fest, "answer": "maybe"})
    check("RSVPs: one answer per person per event: a second is refused", st == 409 and mine(fest, P) == "going", str(st))
    st, rows = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", pat, {"answer": "maybe"})
    check("RSVPs: Pat changes her answer to Maybe", st == 200 and len(rows or []) == 1 and rows[0]["answer"] == "maybe", f"{st} {rows}")
    st, _ = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", pat, {"answer": "yes please"})
    st2, _ = call("POST", "/rsvps", vic, {"event_id": fest, "answer": "perhaps"})
    check("RSVPs: only Going, Maybe or Not going", st == 400 and st2 == 400 and mine(fest, P) == "maybe", f"{st} {st2}")
    st, rows = call("POST", "/rsvps", olive, {"event_id": fest, "answer": "no"})
    check("RSVPs: Olive answers Not going on the #festival event", st == 201, f"{st} {rows}")
    # Nobody writes someone else's answer, and Pat still cannot write in #festival.
    st, _ = call("POST", "/rsvps", vic, {"event_id": fest, "answer": "going", "user_id": P})
    check("RSVPs: an answer cannot be given in someone else's name (authorship cannot be forged)", refused(st) and mine(fest, V) == "none", str(st))
    st, rows = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{O}", pat, {"answer": "going"})
    st2, rows2 = call("DELETE", f"/rsvps?event_id=eq.{fest}&user_id=eq.{O}", pat)
    st3, rows3 = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", olive, {"answer": "no"})
    st4, rows4 = call("DELETE", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", olive)
    check("RSVPs: nobody, editors included, changes or clears someone else's answer", rows == [] and rows2 == [] and rows3 == [] and rows4 == []
          and mine(fest, O) == "no" and mine(fest, P) == "maybe", f"{st} {st2} {st3} {st4}")
    st, rows = call("PATCH", f"/events?id=eq.{fest}", pat, {"title": "pwned"})
    st2, _ = call("POST", "/events", pat, {"space_id": SID["festival"], "title": "pwned", "starts_at": soon, "ends_at": soon_end})
    check("RSVPs: answering does not let Pat (viewer) change or add #festival events", rows == [] and refused(st2)
          and oq(f"select title from weft.events where id = '{fest}'") != "pwned", f"{st} {st2}")
    st, _ = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", pat, {"user_id": V})
    st2, _ = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", pat, {"event_id": org})
    st3, _ = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", pat, {"updated_at": "2020-01-01T00:00:00Z"})
    check("RSVPs: an answer's person, event and times cannot be changed", refused(st) and refused(st2) and refused(st3)
          and mine(fest, P) == "maybe", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/rsvps?event_id=eq.{fest}&select=user_id,answer,user:users(display_name)", pat)
    check("RSVPs: members see who answered what (Pat sees her and Olive's answers, with names)", st == 200
          and {(r["user_id"], r["answer"]) for r in rows} == {(P, "maybe"), (O, "no")} and all(r["user"] for r in rows), str(rows))
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/rsvps?event_id=in.({org},{fest})&select=event_id", scoped)
    check("RSVPs: a #festival-scoped token sees only #festival answers", st == 200 and rows and {r["event_id"] for r in rows} == {fest}, str(rows))
    st, rows = call("PATCH", f"/rsvps?event_id=eq.{org}&user_id=eq.{O}", scoped, {"answer": "no"})
    st2, rows2 = call("DELETE", f"/rsvps?event_id=eq.{org}&user_id=eq.{O}", scoped)
    check("RSVPs: nor changes or clears Olive's own Organizers answer", rows == [] and rows2 == [] and mine(org, O) == "going", f"{st} {st2}")
    st, rows = call("PATCH", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", mint("u-pub", scope="volunteers"), {"answer": "going"})
    check("RSVPs: Pat cannot answer through a token scoped to another channel", rows == [] and mine(fest, P) == "maybe", f"{st} {rows}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/rsvps?event_id=eq.{org}&select=answer", helper)
    check("RSVPs: the assistant (for Olive) reads Organizers answers (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/rsvps?event_id=eq.{org}", helper)
    st2, _ = call("POST", "/rsvps", helper, {"event_id": fest, "answer": "going"})
    st3, _ = call("PATCH", f"/rsvps?event_id=eq.{org}", helper, {"answer": "no"})
    check("RSVPs: the assistant cannot delete, give or change answers", refused(st) and refused(st2) and refused(st3)
          and mine(org, O) == "going", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/rsvps?event_id=eq.{org}&select=answer", mint("u-pub", assistant=True))
    check("RSVPs: the assistant for Pat reads no Organizers answers", st == 200 and rows == [], str(rows))
    # Audit.
    st, rows = call("GET", f"/audit?row_id=eq.{fest}&table_name=eq.rsvps&select=op", vic)
    check("RSVPs: a changed #festival answer is in the audit log, for its members, Vic included (positive control)", len(rows or []) >= 1, str(rows))
    call("PATCH", f"/rsvps?event_id=eq.{org}&user_id=eq.{O}", olive, {"answer": "maybe"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&table_name=eq.rsvps&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("RSVPs: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    # Clearing your own answer.
    st, _ = call("DELETE", f"/rsvps?event_id=eq.{fest}&user_id=eq.{O}", olive)
    check("RSVPs: Olive clears her own answer (positive control)", st in (200, 204) and mine(fest, O) == "none", str(st))
    # Ended events: the answers are fixed.
    st, rows = call("POST", "/events", olive, {"space_id": SID["festival"], "title": "Soundcheck", "starts_at": soon, "ends_at": soon_end})
    ev = rows[0]["id"] if st == 201 else None
    call("POST", "/rsvps", pat, {"event_id": ev, "answer": "going"})
    oq(f"update weft.events set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' where id = '{ev}'")
    st, _ = call("PATCH", f"/rsvps?event_id=eq.{ev}&user_id=eq.{P}", pat, {"answer": "no"})
    st2, _ = call("DELETE", f"/rsvps?event_id=eq.{ev}&user_id=eq.{P}", pat)
    st3, body = call("POST", "/rsvps", olive, {"event_id": ev, "answer": "going"})
    check("RSVPs: once an event has ended, nobody changes, clears or adds an answer", refused(st) and refused(st2) and refused(st3)
          and "ended" in json.dumps(body) and mine(ev, P) == "going" and mine(ev, O) == "none", f"{st} {st2} {st3} {body}")
    st, rows = call("GET", f"/rsvps?event_id=eq.{ev}&select=answer", pat)
    check("RSVPs: the ended event's answers can still be read", rows == [{"answer": "going"}], str(rows))
    # Moves follow the space.
    st, rows = call("POST", "/events", olive, {"space_id": SID["festival"], "title": "Parade walk-through", "starts_at": soon, "ends_at": soon_end})
    mv = rows[0]["id"] if st == 201 else None
    for tok in (pat, vic, olive):
        call("POST", "/rsvps", tok, {"event_id": mv, "answer": "going"})
    check("RSVPs: Pat, Vic and Olive say Going to a #festival event", oq(f"select count(*) from weft.rsvps where event_id = '{mv}'") == "3")
    st, _ = call("PATCH", f"/events?id=eq.{mv}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/rsvps?event_id=eq.{mv}&select=user_id", pat)
    check("RSVPs: the event moved to Volunteers keeps only answers from its members (Vic, Olive), and Pat sees none",
          st == 200 and rows == [] and oq(f"select string_agg(user_id::text, ',' order by user_id) from weft.rsvps where event_id = '{mv}'") == ",".join(sorted([V, O])), f"{st} {rows}")
    st, rows = call("GET", f"/rsvps?event_id=eq.{mv}&select=user_id", vic)
    check("RSVPs: Vic (editor in Volunteers) still sees the answers there (positive control)", len(rows or []) == 2, str(rows))
    st, _ = call("PATCH", f"/events?id=eq.{mv}", olive, {"space_id": SID["organizers"]})
    check("RSVPs: moved on to Organizers, only Olive's answer stays", mine(mv, O) == "going" and mine(mv, V) == "none", str(st))
    # Leaving a space takes your answers there with you.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "rsvp test"})
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("POST", "/events", olive, {"space_id": ch, "title": "Picnic", "starts_at": soon, "ends_at": soon_end})
    pic = rows[0]["id"] if st == 201 else None
    st, _ = call("POST", "/rsvps", pat, {"event_id": pic, "answer": "going"})
    check("RSVPs: added to a new channel as a viewer, Pat answers on its event (positive control)", st == 201, str(st))
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    check("RSVPs: removed from the channel, her answer there is gone", mine(pic, P) == "none")
    st, _ = call("DELETE", f"/events?id=eq.{pic}", pat)
    check("RSVPs: Pat cannot delete an event or its answers", oq(f"select count(*) from weft.events where id = '{pic}'") == "1", str(st))
    call("POST", "/rsvps", olive, {"event_id": pic, "answer": "maybe"})
    st, _ = call("DELETE", f"/events?id=eq.{pic}", olive)
    check("RSVPs: deleting an event deletes its answers", st in (200, 204) and oq(f"select count(*) from weft.rsvps where event_id = '{pic}'") == "0", str(st))
    call("DELETE", f"/spaces?id=eq.{ch}", olive)
    for e in (org, ev, mv):
        call("DELETE", f"/events?id=eq.{e}", olive)
    check("RSVPs: deleting an ended event deletes its answers too", oq(f"select count(*) from weft.rsvps where event_id in ('{org}', '{ev}', '{mv}')") == "0")
    call("DELETE", f"/rsvps?event_id=eq.{fest}&user_id=eq.{P}", pat)


    # Moving an event must not leak the answers it drops into the new space (found by the independent review).
    Q = uid("user", "u-quinn")
    oq(f"insert into weft.users (id, email, display_name) values ('{Q}', 'quinn.org@example.com', 'Quinn Organizer') on conflict (id) do nothing")
    oq(f"insert into weft.members (space_id, user_id, role) values ('{SID['organizers']}', '{Q}', 'viewer') on conflict do nothing")
    mev = oq(f"insert into weft.events (space_id, title, starts_at, ends_at, created_by) values ('{SID['organizers']}', 'ORG-RSVP-MOVE planning', now() + interval '5 days', now() + interval '5 days 1 hour', '{O}') returning id").splitlines()[0]
    st, _ = call("POST", "/rsvps", mint("u-quinn"), {"event_id": mev, "answer": "going"}, prefer="return=minimal")
    check("RSVPs: Quinn (only in Organizers) answers an Organizers event", st in (200, 201) and mine(mev, Q) == "going", str(st))
    call("PATCH", f"/events?id=eq.{mev}", olive, {"space_id": SID["festival"]})
    check("RSVPs: moved to #festival, Quinn's answer (she is not in #festival) is dropped", oq(f"select space_id from weft.events where id = '{mev}'") == SID["festival"] and mine(mev, Q) == "none")
    st, rows = call("GET", f"/audit?table_name=eq.rsvps&row_id=eq.{mev}&select=space_id,old_row", pat)
    check("RSVPs: Pat (in #festival) cannot see the dropped answer in the audit log", st == 200 and not any(Q in str(r.get("old_row")) for r in rows), str(rows)[:200])
    check("RSVPs: the drop is recorded under Organizers, where the answer was (positive control)",
          oq(f"select count(*) from weft.audit where table_name = 'rsvps' and row_id = '{mev}' and space_id = '{SID['organizers']}' and old_row->>'user_id' = '{Q}'") == "1"
          and oq(f"select count(*) from weft.audit where table_name = 'rsvps' and row_id = '{mev}' and space_id = '{SID['festival']}'") == "0")

# ---------------------------------------------------------------- bookings
def bookings():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, O, A = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    ts = lambda iv: oq(f"select to_char(date_trunc('hour', now()) + interval '{iv}', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    count = lambda where: oq(f"select count(*) from weft.bookings where {where}")
    # Things to book.
    st, rows = call("POST", "/resources", olive, {"space_id": SID["organizers"], "name": "  ORG-BOOK-SECRET board room ", "note": "Key at the desk"})
    room = rows[0]["id"] if st == 201 else None
    check("Bookings: Olive (editor) adds a thing in Organizers (positive control), created_by set by the database, name trimmed",
          room and rows[0]["created_by"] == O and rows[0]["name"] == "ORG-BOOK-SECRET board room", f"{st} {rows}")
    st, rows = call("POST", "/resources", olive, {"space_id": SID["festival"], "name": "Festival van"})
    van = rows[0]["id"] if st == 201 else None
    check("Bookings: Olive adds a thing in #festival", van is not None, f"{st} {rows}")
    st, _ = call("POST", "/resources", pat, {"space_id": SID["festival"], "name": "pwned"})
    st2, _ = call("POST", "/resources", vic, {"space_id": SID["festival"], "name": "pwned"})
    st3, _ = call("POST", "/resources", vic, {"space_id": SID["organizers"], "name": "pwned"})
    check("Bookings: Pat and Vic (viewers in #festival) cannot add things there, nor Vic in Organizers", refused(st) and refused(st2) and refused(st3), f"{st} {st2} {st3}")
    for key in ("personal-u-org", "dm-alex-olive"):
        st, body = call("POST", "/resources", olive, {"space_id": SID[key], "name": "not a channel"})
        check(f"Bookings: only channels have things to book ({key.split('-')[0]} refused)", st == 400 and "channel" in json.dumps(body), f"{st} {body}")
    # Booking, and no double booking.
    s10, s12, s11, s13, s14 = ts("3 days 10 hours"), ts("3 days 12 hours"), ts("3 days 11 hours"), ts("3 days 13 hours"), ts("3 days 14 hours")
    st, rows = call("POST", "/bookings", olive, {"resource_id": room, "starts_at": s10, "ends_at": s12, "note": "ORG-BOOK-SECRET budget"})
    org = rows[0]["id"] if st == 201 else None
    check("Bookings: Olive books the Organizers room; the database sets who booked and the channel",
          org and rows[0]["booked_by"] == O and rows[0]["space_id"] == SID["organizers"], f"{st} {rows}")
    st, rows = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": s10, "ends_at": s12, "note": " Pick up chairs "})
    fest = rows[0]["id"] if st == 201 else None
    check("Bookings: Olive books the #festival van, note trimmed (positive control)", fest and rows[0]["space_id"] == SID["festival"] and rows[0]["note"] == "Pick up chairs", f"{st} {rows}")
    st, body = call("POST", "/bookings", alex, {"resource_id": van, "starts_at": s11, "ends_at": s13})
    clash = lambda st, body: st in (400, 409) and isinstance(body, dict) and body.get("code") == "23P01"
    check("Bookings: Alex cannot book the van for an overlapping slot (no double booking)", clash(st, body) and "overlaps" in json.dumps(body), f"{st} {body}")
    st, body = call("POST", "/bookings", alex, {"resource_id": van, "starts_at": ts("3 days 9 hours"), "ends_at": ts("3 days 15 hours")})
    check("Bookings: nor a slot that covers the whole booking", clash(st, body), f"{st} {body}")
    st, rows = call("POST", "/bookings", alex, {"resource_id": van, "starts_at": s12, "ends_at": s13})
    alexb = rows[0]["id"] if st == 201 else None
    check("Bookings: a slot that starts as the other ends is fine (positive control)", alexb is not None, f"{st} {rows}")
    st, rows = call("POST", "/bookings", alex, {"resource_id": room, "starts_at": s12, "ends_at": s13})
    check("Bookings: another thing at the same time is fine (the room is not the van)", st == 201, f"{st} {rows}")
    if st == 201:
        call("DELETE", f"/bookings?id=eq.{rows[0]['id']}", alex)
    # The constraint holds even without the trigger's check (two bookings racing).
    try:
        oq(f"set session_replication_role = replica; insert into weft.bookings (resource_id, space_id, starts_at, ends_at, booked_by) values ('{van}', '{SID['festival']}', '{s11}', '{s13}', '{A}')")
        raced = True
    except subprocess.CalledProcessError:
        raced = False
    check("Bookings: the exclusion constraint itself refuses an overlap the trigger did not see", not raced and count(f"resource_id = '{van}'") == "2")
    # Reads: members only, viewers included.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/resources?space_id=eq.{SID['organizers']}&select=id", tok)
        st2, rows2 = call("GET", "/resources?name=like.*ORG-BOOK*&select=id", tok)
        st3, rows3 = call("GET", f"/bookings?or=(resource_id.eq.{room},note.like.*ORG-BOOK*)&select=id", tok)
        check(f"Bookings: {who} gets no Organizers things or bookings, by space, name, thing or note",
              st == 200 and rows == [] and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
    st, rows = call("GET", f"/bookings?resource_id=eq.{van}&select=id,note,who:users!bookings_booked_by_fkey(display_name)&order=starts_at", pat)
    check("Bookings: Pat (viewer) reads the #festival van's bookings with names (positive control)",
          st == 200 and len(rows) == 2 and rows[0]["who"]["display_name"] == "Olive Organizer", str(rows))
    # Viewers read only; outsiders learn nothing.
    st, _ = call("POST", "/bookings", pat, {"resource_id": van, "starts_at": s13, "ends_at": s14})
    st2, _ = call("POST", "/bookings", vic, {"resource_id": van, "starts_at": s13, "ends_at": s14})
    check("Bookings: Pat and Vic (viewers) cannot book the #festival van", refused(st) and refused(st2), f"{st} {st2}")
    st, b1 = call("POST", "/bookings", vic, {"resource_id": room, "starts_at": s10, "ends_at": s12})
    st2, b2 = call("POST", "/bookings", vic, {"resource_id": room, "starts_at": ts("5 days"), "ends_at": ts("5 days 1 hour")})
    st3, b3 = call("POST", "/bookings", vic, {"resource_id": uid("resource", "nothing"), "starts_at": s10, "ends_at": s12})
    st4, b4 = call("POST", "/bookings", vic, {"resource_id": room, "starts_at": ts("-3 days"), "ends_at": ts("-3 days 1 hour")})
    check("Bookings: Vic booking the Organizers room gets the same refusal whether the slot is taken, free, in the past, or the thing does not exist",
          all(refused(x) for x in (st, st2, st3, st4)) and len({json.dumps(b.get("message") if isinstance(b, dict) else b) for b in (b1, b2, b3, b4)}) == 1, f"{st} {st2} {st3} {st4} {b1} {b3}")
    st, rows = call("PATCH", f"/bookings?id=eq.{fest}", pat, {"note": "pwned"})
    st2, rows2 = call("DELETE", f"/bookings?id=eq.{fest}", pat)
    st3, rows3 = call("PATCH", f"/resources?id=eq.{van}", pat, {"name": "pwned"})
    check("Bookings: Pat cannot change or cancel a booking, or rename the van", rows == [] and rows2 == [] and (refused(st3) or rows3 == []), f"{st} {st2} {st3}")
    check("Bookings: so the booking and the van are unchanged", oq(f"select note from weft.bookings where id = '{fest}'") == "Pick up chairs"
          and oq(f"select name from weft.resources where id = '{van}'") == "Festival van")
    # The booker or an owner changes and cancels; another editor does not.
    st, rows = call("PATCH", f"/bookings?id=eq.{alexb}", olive, {"note": "pwned"})
    st2, rows2 = call("DELETE", f"/bookings?id=eq.{alexb}", olive)
    check("Bookings: Olive (editor) cannot change or cancel Alex's booking", rows == [] and rows2 == [] and count(f"id = '{alexb}' and note = ''") == "1", f"{st} {st2} {rows}")
    st, rows = call("PATCH", f"/bookings?id=eq.{fest}", olive, {"starts_at": ts("3 days 9 hours"), "note": "Chairs and tables"})
    check("Bookings: Olive changes her own booking (positive control)", st == 200 and len(rows or []) == 1 and rows[0]["note"] == "Chairs and tables", f"{st} {rows}")
    st, body = call("PATCH", f"/bookings?id=eq.{fest}", olive, {"ends_at": s13})
    check("Bookings: a change that overlaps another booking is refused too", clash(st, body), f"{st} {body}")
    st, rows = call("PATCH", f"/bookings?id=eq.{fest}", alex, {"note": "Checked by Alex"})
    check("Bookings: Alex (owner of #festival) can change Olive's booking", st == 200 and len(rows or []) == 1 and rows[0]["booked_by"] == O, f"{st} {rows}")
    st, rows = call("PATCH", f"/resources?id=eq.{van}", olive, {"name": " Festival van (white) ", "note": "Diesel"})
    check("Bookings: Olive (editor) renames the van", st == 200 and rows and rows[0]["name"] == "Festival van (white)", f"{st} {rows}")
    # Sensible times.
    st, _ = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": ts("-2 hours"), "ends_at": ts("-1 hour")})
    st2, _ = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": ts("10 days"), "ends_at": ts("42 days")})
    st3, _ = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": ts("10 days 2 hours"), "ends_at": ts("10 days 1 hour")})
    st4, _ = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": ts("10 days"), "ends_at": ts("10 days 1 hour"), "note": "x" * 201})
    check("Bookings: a booking that has ended, lasts over 31 days, ends before it starts, or has a long note is refused",
          all(x == 400 for x in (st, st2, st3, st4)), f"{st} {st2} {st3} {st4}")
    past = oq(f"insert into weft.bookings (resource_id, space_id, starts_at, ends_at, booked_by) values ('{van}', '{SID['festival']}', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', '{O}') returning id").splitlines()[0]
    st, b = call("PATCH", f"/bookings?id=eq.{past}", olive, {"note": "late"})
    st2, b2 = call("DELETE", f"/bookings?id=eq.{past}", olive)
    check("Bookings: an ended booking is fixed: neither changed nor cancelled", refused(st) and refused(st2) and count(f"id = '{past}' and note = ''") == "1", f"{st} {st2} {b}")
    # Authorship, the channel and the thing are fixed.
    st, _ = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": ts("6 days"), "ends_at": ts("6 days 1 hour"), "booked_by": A})
    st2, _ = call("POST", "/bookings", olive, {"resource_id": van, "starts_at": ts("6 days"), "ends_at": ts("6 days 1 hour"), "space_id": SID["organizers"]})
    st3, _ = call("POST", "/resources", olive, {"space_id": SID["festival"], "name": "forged", "created_by": A})
    check("Bookings: who booked, the booking's channel and who added a thing cannot be forged", refused(st) and refused(st2) and refused(st3), f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/bookings?id=eq.{fest}", olive, {"booked_by": A})
    st2, _ = call("PATCH", f"/bookings?id=eq.{fest}", olive, {"resource_id": room})
    st3, _ = call("PATCH", f"/bookings?id=eq.{fest}", olive, {"space_id": SID["organizers"]})
    st4, _ = call("PATCH", f"/resources?id=eq.{van}", olive, {"space_id": SID["organizers"]})
    check("Bookings: nor changed afterwards: a booking never moves to another thing or channel, nor a thing to another channel",
          all(refused(x) for x in (st, st2, st3, st4)) and oq(f"select booked_by::text || resource_id::text || space_id::text from weft.bookings where id = '{fest}'") == f"{O}{van}{SID['festival']}"
          and oq(f"select space_id from weft.resources where id = '{van}'") == SID["festival"], f"{st} {st2} {st3} {st4}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/bookings?id=in.({org},{fest})&select=space_id", scoped)
    st2, rows2 = call("GET", f"/resources?id=in.({room},{van})&select=space_id", scoped)
    check("Bookings: a #festival-scoped token sees only #festival things and bookings", rows and {r["space_id"] for r in rows} == {SID["festival"]}
          and rows2 and {r["space_id"] for r in rows2} == {SID["festival"]}, f"{rows} {rows2}")
    st, _ = call("POST", "/bookings", scoped, {"resource_id": room, "starts_at": ts("7 days"), "ends_at": ts("7 days 1 hour")})
    check("Bookings: nor books in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/bookings?id=eq.{org}&select=id", helper)
    check("Bookings: the assistant (for Olive) reads Organizers bookings (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/bookings?id=eq.{org}", helper)
    st2, _ = call("PATCH", f"/bookings?id=eq.{org}", helper, {"note": "by the assistant"})
    st3, _ = call("POST", "/bookings", helper, {"resource_id": room, "starts_at": ts("8 days"), "ends_at": ts("8 days 1 hour")})
    st4, _ = call("DELETE", f"/resources?id=eq.{room}", helper)
    check("Bookings: the assistant cannot delete, change or make bookings, nor delete things", all(refused(x) for x in (st, st2, st3, st4))
          and count(f"id = '{org}' and note = 'ORG-BOOK-SECRET budget'") == "1", f"{st} {st2} {st3} {st4}")
    st, rows = call("GET", f"/bookings?id=eq.{org}&select=id", mint("u-pub", assistant=True))
    check("Bookings: the assistant for Pat reads no Organizers bookings", st == 200 and rows == [], str(rows))
    # Audit.
    call("PATCH", f"/bookings?id=eq.{org}", olive, {"note": "ORG-BOOK-SECRET budget, moved"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Bookings: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/audit?row_id=eq.{fest}&select=op", vic)
    check("Bookings: #festival changes are readable by its members, Vic included (positive control)", len(rows or []) >= 1, str(rows))
    # Deleting: owners delete things (and their bookings go); the booker cancels.
    st, rows = call("DELETE", f"/resources?id=eq.{van}", olive)
    check("Bookings: Olive (editor) cannot delete the van", rows == [] and oq(f"select count(*) from weft.resources where id = '{van}'") == "1", f"{st} {rows}")
    st, _ = call("DELETE", f"/bookings?id=eq.{fest}", olive)
    check("Bookings: Olive cancels her own booking (positive control)", st in (200, 204) and count(f"id = '{fest}'") == "0", str(st))
    st, _ = call("DELETE", f"/resources?id=eq.{van}", alex)
    check("Bookings: Alex (owner) deletes the van, and its bookings (the ended one too) go with it", st in (200, 204)
          and oq(f"select count(*) from weft.resources where id = '{van}'") == "0" and count(f"resource_id = '{van}'") == "0", str(st))
    # Membership decides, and deleting the channel deletes everything in it.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "booking test"})
    st, rows = call("POST", "/resources", olive, {"space_id": ch, "name": "Projector"})
    proj = rows[0]["id"] if st == 201 else None
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "editor"}, prefer="return=minimal")
    st, rows = call("POST", "/bookings", pat, {"resource_id": proj, "starts_at": ts("4 days"), "ends_at": ts("4 days 2 hours")})
    pb = rows[0]["id"] if st == 201 else None
    check("Bookings: added as an editor, Pat books the projector (positive control)", pb is not None and rows[0]["booked_by"] == P, f"{st} {rows}")
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, rows = call("GET", f"/bookings?id=eq.{pb}&select=id", pat)
    st2, rows2 = call("DELETE", f"/bookings?id=eq.{pb}", pat)
    check("Bookings: removed from the channel, she reads nothing there and cannot cancel", rows == [] and rows2 == [] and count(f"id = '{pb}'") == "1", f"{rows} {rows2}")
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Bookings: deleting the channel deletes its things and bookings", st in (200, 204)
          and oq(f"select count(*) from weft.resources where id = '{proj}'") == "0" and count(f"id = '{pb}'") == "0", str(st))
    call("DELETE", f"/bookings?id=eq.{alexb}", alex)
    call("DELETE", f"/resources?id=eq.{room}", alex)


def repeating_bookings():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, O, A = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    rpc = lambda tok, body: call("POST", "/rpc/book_weekly", tok, body)
    utc = lambda rows: ",".join(oq(f"select to_char('{r['starts_at']}'::timestamptz at time zone 'UTC', 'MM-DD HH24:MI')") for r in rows)
    st, rows = call("POST", "/resources", olive, {"space_id": SID["organizers"], "name": "RB-ORG-SECRET room"})
    room = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/resources", olive, {"space_id": SID["festival"], "name": "RB festival van"})
    van = rows[0]["id"] if st == 201 else None
    # Alex already has the room on the third week.
    st, rows = call("POST", "/bookings", alex, {"resource_id": room, "starts_at": "2027-03-24T17:30:00Z", "ends_at": "2027-03-24T19:00:00Z"})
    check("Repeating bookings: setup, Alex books the Organizers room once", st == 201 and room and van, f"{st} {rows}")
    # Olive books it weekly, in Berlin time, across the clock change of 28 March 2027.
    week = {"p_resource": room, "p_starts": "2027-03-10T17:00:00Z", "p_ends": "2027-03-10T18:00:00Z", "p_weeks": 5, "p_note": " RB-ORG-SECRET budget ", "p_tz": "Europe/Berlin"}
    st, res = rpc(olive, week)
    ok = st == 200 and isinstance(res, dict)
    sid = res["series"] if ok else None
    check("Repeating bookings: Olive (editor) books the Organizers room weekly for 5 weeks; 4 booked, 1 refused (positive control)",
          ok and len(res["booked"]) == 4 and len(res["clashed"]) == 1, f"{st} {res}")
    check("Repeating bookings: the refused week is the one that clashes, and it says whose booking is in the way",
          ok and utc(res["clashed"]) == "03-24 17:00" and (res["clashed"][0].get("by") or "").startswith("Alex"), str(res))
    check("Repeating bookings: the weeks keep the local time across a clock change (18:00 Berlin is 17:00 UTC, then 16:00 UTC)",
          ok and utc(res["booked"]) == "03-10 17:00,03-17 17:00,03-31 16:00,04-07 16:00", str(res))
    check("Repeating bookings: each week is an ordinary booking by Olive in Organizers, note trimmed, in the series",
          oq(f"select count(*) from weft.bookings where series_id = '{sid}' and booked_by = '{O}' and space_id = '{SID['organizers']}' and note = 'RB-ORG-SECRET budget' and ends_at - starts_at = interval '1 hour'") == "4")
    check("Repeating bookings: the series is the room's, in Organizers, made by Olive (set by the database)",
          oq(f"select resource_id::text || space_id::text || created_by::text || weeks || tz from weft.booking_series where id = '{sid}'") == f"{room}{SID['organizers']}{O}5Europe/Berlin")
    # Reading follows membership.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/booking_series?id=eq.{sid}", tok)
        st2, rows2 = call("GET", f"/bookings?series_id=eq.{sid}&select=id", tok)
        st3, rows3 = call("GET", "/booking_series?select=id,resource_id", tok)
        check(f"Repeating bookings: {who} sees no Organizers series nor its bookings", st == 200 and rows == [] and rows2 == []
              and room not in {r["resource_id"] for r in rows3 or []}, f"{rows} {rows2} {rows3}")
    st, rows = call("GET", f"/bookings?series_id=eq.{sid}&select=id,series:booking_series(weeks)", olive)
    check("Repeating bookings: Olive reads her bookings with their series (positive control)", st == 200 and len(rows) == 4 and rows[0]["series"] == {"weeks": 5}, str(rows))
    # Outsiders cannot book weekly in Organizers, and learn nothing from trying.
    later = {**week, "p_starts": "2027-06-01T10:00:00Z", "p_ends": "2027-06-01T11:00:00Z"}
    st, b = rpc(vic, later)
    st2, b2 = rpc(vic, {**later, "p_resource": uid("resource", "nothing")})
    st3, b3 = rpc(vic, week)
    st4, b4 = rpc(pat, later)
    check("Repeating bookings: Vic and Pat cannot book the Organizers room weekly; the same answer whether it is free, taken or does not exist",
          all(refused(x) for x in (st, st2, st3, st4)) and len({json.dumps(x.get("message") if isinstance(x, dict) else x) for x in (b, b2, b3, b4)}) == 1
          and oq(f"select count(*) from weft.booking_series where resource_id = '{room}'") == "1", f"{st} {st2} {st3} {st4} {b} {b2}")
    # #festival: viewers read, editors book.
    fw = {"p_resource": van, "p_starts": "2027-05-04T08:00:00Z", "p_ends": "2027-05-04T10:00:00Z", "p_weeks": 3, "p_tz": "UTC"}
    st, _ = rpc(pat, fw)
    st2, _ = rpc(vic, fw)
    check("Repeating bookings: Pat and Vic (viewers in #festival) cannot book the van weekly", refused(st) and refused(st2)
          and oq(f"select count(*) from weft.bookings where resource_id = '{van}'") == "0", f"{st} {st2}")
    st, fres = rpc(olive, fw)
    fsid = fres["series"] if st == 200 else None
    check("Repeating bookings: Olive books the #festival van weekly for 3 weeks, none clash (positive control)",
          st == 200 and len(fres["booked"]) == 3 and fres["clashed"] == [], f"{st} {fres}")
    st, rows = call("GET", f"/bookings?series_id=eq.{fsid}&select=id,series:booking_series(weeks)", pat)
    check("Repeating bookings: Pat (viewer) reads the #festival series and its 3 bookings (positive control)", st == 200 and len(rows) == 3 and rows[0]["series"]["weeks"] == 3, str(rows))
    # When every week clashes, nothing is made and the answer lists the dates.
    n = oq("select count(*) from weft.booking_series")
    st, body = rpc(alex, fw)
    check("Repeating bookings: when every week clashes, it is refused with the dates, and no series is left behind",
          st in (400, 409) and isinstance(body, dict) and body.get("code") == "23P01" and "2027-05-04, 2027-05-11, 2027-05-18" in body.get("message", "")
          and oq("select count(*) from weft.booking_series") == n, f"{st} {body}")
    # Sensible input.
    bad = [{**fw, "p_weeks": 1}, {**fw, "p_weeks": 27}, {**fw, "p_ends": "2027-05-12T09:00:00Z"}, {**fw, "p_ends": "2027-05-04T07:00:00Z"},
           {**fw, "p_tz": "Mars/Olympus"}, {**fw, "p_starts": "2020-05-04T08:00:00Z", "p_ends": "2020-05-04T10:00:00Z"}, {**fw, "p_starts": "2027-08-01T08:00:00Z", "p_ends": "2027-08-01T09:00:00Z", "p_note": "x" * 201}]
    sts = [rpc(olive, x)[0] for x in bad]
    check("Repeating bookings: 1 or 27 weeks, longer than a week, ending before it starts, an unknown time zone, a first week that has ended or a long note are refused, leaving nothing",
          all(x == 400 for x in sts) and oq("select count(*) from weft.booking_series") == n, str(sts))
    # A booking joins only its own booker's series for the same thing; series_id never changes.
    free = {"resource_id": van, "starts_at": "2027-07-01T08:00:00Z", "ends_at": "2027-07-01T09:00:00Z"}
    st, body = call("POST", "/bookings", alex, {**free, "series_id": fsid})
    st2, body2 = call("POST", "/bookings", olive, {**free, "series_id": sid})
    check("Repeating bookings: Alex cannot add a booking to Olive's series, nor Olive put a van booking in the room's series",
          st == 400 and "series" in json.dumps(body) and st2 == 400 and oq(f"select count(*) from weft.bookings where resource_id = '{van}' and starts_at = '2027-07-01T08:00:00Z'") == "0", f"{st} {body} {st2} {body2}")
    st, rows = call("POST", "/bookings", olive, {**free, "series_id": fsid})
    extra = rows[0]["id"] if st == 201 else None
    check("Repeating bookings: Olive adds a booking to her own van series (positive control)", extra and rows[0]["series_id"] == fsid, f"{st} {rows}")
    st, _ = call("PATCH", f"/bookings?id=eq.{extra}", olive, {"series_id": sid})
    st2, _ = call("POST", "/bookings", pat, {**free, "starts_at": "2027-07-02T08:00:00Z", "ends_at": "2027-07-02T09:00:00Z", "series_id": fsid})
    check("Repeating bookings: a booking's series cannot be changed, and Pat (viewer) cannot join one", refused(st) and refused(st2)
          and oq(f"select series_id from weft.bookings where id = '{extra}'") == fsid, f"{st} {st2}")
    # A series is never forged, changed or deleted directly.
    st, _ = call("POST", "/booking_series", olive, {"resource_id": van, "weeks": 3, "created_by": A})
    st2, _ = call("POST", "/booking_series", olive, {"resource_id": van, "weeks": 3, "space_id": SID["organizers"]})
    st3, r3 = call("PATCH", f"/booking_series?id=eq.{fsid}", olive, {"weeks": 26})
    st4, r4 = call("DELETE", f"/booking_series?id=eq.{fsid}", alex)
    st5, _ = call("POST", "/booking_series", vic, {"resource_id": room, "weeks": 3})
    check("Repeating bookings: a series' author or channel cannot be forged, a series is not changed or deleted directly, and Vic cannot make one in Organizers",
          all(refused(x) or (isinstance(r, list) and r == []) for x, r in ((st, None), (st2, None), (st3, r3), (st4, r4), (st5, None)))
          and refused(st) and refused(st2) and refused(st5)
          and oq(f"select weeks::text || created_by::text from weft.booking_series where id = '{fsid}'") == f"3{O}", f"{st} {st2} {st3} {st4} {st5}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/booking_series?id=in.({sid},{fsid})&select=space_id", scoped)
    check("Repeating bookings: a #festival-scoped token sees only the #festival series", rows and {r["space_id"] for r in rows} == {SID["festival"]}, str(rows))
    st, _ = rpc(scoped, later)
    check("Repeating bookings: nor books weekly in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/booking_series?id=eq.{sid}&select=id", helper)
    check("Repeating bookings: the assistant (for Olive) reads the Organizers series (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = rpc(helper, later)
    st2, _ = call("DELETE", f"/bookings?series_id=eq.{sid}", helper)
    st3, _ = call("DELETE", f"/booking_series?id=eq.{sid}", helper)
    st4, _ = call("POST", "/booking_series", helper, {"resource_id": room, "weeks": 3})
    check("Repeating bookings: the assistant cannot book weekly, cancel a series' bookings, or delete or make a series",
          all(refused(x) for x in (st, st2, st3, st4)) and oq(f"select count(*) from weft.bookings where series_id = '{sid}'") == "4", f"{st} {st2} {st3} {st4}")
    st, rows = call("GET", f"/booking_series?id=eq.{sid}&select=id", mint("u-pub", assistant=True))
    check("Repeating bookings: the assistant for Pat reads no Organizers series", st == 200 and rows == [], str(rows))
    # Cancelling this and the later ones: the booker or an owner; others cannot; an ended week stays.
    third = urllib.parse.quote(fres["booked"][1]["starts_at"]) if fsid else ""
    st, rows = call("DELETE", f"/bookings?series_id=eq.{fsid}&starts_at=gte.{third}&ends_at=gt.now", pat)
    st2, rows2 = call("DELETE", f"/bookings?series_id=eq.{fsid}&starts_at=gte.{third}", mint("u-org", scope="organizers"))
    check("Repeating bookings: Pat (viewer), or Olive with an Organizers-scoped token, cannot cancel the van series",
          rows == [] and rows2 == [] and oq(f"select count(*) from weft.bookings where series_id = '{fsid}'") == "4", f"{st} {rows} {st2} {rows2}")
    past = oq(f"insert into weft.bookings (resource_id, space_id, starts_at, ends_at, booked_by, series_id) values ('{van}', '{SID['festival']}', now() - interval '7 days', now() - interval '7 days' + interval '1 hour', '{O}', '{fsid}') returning id").splitlines()[0]
    st, rows = call("DELETE", f"/bookings?series_id=eq.{fsid}&starts_at=gte.{third}&ends_at=gt.now", olive)
    check("Repeating bookings: Olive cancels the second week and the later ones (positive control); the first week and an ended one stay",
          st == 200 and len(rows or []) == 3 and oq(f"select count(*) from weft.bookings where series_id = '{fsid}'") == "2"
          and oq(f"select count(*) from weft.bookings where id = '{past}'") == "1", f"{st} {rows}")
    st, _ = call("DELETE", f"/bookings?series_id=eq.{fsid}", olive)
    check("Repeating bookings: cancelling a whole series that has an ended week is refused (an ended booking is fixed)",
          refused(st) and oq(f"select count(*) from weft.bookings where id = '{past}'") == "1", str(st))
    st, rows = call("DELETE", f"/bookings?series_id=eq.{sid}&ends_at=gt.now", alex)
    check("Repeating bookings: Alex (owner of Organizers) can cancel Olive's weekly bookings there", st == 200 and len(rows or []) == 4, f"{st} {rows}")
    # Deleting the thing deletes its series and their bookings, the ended one too.
    st, _ = call("DELETE", f"/resources?id=eq.{van}", alex)
    check("Repeating bookings: deleting the van deletes its series and every booking in them", st in (200, 204)
          and oq(f"select count(*) from weft.booking_series where id = '{fsid}'") == "0" and oq(f"select count(*) from weft.bookings where id = '{past}'") == "0", str(st))
    call("DELETE", f"/resources?id=eq.{room}", alex)
    check("Repeating bookings: deleting the room deletes its series", oq(f"select count(*) from weft.booking_series where id = '{sid}'") == "0")


def copy_shifts():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    rpc = lambda tok, body: call("POST", "/rpc/copy_shifts", tok, body)
    org, fest = SID["organizers"], SID["festival"]
    utc = lambda where: oq(f"select coalesce(string_agg(to_char(starts_at at time zone 'UTC', 'MM-DD HH24:MI') || '-' || to_char(ends_at at time zone 'UTC', 'HH24:MI'), ',' order by starts_at), '') from weft.shifts where {where}")
    made = []

    def add(tok, body):
        st, rows = call("POST", "/shifts", tok, body)
        if st == 201:
            made.append(rows[0]["id"])
            return rows[0]["id"]
        return None
    # The Organizers rota, the week of Monday 22 March 2027, in Berlin time (the clocks change on Sunday 28 March).
    desk = add(olive, {"space_id": org, "title": "CS-ORG-SECRET desk", "starts_at": "2027-03-22T08:00:00Z", "ends_at": "2027-03-22T11:00:00Z", "places": 2, "note": "Back office"})
    bar = add(alex, {"space_id": org, "title": "CS-ORG-SECRET bar", "starts_at": "2027-03-27T17:00:00Z", "ends_at": "2027-03-27T22:00:00Z", "places": 3})
    outside = add(olive, {"space_id": org, "title": "CS-ORG-SECRET outside", "starts_at": "2027-03-29T08:00:00Z", "ends_at": "2027-03-29T09:00:00Z", "places": 1})
    st, _ = call("POST", "/shift_signups", alex, {"shift_id": desk})
    check("Copy shifts: setup, an Organizers week of two shifts (one by Alex, one with Alex signed up) and one shift the week after",
          desk and bar and outside and st == 201)
    week = {"p_space": org, "p_from": "2027-03-22", "p_days": 7, "p_to": "2027-03-29", "p_tz": "Europe/Berlin"}
    n0 = oq(f"select count(*) from weft.shifts where space_id = '{org}'")
    # Outsiders and viewers cannot copy, and learn nothing from trying.
    st, b = rpc(vic, week)
    st2, b2 = rpc(vic, {**week, "p_space": uid("space", "nothing")})
    st3, b3 = rpc(pat, week)
    st4, b4 = rpc(pat, {**week, "p_from": "2030-01-01", "p_to": "2030-01-08"})
    check("Copy shifts: Vic and Pat cannot copy Organizers shifts; the same answer whether there are shifts, none, or no such channel",
          all(refused(x) for x in (st, st2, st3, st4)) and len({json.dumps(x.get("message") if isinstance(x, dict) else x) for x in (b, b2, b3, b4)}) == 1
          and oq(f"select count(*) from weft.shifts where space_id = '{org}'") == n0, f"{st} {st2} {st3} {st4} {b} {b2}")
    # Olive (editor) copies the week (positive control).
    st, res = rpc(olive, week)
    check("Copy shifts: Olive (editor) copies the Organizers week a week on: 2 copied (positive control)",
          st == 200 and isinstance(res, dict) and res.get("copied") == 2 and res.get("already") == 0 and res.get("past") == 0 and res.get("first"), f"{st} {res}")
    copies = "space_id = '{}' and starts_at >= '2027-03-29' and starts_at < '2027-04-05' and title <> 'CS-ORG-SECRET outside'".format(org)
    made += oq(f"select id from weft.shifts where {copies}").split()
    check("Copy shifts: the copies keep the clock time across the clock change (09:00 and 18:00 in Berlin: 08:00 and 17:00 UTC in winter, 07:00 and 16:00 UTC in summer)",
          utc(copies) == "03-29 07:00-10:00,04-03 16:00-21:00", utc(copies))
    check("Copy shifts: the copies keep title, places and note, are by Olive (set by the database), and have nobody signed up",
          oq(f"select string_agg(title || '|' || places || '|' || note || '|' || (created_by = '{O}')::text, ';' order by starts_at) from weft.shifts where {copies}")
          == "CS-ORG-SECRET desk|2|Back office|true;CS-ORG-SECRET bar|3||true"
          and oq(f"select count(*) from weft.shift_signups x join weft.shifts s on s.id = x.shift_id where {copies.replace('space_id', 's.space_id').replace('starts_at', 's.starts_at').replace('title', 's.title')}") == "0"
          and oq(f"select count(*) from weft.shift_signups where shift_id = '{desk}'") == "1")
    st, res = rpc(olive, week)
    check("Copy shifts: copying the same week again makes nothing new (2 already there)",
          st == 200 and res.get("copied") == 0 and res.get("already") == 2 and res.get("first") is None
          and oq(f"select count(*) from weft.shifts where {copies}") == "2", f"{st} {res}")
    # Reading the copies follows membership.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/shifts?space_id=eq.{org}&select=id", tok)
        check(f"Copy shifts: {who} sees none of the Organizers copies", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/shifts?id=in.({','.join(made)})&select=id", olive)
    check("Copy shifts: Olive reads them all (positive control)", st == 200 and len(rows) == len(made), f"{len(rows or [])} {len(made)}")
    # A single day, and Alex (owner) may copy too.
    st, res = rpc(alex, {**week, "p_days": 1, "p_to": "2027-04-05"})
    made += oq(f"select id from weft.shifts where space_id = '{org}' and starts_at >= '2027-04-05' and starts_at < '2027-04-06'").split()
    check("Copy shifts: Alex (owner) copies just the Monday two weeks on: only the desk shift, by Alex",
          st == 200 and res.get("copied") == 1 and utc(f"space_id = '{org}' and starts_at >= '2027-04-05' and starts_at < '2027-04-12'") == "04-05 07:00-10:00"
          and oq(f"select created_by from weft.shifts where id = '{res.get('first')}'") == A, f"{st} {res}")
    # #festival: viewers read the copies, editors copy.
    fs = add(olive, {"space_id": fest, "title": "CS festival gate", "starts_at": "2027-05-04T08:00:00Z", "ends_at": "2027-05-04T12:00:00Z", "places": 4})
    fday = {"p_space": fest, "p_from": "2027-05-04", "p_days": 1, "p_to": "2027-05-11", "p_tz": "UTC"}
    st, _ = rpc(pat, fday)
    st2, _ = rpc(vic, fday)
    check("Copy shifts: Pat and Vic (viewers in #festival) cannot copy there", refused(st) and refused(st2)
          and oq(f"select count(*) from weft.shifts where space_id = '{fest}' and title = 'CS festival gate'") == "1", f"{st} {st2}")
    st, res = rpc(olive, fday)
    if st == 200 and res.get("first"):
        made.append(res["first"])
    st2, rows = call("GET", f"/shifts?id=eq.{res.get('first') if isinstance(res, dict) else ''}&select=title,places", pat)
    check("Copy shifts: Olive copies the #festival day (positive control) and Pat (viewer) reads the copy",
          fs and st == 200 and res.get("copied") == 1 and rows == [{"title": "CS festival gate", "places": 4}], f"{st} {res} {rows}")
    # Vic edits Volunteers: he can copy there (positive control), and only there.
    vs = add(vic, {"space_id": SID["volunteers"], "title": "CS vol tea", "starts_at": "2027-05-05T08:00:00Z", "ends_at": "2027-05-05T09:00:00Z", "places": 1})
    st, res = rpc(vic, {**fday, "p_space": SID["volunteers"], "p_from": "2027-05-05", "p_to": "2027-05-06"})
    if st == 200 and res.get("first"):
        made.append(res["first"])
    check("Copy shifts: Vic (editor in Volunteers) copies a Volunteers day (positive control)", vs and st == 200 and res.get("copied") == 1, f"{st} {res}")
    # Sensible input.
    bad = [{**week, "p_days": 0}, {**week, "p_days": 8}, {**week, "p_to": "2027-03-22"}, {**week, "p_to": "2027-03-01"},
           {**week, "p_tz": "Mars/Olympus"}, {**week, "p_to": "2028-03-22"}]
    n1 = oq("select count(*) from weft.shifts")
    sts = [rpc(olive, x)[0] for x in bad]
    check("Copy shifts: 0 or 8 days, the same or an earlier date, an unknown time zone or more than 52 weeks on are refused, making nothing",
          all(x == 400 for x in sts) and oq("select count(*) from weft.shifts") == n1, str(sts))
    # Ended shifts can be copied forward; a copy that would itself have ended is skipped.
    old = oq(f"insert into weft.shifts (space_id, title, starts_at, ends_at, places, created_by) values ('{fest}', 'CS ended', date_trunc('day', now() - interval '9 days') + interval '10 hours', date_trunc('day', now() - interval '9 days') + interval '12 hours', 2, '{O}') returning id").splitlines()[0]
    made.append(old)
    oday = oq("select to_char(now() - interval '9 days', 'YYYY-MM-DD')")
    st, res = rpc(olive, {**fday, "p_from": oday, "p_to": oq("select to_char(now() - interval '8 days', 'YYYY-MM-DD')")})
    check("Copy shifts: a copy that would already have ended is not made (counted as past)", st == 200 and res.get("copied") == 0 and res.get("past") == 1, f"{st} {res}")
    st, res = rpc(olive, {**fday, "p_from": oday, "p_to": oq("select to_char(now() + interval '5 days', 'YYYY-MM-DD')")})
    if st == 200 and res.get("first"):
        made.append(res["first"])
    check("Copy shifts: last week's ended shift is copied into the future (positive control)", st == 200 and res.get("copied") == 1, f"{st} {res}")
    # No author can be forged: the function takes none, and created_by is never granted.
    st, _ = call("POST", "/rpc/copy_shifts", olive, {**fday, "p_created_by": A})
    st2, _ = call("POST", "/shifts", olive, {"space_id": fest, "title": "CS forged", "starts_at": "2027-06-01T08:00:00Z", "ends_at": "2027-06-01T09:00:00Z", "places": 1, "created_by": A})
    check("Copy shifts: no author can be sent to the copy, nor to a shift", st in (400, 404) and refused(st2)
          and oq(f"select count(*) from weft.shifts where title = 'CS forged'") == "0", f"{st} {st2}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, _ = rpc(scoped, {**week, "p_to": "2027-04-12"})
    st2, res = rpc(scoped, {**fday, "p_to": "2027-05-18"})
    if st2 == 200 and res.get("first"):
        made.append(res["first"])
    check("Copy shifts: a #festival-scoped token cannot copy Organizers shifts, but can copy #festival ones (positive control)",
          refused(st) and st2 == 200 and res.get("copied") == 1
          and oq(f"select count(*) from weft.shifts where space_id = '{org}' and starts_at >= '2027-04-12'") == "0", f"{st} {st2} {res}")
    helper = mint("u-org", assistant=True)
    st, _ = rpc(helper, {**fday, "p_to": "2027-05-25"})
    st2, _ = call("DELETE", f"/shifts?id=eq.{fs}", helper)
    st3, rows = call("GET", f"/shifts?id=eq.{fs}&select=id", helper)
    check("Copy shifts: the assistant (for Olive) cannot copy or delete shifts, but reads them (positive control)",
          refused(st) and refused(st2) and st3 == 200 and len(rows) == 1
          and oq(f"select count(*) from weft.shifts where space_id = '{fest}' and starts_at >= '2027-05-25' and starts_at < '2027-05-26'") == "0", f"{st} {st2} {st3}")
    # Copies are ordinary shifts: Pat cannot delete them, Olive can; they go with the channel's rules.
    st, rows = call("DELETE", f"/shifts?space_id=eq.{org}&starts_at=gte.2027-03-29", pat)
    check("Copy shifts: Pat cannot delete the Organizers copies", rows == [] and oq(f"select count(*) from weft.shifts where {copies}") == "2", f"{st} {rows}")
    st, rows = call("DELETE", f"/shifts?space_id=eq.{org}&starts_at=gte.2027-03-29&title=like.CS-ORG-SECRET*&id=neq.{outside}", olive)
    check("Copy shifts: Olive deletes the Organizers copies (positive control)", st == 200 and len(rows or []) == 3, f"{st} {rows}")
    oq("delete from weft.shifts where id in ({})".format(",".join(f"'{x}'" for x in made)))


def shifts():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    ts = lambda iv: oq(f"select to_char(date_trunc('hour', now()) + interval '{iv}', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    on = lambda sh: oq(f"select coalesce(string_agg(user_id::text, ',' order by user_id), '') from weft.shift_signups where shift_id = '{sh}'")
    n_on = lambda sh: oq(f"select count(*) from weft.shift_signups where shift_id = '{sh}'")
    s10, s12 = ts("3 days 10 hours"), ts("3 days 12 hours")
    # Shifts: editors and owners add them, in channels only.
    st, rows = call("POST", "/shifts", olive, {"space_id": SID["organizers"], "title": "  ORG-SHIFT-SECRET cash count ", "starts_at": s10, "ends_at": s12, "places": 2, "note": "Back office"})
    org = rows[0]["id"] if st == 201 else None
    check("Shifts: Olive (editor) adds a shift in Organizers (positive control), created_by set by the database, title trimmed",
          org and rows[0]["created_by"] == O and rows[0]["title"] == "ORG-SHIFT-SECRET cash count", f"{st} {rows}")
    st, rows = call("POST", "/shifts", olive, {"space_id": SID["festival"], "title": "Bar", "starts_at": s10, "ends_at": s12, "places": 2})
    bar = rows[0]["id"] if st == 201 else None
    check("Shifts: Olive adds a #festival shift with two places", bar is not None and rows[0]["places"] == 2, f"{st} {rows}")
    st, _ = call("POST", "/shifts", pat, {"space_id": SID["festival"], "title": "pwned", "starts_at": s10, "ends_at": s12, "places": 1})
    st2, _ = call("POST", "/shifts", vic, {"space_id": SID["festival"], "title": "pwned", "starts_at": s10, "ends_at": s12, "places": 1})
    st3, _ = call("POST", "/shifts", vic, {"space_id": SID["organizers"], "title": "pwned", "starts_at": s10, "ends_at": s12, "places": 1})
    check("Shifts: Pat and Vic (viewers in #festival) cannot add shifts there, nor Vic in Organizers", refused(st) and refused(st2) and refused(st3), f"{st} {st2} {st3}")
    for key in ("personal-u-org", "dm-alex-olive"):
        st, body = call("POST", "/shifts", olive, {"space_id": SID[key], "title": "not a channel", "starts_at": s10, "ends_at": s12, "places": 1})
        check(f"Shifts: only channels have shifts ({key.split('-')[0]} refused)", st == 400 and "channel" in json.dumps(body), f"{st} {body}")
    # Sensible values.
    bad = [{"starts_at": ts("-3 hours"), "ends_at": ts("-2 hours"), "places": 1}, {"starts_at": s12, "ends_at": s10, "places": 1},
           {"starts_at": s10, "ends_at": ts("11 days"), "places": 1}, {"starts_at": s10, "ends_at": s12, "places": 0},
           {"starts_at": s10, "ends_at": s12, "places": 201}, {"starts_at": s10, "ends_at": s12, "places": 1, "note": "x" * 501}]
    sts = [call("POST", "/shifts", olive, {"space_id": SID["festival"], "title": "bad", **b})[0] for b in bad]
    check("Shifts: a shift that has ended, ends before it starts, lasts over 7 days, has 0 or over 200 places or a long note is refused",
          all(x == 400 for x in sts), str(sts))
    # Reads: members only, viewers included.
    call("POST", "/shift_signups", olive, {"shift_id": org})
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/shifts?space_id=eq.{SID['organizers']}&select=id", tok)
        st2, rows2 = call("GET", "/shifts?title=like.*ORG-SHIFT*&select=id", tok)
        st3, rows3 = call("GET", f"/shift_signups?or=(shift_id.eq.{org},space_id.eq.{SID['organizers']})&select=id", tok)
        check(f"Shifts: {who} gets no Organizers shifts or sign-ups, by space, title or shift",
              st == 200 and rows == [] and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
    st, rows = call("GET", f"/shifts?id=eq.{org}&select=id,shift_signups(user_id)", olive)
    check("Shifts: Olive reads the Organizers shift with herself on it (positive control)", st == 200 and len(rows) == 1 and rows[0]["shift_signups"] == [{"user_id": O}], str(rows))
    # Claiming: every member, viewers included, only themselves.
    st, rows = call("POST", "/shift_signups", pat, {"shift_id": bar})
    pat_su = rows[0]["id"] if st == 201 else None
    check("Shifts: Pat (viewer) takes a place on the #festival bar shift (positive control); the database sets her and the channel",
          pat_su and rows[0]["user_id"] == P and rows[0]["space_id"] == SID["festival"], f"{st} {rows}")
    st, body = call("POST", "/shift_signups", pat, {"shift_id": bar})
    check("Shifts: once per person per shift: a second claim is refused", st == 409 and n_on(bar) == "1", f"{st} {body}")
    st, rows = call("GET", f"/shift_signups?shift_id=eq.{bar}&select=user_id,who:users!shift_signups_user_id_fkey(display_name)", vic)
    check("Shifts: Vic (viewer) reads who is on the bar shift, with names", st == 200 and len(rows) == 1 and rows[0]["who"]["display_name"] == "Pat Public", str(rows))
    st, _ = call("POST", "/shift_signups", vic, {"shift_id": bar})
    check("Shifts: Vic takes the second place", st == 201 and n_on(bar) == "2", str(st))
    st, body = call("POST", "/shift_signups", alex, {"shift_id": bar})
    check("Shifts: a full shift takes nobody else, with a plain answer", st == 400 and "full" in json.dumps(body) and n_on(bar) == "2", f"{st} {body}")
    # Forging and outsiders.
    st, _ = call("POST", "/shift_signups", olive, {"shift_id": org, "user_id": A})
    st2, _ = call("POST", "/shift_signups", alex, {"shift_id": org, "space_id": SID["festival"]})
    st3, _ = call("POST", "/shifts", olive, {"space_id": SID["festival"], "title": "forged", "starts_at": s10, "ends_at": s12, "places": 1, "created_by": A})
    check("Shifts: nobody signs up someone else, sets a sign-up's channel or forges who added a shift", refused(st) and refused(st2) and refused(st3)
          and on(org) == O, f"{st} {st2} {st3}")
    st, rows = call("POST", "/shifts", olive, {"space_id": SID["organizers"], "title": "ORG-SHIFT-SECRET open", "starts_at": s10, "ends_at": s12, "places": 5})
    org_open = rows[0]["id"] if st == 201 else None
    oq(f"insert into weft.shift_signups (shift_id, space_id, user_id) values ('{org}', '{SID['organizers']}', '{A}')")   # Organizers shift now full
    past_org = oq(f"insert into weft.shifts (space_id, title, starts_at, ends_at, places, created_by) values ('{SID['organizers']}', 'old', now() - interval '3 hours', now() - interval '2 hours', 3, '{O}') returning id").splitlines()[0]
    answers = [call("POST", "/shift_signups", vic, {"shift_id": x}) for x in (org, org_open, past_org, uid("shift", "nothing"))]
    check("Shifts: Vic claiming in Organizers gets the same refusal whether the shift is full, open, ended or does not exist",
          all(refused(s) for s, _ in answers) and len({json.dumps(b.get("message") if isinstance(b, dict) else b) for _, b in answers}) == 1, str(answers))
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/shifts?id=in.({org},{bar})&select=space_id", scoped)
    st2, rows2 = call("GET", f"/shift_signups?shift_id=in.({org},{bar})&select=space_id", scoped)
    st3, _ = call("POST", "/shift_signups", scoped, {"shift_id": org_open})
    check("Shifts: a #festival-scoped token sees only #festival shifts and sign-ups, and cannot claim in Organizers",
          rows and {r["space_id"] for r in rows} == {SID["festival"]} and rows2 and {r["space_id"] for r in rows2} == {SID["festival"]} and refused(st3), f"{rows} {rows2} {st3}")
    # Changing shifts: editors and owners; viewers cannot.
    st, rows = call("PATCH", f"/shifts?id=eq.{bar}", pat, {"places": 9})
    st2, rows2 = call("DELETE", f"/shifts?id=eq.{bar}", vic)
    check("Shifts: Pat and Vic cannot change or delete the bar shift", (refused(st) or rows == []) and rows2 == []
          and oq(f"select places from weft.shifts where id = '{bar}'") == "2", f"{st} {st2}")
    st, body = call("PATCH", f"/shifts?id=eq.{bar}", olive, {"places": 1})
    check("Shifts: places cannot drop below the people on the shift", st == 400 and "at least 2" in json.dumps(body), f"{st} {body}")
    st, rows = call("PATCH", f"/shifts?id=eq.{bar}", olive, {"places": 3, "title": " Bar (main tent) ", "note": "Bring a jumper"})
    check("Shifts: Olive (editor) gives the shift a third place and a new title (positive control)", st == 200 and rows and rows[0]["places"] == 3 and rows[0]["title"] == "Bar (main tent)", f"{st} {rows}")
    st, _ = call("PATCH", f"/shifts?id=eq.{bar}", olive, {"space_id": SID["organizers"]})
    st2, _ = call("PATCH", f"/shifts?id=eq.{bar}", olive, {"created_by": A})
    st3, _ = call("PATCH", f"/shift_signups?id=eq.{pat_su}", olive, {"shift_id": org_open})
    st4, _ = call("PATCH", f"/shift_signups?id=eq.{pat_su}", pat, {"user_id": V})
    check("Shifts: a shift never moves channel or changes author; a sign-up never moves shift or person",
          all(refused(x) for x in (st, st2, st3, st4)) and oq(f"select space_id from weft.shifts where id = '{bar}'") == SID["festival"]
          and oq(f"select shift_id::text || user_id::text from weft.shift_signups where id = '{pat_su}'") == f"{bar}{P}", f"{st} {st2} {st3} {st4}")
    # Giving back: your own place; editors and owners take anyone off; others cannot.
    vic_su = oq(f"select id from weft.shift_signups where shift_id = '{bar}' and user_id = '{V}'")
    st, rows = call("DELETE", f"/shift_signups?id=eq.{vic_su}", pat)
    check("Shifts: Pat cannot take Vic off the shift", rows == [] and n_on(bar) == "2", f"{st} {rows}")
    st, _ = call("DELETE", f"/shift_signups?id=eq.{pat_su}", pat)
    check("Shifts: Pat gives her place back (positive control)", st in (200, 204) and on(bar) == V, str(st))
    st, _ = call("DELETE", f"/shift_signups?id=eq.{vic_su}", olive)
    check("Shifts: Olive (editor) takes Vic off the shift", st in (200, 204) and on(bar) == "", str(st))
    # Ended shifts are fixed.
    past = oq(f"insert into weft.shifts (space_id, title, starts_at, ends_at, places, created_by) values ('{SID['festival']}', 'Set-up', now() - interval '3 hours', now() - interval '1 hour', 3, '{O}') returning id").splitlines()[0]
    psu = oq(f"insert into weft.shift_signups (shift_id, space_id, user_id) values ('{past}', '{SID['festival']}', '{P}') returning id").splitlines()[0]
    st, _ = call("POST", "/shift_signups", vic, {"shift_id": past})
    st2, _ = call("DELETE", f"/shift_signups?id=eq.{psu}", pat)
    st3, _ = call("DELETE", f"/shift_signups?id=eq.{psu}", alex)
    st4, _ = call("PATCH", f"/shifts?id=eq.{past}", olive, {"ends_at": ts("2 days")})
    check("Shifts: an ended shift is fixed: nobody claims, gives back or is taken off, and the shift does not change",
          all(refused(x) for x in (st, st2, st3, st4)) and on(past) == P, f"{st} {st2} {st3} {st4}")
    # Never over-filled, even when everyone claims the last places at once.
    import threading
    st, rows = call("POST", "/shifts", olive, {"space_id": SID["festival"], "title": "Gate", "starts_at": s10, "ends_at": s12, "places": 2})
    gate = rows[0]["id"]
    got = []
    ths = [threading.Thread(target=lambda tok=tok: got.append(call("POST", "/shift_signups", tok, {"shift_id": gate})[0])) for tok in (pat, vic, olive, alex)]
    [t.start() for t in ths]; [t.join() for t in ths]
    check("Shifts: four people claiming a two-place shift at once: exactly two get it", sorted(got).count(201) == 2 and n_on(gate) == "2", str(sorted(got)))
    # The assistant only reads.
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/shift_signups?shift_id=eq.{org}&select=id", helper)
    check("Shifts: the assistant (for Olive) reads Organizers sign-ups (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("DELETE", f"/shift_signups?shift_id=eq.{org}", helper)
    st2, _ = call("POST", "/shift_signups", helper, {"shift_id": org_open})
    st3, _ = call("DELETE", f"/shifts?id=eq.{org}", helper)
    st4, _ = call("POST", "/shifts", helper, {"space_id": SID["organizers"], "title": "by the assistant", "starts_at": s10, "ends_at": s12, "places": 1})
    st5, _ = call("PATCH", f"/shifts?id=eq.{org}", helper, {"places": 9})
    check("Shifts: the assistant cannot delete, claim, add or change anything", all(refused(x) for x in (st, st2, st3, st4, st5))
          and n_on(org) == "2" and oq(f"select places from weft.shifts where id = '{org}'") == "2", f"{st} {st2} {st3} {st4} {st5}")
    st, rows = call("GET", f"/shifts?id=eq.{org}&select=id", mint("u-pub", assistant=True))
    check("Shifts: the assistant for Pat reads no Organizers shifts", st == 200 and rows == [], str(rows))
    # Audit.
    call("PATCH", f"/shifts?id=eq.{org}", olive, {"note": "ORG-SHIFT-SECRET moved to the office"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Shifts: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/audit?row_id=eq.{pat_su}&select=op", vic)
    check("Shifts: a place given back in #festival is in its audit log, readable by Vic (positive control)", len(rows or []) == 1, str(rows))
    # Deletes and membership follow the channel.
    st, _ = call("DELETE", f"/shifts?id=eq.{gate}", olive)
    check("Shifts: Olive deletes a shift, and its sign-ups go with it", st in (200, 204) and n_on(gate) == "0"
          and oq(f"select count(*) from weft.shifts where id = '{gate}'") == "0", str(st))
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "shift test"})
    st, rows = call("POST", "/shifts", olive, {"space_id": ch, "title": "Stewards", "starts_at": s10, "ends_at": s12, "places": 4})
    stw = rows[0]["id"] if st == 201 else None
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("POST", "/shift_signups", pat, {"shift_id": stw})
    check("Shifts: added as a viewer to a new channel, Pat signs up (positive control)", st == 201 and on(stw) == P, f"{st} {rows}")
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, rows = call("GET", f"/shifts?id=eq.{stw}&select=id", pat)
    check("Shifts: removed from the channel, Pat reads nothing there and is off its shift", rows == [] and on(stw) == "", f"{rows}")
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Shifts: deleting the channel deletes its shifts", st in (200, 204) and oq(f"select count(*) from weft.shifts where id = '{stw}'") == "0", str(st))
    oq(f"delete from weft.shifts where id in ('{org}', '{org_open}', '{past_org}', '{past}', '{bar}')")


def time_off():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    day = lambda n: oq(f"select (current_date + {n})::text")
    d3, d5, d7, d10 = day(3), day(5), day(7), day(10)
    count = lambda where: oq(f"select count(*) from weft.time_off where {where}")
    # Adding: your own, in a channel you are in; editors for anyone in the channel.
    st, rows = call("POST", "/time_off", olive, {"space_id": SID["organizers"], "starts_on": d3, "ends_on": d5, "note": "  ORG-AWAY-SECRET surgery "})
    org = rows[0]["id"] if st == 201 else None
    check("Time off: Olive adds her own in Organizers (positive control); who, created_by set by the database, note trimmed",
          org and rows[0]["user_id"] == O and rows[0]["created_by"] == O and rows[0]["note"] == "ORG-AWAY-SECRET surgery", f"{st} {rows}")
    st, rows = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d5, "ends_on": d7, "note": "Holiday"})
    patt = rows[0]["id"] if st == 201 else None
    check("Time off: Pat (viewer in #festival) adds her own time off there (positive control)", patt and rows[0]["user_id"] == P and rows[0]["created_by"] == P, f"{st} {rows}")
    st, rows = call("POST", "/time_off", olive, {"space_id": SID["festival"], "user_id": V, "starts_on": d3, "ends_on": d3, "note": "Sick"})
    vict = rows[0]["id"] if st == 201 else None
    check("Time off: Olive (editor) adds time off for Vic in #festival; created_by is Olive, user_id is Vic", vict and rows[0]["user_id"] == V and rows[0]["created_by"] == O, f"{st} {rows}")
    st, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "user_id": V, "starts_on": d3, "ends_on": d3})
    st2, _ = call("POST", "/time_off", vic, {"space_id": SID["festival"], "user_id": P, "starts_on": d3, "ends_on": d3})
    check("Time off: Pat and Vic (viewers in #festival) cannot add time off for someone else there", refused(st) and refused(st2), f"{st} {st2}")
    st, b1 = call("POST", "/time_off", vic, {"space_id": SID["organizers"], "starts_on": d3, "ends_on": d3})
    st2, b2 = call("POST", "/time_off", vic, {"space_id": SID["organizers"], "user_id": O, "starts_on": d3, "ends_on": d3})
    st3, b3 = call("POST", "/time_off", vic, {"space_id": uid("space", "nowhere"), "starts_on": d3, "ends_on": d3})
    st4, b4 = call("POST", "/time_off", vic, {"space_id": SID["organizers"], "starts_on": d5, "ends_on": d3})
    check("Time off: Vic (not in Organizers) gets one refusal there, for himself, for Olive, a bad range, or a channel that does not exist",
          all(refused(x) for x in (st, st2, st3, st4)) and len({json.dumps(b.get("message") if isinstance(b, dict) else b) for b in (b1, b2, b3, b4)}) == 1, f"{st} {st2} {st3} {st4} {b1} {b4}")
    st, body = call("POST", "/time_off", olive, {"space_id": SID["organizers"], "user_id": V, "starts_on": d3, "ends_on": d3})
    check("Time off: Olive cannot add time off in Organizers for Vic, who is not a member (a plain answer)", st == 400 and "not a member" in json.dumps(body), f"{st} {body}")
    for key in ("personal-u-org", "dm-alex-olive"):
        st, body = call("POST", "/time_off", olive, {"space_id": SID[key], "starts_on": d3, "ends_on": d3})
        check(f"Time off: only channels keep time off ({key.split('-')[0]} refused)", st == 400 and "channel" in json.dumps(body), f"{st} {body}")
    # Sensible values.
    st, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d5, "ends_on": d3})
    st2, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d3, "ends_on": day(3 + 366)})
    st3, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d3, "ends_on": d3, "note": "x" * 201})
    check("Time off: ending before it starts, lasting over 366 days, or a note over 200 characters is refused", all(x == 400 for x in (st, st2, st3)), f"{st} {st2} {st3}")
    st, rows = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d3, "ends_on": day(3 + 365)})
    check("Time off: exactly 366 days is fine (positive control)", st == 201, f"{st} {rows}")
    if st == 201:
        call("DELETE", f"/time_off?id=eq.{rows[0]['id']}", pat)
    # Reads: members only, viewers included, with names.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/time_off?space_id=eq.{SID['organizers']}&select=id", tok)
        st2, rows2 = call("GET", f"/time_off?or=(id.eq.{org},note.like.*ORG-AWAY*)&select=id", tok)
        check(f"Time off: {who} gets no Organizers time off, by space, id or note", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/time_off?space_id=eq.{SID['festival']}&select=id,user_id,who:users!time_off_user_id_fkey(display_name)&order=starts_on", pat)
    check("Time off: Pat (viewer) reads #festival's time off with names (positive control)",
          st == 200 and {r["user_id"] for r in rows} == {P, V} and all(r["who"] for r in rows), str(rows))
    # Changing and removing: your own, or anyone's for editors and owners.
    st, rows = call("PATCH", f"/time_off?id=eq.{patt}", pat, {"ends_on": d10, "note": " Longer holiday "})
    check("Time off: Pat changes her own (positive control)", st == 200 and len(rows or []) == 1 and rows[0]["ends_on"] == d10 and rows[0]["note"] == "Longer holiday", f"{st} {rows}")
    st, rows = call("PATCH", f"/time_off?id=eq.{vict}", pat, {"note": "pwned"})
    st2, rows2 = call("DELETE", f"/time_off?id=eq.{vict}", pat)
    st3, rows3 = call("PATCH", f"/time_off?id=eq.{patt}", vic, {"note": "pwned"})
    st4, rows4 = call("DELETE", f"/time_off?id=eq.{patt}", vic)
    check("Time off: Pat cannot change or remove Vic's, nor Vic Pat's (viewers)", rows == [] and rows2 == [] and rows3 == [] and rows4 == []
          and count(f"id = '{vict}' and note = 'Sick'") == "1" and count(f"id = '{patt}' and note = 'Longer holiday'") == "1", f"{st} {st2} {st3} {st4}")
    st, rows = call("PATCH", f"/time_off?id=eq.{vict}", vic, {"note": "Flu"})
    check("Time off: Vic changes his own, though Olive added it (positive control)", st == 200 and len(rows or []) == 1 and rows[0]["note"] == "Flu", f"{st} {rows}")
    st, rows = call("PATCH", f"/time_off?id=eq.{patt}", olive, {"note": "Holiday (confirmed)"})
    check("Time off: Olive (editor) changes Pat's (positive control)", st == 200 and len(rows or []) == 1 and rows[0]["user_id"] == P, f"{st} {rows}")
    st, body = call("PATCH", f"/time_off?id=eq.{patt}", pat, {"ends_on": day(1)})
    check("Time off: a change that makes it end before it starts is refused", st == 400, f"{st} {body}")
    # Authorship, the person and the channel are fixed.
    st, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d3, "ends_on": d3, "created_by": A})
    check("Time off: created_by cannot be forged", refused(st), str(st))
    st, _ = call("PATCH", f"/time_off?id=eq.{patt}", pat, {"user_id": V})
    st2, _ = call("PATCH", f"/time_off?id=eq.{patt}", olive, {"space_id": SID["organizers"]})
    st3, _ = call("PATCH", f"/time_off?id=eq.{patt}", olive, {"created_by": A})
    check("Time off: nor changed afterwards: the person, the channel and who added it never change",
          all(refused(x) for x in (st, st2, st3)) and oq(f"select user_id::text || space_id::text || created_by::text from weft.time_off where id = '{patt}'") == f"{P}{SID['festival']}{P}", f"{st} {st2} {st3}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/time_off?id=in.({org},{patt})&select=space_id", scoped)
    check("Time off: a #festival-scoped token sees only #festival time off", rows and {r["space_id"] for r in rows} == {SID["festival"]}, str(rows))
    st, _ = call("POST", "/time_off", scoped, {"space_id": SID["organizers"], "starts_on": d7, "ends_on": d7})
    st2, rows2 = call("DELETE", f"/time_off?id=eq.{org}", scoped)
    check("Time off: nor adds or removes in Organizers", refused(st) and rows2 == [] and count(f"id = '{org}'") == "1", f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/time_off?id=eq.{org}&select=id", helper)
    check("Time off: the assistant (for Olive) reads Organizers time off (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/time_off?id=eq.{org}", helper)
    st2, _ = call("PATCH", f"/time_off?id=eq.{org}", helper, {"note": "by the assistant"})
    st3, _ = call("POST", "/time_off", helper, {"space_id": SID["organizers"], "starts_on": d7, "ends_on": d7})
    check("Time off: the assistant cannot delete, change or add time off", all(refused(x) for x in (st, st2, st3))
          and count(f"id = '{org}' and note = 'ORG-AWAY-SECRET surgery'") == "1", f"{st} {st2} {st3}")
    st, rows = call("GET", f"/time_off?id=eq.{org}&select=id", mint("u-pub", assistant=True))
    check("Time off: the assistant for Pat reads no Organizers time off", st == 200 and rows == [], str(rows))
    # Audit.
    call("PATCH", f"/time_off?id=eq.{org}", olive, {"note": "ORG-AWAY-SECRET surgery, moved"})
    st, rows = call("GET", f"/audit?row_id=eq.{org}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{org}&select=op", pat)
    check("Time off: an Organizers change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/audit?row_id=eq.{patt}&select=op", vic)
    check("Time off: #festival changes are readable by its members, Vic included (positive control)", len(rows or []) >= 1, str(rows))
    # Removing.
    st, _ = call("DELETE", f"/time_off?id=eq.{vict}", olive)
    check("Time off: Olive (editor) removes Vic's (positive control)", st in (200, 204) and count(f"id = '{vict}'") == "0", str(st))
    st, _ = call("DELETE", f"/time_off?id=eq.{patt}", pat)
    check("Time off: Pat removes her own (positive control)", st in (200, 204) and count(f"id = '{patt}'") == "0", str(st))
    # Membership decides: leaving removes your time off there; deleting the channel removes it all.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "time off test"})
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("POST", "/time_off", pat, {"space_id": ch, "starts_on": d3, "ends_on": d5})
    pt = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/time_off", olive, {"space_id": ch, "starts_on": d3, "ends_on": d5})
    ot = rows[0]["id"] if st == 201 else None
    check("Time off: added as a viewer to a new channel, Pat adds her time off there (positive control)", pt is not None and ot is not None, f"{st} {rows}")
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, rows = call("GET", f"/time_off?space_id=eq.{ch}&select=id", pat)
    check("Time off: removed from the channel, Pat reads nothing there and her time off there is gone", rows == [] and count(f"id = '{pt}'") == "0" and count(f"id = '{ot}'") == "1", f"{rows}")
    st, rows = call("GET", f"/audit?row_id=eq.{pt}&select=op,space_id", olive)
    check("Time off: the removal is in that channel's audit log", rows and rows[0]["space_id"] == ch, str(rows))
    st, _ = call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Time off: deleting the channel deletes its time off", st in (200, 204) and count(f"space_id = '{ch}'") == "0", str(st))
    call("DELETE", f"/time_off?id=eq.{org}", olive)


def retros():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    COLS = "id,retro_id,kind,body,anonymous,author_id,task_id,created_at,updated_at"
    note = lambda tok, retro, kind, body, anon=False: call("POST", f"/retro_notes?select={COLS}", tok, {"retro_id": retro, "kind": kind, "body": body, "anonymous": anon})
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "retro", "title": "Org retro"})
    org = rows[0]["id"] if st == 201 else None
    st2, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "retro", "title": "Festival retro"})
    fest = rows[0]["id"] if st2 == 201 else None
    check("Retros: Olive (editor) makes retros in Organizers and #festival; each gets its row", org and fest
          and oq(f"select count(*) from weft.retros where id in ('{org}', '{fest}')") == "2", f"{st} {st2}")
    st, _ = call("POST", "/items", pat, {"space_id": SID["festival"], "kind": "retro", "title": "x"})
    check("Retros: Pat (viewer) cannot make a retro in #festival", refused(st), str(st))
    st, _ = call("POST", "/retros", olive, {"id": fest})
    check("Retros: nobody inserts a retro row by hand", refused(st), str(st))
    # Notes: every member adds them, viewers included; the database sets the author.
    st, rows = note(olive, org, "to_improve", "  ORG-RETRO-SECRET budget overrun ")
    on = rows[0]["id"] if st == 201 else None
    check("Retros: Olive adds a note in Organizers (positive control); author set by the database, text trimmed",
          on and rows[0]["author_id"] == O and rows[0]["body"] == "ORG-RETRO-SECRET budget overrun" and rows[0]["anonymous"] is False, f"{st} {rows}")
    st, rows = note(pat, fest, "to_improve", "The queue at the gate was too long", True)
    pn = rows[0]["id"] if st == 201 else None
    check("Retros: Pat (viewer in #festival) adds an anonymous note there (positive control); no author shown",
          pn and rows[0]["author_id"] is None and rows[0]["anonymous"] is True and oq(f"select created_by from weft.retro_notes where id = '{pn}'") == P, f"{st} {rows}")
    # Found by the independent review: the retro's text refresh caused an items audit row naming the author.
    check("Retros: an anonymous note leaves no audit row anywhere naming its author (the retro's items row included)",
          oq(f"select count(*) from weft.audit where table_name = 'items' and row_id = '{fest}' and actor_id = '{P}'") == "0",
          oq(f"select coalesce(string_agg(coalesce(actor_id::text, 'nobody'), ', '), 'no rows') from weft.audit where table_name = 'items' and row_id = '{fest}'"))
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", olive)
    check("Retros: the retro's text still picks up the anonymous note (positive control)", rows and "queue at the gate" in (rows[0]["body_text"] or ""), str(rows)[:200])
    st, rows = note(vic, fest, "went_well", "Great volunteers")
    vn = rows[0]["id"] if st == 201 else None
    check("Retros: Vic (viewer in #festival) adds a named note; his name is shown", vn and rows[0]["author_id"] == V, f"{st} {rows}")
    st, rows = note(olive, fest, "action", "Open a second gate next year")
    act = rows[0]["id"] if st == 201 else None
    st2, rows2 = note(olive, fest, "action", "Order more bins")
    act2 = rows2[0]["id"] if st2 == 201 else None
    check("Retros: Olive adds actions in #festival (positive control)", act and act2, f"{st} {st2}")
    st, _ = note(pat, org, "went_well", "x")
    st2, _ = note(vic, org, "went_well", "x")
    check("Retros: Pat and Vic cannot add notes to the Organizers retro", refused(st) and refused(st2), f"{st} {st2}")
    st, _ = note(pat, uid("item", "porches"), "went_well", "on a table")
    check("Retros: a note cannot hang off an item that is not a retro", refused(st), str(st))
    for bad, why in (({"kind": "went_well", "body": "   "}, "an empty note"), ({"kind": "went_well", "body": "x" * 1001}, "a note over 1000 characters"),
                     ({"kind": "gripes", "body": "x"}, "a column that does not exist")):
        st, _ = call("POST", "/retro_notes?select=id", olive, {"retro_id": fest, **bad})
        check(f"Retros: {why} is refused", st == 400, str(st))
    # Outsiders see nothing, not by id and not by filtering.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/retro_notes?retro_id=eq.{org}&select=id", tok)
        st2, rows2 = call("GET", f"/retros?id=eq.{org}", tok)
        st3, rows3 = call("GET", f"/items?id=eq.{org}&select=body_text", tok)
        check(f"Retros: {who} gets no Organizers retro, notes or summary", st == 200 and rows == [] and rows2 == [] and rows3 == [], f"{rows} {rows2} {rows3}")
    st, rows = call("GET", "/retro_notes?select=id&body=like.*ORG-RETRO*", pat)
    check("Retros: nor finds Organizers notes by filtering every note", st == 200 and rows == [], str(rows))
    st, rows = call("GET", f"/retro_notes?retro_id=eq.{fest}&select=id", pat)
    check("Retros: Pat reads the #festival notes (positive control)", st == 200 and len(rows) == 4, str(rows))
    # Anonymous: nobody reads who wrote a note, not the owner, an editor or the assistant, in any way.
    helper = mint("u-alex", assistant=True)
    for who, tok in (("Alex (owner)", alex), ("Olive (editor)", olive), ("the assistant", helper)):
        tries = [call("GET", f"/retro_notes?id=eq.{pn}", tok), call("GET", f"/retro_notes?id=eq.{pn}&select=created_by", tok),
                 call("GET", f"/retro_notes?select=id&created_by=eq.{P}", tok), call("GET", f"/retro_notes?select=id&retro_id=eq.{fest}&order=created_by", tok),
                 call("GET", f"/retro_notes?id=eq.{pn}&select=id,who:users!retro_notes_created_by_fkey(display_name)", tok),
                 call("GET", f"/users?id=eq.{P}&select=id,notes:retro_notes!retro_notes_created_by_fkey(id)", tok)]
        check(f"Retros: {who} cannot read, filter, order or embed by who wrote a note", all(refused(s) for s, _ in tries), str([s for s, _ in tries]))
    st, rows = call("GET", f"/retro_notes?id=eq.{pn}&select=id,author_id,anonymous", alex)
    check("Retros: Alex (owner) sees the anonymous note with no author (positive control: the note is readable)",
          st == 200 and len(rows) == 1 and rows[0]["author_id"] is None, str(rows))
    st, rows = call("POST", "/rpc/my_retro_notes", pat, {"p_retro": fest})
    st2, rows2 = call("POST", "/rpc/my_retro_notes", olive, {"p_retro": fest})
    st3, rows3 = call("POST", "/rpc/my_retro_notes", alex, {"p_retro": fest})
    check("Retros: my_retro_notes tells Pat her note is hers, and tells Olive and Alex only about their own",
          st == 200 and rows == [pn] and st2 == 200 and set(rows2) == {act, act2} and st3 == 200 and rows3 == [], f"{rows} {rows2} {rows3}")
    st, rows = call("POST", "/rpc/my_retro_notes", vic, {"p_retro": org})
    st2, _ = call("POST", "/rpc/my_retro_notes", helper, {"p_retro": fest})
    check("Retros: nor anything about a retro you cannot see; the assistant cannot ask", st == 200 and rows == [] and refused(st2), f"{rows} {st2}")
    # Authorship and the anonymous choice cannot be forged or changed.
    st, _ = call("POST", "/retro_notes?select=id", pat, {"retro_id": fest, "kind": "went_well", "body": "forged", "created_by": V})
    st2, _ = call("POST", "/retro_notes?select=id", pat, {"retro_id": fest, "kind": "went_well", "body": "forged", "author_id": V})
    st3, _ = call("POST", "/retro_notes?select=id", olive, {"retro_id": fest, "kind": "action", "body": "forged", "task_id": uid("item", "x")})
    check("Retros: the author (hidden or shown) cannot be forged, nor a task set on insert", refused(st) and refused(st2) and refused(st3), f"{st} {st2} {st3}")
    st, _ = call("PATCH", f"/retro_notes?id=eq.{pn}", pat, {"anonymous": False}, prefer="return=minimal")
    st2, _ = call("PATCH", f"/retro_notes?id=eq.{vn}", vic, {"author_id": P}, prefer="return=minimal")
    st3, _ = call("PATCH", f"/retro_notes?id=eq.{vn}", vic, {"kind": "to_improve"}, prefer="return=minimal")
    st4, _ = call("PATCH", f"/retro_notes?id=eq.{vn}", vic, {"retro_id": org}, prefer="return=minimal")
    check("Retros: a note's anonymity, author, column and retro cannot be changed", all(refused(s) for s in (st, st2, st3, st4))
          and oq(f"select anonymous::text || author_id::text || kind || retro_id from weft.retro_notes where id = '{vn}'") == f"false{V}went_well{fest}", f"{st} {st2} {st3} {st4}")
    # Your own note only; editors and owners tidy up by deleting.
    st, rows = call("PATCH", f"/retro_notes?id=eq.{pn}", vic, {"body": "pwned"}, prefer="return=minimal")
    st2, _ = call("PATCH", f"/retro_notes?id=eq.{pn}", olive, {"body": "pwned"}, prefer="return=minimal")
    st3, _ = call("DELETE", f"/retro_notes?id=eq.{vn}", pat, prefer="return=minimal")
    check("Retros: Vic and Olive cannot change Pat's note; Pat cannot delete Vic's", refused(st2) and st3 in (200, 204)
          and oq(f"select body from weft.retro_notes where id = '{pn}'") == "The queue at the gate was too long" and oq(f"select count(*) from weft.retro_notes where id = '{vn}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/retro_notes?id=eq.{pn}&select=id,body,updated_at,created_at", pat, {"body": " The queue at the gate was far too long "})
    check("Retros: Pat changes her own anonymous note (positive control)", st == 200 and rows and rows[0]["body"] == "The queue at the gate was far too long", f"{st} {rows}")
    st, rows = call("GET", f"/audit?table_name=eq.retro_notes&row_id=eq.{pn}&select=actor_id,old_row", olive)
    check("Retros: the audit row of an anonymous note names no actor and carries no created_by",
          st == 200 and len(rows) == 1 and rows[0]["actor_id"] is None and "created_by" not in rows[0]["old_row"] and rows[0]["old_row"]["author_id"] is None, str(rows))
    st, rows = call("PATCH", f"/retro_notes?id=eq.{vn}&select=id", vic, {"body": "Great volunteers, again"})
    st2, rows2 = call("GET", f"/audit?table_name=eq.retro_notes&row_id=eq.{vn}&select=actor_id,old_row", pat)
    check("Retros: a named note's audit row names the actor, still without created_by (positive control)",
          st == 200 and len(rows2) == 1 and rows2[0]["actor_id"] == V and "created_by" not in rows2[0]["old_row"], f"{st} {rows2}")
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", pat)
    body = (rows[0]["body_text"] if rows else "") or ""
    check("Retros: the summary carries the notes by column and names no one",
          "To improve:\n- The queue at the gate was far too long" in body and "Went well:\n- Great volunteers, again" in body and "Actions:\n- Open a second gate next year" in body
          and not any(n in body for n in ("Pat", "Vic", "Olive")), body)
    # Period and task list: editors and owners only, the list in the retro's own space.
    st, rows = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "tasklist", "title": "Festival follow-ups"})
    flist = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "tasklist", "title": "Org follow-ups"})
    olist = rows[0]["id"] if st == 201 else None
    st, rows = call("PATCH", f"/retros?id=eq.{fest}", pat, {"period_from": "2026-10-01"})
    check("Retros: Pat (viewer) cannot set the period", st == 200 and rows == [] and oq(f"select coalesce(period_from::text, '') from weft.retros where id = '{fest}'") == "", f"{st} {rows}")
    st, _ = call("PATCH", f"/retros?id=eq.{fest}", olive, {"task_list_id": olist})
    st2, _ = call("PATCH", f"/retros?id=eq.{fest}", olive, {"task_list_id": HOST_CONTACTS})
    check("Retros: the task list must be a task list in the retro's own space", st == 400 and st2 == 400, f"{st} {st2}")
    st, _ = call("PATCH", f"/retros?id=eq.{fest}", olive, {"period_from": "2026-10-10", "period_to": "2026-10-01"})
    check("Retros: a period that ends before it starts is refused", st == 400, str(st))
    st, rows = call("PATCH", f"/retros?id=eq.{fest}", olive, {"period_from": "2026-10-01", "period_to": "2026-10-31", "task_list_id": flist})
    check("Retros: Olive sets the period and the task list (positive control)", st == 200 and rows and rows[0]["task_list_id"] == flist and rows[0]["period_to"] == "2026-10-31", f"{st} {rows}")
    st, rows = call("PATCH", f"/retros?id=eq.{org}", olive, {"task_list_id": olist})
    # Actions become tasks.
    st, _ = call("POST", "/rpc/retro_action_to_task", pat, {"p_note": act})
    st2, _ = call("POST", "/rpc/retro_action_to_task", vic, {"p_note": act})
    check("Retros: Pat and Vic (viewers) cannot turn an action into a task; no task is made", refused(st) and refused(st2)
          and oq(f"select count(*) from weft.tasks where list_id = '{flist}'") == "0" and oq(f"select coalesce(task_id::text, '') from weft.retro_notes where id = '{act}'") == "", f"{st} {st2}")
    st, rows = call("POST", "/rpc/retro_action_to_task", olive, {"p_note": act, "p_assignee": V, "p_due": "2027-03-01"})
    task = rows["id"] if st == 200 and isinstance(rows, dict) else None
    check("Retros: Olive turns an action into a task (positive control): a real task in the list, linked to the note",
          task and rows["list_id"] == flist and rows["title"] == "Open a second gate next year" and rows["assignee_id"] == V
          and oq(f"select task_id from weft.retro_notes where id = '{act}'") == task, f"{st} {rows}")
    st, _ = call("POST", "/rpc/retro_action_to_task", olive, {"p_note": act})
    st2, _ = call("POST", "/rpc/retro_action_to_task", olive, {"p_note": pn})
    st3, _ = call("POST", "/rpc/retro_action_to_task", olive, {"p_note": on, "p_assignee": None})
    check("Retros: an action that is already a task, or a note that is not an action, does not become one",
          st == 400 and st2 == 400 and oq(f"select count(*) from weft.tasks where list_id = '{flist}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("POST", "/tasks", olive, {"list_id": olist, "title": "Org task"})
    otask = rows[0]["id"] if st == 201 else None
    st, _ = call("PATCH", f"/retro_notes?id=eq.{act2}", olive, {"task_id": otask}, prefer="return=minimal")
    st2, _ = call("PATCH", f"/retro_notes?id=eq.{pn}", pat, {"task_id": task}, prefer="return=minimal")
    check("Retros: an action cannot link to a task in another space; a viewer cannot link even her own note",
          st == 400 and refused(st2) and oq(f"select coalesce(task_id::text, '') from weft.retro_notes where id = '{act2}'") == "", f"{st} {st2}")
    st, _ = call("PATCH", f"/tasks?id=eq.{task}", vic, {"done": True}, prefer="return=minimal")
    body = oq(f"select body_text from weft.items where id = '{fest}'") or ""
    check("Retros: the assignee ticks the task off (the Tasks rule) and the retro's summary follows", "Open a second gate next year (task, done)" in body, body)
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/retro_notes?retro_id=in.({org},{fest})&select=retro_id", scoped)
    st2, _ = note(scoped, org, "went_well", "scoped")
    st3, _ = call("POST", "/rpc/retro_action_to_task", scoped, {"p_note": on})
    check("Retros: a #festival-scoped token sees only #festival notes and writes nothing in Organizers",
          st == 200 and rows and {r["retro_id"] for r in rows} == {fest} and refused(st2) and refused(st3), f"{rows} {st2} {st3}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/retro_notes?retro_id=eq.{org}&select=id,body", helper)
    check("Retros: the assistant (for Olive) reads Organizers notes (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/retro_notes?id=eq.{on}", helper, prefer="return=minimal")
    st2, _ = call("PATCH", f"/retro_notes?id=eq.{on}", helper, {"body": "by the assistant"}, prefer="return=minimal")
    st3, _ = note(helper, org, "went_well", "by the assistant")
    st4, _ = call("PATCH", f"/retros?id=eq.{org}", helper, {"period_from": "2026-01-01"}, prefer="return=minimal")
    st5, _ = call("POST", "/rpc/retro_action_to_task", helper, {"p_note": act2})
    check("Retros: the assistant cannot delete, change or add notes, change a retro or make tasks", all(refused(s) for s in (st, st2, st3, st4, st5))
          and oq(f"select body from weft.retro_notes where id = '{on}'") == "ORG-RETRO-SECRET budget overrun", f"{st} {st2} {st3} {st4} {st5}")
    # Audit under the retro's space; search.
    call("PATCH", f"/retro_notes?id=eq.{on}", olive, {"body": "ORG-RETRO-SECRET budget overrun, again"}, prefer="return=minimal")
    st, rows = call("GET", f"/audit?row_id=eq.{on}&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{on}&select=op", pat)
    check("Retros: an Organizers note change is in the audit log for Organizers members only", len(rows or []) >= 1 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "ORG-RETRO-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "ORG-RETRO-SECRET"})
    check("Retros: search finds the retro for Olive, not for Pat", any(r["id"] == org and r["kind"] == "retro" for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    # Deletes: your own; editors and owners any; a deleted task unlinks its action.
    st, _ = call("DELETE", f"/retro_notes?id=eq.{pn}", pat, prefer="return=minimal")
    check("Retros: Pat deletes her own anonymous note (positive control)", st in (200, 204) and oq(f"select count(*) from weft.retro_notes where id = '{pn}'") == "0", str(st))
    st, _ = call("DELETE", f"/retro_notes?id=eq.{vn}", olive, prefer="return=minimal")
    check("Retros: Olive (editor) deletes Vic's note (tidying up)", st in (200, 204) and oq(f"select count(*) from weft.retro_notes where id = '{vn}'") == "0", str(st))
    st, rows = call("POST", "/rpc/retro_action_to_task", olive, {"p_note": act2})
    task2 = rows["id"] if st == 200 and isinstance(rows, dict) else None
    call("DELETE", f"/tasks?id=eq.{task2}", olive)
    check("Retros: deleting a task keeps the action and clears its link", task2 and oq(f"select coalesce(task_id::text, 'none') from weft.retro_notes where id = '{act2}'") == "none", str(st))
    # Moves follow the space. An Organizers retro with an Organizers list and task moves to #festival: Pat
    # sees no trace of them, and Organizers members still see the clean-up in the audit log.
    st, rows = note(olive, org, "action", "Renegotiate the venue")
    oact = rows[0]["id"] if st == 201 else None
    call("POST", "/rpc/retro_action_to_task", olive, {"p_note": oact})
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/retros?id=eq.{org}&select=task_list_id", pat)
    st3, rows3 = call("GET", f"/retro_notes?id=eq.{oact}&select=task_id", pat)
    st4, rows4 = call("GET", f"/audit?or=(row_id.eq.{org},row_id.eq.{oact})&table_name=in.(retros,retro_notes)&select=old_row", pat)
    st5, rows5 = call("GET", f"/audit?or=(row_id.eq.{org},row_id.eq.{oact})&table_name=in.(retros,retro_notes)&select=space_id", olive)
    body = oq(f"select body_text from weft.items where id = '{org}'") or ""
    check("Retros: a retro moved into #festival drops its Organizers list and task links; Pat sees no trace of them",
          st == 200 and rows == [{"task_list_id": None}] and rows3 == [{"task_id": None}] and rows4 == [] and "(task" not in body
          and olist not in json.dumps(rows4), f"{st} {rows} {rows3} {rows4} {body}")
    check("Retros: Organizers members still see the clean-up in the audit log, under Organizers",
          len(rows5 or []) >= 2 and {r["space_id"] for r in rows5} == {SID["organizers"]}, str(rows5))
    st, rows = call("GET", f"/retro_notes?retro_id=eq.{org}&select=id", pat)
    check("Retros: the moved retro's notes are now readable to Pat (positive control)", st == 200 and len(rows) == 2, str(rows))
    st, _ = call("PATCH", f"/items?id=eq.{flist}", olive, {"space_id": SID["volunteers"]})
    check("Retros: a task list moved to Volunteers stops being the #festival retro's list, and its tasks unlink",
          oq(f"select coalesce(task_list_id::text, 'none') from weft.retros where id = '{fest}'") == "none"
          and oq(f"select coalesce(task_id::text, 'none') from weft.retro_notes where id = '{act}'") == "none"
          and oq(f"select count(*) from weft.tasks where id = '{task}'") == "1", str(st))
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/retro_notes?retro_id=eq.{fest}&select=id", pat)
    check("Retros: a retro moved to Volunteers takes its notes out of Pat's sight", st == 200 and rows == [], f"{st} {rows}")
    st, _ = call("DELETE", f"/items?id=eq.{org}", pat)
    check("Retros: Pat cannot delete a retro", oq(f"select count(*) from weft.items where id = '{org}'") == "1", str(st))
    st, _ = call("DELETE", f"/items?id=eq.{org}", olive)
    check("Retros: deleting a retro deletes its notes and row; tasks made from it stay", st in (200, 204)
          and oq(f"select count(*) from weft.retro_notes where retro_id = '{org}'") == "0" and oq(f"select count(*) from weft.retros where id = '{org}'") == "0"
          and oq(f"select count(*) from weft.tasks where list_id = '{olist}' and title = 'Renegotiate the venue'") == "1", str(st))
    for i in (fest, flist, olist):
        call("DELETE", f"/items?id=eq.{i}", olive)



# ---------------------------------------------------------------- repeating events (049)
def repeating_events():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, O, A = uid("user", "u-pub"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    rpc = lambda name, tok, body: call("POST", f"/rpc/{name}", tok, body)
    def event(tok, space, title, start, end, **extra):
        st, rows = call("POST", "/events", tok, {"space_id": SID[space], "title": title, "starts_at": start, "ends_at": end, **extra})
        return rows[0]["id"] if st == 201 else None
    # Olive makes a weekly Organizers meeting repeat, in Berlin time, across the clock change of 28 March 2027.
    org = event(olive, "organizers", "REPEAT-ORG-SECRET budget call", "2027-03-10T17:00:00Z", "2027-03-10T18:00:00Z", location="Back room")
    st, sid = rpc("repeat_event", olive, {"p_event": org, "p_repeats": "weekly", "p_until": "2027-04-07", "p_tz": "Europe/Berlin"})
    times = oq(f"select string_agg(to_char(starts_at at time zone 'UTC', 'MM-DD HH24:MI'), ',' order by starts_at) from weft.events where series_id = '{sid}'") if st == 200 else ""
    check("Repeating: Olive (editor) makes an Organizers event repeat weekly until a date, 5 occurrences (positive control)",
          st == 200 and times.count(",") == 4, f"{st} {sid} {times}")
    check("Repeating: occurrences keep the local time across a clock change (18:00 Berlin is 17:00 UTC, then 16:00 UTC)",
          times == "03-10 17:00,03-17 17:00,03-24 17:00,03-31 16:00,04-07 16:00", times)
    check("Repeating: the series is in the event's space, made by Olive (set by the database), and copies keep title, place and length",
          oq(f"select space_id::text || created_by::text || repeats || until_on::text from weft.event_series where id = '{sid}'") == f"{SID['organizers']}{O}weekly2027-04-07"
          and oq(f"select count(*) from weft.events where series_id = '{sid}' and title = 'REPEAT-ORG-SECRET budget call' and location = 'Back room' and ends_at - starts_at = interval '1 hour' and created_by = '{O}'") == "5", sid)
    # Reading follows membership.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/event_series?id=eq.{sid}", tok)
        st2, rows2 = call("GET", f"/events?series_id=eq.{sid}&select=id", tok)
        check(f"Repeating: {who} sees no Organizers series nor its occurrences", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/events?id=eq.{org}&select=id,series:event_series(repeats,until_on)", olive)
    check("Repeating: Olive reads the event with how it repeats (positive control)", st == 200 and rows and rows[0]["series"] == {"repeats": "weekly", "until_on": "2027-04-07"}, str(rows))
    # Outsiders cannot make, change or delete Organizers series.
    st, _ = rpc("repeat_event", vic, {"p_event": org, "p_repeats": "daily", "p_until": "2027-03-20", "p_tz": "UTC"})
    st2, _ = rpc("change_series", vic, {"p_event": org, "p_title": "pwned", "p_location": "", "p_starts": "2027-03-10T17:00:00Z", "p_ends": "2027-03-10T18:00:00Z"})
    st3, _ = rpc("delete_series", pat, {"p_event": org})
    st4, rows4 = call("DELETE", f"/event_series?id=eq.{sid}", vic)
    check("Repeating: Vic and Pat cannot repeat, change or delete an Organizers series", refused(st) and refused(st2) and refused(st3) and rows4 == []
          and oq(f"select count(*) from weft.events where series_id = '{sid}' and title like 'REPEAT-ORG%'") == "5", f"{st} {st2} {st3} {st4}")
    # #festival: viewers read, but only editors write.
    fest = event(olive, "festival", "Rehearsal", "2027-05-03T18:00:00Z", "2027-05-03T20:00:00Z")
    st, fsid = rpc("repeat_event", olive, {"p_event": fest, "p_repeats": "daily", "p_until": "2027-05-07", "p_tz": "UTC"})
    check("Repeating: Olive makes a #festival rehearsal repeat daily (positive control)", st == 200
          and oq(f"select count(*) from weft.events where series_id = '{fsid}'") == "5", f"{st} {fsid}")
    st, rows = call("GET", f"/events?series_id=eq.{fsid}&select=id,series:event_series(repeats)", pat)
    check("Repeating: Pat (viewer) reads the #festival series and its 5 occurrences (positive control)", st == 200 and len(rows) == 5 and rows[0]["series"]["repeats"] == "daily", str(rows))
    single = event(olive, "festival", "One-off", "2027-05-10T18:00:00Z", "2027-05-10T19:00:00Z")
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, _ = rpc("repeat_event", tok, {"p_event": single, "p_repeats": "weekly", "p_until": "2027-06-10", "p_tz": "UTC"})
        st2, _ = rpc("change_series", tok, {"p_event": fest, "p_title": "pwned", "p_location": "", "p_starts": "2027-05-03T18:00:00Z", "p_ends": "2027-05-03T20:00:00Z"})
        st3, _ = rpc("delete_series", tok, {"p_event": fest})
        st4, _ = call("POST", "/event_series", tok, {"space_id": SID["festival"], "repeats": "weekly", "until_on": "2027-06-01"})
        st5, rows5 = call("DELETE", f"/event_series?id=eq.{fsid}", tok)
        st6, rows6 = call("PATCH", f"/events?id=eq.{single}", tok, {"series_id": fsid})
        check(f"Repeating: {who} (viewer in #festival) cannot repeat, change or delete there, add or delete a series, or attach an event",
              refused(st) and refused(st2) and refused(st3) and refused(st4) and rows5 == [] and rows6 == []
              and oq(f"select count(*) from weft.events where series_id = '{fsid}' and title = 'Rehearsal'") == "5"
              and oq(f"select count(*) from weft.events where id = '{single}' and series_id is null") == "1", f"{st} {st2} {st3} {st4} {st5} {st6}")
    # Authorship cannot be forged.
    st, _ = call("POST", "/event_series", olive, {"space_id": SID["festival"], "repeats": "weekly", "until_on": "2027-06-01", "created_by": A})
    st2, _ = call("PATCH", f"/event_series?id=eq.{fsid}", olive, {"until_on": "2027-12-01"})
    check("Repeating: a series' author cannot be forged, and a series is not changed directly", refused(st) and refused(st2)
          and oq(f"select created_by::text || until_on::text from weft.event_series where id = '{fsid}'") == f"{O}2027-05-07", f"{st} {st2}")
    # A series never spans two spaces.
    st, body = call("POST", "/events", olive, {"space_id": SID["festival"], "title": "sneak", "starts_at": "2027-05-20T10:00:00Z", "ends_at": "2027-05-20T11:00:00Z", "series_id": sid})
    st2, body2 = call("PATCH", f"/events?id=eq.{single}", olive, {"series_id": sid})
    pev = event(pat, "personal-u-pub", "Pat's own", "2027-05-04T08:00:00Z", "2027-05-04T09:00:00Z")
    st3, _ = call("PATCH", f"/events?id=eq.{pev}", pat, {"series_id": fsid})
    check("Repeating: an event cannot join a series in another space (Organizers series in #festival, #festival series in Pat's personal space)",
          st == 400 and st2 == 400 and st3 == 400 and oq(f"select count(*) from weft.events where series_id = '{sid}'") == "5"
          and oq(f"select count(*) from weft.events where title = 'sneak'") == "0", f"{st} {st2} {st3} {body}")
    st, rows = call("POST", "/events", olive, {"space_id": SID["festival"], "title": "Rehearsal extra", "starts_at": "2027-05-08T18:00:00Z", "ends_at": "2027-05-08T20:00:00Z", "series_id": fsid})
    check("Repeating: an editor may add an event to a series in the same space (positive control)", st == 201 and rows[0]["series_id"] == fsid, f"{st} {rows}")
    # Moving one occurrence to another space takes it out of the series; the rest stay.
    moved = oq(f"select id from weft.events where series_id = '{sid}' order by starts_at limit 1 offset 1")
    st, rows = call("PATCH", f"/events?id=eq.{moved}", olive, {"space_id": SID["festival"], "title": "Moved to festival"})
    check("Repeating: an occurrence moved to #festival leaves the series; the other 4 stay in Organizers", st == 200 and rows and rows[0]["series_id"] is None
          and oq(f"select count(*) from weft.events where series_id = '{sid}' and space_id = '{SID['organizers']}'") == "4", f"{st} {rows}")
    st, rows = call("GET", f"/events?id=eq.{moved}&select=series_id,series:event_series(id)", pat)
    check("Repeating: Pat sees the moved event but no link to the Organizers series", st == 200 and len(rows) == 1 and rows[0]["series_id"] is None and rows[0]["series"] is None, str(rows))
    # What a repeat may be.
    bad = [({"p_repeats": "hourly", "p_until": "2027-06-01", "p_tz": "UTC"}, "hourly"),
           ({"p_repeats": "weekly", "p_until": "2028-06-01", "p_tz": "UTC"}, "more than a year"),
           ({"p_repeats": "weekly", "p_until": "2027-05-10", "p_tz": "UTC"}, "until the first day"),
           ({"p_repeats": "weekly", "p_until": "2027-06-01", "p_tz": "Mars/Olympus"}, "unknown time zone")]
    for body, what in bad:
        st, _ = rpc("repeat_event", olive, {"p_event": single, **body})
        check(f"Repeating: refused, {what}", st == 400, str(st))
    st, _ = rpc("repeat_event", olive, {"p_event": fest, "p_repeats": "weekly", "p_until": "2027-06-01", "p_tz": "UTC"})
    check("Repeating: an event that already repeats cannot be repeated again", st == 400
          and oq(f"select count(*) from weft.event_series where space_id = '{SID['festival']}'") == "1", str(st))
    # Monthly on the 31st lands on the last day of shorter months, and returns to the 31st.
    m31 = event(olive, "festival", "Month end", "2027-01-31T12:00:00Z", "2027-01-31T13:00:00Z")
    st, msid = rpc("repeat_event", olive, {"p_event": m31, "p_repeats": "monthly", "p_until": "2027-05-31", "p_tz": "UTC"})
    days = oq(f"select string_agg(to_char(starts_at at time zone 'UTC', 'MM-DD'), ',' order by starts_at) from weft.events where series_id = '{msid}'")
    check("Repeating: monthly on the 31st (Jan 31, Feb 28, Mar 31, Apr 30, May 31)", st == 200 and days == "01-31,02-28,03-31,04-30,05-31", days)
    st, rows = rpc("repeat_event", olive, {"p_event": single, "p_repeats": "daily", "p_until": "2028-05-10", "p_tz": "UTC"})
    check("Repeating: daily for exactly a year is allowed (367 days, first and last included)", st == 200
          and oq(f"select count(*) from weft.events where series_id = '{rows}'") == "367", f"{st} {rows}")
    rpc("delete_series", olive, {"p_event": single})
    # Change all of them: rename and shift by an hour, from any occurrence.
    third = oq(f"select id from weft.events where series_id = '{sid}' order by starts_at limit 1 offset 2")
    st, n = rpc("change_series", olive, {"p_event": third, "p_title": "  Budget call (new time) ", "p_location": " ", "p_starts": "2027-03-31T17:00:00Z", "p_ends": "2027-03-31T18:30:00Z"})
    times = oq(f"select string_agg(to_char(starts_at at time zone 'UTC', 'MM-DD HH24:MI') || '+' || (ends_at - starts_at), ',' order by starts_at) from weft.events where series_id = '{sid}'")
    check("Repeating: Olive changes all of them: title, no place, an hour later in local time and 90 minutes long (positive control)",
          st == 200 and n == 4 and times == "03-10 18:00+01:30:00,03-24 18:00+01:30:00,03-31 17:00+01:30:00,04-07 17:00+01:30:00"
          and oq(f"select count(*) from weft.events where series_id = '{sid}' and title = 'Budget call (new time)' and location is null") == "4", f"{st} {n} {times}")
    st, _ = rpc("change_series", olive, {"p_event": third, "p_title": " ", "p_location": "", "p_starts": "2027-03-31T17:00:00Z", "p_ends": "2027-03-31T18:30:00Z"})
    st2, _ = rpc("change_series", olive, {"p_event": third, "p_title": "x", "p_location": "", "p_starts": "2027-03-31T17:00:00Z", "p_ends": "2027-03-31T16:00:00Z"})
    st3, _ = rpc("change_series", olive, {"p_event": moved, "p_title": "x", "p_location": "", "p_starts": "2027-03-17T17:00:00Z", "p_ends": "2027-03-17T18:00:00Z"})
    check("Repeating: changing all is refused with no title, an end before the start, or an event that does not repeat", st == 400 and st2 == 400 and st3 == 400, f"{st} {st2} {st3}")
    # Just this one: an ordinary change or delete leaves the others alone.
    st, rows = call("PATCH", f"/events?id=eq.{third}", olive, {"title": "Budget call (moved room)", "location": "Hall"})
    st2, rows2 = call("DELETE", f"/events?id=eq.{oq(f'''select id from weft.events where series_id = '{sid}' order by starts_at desc limit 1''')}", olive)
    check("Repeating: changing or deleting just one occurrence leaves the others as they were (positive control)",
          st == 200 and len(rows2 or []) == 1 and oq(f"select string_agg(title, '|' order by starts_at) from weft.events where series_id = '{sid}'") == "Budget call (new time)|Budget call (new time)|Budget call (moved room)", f"{st} {st2}")
    st, n = rpc("change_series", olive, {"p_event": third, "p_title": None, "p_location": None, "p_starts": "2027-03-31T17:30:00Z", "p_ends": "2027-03-31T19:00:00Z"})
    check("Repeating: moving all of them with no title or place given keeps each one's own (positive control)",
          st == 200 and n == 3 and oq(f"select string_agg(title || '@' || coalesce(location, '-') || '@' || to_char(starts_at at time zone 'UTC', 'MM-DD HH24:MI'), '|' order by starts_at) from weft.events where series_id = '{sid}'")
          == "Budget call (new time)@-@03-10 18:30|Budget call (new time)@-@03-24 18:30|Budget call (moved room)@Hall@03-31 17:30", f"{st} {n}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", "/event_series?select=space_id", scoped)
    check("Repeating: a #festival-scoped token sees only #festival series", st == 200 and rows and {r["space_id"] for r in rows} == {SID["festival"]}, str(rows))
    st, _ = rpc("change_series", scoped, {"p_event": third, "p_title": "scoped", "p_location": "", "p_starts": "2027-03-31T17:00:00Z", "p_ends": "2027-03-31T18:00:00Z"})
    st2, _ = rpc("delete_series", scoped, {"p_event": third})
    st3, rows3 = call("DELETE", f"/event_series?id=eq.{sid}", scoped)
    check("Repeating: nor changes or deletes the Organizers series", refused(st) and refused(st2) and rows3 == []
          and oq(f"select count(*) from weft.events where series_id = '{sid}'") == "3", f"{st} {st2} {st3}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/event_series?id=eq.{sid}&select=id", helper)
    check("Repeating: the assistant (for Olive) reads the Organizers series (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/event_series?id=eq.{sid}", helper)
    st2, _ = rpc("delete_series", helper, {"p_event": third})
    st3, _ = rpc("repeat_event", helper, {"p_event": moved, "p_repeats": "weekly", "p_until": "2027-06-01", "p_tz": "UTC"})
    st4, _ = rpc("change_series", helper, {"p_event": third, "p_title": "by the assistant", "p_location": "", "p_starts": "2027-03-31T17:00:00Z", "p_ends": "2027-03-31T18:00:00Z"})
    st5, _ = call("PATCH", f"/events?id=eq.{moved}", helper, {"series_id": fsid})
    st6, _ = call("POST", "/event_series", helper, {"space_id": SID["organizers"], "repeats": "weekly", "until_on": "2027-06-01"})
    check("Repeating: the assistant cannot delete, make or change series, or set an event's series", all(refused(x) for x in (st, st2, st3, st4, st5, st6))
          and oq(f"select count(*) from weft.events where series_id = '{sid}'") == "3", f"{st} {st2} {st3} {st4} {st5} {st6}")
    st, rows = call("GET", f"/event_series?id=eq.{sid}&select=id", mint("u-pub", assistant=True))
    check("Repeating: the assistant for Pat sees no Organizers series", st == 200 and rows == [], str(rows))
    # Delete all of them: every occurrence goes, kept in the audit log under Organizers, which Pat cannot read.
    st, n = rpc("delete_series", olive, {"p_event": third})
    check("Repeating: Olive deletes all of them (positive control); the series goes too", st == 200 and n == 3
          and oq(f"select count(*) from weft.events where series_id = '{sid}'") == "0" and oq(f"select count(*) from weft.event_series where id = '{sid}'") == "0", f"{st} {n}")
    check("Repeating: the deleted occurrences (3 together, 1 on its own) are in the audit log, under Organizers, by Olive",
          oq(f"select count(*) from weft.audit where table_name = 'events' and op = 'DELETE' and old_row->>'series_id' = '{sid}' and space_id = '{SID['organizers']}' and actor_id = '{O}'") == "4")
    st, rows = call("GET", "/audit?old_row->>title=like.*Budget%20call*&select=id", pat)
    st2, rows2 = call("GET", "/audit?select=id&old_row->>title=like.*Budget%20call*", olive)
    check("Repeating: Pat reads none of those audit rows; Olive (an organizer) does (positive control)", st == 200 and rows == [] and st2 == 200 and len(rows2) >= 3, f"{rows} {len(rows2 or [])}")
    # Bulk writes send one live notice, not one per occurrence: weft.quiet is set only for the function's own transaction.
    check("Repeating: the quiet setting does not outlive the function", oq("select coalesce(current_setting('weft.quiet', true), '')") == "")
    # Tidy up, so later suites see the seeded calendar.
    for e in (fest, m31):
        rpc("delete_series", olive, {"p_event": e})
    for e in (moved, pev):
        oq(f"delete from weft.events where id = '{e}'")
    check("Repeating: tidied up", oq("select count(*) from weft.event_series") == "0" and oq("select count(*) from weft.events where title in ('One-off', 'Moved to festival', 'Rehearsal extra')") == "0")


# ---------------------------------------------------------------- repeating tasks (050)
def repeating_tasks():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    today = oq("select current_date::text")
    nd = lambda due, rep: oq(f"select weft_private.next_due({'null' if due is None else repr(due)}::date, '{rep}', current_date)::text")
    def task(tok, lst, title, **extra):
        st, rows = call("POST", "/tasks", tok, {"list_id": lst, "title": title, **extra})
        return rows[0]["id"] if st == 201 else None
    def newest(lst, title):
        return oq(f"select id::text || '|' || coalesce(assignee_id::text, '-') || '|' || coalesce(due_on::text, '-') || '|' || coalesce(repeats, '-') || '|' || done || '|' || created_by"
                  f" from weft.tasks where list_id = '{lst}' and title = '{title}' and not done order by created_at desc limit 1")
    def count(lst, title): return oq(f"select count(*) from weft.tasks where list_id = '{lst}' and title = '{title}'")
    org = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "tasklist", "title": "Org repeating"})[1][0]["id"]
    fest = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "tasklist", "title": "Festival repeating"})[1][0]["id"]

    # The schedule itself: strictly after today, stepping from the due date.
    check("Repeating tasks: next dates (weekly due today -> +7, weekly ticked late stays on its weekday, daily from the future, no due date -> from today)",
          oq("select weft_private.next_due('2026-11-16', 'weekly', '2026-11-16')::text") == "2026-11-23"
          and oq("select weft_private.next_due('2026-11-02', 'weekly', '2026-11-11')::text") == "2026-11-16"
          and oq("select weft_private.next_due('2026-11-20', 'daily', '2026-11-11')::text") == "2026-11-21"
          and oq("select weft_private.next_due(null, 'daily', '2026-11-11')::text") == "2026-11-12"
          and oq("select weft_private.next_due('2026-11-09', 'daily', '2026-11-11')::text") == "2026-11-12")
    check("Repeating tasks: monthly (31 Jan -> 28 Feb; due 15 Aug ticked 20 Nov -> 15 Dec; due in a later month -> a month after it)",
          oq("select weft_private.next_due('2027-01-31', 'monthly', '2027-01-31')::text") == "2027-02-28"
          and oq("select weft_private.next_due('2026-08-15', 'monthly', '2026-11-20')::text") == "2026-12-15"
          and oq("select weft_private.next_due('2027-03-10', 'monthly', '2026-11-20')::text") == "2027-04-10"
          and oq("select weft_private.next_due('2026-11-10', 'monthly', '2026-11-10')::text") == "2026-12-10")

    # Olive (editor) makes a weekly Organizers task assigned to Alex and ticks it off.
    ot = task(olive, org, "REPTASK-ORG-SECRET payroll", assignee_id=A, due_on="2026-11-16", repeats="weekly")
    check("Repeating tasks: Olive (editor) adds a weekly task in Organizers (positive control)", ot is not None
          and oq(f"select repeats from weft.tasks where id = '{ot}'") == "weekly")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    check("Repeating tasks: the list summary says it repeats (search and the assistant see it)",
          st == 200 and ", due 2026-11-16, every week)" in (rows[0]["body_text"] or ""), str(rows))
    st, rows = call("PATCH", f"/tasks?id=eq.{ot}", olive, {"done": True})
    nxt = newest(org, "REPTASK-ORG-SECRET payroll").split("|")
    check("Repeating tasks: ticking it off makes the next one: same list, title, assignee and repeat, not done, due on the next date, made by Olive",
          st == 200 and len(nxt) == 6 and nxt[0] != ot and nxt[1] == A and nxt[2] == nd("2026-11-16", "weekly") and nxt[3] == "weekly" and nxt[4] == "false" and nxt[5] == O,
          f"{st} {nxt} today={today}")
    check("Repeating tasks: the ticked one stays done and stops repeating",
          oq(f"select done::text || coalesce(repeats, '-') from weft.tasks where id = '{ot}'") == "true-")
    call("PATCH", f"/tasks?id=eq.{ot}", olive, {"done": False})
    call("PATCH", f"/tasks?id=eq.{ot}", olive, {"done": True})
    check("Repeating tasks: unticking and ticking it again makes no second copy", count(org, "REPTASK-ORG-SECRET payroll") == "2")

    # Outsiders: nothing to read, nothing to change, no copies to cause.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/tasks?list_id=eq.{org}&select=id,repeats", tok)
        st2, rows2 = call("PATCH", f"/tasks?id=eq.{nxt[0]}", tok, {"done": True})
        st3, rows3 = call("PATCH", f"/tasks?id=eq.{nxt[0]}", tok, {"repeats": "daily"})
        check(f"Repeating tasks: {who} reads no Organizers tasks and cannot tick off or change one there",
              st == 200 and rows == [] and rows2 == [] and rows3 == []
              and oq(f"select done::text || repeats from weft.tasks where id = '{nxt[0]}'") == "falseweekly"
              and count(org, "REPTASK-ORG-SECRET payroll") == "2", f"{rows} {st2} {st3}")
    st, _ = call("POST", "/tasks", pat, {"list_id": org, "title": "pwned", "repeats": "daily"})
    check("Repeating tasks: Pat cannot add a repeating task in Organizers", refused(st), str(st))

    # #festival: Pat is a viewer. She may tick off her own repeating task (and so cause the next one), nothing else.
    ft = task(olive, fest, "Water the porch plants", assignee_id=P, due_on="2026-11-10", repeats="daily")
    st, rows = call("GET", f"/tasks?id=eq.{ft}&select=repeats", pat)
    check("Repeating tasks: Pat (viewer) reads how a #festival task repeats (positive control)", st == 200 and rows == [{"repeats": "daily"}], str(rows))
    st, _ = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"repeats": "monthly"})
    st2, _ = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"repeats": None})
    st3, _ = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True, "repeats": "monthly"})
    st4, _ = call("POST", "/tasks", pat, {"list_id": fest, "title": "pwned", "repeats": "daily"})
    check("Repeating tasks: Pat cannot change or clear the repeat, not even alongside done, nor add a repeating task",
          all(refused(x) for x in (st, st2, st3, st4)) and oq(f"select done::text || repeats from weft.tasks where id = '{ft}'") == "falsedaily"
          and count(fest, "Water the porch plants") == "1", f"{st} {st2} {st3} {st4}")
    st, rows = call("PATCH", f"/tasks?id=eq.{ft}", pat, {"done": True})
    nxt2 = newest(fest, "Water the porch plants").split("|")
    check("Repeating tasks: Pat ticks off her own daily task (positive control); the next one is hers, due tomorrow, made by Pat",
          st == 200 and len(rows or []) == 1 and len(nxt2) == 6 and nxt2[1] == P and nxt2[2] == nd("2026-11-10", "daily")
          and nxt2[2] == oq("select (current_date + 1)::text") and nxt2[3] == "daily" and nxt2[5] == P, f"{st} {rows} {nxt2}")
    other = task(olive, fest, "Sweep the stage", assignee_id=O, repeats="weekly")
    st, rows = call("PATCH", f"/tasks?id=eq.{other}", pat, {"done": True})
    check("Repeating tasks: Pat cannot tick off someone else's repeating task, so no copy appears", rows == []
          and count(fest, "Sweep the stage") == "1", f"{st} {rows}")
    st, rows = call("PATCH", f"/tasks?id=eq.{nxt2[0]}", mint("u-pub", scope="volunteers"), {"done": True})
    check("Repeating tasks: nor tick off her own through a token scoped to another channel", rows == []
          and count(fest, "Water the porch plants") == "2", f"{st} {rows}")

    # Editors set and clear the repeat; only the three values; no due date steps from today.
    st, rows = call("PATCH", f"/tasks?id=eq.{other}", olive, {"repeats": "monthly"})
    st2, _ = call("PATCH", f"/tasks?id=eq.{other}", olive, {"repeats": "hourly"})
    check("Repeating tasks: Olive changes the repeat (positive control); 'hourly' is refused", st == 200 and rows[0]["repeats"] == "monthly" and st2 == 400, f"{st} {st2}")
    st, rows = call("PATCH", f"/tasks?id=eq.{other}", olive, {"done": True})
    nxt3 = newest(fest, "Sweep the stage").split("|")
    check("Repeating tasks: a monthly task with no due date comes back due a month from today",
          st == 200 and len(nxt3) == 6 and nxt3[2] == oq("select (current_date + interval '1 month')::date::text") and nxt3[3] == "monthly", str(nxt3))
    call("PATCH", f"/tasks?id=eq.{nxt3[0]}", olive, {"repeats": None})
    call("PATCH", f"/tasks?id=eq.{nxt3[0]}", olive, {"done": True})
    check("Repeating tasks: once the repeat is cleared, ticking off makes nothing new", count(fest, "Sweep the stage") == "2")
    done_rep = task(olive, fest, "Born done", done=True, repeats="weekly")
    check("Repeating tasks: a task added already done does not repeat",
          oq(f"select coalesce(repeats, '-') from weft.tasks where id = '{done_rep}'") == "-" and count(fest, "Born done") == "1")

    # Authorship cannot be forged on the copy: created_by is whoever ticked, never set by the client.
    st, _ = call("POST", "/tasks", olive, {"list_id": fest, "title": "forged", "repeats": "daily", "created_by": A})
    check("Repeating tasks: authorship of a repeating task cannot be forged", refused(st), str(st))

    # The assignee has left the space since: the next one is unassigned instead of the tick failing.
    vt = task(olive, fest, "Count the chairs", assignee_id=V, due_on="2026-11-12", repeats="weekly")
    oq(f"delete from weft.members where space_id = '{SID['festival']}' and user_id = '{V}'")
    st, rows = call("PATCH", f"/tasks?id=eq.{vt}", olive, {"done": True})
    nxt4 = newest(fest, "Count the chairs").split("|")
    oq(f"insert into weft.members (space_id, user_id, role) values ('{SID['festival']}', '{V}', 'viewer')")
    check("Repeating tasks: if the assignee has left the space, the next task is unassigned (the tick still works)",
          st == 200 and len(nxt4) == 6 and nxt4[1] == "-" and nxt4[3] == "weekly", f"{st} {rows} {nxt4}")
    check("Repeating tasks: Vic is back in #festival as a viewer (tidy)",
          oq(f"select role from weft.members where space_id = '{SID['festival']}' and user_id = '{V}'") == "viewer")

    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("PATCH", f"/tasks?id=eq.{nxt[0]}", scoped, {"done": True})
    st2, rows2 = call("GET", "/tasks?repeats=not.is.null&select=list_id", scoped)
    check("Repeating tasks: a #festival-scoped token sees only #festival repeating tasks and cannot tick off an Organizers one",
          rows == [] and st2 == 200 and rows2 and {r["list_id"] for r in rows2} == {fest} and count(org, "REPTASK-ORG-SECRET payroll") == "2", f"{st} {rows2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/tasks?id=eq.{nxt[0]}&select=repeats", helper)
    check("Repeating tasks: the assistant (for Olive) reads the repeat (positive control)", st == 200 and rows == [{"repeats": "weekly"}], str(rows))
    st, _ = call("PATCH", f"/tasks?id=eq.{nxt[0]}", helper, {"done": True})
    st2, _ = call("PATCH", f"/tasks?id=eq.{nxt[0]}", helper, {"repeats": "daily"})
    st3, _ = call("DELETE", f"/tasks?id=eq.{nxt[0]}", helper)
    st4, _ = call("POST", "/tasks", helper, {"list_id": org, "title": "by the assistant", "repeats": "daily"})
    check("Repeating tasks: the assistant cannot tick off, change, delete or add a repeating task", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select done::text || repeats from weft.tasks where id = '{nxt[0]}'") == "falseweekly", f"{st} {st2} {st3} {st4}")
    st, rows = call("GET", f"/tasks?id=eq.{nxt[0]}&select=id", mint("u-pub", assistant=True))
    check("Repeating tasks: the assistant for Pat sees no Organizers repeating task", st == 200 and rows == [], str(rows))

    # Live notices and audit: the copy is announced under its own space only; the tick is audited there.
    check("Repeating tasks: the tick is in the audit log under Organizers, by Olive, with the repeat it had",
          oq(f"select count(*) from weft.audit where table_name = 'tasks' and row_id = '{ot}' and space_id = '{SID['organizers']}' and actor_id = '{O}' and old_row->>'repeats' = 'weekly'") == "1")
    st, rows = call("GET", f"/audit?row_id=eq.{ot}&select=id", pat)
    check("Repeating tasks: Pat reads none of it", st == 200 and rows == [], str(rows))

    # Moves follow the space: a list moved to #festival keeps its repeating tasks; deleting the list deletes them.
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows2 = call("GET", f"/tasks?list_id=eq.{org}&done=is.false&select=assignee_id,repeats", pat)
    check("Repeating tasks: an Organizers list moved to #festival: Pat now sees its repeating task, still assigned to Alex (a #festival member)",
          st == 200 and st2 == 200 and rows2 == [{"assignee_id": A, "repeats": "weekly"}], f"{st} {rows2}")
    for lst in (org, fest):
        call("DELETE", f"/items?id=eq.{lst}", olive)
    check("Repeating tasks: deleting the lists deletes their tasks (tidy)",
          oq(f"select count(*) from weft.tasks where list_id in ('{org}', '{fest}')") == "0")


# ---------------------------------------------------------------- comments on tasks
def task_comments():
    """Comments on tasks (053): who reads, posts and deletes; authorship; scope; the assistant; search; moves."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    def task(lst, title, **extra):
        st, rows = call("POST", "/tasks", olive, {"list_id": lst, "title": title, **extra})
        return rows[0]["id"] if st == 201 else None
    def comment(tok, task_id, body, **extra):
        st, rows = call("POST", "/task_comments", tok, {"task_id": task_id, "body": body, **extra})
        return st, (rows[0] if st == 201 and rows else rows)
    def count(task_id): return oq(f"select count(*) from weft.task_comments where task_id = '{task_id}'")
    org = call("POST", "/items", olive, {"space_id": SID["organizers"], "kind": "tasklist", "title": "Org commented"})[1][0]["id"]
    fest = call("POST", "/items", olive, {"space_id": SID["festival"], "kind": "tasklist", "title": "Festival commented"})[1][0]["id"]
    ot = task(org, "Book the caterer", assignee_id=A)
    pt = task(fest, "Hang the banners", assignee_id=P)
    xt = task(fest, "Order the stage", assignee_id=O)

    # Olive (editor) comments in Organizers; the database sets the author and trims the text.
    st, c = comment(olive, ot, "  TCOMMENT-ORG-SECRET quote is 4200, too high?  \n")
    oc = c.get("id") if st == 201 else None
    check("Comments on tasks: Olive (editor) comments on an Organizers task; she is the author, the text is trimmed (positive control)",
          st == 201 and c["author_id"] == O and c["body"] == "TCOMMENT-ORG-SECRET quote is 4200, too high?", f"{st} {c}")
    st, rows = call("GET", f"/task_comments?task_id=eq.{ot}&select=body,author_id", alex)
    check("Comments on tasks: Alex (owner) reads it (positive control)", st == 200 and len(rows) == 1, str(rows))

    # Outsiders read nothing and post nothing in Organizers.
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/task_comments?task_id=eq.{ot}", tok)
        st2, rows2 = call("GET", "/task_comments?select=task_id,body", tok)
        st3, rows3 = call("GET", f"/tasks?id=eq.{ot}&select=id,task_comments(body)", tok)
        check(f"Comments on tasks: {who} reads no Organizers comment, by task, by listing all, or through the task",
              st == 200 and rows == [] and st2 == 200 and not any("TCOMMENT-ORG" in r["body"] for r in rows2) and rows3 == [], f"{rows} {rows3}")
        st, _ = comment(tok, ot, "pwned")
        check(f"Comments on tasks: {who} cannot comment on an Organizers task", refused(st) and count(ot) == "1", str(st))

    # #festival: Pat is a viewer. She reads every comment; she may comment only on the task assigned to her.
    st, c = comment(olive, xt, "Stage company needs the size by Friday")
    xc = c.get("id") if st == 201 else None
    st, rows = call("GET", f"/task_comments?task_id=eq.{xt}&select=body", pat)
    check("Comments on tasks: Pat (viewer) reads comments in #festival (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, c = comment(pat, pt, "Banners are in the shed, I will hang them Saturday")
    pc = c.get("id") if st == 201 else None
    check("Comments on tasks: Pat (viewer) comments on the task assigned to her (positive control)", st == 201 and c["author_id"] == P, f"{st} {c}")
    st, _ = comment(pat, xt, "pwned")
    st2, _ = comment(vic, pt, "pwned")
    check("Comments on tasks: Pat cannot comment on someone else's task, nor Vic (viewer) on Pat's", refused(st) and refused(st2)
          and count(xt) == "1" and count(pt) == "1", f"{st} {st2}")
    st, _ = comment(mint("u-pub", scope="volunteers"), pt, "pwned")
    check("Comments on tasks: nor Pat on her own task through a token scoped to another channel", refused(st) and count(pt) == "1", str(st))
    st, _ = comment(olive, pt, "   ")
    st2, _ = comment(olive, pt, "x" * 1001)
    check("Comments on tasks: an empty comment and one over 1000 characters are refused", st == 400 and st2 == 400 and count(pt) == "1", f"{st} {st2}")

    # Authorship and time cannot be forged; comments are not edited and do not jump between tasks.
    st, _ = comment(olive, xt, "forged", author_id=A)
    st2, _ = comment(olive, xt, "backdated", created_at="2020-01-01T00:00:00Z")
    check("Comments on tasks: author and time cannot be set by the client", refused(st) and refused(st2) and count(xt) == "1", f"{st} {st2}")
    st, _ = call("PATCH", f"/task_comments?id=eq.{xc}", olive, {"body": "rewritten"})
    st2, _ = call("PATCH", f"/task_comments?id=eq.{xc}", olive, {"task_id": ot})
    check("Comments on tasks: a comment cannot be edited or moved to another task, not even by its author",
          refused(st) and refused(st2) and oq(f"select task_id::text || body from weft.task_comments where id = '{xc}'") == xt + "Stage company needs the size by Friday", f"{st} {st2}")

    # Deleting: your own, or an owner of the space.
    st, rows = call("DELETE", f"/task_comments?id=eq.{pc}", vic)
    st2, rows2 = call("DELETE", f"/task_comments?id=eq.{pc}", olive)
    check("Comments on tasks: Vic and Olive (editor, not owner) cannot delete Pat's comment", (rows == [] or refused(st)) and (rows2 == [] or refused(st2)) and count(pt) == "1", f"{st} {rows} {st2} {rows2}")
    st, rows = call("DELETE", f"/task_comments?id=eq.{xc}", pat)
    check("Comments on tasks: Pat cannot delete Olive's comment", (rows == [] or refused(st)) and count(xt) == "1", f"{st} {rows}")
    st, rows = call("DELETE", f"/task_comments?id=eq.{pc}", pat)
    check("Comments on tasks: Pat deletes her own comment (positive control)", st == 200 and len(rows or []) == 1 and count(pt) == "0", f"{st} {rows}")
    st, rows = call("DELETE", f"/task_comments?id=eq.{xc}", alex)
    check("Comments on tasks: Alex (owner of #festival) deletes Olive's comment (positive control)", st == 200 and len(rows or []) == 1 and count(xt) == "0", f"{st} {rows}")
    check("Comments on tasks: the delete is in the audit log under #festival, by Alex, with the text it had",
          oq(f"select count(*) from weft.audit where table_name = 'task_comments' and row_id = '{xc}' and space_id = '{SID['festival']}' and actor_id = '{A}' and op = 'DELETE' and old_row->>'author_id' = '{O}'") == "1")

    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    comment(olive, xt, "TCOMMENT-FEST size is 8 by 6 metres")
    st, rows = call("GET", "/task_comments?select=task_id", scoped)
    st2, _ = comment(scoped, ot, "pwned")
    check("Comments on tasks: a #festival-scoped token for Olive sees only #festival comments and cannot comment in Organizers",
          st == 200 and rows and ot not in {r["task_id"] for r in rows} and refused(st2) and count(ot) == "1", f"{st} {st2}")
    st, rows = call("GET", f"/task_comments?id=eq.{oc}", mint("u-vol", scope="volunteers"))
    check("Comments on tasks: a scoped token for Vic sees no Organizers comment", st == 200 and rows == [], str(rows))
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/task_comments?task_id=eq.{ot}&select=body", helper)
    check("Comments on tasks: the assistant (for Olive) reads the comment (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/task_comments?id=eq.{oc}", helper)
    st2, _ = comment(helper, ot, "by the assistant")
    check("Comments on tasks: the assistant cannot delete or post a comment", refused(st) and refused(st2) and count(ot) == "1", f"{st} {st2}")
    st, rows = call("GET", f"/task_comments?id=eq.{oc}", mint("u-pub", assistant=True))
    check("Comments on tasks: the assistant for Pat sees no Organizers comment", st == 200 and rows == [], str(rows))

    # Search and the assistant read the list's text summary.
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", olive)
    check("Comments on tasks: the list summary carries the comment under its task (search and the assistant see it)",
          st == 200 and "Book the caterer (Alex" in (rows[0]["body_text"] or "") and "\n  Comment by Olive Organizer: TCOMMENT-ORG-SECRET quote is 4200" in (rows[0]["body_text"] or ""), str(rows))
    st, rows = call("GET", f"/items?body_text=like.*TCOMMENT-ORG*&select=id", pat)
    check("Comments on tasks: Pat finds no item carrying the Organizers comment", st == 200 and rows == [], str(rows))

    # Moves: a #festival list moved to Volunteers keeps its comments; Pat (not in Volunteers) loses her name on hers,
    # recorded under #festival only.
    st, c = comment(pat, pt, "TCOMMENT-PAT done the left side")
    mc = c.get("id") if st == 201 else None
    st, _ = call("PATCH", f"/items?id=eq.{fest}", olive, {"space_id": SID["volunteers"]})
    st2, rows2 = call("GET", f"/task_comments?task_id=eq.{pt}&select=id,author_id,body", vic)
    check("Comments on tasks: the list moved to Volunteers: its comments go with it, and Pat's (she is not in Volunteers) has no author",
          st == 200 and st2 == 200 and rows2 == [{"id": mc, "author_id": None, "body": "TCOMMENT-PAT done the left side"}], f"{st} {rows2}")
    st, rows = call("GET", f"/task_comments?task_id=eq.{xt}&select=author_id", vic)
    check("Comments on tasks: Olive's comment (she is in Volunteers) keeps its author", st == 200 and rows == [{"author_id": O}], str(rows))
    check("Comments on tasks: the removed author is recorded under #festival (the space it moved from), never Volunteers",
          oq(f"select count(*) from weft.audit where table_name = 'task_comments' and row_id = '{mc}' and space_id = '{SID['festival']}' and old_row->>'author_id' = '{P}'") == "1"
          and oq(f"select count(*) from weft.audit where table_name = 'task_comments' and row_id = '{mc}' and space_id <> '{SID['festival']}'") == "0")
    st, rows = call("GET", f"/audit?row_id=eq.{mc}&select=space_id", olive)
    check("Comments on tasks: Olive (a #festival member) still reads that audit row", st == 200 and [r["space_id"] for r in rows] == [SID["festival"]], str(rows))
    st, rows = call("GET", f"/items?id=eq.{fest}&select=body_text", vic)
    check("Comments on tasks: the moved list's summary names no one for Pat's comment",
          st == 200 and "Comment by someone: TCOMMENT-PAT" in (rows[0]["body_text"] or "") and "Pat" not in (rows[0]["body_text"] or ""), str(rows))
    st, rows = call("GET", f"/task_comments?task_id=eq.{pt}", pat)
    st2, _ = call("DELETE", f"/task_comments?id=eq.{mc}", pat)
    check("Comments on tasks: Pat now reads nothing of the moved list and cannot delete the comment that was hers",
          st == 200 and rows == [] and count(pt) == "1", f"{rows} {st2}")

    # Deleting a task deletes its comments; deleting the list deletes the rest.
    call("DELETE", f"/tasks?id=eq.{pt}", olive)
    check("Comments on tasks: deleting a task deletes its comments", count(pt) == "0")
    for lst in (org, fest):
        call("DELETE", f"/items?id=eq.{lst}", alex)
    check("Comments on tasks: deleting the lists deletes their comments (tidy)",
          oq(f"select count(*) from weft.task_comments where task_id in ('{ot}', '{xt}')") == "0")


# ---------------------------------------------------------------- more on the calendar
def more_on_the_calendar():
    """Milestones and your shifts on the Calendar (the exact queries Calendar.jsx makes), and the saved switches."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org")
    oq = lambda sql: owner_sql(sql)
    day0, day1 = "2031-03-03", "2031-03-10"
    start, end = "2031-03-03T00:00:00Z", "2031-03-10T00:00:00Z"
    ms_q = f"/milestones?and=(day.gte.{day0},day.lt.{day1})&select=id,space_id,title,day,note&order=day&limit=1000"
    sh_q = lambda who: f"/shifts?and=(starts_at.lt.{end},ends_at.gt.{start})&select=id,space_id,title,starts_at,ends_at,mine:shift_signups!inner(user_id)&mine.user_id=eq.{who}&order=starts_at&limit=1000"
    st, rows = call("POST", "/milestones", olive, {"space_id": SID["organizers"], "title": "CAL-MS-ORG-SECRET", "day": "2031-03-04"})
    m_org = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/milestones", olive, {"space_id": SID["festival"], "title": "CAL-MS-FEST", "day": "2031-03-05"})
    m_fest = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/shifts", olive, {"space_id": SID["organizers"], "title": "CAL-SHIFT-ORG-SECRET", "starts_at": "2031-03-04T10:00:00Z", "ends_at": "2031-03-04T12:00:00Z", "places": 3})
    s_org = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/shifts", olive, {"space_id": SID["festival"], "title": "CAL-SHIFT-FEST", "starts_at": "2031-03-05T10:00:00Z", "ends_at": "2031-03-05T12:00:00Z", "places": 3})
    s_fest = rows[0]["id"] if st == 201 else None
    check("Calendar: Olive sets up milestones and shifts in Organizers and #festival (positive control)", all((m_org, m_fest, s_org, s_fest)), f"{st} {rows}")
    call("POST", "/shift_signups", olive, {"shift_id": s_org}, prefer="return=minimal")
    call("POST", "/shift_signups", olive, {"shift_id": s_fest}, prefer="return=minimal")
    st, _ = call("POST", "/shift_signups", pat, {"shift_id": s_fest}, prefer="return=minimal")
    check("Calendar: Pat (viewer) signs up for the #festival shift (positive control)", st == 201, str(st))
    # Milestones: members only, through the Calendar's own query.
    st, rows = call("GET", ms_q, pat)
    check("Calendar: Pat's milestones for the week are #festival's only, never Organizers'",
          st == 200 and m_fest in {r["id"] for r in rows} and all(r["space_id"] != SID["organizers"] and "SECRET" not in r["title"] for r in rows), str(rows))
    st, rows = call("GET", ms_q, olive)
    check("Calendar: Olive sees both milestones (positive control)", st == 200 and {m_org, m_fest} <= {r["id"] for r in rows}, str(rows))
    st, rows = call("GET", ms_q, mint("u-org", scope="festival"))
    check("Calendar: a #festival-scoped token sees only #festival milestones", st == 200 and m_fest in {r["id"] for r in rows}
          and all(r["space_id"] == SID["festival"] for r in rows), str(rows))
    # Your shifts: only your own sign-ups, and only where you are a member.
    st, rows = call("GET", sh_q(P), pat)
    check("Calendar: Pat's shifts are the one she signed up for", st == 200 and [r["id"] for r in rows] == [s_fest], str(rows))
    st, rows = call("GET", sh_q(O), pat)
    check("Calendar: asking for Olive's shifts, Pat still gets no Organizers shift", st == 200 and all(r["space_id"] != SID["organizers"] for r in rows), str(rows))
    st, rows = call("GET", sh_q(V), vic)
    check("Calendar: Vic, signed up for nothing, gets no shifts that week", st == 200 and rows == [], str(rows))
    st, rows = call("GET", sh_q(O), olive)
    check("Calendar: Olive sees both of her shifts (positive control)", st == 200 and {r["id"] for r in rows} == {s_org, s_fest}, str(rows))
    st, rows = call("GET", sh_q(O), mint("u-org", scope="festival"))
    check("Calendar: with a #festival-scoped token Olive sees only her #festival shift", st == 200 and [r["id"] for r in rows] == [s_fest], str(rows))
    # Nothing on the Calendar writes them: Pat cannot change or delete them there; the assistant cannot delete.
    st, rows = call("PATCH", f"/milestones?id=eq.{m_fest}", pat, {"day": "2031-03-06"})
    st2, rows2 = call("DELETE", f"/shifts?id=eq.{s_fest}", pat)
    check("Calendar: Pat (viewer) cannot move a #festival milestone or delete a shift",
          rows == [] and rows2 == [] and oq(f"select day::text from weft.milestones where id = '{m_fest}'") == "2031-03-05"
          and oq(f"select count(*) from weft.shifts where id = '{s_fest}'") == "1", f"{st} {st2}")
    helper = mint("u-org", assistant=True)
    st, _ = call("DELETE", f"/milestones?id=eq.{m_org}", helper)
    st2, _ = call("DELETE", f"/shifts?id=eq.{s_org}", helper)
    st3, _ = call("DELETE", "/user_prefs", helper)
    check("Calendar: the assistant cannot delete milestones, shifts or anyone's switches",
          all(refused(x) for x in (st, st2, st3)) and oq(f"select count(*) from weft.milestones where id = '{m_org}'") == "1"
          and oq(f"select count(*) from weft.shifts where id = '{s_org}'") == "1", f"{st} {st2} {st3}")
    st, rows = call("GET", "/user_prefs?select=calendar", helper)
    check("Calendar: the assistant cannot read anyone's switches", refused(st) or rows == [], f"{st} {rows}")
    # The switches: your own row only, a checked shape, and saving them keeps your Home layout.
    call("POST", "/user_prefs?on_conflict=user_id", pat, {"home": {"widgets": ["recent"]}}, prefer="resolution=merge-duplicates,return=minimal")
    st, _ = call("POST", "/user_prefs?on_conflict=user_id", pat, {"calendar": {"off": ["milestones", "away"]}}, prefer="resolution=merge-duplicates,return=minimal")
    st2, rows = call("GET", "/user_prefs?select=user_id,home,calendar", pat)
    check("Calendar: Pat saves her switches and reads them back; her Home layout is kept (positive control)", st in (200, 201)
          and rows == [{"user_id": P, "home": {"widgets": ["recent"]}, "calendar": {"off": ["milestones", "away"]}}], f"{st} {rows}")
    st, rows = call("GET", "/user_prefs?select=user_id,calendar", olive)
    check("Calendar: Olive cannot read Pat's switches", st == 200 and all(r["user_id"] != P for r in rows), str(rows))
    st, _ = call("POST", "/user_prefs", olive, {"user_id": P, "calendar": {"off": []}}, prefer="return=minimal")
    st2, rows2 = call("PATCH", f"/user_prefs?user_id=eq.{P}", olive, {"calendar": {"off": ["tasks"]}})
    check("Calendar: Olive cannot write Pat's switches", refused(st) and (refused(st2) or rows2 == [])
          and oq(f"select calendar::text from weft.user_prefs where user_id = '{P}'") == '{"off": ["milestones", "away"]}', f"{st} {st2}")
    st, _ = call("PATCH", f"/user_prefs?user_id=eq.{P}", pat, {"user_id": O})
    check("Calendar: Pat cannot move her switches to another person", refused(st), str(st))
    st, rows = call("PATCH", f"/user_prefs?user_id=eq.{P}", mint("u-pub", scope="festival"), {"calendar": {"off": []}})
    check("Calendar: a channel-scoped token cannot change the switches", (refused(st) or rows == [])
          and oq(f"select calendar::text from weft.user_prefs where user_id = '{P}'") == '{"off": ["milestones", "away"]}', f"{st} {rows}")
    bad = [{"off": ["secrets"]}, {"off": "tasks"}, {"off": ["tasks"], "note": "x" * 5000}, ["tasks"], {"off": ["tasks"] * 6}]
    sts = [call("PATCH", f"/user_prefs?user_id=eq.{P}", pat, {"calendar": b})[0] for b in bad]
    check("Calendar: switches of any other shape are refused (an unknown kind, not a list, extra keys, not an object, too long)",
          all(x == 400 for x in sts), str(sts))
    st, rows = call("PATCH", f"/user_prefs?user_id=eq.{P}", pat, {"calendar": {}})
    check("Calendar: Pat switches everything back on (positive control)", st == 200 and rows and rows[0]["calendar"] == {}, f"{st} {rows}")
    # Clean up: deleting the channel's things takes them off the Calendar.
    for t, i in (("milestones", m_org), ("milestones", m_fest), ("shifts", s_org), ("shifts", s_fest)):
        call("DELETE", f"/{t}?id=eq.{i}", olive)
    st, rows = call("GET", sh_q(P), pat)
    st2, rows2 = call("GET", ms_q, pat)
    check("Calendar: once deleted, the shift and milestone are gone from Pat's Calendar", rows == [] and all(r["id"] != m_fest for r in rows2), f"{rows} {rows2}")


# ---------------------------------------------------------------- away warnings (052)
def away_warnings():
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    day = lambda n: oq(f"select (current_date + {n})::text")
    w0, w1 = day(140), day(180)   # a window of its own, clear of the other suites' time off
    d150, d152, d155, d157, d160, d162 = day(150), day(152), day(155), day(157), day(160), day(162)
    def away(tok, a=w0, b=w1, method="GET"):
        if method == "GET":
            return call("GET", f"/rpc/away_between?p_from={a}&p_to={b}", tok)
        return call("POST", "/rpc/away_between", tok, {"p_from": a, "p_to": b})
    def has(rows, who, a, b):
        return isinstance(rows, list) and any(r.get("user_id") == who and r.get("starts_on") == a and r.get("ends_on") == b for r in rows)
    def add(tok, space, a, b, user=None, note=""):
        st, rows = call("POST", "/time_off", tok, {"space_id": SID[space], "starts_on": a, "ends_on": b, "note": note, **({"user_id": user} if user else {})})
        return rows[0]["id"] if st == 201 else None
    # Alex away in Organizers only (a secret to #festival), Olive in both Organizers and #festival on the same
    # days, Pat in #festival, Vic in #festival (added by Olive).
    alex_org = add(alex, "organizers", d160, d162, note="AWAYWARN-ORG-SECRET clinic")
    olive_org = add(olive, "organizers", d150, d152, note="AWAYWARN-ORG-SECRET")
    olive_fest = add(olive, "festival", d150, d152)
    pat_fest = add(pat, "festival", d155, d157, note="Holiday")
    vic_fest = add(olive, "festival", d155, d155, user=V)
    check("Away warnings: the time off to warn about was added (setup)", all((alex_org, olive_org, olive_fest, pat_fest, vic_fest)))

    st, rows = away(olive)
    check("Away warnings: Olive (in both channels) is warned about Alex, Pat, Vic and herself (positive control)",
          st == 200 and has(rows, A, d160, d162) and has(rows, P, d155, d157) and has(rows, V, d155, d155) and has(rows, O, d150, d152), f"{st} {rows}")
    check("Away warnings: Olive's same days in two channels come back once",
          isinstance(rows, list) and sum(1 for r in rows if r.get("user_id") == O and r.get("starts_on") == d150) == 1, str(rows))
    check("Away warnings: only who and which days: no note, channel, id or author",
          isinstance(rows, list) and rows and all(set(r) == {"user_id", "starts_on", "ends_on"} for r in rows), str(rows[:2] if isinstance(rows, list) else rows))
    st2, rows2 = away(olive, method="POST")
    check("Away warnings: asking by POST gives the same answer (it only reads)", st2 == 200 and rows2 == rows, f"{st2} {rows2}")

    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = away(tok)
        check(f"Away warnings: {who} (#festival viewer, not in Organizers) is not warned about Alex's Organizers-only time off",
              st == 200 and not any(r.get("user_id") == A for r in rows), f"{st} {rows}")
        check(f"Away warnings: {who} is warned about #festival time off: Pat, Vic and Olive's #festival entry (positive control)",
              st == 200 and has(rows, P, d155, d157) and has(rows, V, d155, d155) and has(rows, O, d150, d152), f"{st} {rows}")
    st, rows = away(pat, day(159), day(163))
    check("Away warnings: Pat asking about exactly Alex's days gets nothing", st == 200 and rows == [], f"{st} {rows}")
    st, rows = away(alex, day(159), day(163))
    check("Away warnings: Alex asking about the same days sees his own (positive control)", st == 200 and has(rows, A, d160, d162) and len(rows) == 1, f"{st} {rows}")

    # The window: overlap counts, a day outside does not; nonsense windows return nothing.
    st, rows = away(olive, d157, d157)
    check("Away warnings: a one-day window inside Pat's time off finds her (last day included)", st == 200 and has(rows, P, d155, d157), f"{st} {rows}")
    st, rows = away(olive, day(158), day(159))
    check("Away warnings: the days between time off find nobody", st == 200 and not any(r.get("user_id") in (P, V, A, O) for r in rows), f"{st} {rows}")
    st, rows = away(olive, w1, w0)
    st2, rows2 = away(olive, day(0), day(401))
    st3, rows3 = call("GET", f"/rpc/away_between?p_from={w0}", olive)
    check("Away warnings: a backwards window or one over 400 days returns nothing; a missing end is refused or empty",
          st == 200 and rows == [] and st2 == 200 and rows2 == [] and (st3 >= 400 or rows3 == []), f"{st} {st2} {rows2[:1] if isinstance(rows2, list) else rows2} {st3}")
    st, rows = away(olive, day(0), day(400))
    check("Away warnings: exactly 400 days is fine (positive control)", st == 200 and has(rows, A, d160, d162), f"{st}")

    # Channel scope and the assistant.
    st, rows = away(mint("u-org", scope="festival"))
    check("Away warnings: a #festival-scoped token for Olive is warned only from #festival time off (no Alex)",
          st == 200 and has(rows, P, d155, d157) and not any(r.get("user_id") == A for r in rows), f"{st} {rows}")
    st, rows = away(mint("u-alex", scope="organizers"))
    check("Away warnings: an Organizers-scoped token for Alex sees Alex's Organizers time off but not Pat's #festival one",
          st == 200 and has(rows, A, d160, d162) and not any(r.get("user_id") == P for r in rows), f"{st} {rows}")
    helper = mint("u-org", assistant=True)
    st, rows = away(helper)
    check("Away warnings: the assistant role may not call the helper", refused(st) or (st >= 400 and not isinstance(rows, list)), f"{st} {rows}")
    st, _ = call("DELETE", f"/time_off?id=eq.{alex_org}", helper)
    check("Away warnings: the assistant still cannot delete time off", refused(st) and oq(f"select count(*) from weft.time_off where id = '{alex_org}'") == "1", str(st))
    st, rows = call("GET", f"/rpc/away_between?p_from={w0}&p_to={w1}")
    check("Away warnings: without a token, nothing", st >= 400 or rows == [], f"{st} {rows}")
    check("Away warnings: the helper runs as the caller (not security definer), only reads, and only weft_user may run it",
          oq("select prosecdef::text || provolatile::text from pg_proc where oid = 'weft.away_between(date, date)'::regprocedure") == "falses"
          and oq("select has_function_privilege('weft_user', 'weft.away_between(date, date)', 'execute')::text"
                 " || has_function_privilege('weft_assistant', 'weft.away_between(date, date)', 'execute')::text"
                 " || has_function_privilege('weft_anon', 'weft.away_between(date, date)', 'execute')::text") == "truefalsefalse")

    # Nothing to write: warnings follow the time off. Pat cannot add or change anyone else's to cause one,
    # nor forge who added it; when time off changes or goes, so does the warning.
    st, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "user_id": O, "starts_on": d160, "ends_on": d160})
    st2, _ = call("POST", "/time_off", pat, {"space_id": SID["organizers"], "starts_on": d160, "ends_on": d160})
    st3, _ = call("POST", "/time_off", pat, {"space_id": SID["festival"], "starts_on": d160, "ends_on": d160, "created_by": O})
    st4, rows4 = call("PATCH", f"/time_off?id=eq.{olive_fest}", pat, {"ends_on": d162})
    check("Away warnings: Pat cannot make Olive look away in #festival, add time off in Organizers, forge who added it, or stretch Olive's",
          all(refused(x) for x in (st, st2, st3)) and rows4 == [] and oq(f"select ends_on::text from weft.time_off where id = '{olive_fest}'") == d152, f"{st} {st2} {st3} {st4}")
    st, rows = call("PATCH", f"/time_off?id=eq.{pat_fest}", olive, {"ends_on": d160})
    st2, rows2 = away(vic)
    check("Away warnings: Olive (editor) lengthens Pat's time off; Vic's warning follows (positive control)",
          st == 200 and has(rows2, P, d155, d160) and not has(rows2, P, d155, d157), f"{st} {rows2}")
    oq(f"delete from weft.members where space_id = '{SID['festival']}' and user_id = '{V}'")
    st, rows = away(pat)
    check("Away warnings: Vic removed from #festival: his time off there goes, so Pat is no longer warned about him",
          st == 200 and not any(r.get("user_id") == V for r in rows) and oq(f"select count(*) from weft.time_off where id = '{vic_fest}'") == "0", f"{st} {rows}")
    oq(f"insert into weft.members (space_id, user_id, role) values ('{SID['festival']}', '{V}', 'viewer')")
    check("Away warnings: Vic is back in #festival as a viewer (tidy)",
          oq(f"select role from weft.members where space_id = '{SID['festival']}' and user_id = '{V}'") == "viewer")
    call("DELETE", f"/time_off?id=eq.{olive_fest}", olive)
    st, rows = away(pat)
    st2, rows2 = away(alex)
    check("Away warnings: Olive removes her #festival entry: Pat is no longer warned about her, Alex still is (her Organizers entry)",
          st == 200 and not any(r.get("user_id") == O for r in rows) and has(rows2, O, d150, d152), f"{rows} {rows2}")
    for tid, tok in ((alex_org, alex), (olive_org, olive), (pat_fest, pat)):
        call("DELETE", f"/time_off?id=eq.{tid}", tok)
    check("Away warnings: tidied up", oq(f"select count(*) from weft.time_off where starts_on between '{w0}' and '{w1}'") == "0")


# ---------------------------------------------------------------- meeting decisions to the log
def meeting_decisions():
    """Send a meeting's decision lines to a decision log in the same space (054)."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    O, A = uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    mk = lambda tok, space, kind, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/items", tok, {"space_id": SID[space], "kind": kind, "title": title}))
    send = lambda tok, meeting, log, line, on=None: call("POST", "/rpc/send_meeting_decision", tok, {"p_meeting": meeting, "p_log": log, "p_line": line, "p_on": on})
    links = lambda meeting: oq(f"select count(*) from weft.meeting_decisions where meeting_id = '{meeting}'")
    in_log = lambda log: oq(f"select count(*) from weft.decisions where log_id = '{log}'")
    om, ol = mk(olive, "organizers", "meeting", "MD board meeting"), mk(olive, "organizers", "decisionlog", "MD org decisions")
    fm, fl = mk(olive, "festival", "meeting", "MD festival stand-up"), mk(olive, "festival", "decisionlog", "MD festival decisions")
    check("Meeting decisions: Olive makes a meeting and a decision log in Organizers and in #festival", all((om, ol, fm, fl)))
    call("PATCH", f"/meetings?id=eq.{om}", olive, {"decisions": "MD-ORG-SECRET fee is 40\nKeep the hall"})

    st, d = send(olive, om, ol, "  MD-ORG-SECRET fee is 40  ", "2026-11-12")
    od = d.get("id") if st == 200 and isinstance(d, dict) else None
    check("Meeting decisions: Olive sends a line to the Organizers log (positive control): a decision there, dated and decided by the meeting",
          od and d["log_id"] == ol and d["title"] == "MD-ORG-SECRET fee is 40" and d["decided_by"] == "MD board meeting"
          and d["decided_on"] == "2026-11-12" and d["created_by"] == O, f"{st} {d}")
    check("Meeting decisions: and the link back to the meeting, made by her, with the trimmed line",
          oq(f"select meeting_id || '|' || created_by || '|' || line from weft.meeting_decisions where decision_id = '{od}'") == f"{om}|{O}|MD-ORG-SECRET fee is 40")
    st, body = send(olive, om, ol, "MD-ORG-SECRET fee is 40")
    check("Meeting decisions: the same line is not sent twice", st == 409 and in_log(ol) == "1" and links(om) == "1", f"{st} {body}")
    st, body = send(olive, om, fl, "Keep the hall")
    st2, body2 = send(olive, om, uid("item", "no-such-log"), "Keep the hall")
    st3, _ = send(olive, om, HOST_CONTACTS, "Keep the hall")
    check("Meeting decisions: a log in another space, one that does not exist, or an item that is not a log is refused, with one answer",
          st == 400 and st2 == 400 and st3 == 400 and body.get("message") == body2.get("message") and in_log(fl) == "0" and links(om) == "1", f"{st} {st2} {st3} {body}")
    st, _ = send(olive, om, ol, "   ")
    st2, _ = send(olive, om, ol, "x" * 1001)
    check("Meeting decisions: an empty line or one over 1,000 characters is refused", st == 400 and st2 == 400 and in_log(ol) == "1", f"{st} {st2}")

    fd = call("POST", "/decisions", olive, {"log_id": fl, "title": "A festival decision"})[1][0]["id"]
    st, body = call("POST", "/meeting_decisions", olive, {"decision_id": fd, "meeting_id": om, "line": "x"})
    check("Meeting decisions: a decision in another space cannot be linked to the Organizers meeting", st == 400 and links(om) == "1", f"{st} {body}")
    st, _ = call("POST", "/meeting_decisions", olive, {"decision_id": fd, "meeting_id": fm, "line": "A festival decision", "created_by": A})
    check("Meeting decisions: authorship of a link cannot be forged", refused(st) and links(fm) == "0", str(st))
    st, rows = call("POST", "/meeting_decisions", olive, {"decision_id": fd, "meeting_id": fm, "line": "A festival decision"})
    check("Meeting decisions: a decision in the same space can be linked directly (positive control)", st == 201 and rows and rows[0]["created_by"] == O, f"{st} {rows}")

    st, _ = send(pat, fm, fl, "pwned")
    st2, _ = send(pat, om, ol, "pwned")
    st3, _ = send(vic, om, ol, "pwned")
    check("Meeting decisions: Pat (viewer) sends nothing in #festival, nor Pat or Vic in Organizers", all(refused(x) for x in (st, st2, st3))
          and in_log(fl) == "1" and in_log(ol) == "1", f"{st} {st2} {st3}")
    pd = call("POST", "/decisions", olive, {"log_id": fl, "title": "Another festival decision"})[1][0]["id"]
    st, _ = call("POST", "/meeting_decisions", pat, {"decision_id": pd, "meeting_id": fm, "line": "x"})
    check("Meeting decisions: Pat cannot link a decision to the #festival meeting", refused(st) and links(fm) == "1", str(st))
    for who, tok in (("Pat", pat), ("Vic", vic)):
        st, rows = call("GET", f"/meeting_decisions?meeting_id=eq.{om}", tok)
        st2, rows2 = call("GET", "/meeting_decisions?line=like.*MD-ORG*&select=decision_id", tok)
        check(f"Meeting decisions: {who} sees no Organizers link, not even by filtering all of them", st == 200 and rows == [] and rows2 == [], f"{rows} {rows2}")
    st, rows = call("GET", f"/meeting_decisions?meeting_id=eq.{fm}&select=line,decision:decisions(title,log_id)", pat)
    check("Meeting decisions: Pat sees the #festival link and its decision (positive control)",
          st == 200 and rows == [{"line": "A festival decision", "decision": {"title": "A festival decision", "log_id": fl}}], str(rows))
    st, rows = call("GET", f"/decisions?id=eq.{fd}&select=id,meeting_decisions(meeting_id,meeting:items(title))", pat)
    check("Meeting decisions: from the log, Pat reaches the meeting a decision came from (what the log shows)",
          st == 200 and rows and rows[0]["meeting_decisions"] and rows[0]["meeting_decisions"]["meeting"]["title"] == "MD festival stand-up", str(rows))
    st, _ = call("PATCH", f"/meeting_decisions?decision_id=eq.{fd}", olive, {"meeting_id": om})
    check("Meeting decisions: a link is never changed (not to another meeting either)", refused(st) and oq(f"select meeting_id from weft.meeting_decisions where decision_id = '{fd}'") == fm, str(st))
    st, rows = call("DELETE", f"/meeting_decisions?decision_id=eq.{fd}", pat)
    check("Meeting decisions: Pat cannot remove a link", rows == [] and links(fm) == "1", f"{st} {rows}")

    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", f"/meeting_decisions?meeting_id=in.({om},{fm})&select=meeting_id", scoped)
    st2, _ = send(scoped, om, ol, "Keep the hall")
    check("Meeting decisions: a #festival-scoped token sees only #festival links and sends nothing in Organizers",
          st == 200 and [r["meeting_id"] for r in rows] == [fm] and refused(st2) and links(om) == "1", f"{rows} {st2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/meeting_decisions?meeting_id=eq.{om}&select=line", helper)
    check("Meeting decisions: the assistant (for Olive) reads the Organizers link (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, _ = call("DELETE", f"/meeting_decisions?decision_id=eq.{od}", helper)
    st2, _ = send(helper, om, ol, "Keep the hall")
    st3, _ = call("POST", "/meeting_decisions", helper, {"decision_id": pd, "meeting_id": fm, "line": "y"})
    check("Meeting decisions: the assistant cannot remove, send or link", refused(st) and refused(st2) and refused(st3) and links(om) == "1" and links(fm) == "1", f"{st} {st2} {st3}")

    # Search and the assistant read the log's text, which now has the sent decision.
    body = oq(f"select body_text from weft.items where id = '{ol}'")
    check("Meeting decisions: the log's text has the sent line, decided by the meeting", "2026-11-12: MD-ORG-SECRET fee is 40 (decided by MD board meeting)" in body, body)
    st, rows = call("POST", "/rpc/search", pat, {"p_q": "MD-ORG-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", olive, {"p_q": "MD-ORG-SECRET"})
    check("Meeting decisions: search finds it for Olive, not for Pat", rows == [] and any(r["id"] == ol for r in rows2 or []), f"{rows} {rows2}")
    long = "Long " + "y" * 300
    st, d = send(olive, om, ol, long)
    check("Meeting decisions: a line over 200 characters keeps a short title and the whole line as context",
          st == 200 and len(d["title"]) == 200 and d["title"].endswith("…") and d["context"] == long, f"{st} {d}")

    # Removing a link keeps the decision; deleting a decision removes its link and frees the line.
    st, rows = call("DELETE", f"/meeting_decisions?decision_id=eq.{fd}", olive)
    check("Meeting decisions: Olive removes a link (positive control); the decision stays in its log",
          st == 200 and len(rows or []) == 1 and oq(f"select count(*) from weft.decisions where id = '{fd}'") == "1", f"{st} {rows}")
    check("Meeting decisions: the removal is in the audit log under #festival",
          oq(f"select count(*) from weft.audit where table_name = 'meeting_decisions' and row_id = '{fd}' and space_id = '{SID['festival']}'") == "1")
    call("DELETE", f"/decisions?id=eq.{od}", olive)
    st, d = send(olive, om, ol, "MD-ORG-SECRET fee is 40")
    od2 = d.get("id") if st == 200 and isinstance(d, dict) else None
    check("Meeting decisions: deleting the decision removes its link, and the line can be sent again", od2 and links(om) == "2", f"{st} {d}")
    st, rows = call("GET", f"/audit?row_id=eq.{od}&table_name=eq.meeting_decisions&select=op", olive)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{od}&select=op", pat)
    check("Meeting decisions: that removal is in the audit log for Organizers members only", len(rows or []) == 1 and rows2 == [], f"{rows} {rows2}")

    # Moves: the Organizers meeting moves into #festival; its links to the Organizers log go, recorded under
    # Organizers only, and Pat sees no trace of them.
    st, _ = call("PATCH", f"/items?id=eq.{om}", olive, {"space_id": SID["festival"]})
    check("Meeting decisions: a meeting moved from Organizers into #festival drops its links to the Organizers log; the decisions stay",
          st == 200 and links(om) == "0" and in_log(ol) == "2", str(st))
    check("Meeting decisions: the removed links are recorded under Organizers (the space it moved from), never #festival",
          oq(f"select count(*) from weft.audit where table_name = 'meeting_decisions' and row_id = '{od2}' and space_id = '{SID['organizers']}'") == "1"
          and oq(f"select count(*) from weft.audit where table_name = 'meeting_decisions' and row_id = '{od2}' and space_id <> '{SID['organizers']}'") == "0")
    st, rows = call("GET", f"/audit?row_id=eq.{od2}&select=space_id", olive)
    st2, rows2 = call("GET", f"/audit?table_name=eq.meeting_decisions&select=row_id,old_row", pat)
    st3, rows3 = call("GET", f"/meeting_decisions?meeting_id=eq.{om}", pat)
    check("Meeting decisions: Olive (in Organizers) still reads that audit row; Pat sees no trace of it",
          [r["space_id"] for r in rows or []] == [SID["organizers"]] and "MD-ORG" not in json.dumps(rows2) and rows3 == [], f"{rows} {rows2} {rows3}")
    st, rows = call("GET", f"/items?id=eq.{om}&select=id", pat)
    check("Meeting decisions: Pat reads the moved meeting (positive control)", st == 200 and len(rows) == 1, str(rows))
    st, d = send(olive, om, fl, "Keep the hall", "2026-11-12")
    md = d.get("id") if st == 200 and isinstance(d, dict) else None
    check("Meeting decisions: from #festival the moved meeting sends to the #festival log", md and d["log_id"] == fl, f"{st} {d}")
    st, _ = call("PATCH", f"/items?id=eq.{fl}", olive, {"space_id": SID["volunteers"]})
    check("Meeting decisions: a log moved out of #festival stops linking to #festival meetings; its decisions stay",
          st == 200 and links(om) == "0" and oq(f"select count(*) from weft.decisions where id = '{md}'") == "1", str(st))
    check("Meeting decisions: that removal is recorded under #festival, not Volunteers",
          oq(f"select string_agg(space_id::text, ',') from weft.audit where table_name = 'meeting_decisions' and row_id = '{md}'") == SID["festival"])

    st, _ = send(olive, fm, mk(olive, "festival", "decisionlog", "Second festival log"), "Gates at nine")
    st2, _ = call("DELETE", f"/items?id=eq.{fm}", pat)
    check("Meeting decisions: Pat cannot delete a meeting with sent decisions", st == 200 and links(fm) == "1" and oq(f"select count(*) from weft.items where id = '{fm}'") == "1", f"{st} {st2}")
    sent = oq(f"select decision_id from weft.meeting_decisions where meeting_id = '{fm}'")
    call("DELETE", f"/items?id=eq.{fm}", olive)
    check("Meeting decisions: deleting a meeting removes its links, never the decisions",
          links(fm) == "0" and oq(f"select count(*) from weft.decisions where id = '{sent}'") == "1")
    for i in (om, ol, fl) + tuple(oq(f"select string_agg(id::text, ' ') from weft.items where title = 'Second festival log'").split()):
        call("DELETE", f"/items?id=eq.{i}", alex)
    check("Meeting decisions: tidied up", oq("select count(*) from weft.items where title in ('MD org decisions', 'MD festival decisions', 'Second festival log', 'MD board meeting')") == "0")


def poll_form_deadlines():
    """058: a "closes at" time on a poll or a form. Members see it, editors set it (the 023/024 rules); it must be
    in the future and within a year; once it passes, the poll or form is closed by itself (votes, answers, choices
    and questions refused) until an editor reopens it; the summary carries it."""
    import time
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    P = uid("user", "u-pub")
    oq = lambda sql: owner_sql(sql)
    at = lambda secs: oq(f"select to_char((now() + interval '{secs} seconds') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
    closes = lambda table, i: oq(f"select coalesce(closes_at::text, '') from weft.{table} where id = '{i}'")
    body = lambda i: oq(f"select body_text from weft.items where id = '{i}'") or ""
    mk = lambda space, kind, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/items", olive, {"space_id": SID[space], "kind": kind, "title": title}))
    org, fest, form, orgform = mk("organizers", "poll", "DL-SECRET org poll"), mk("festival", "poll", "DL festival poll"), mk("festival", "form", "DL festival form"), mk("organizers", "form", "DL-SECRET org form")
    check("Deadlines: Olive makes polls and forms in Organizers and #festival", all((org, fest, form, orgform)), f"{org} {fest} {form} {orgform}")
    ch = {}
    for label in ("Early", "Late"):
        st, rows = call("POST", "/poll_choices", olive, {"poll_id": fest, "label": label})
        ch[label] = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/form_questions", olive, {"form_id": form, "label": "Your name", "kind": "short"})
    q = rows[0]["id"] if st == 201 else None
    T1, T2 = at(86400), at(2 * 86400)

    # Setting it: editors yes, viewers and the assistant no.
    st, rows = call("PATCH", f"/polls?id=eq.{org}", olive, {"closes_at": T1})
    st2, rows2 = call("PATCH", f"/forms?id=eq.{orgform}", olive, {"closes_at": T1})
    check("Deadlines: Olive (editor) sets a closing time on a poll and a form (positive control)", st == 200 and rows and rows[0]["closes_at"] and st2 == 200 and closes("forms", orgform), f"{st} {rows} {st2} {rows2}")
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", pat, {"closes_at": T1})
    st2, rows2 = call("PATCH", f"/forms?id=eq.{form}", pat, {"closes_at": T1})
    st3, rows3 = call("PATCH", f"/polls?id=eq.{fest}", vic, {"closes_at": T1})
    check("Deadlines: Pat and Vic (viewers in #festival) cannot set a closing time", rows == [] and rows2 == [] and rows3 == []
          and closes("polls", fest) == "" and closes("forms", form) == "", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/polls?id=eq.{org}", pat, {"closes_at": None})
    st2, rows2 = call("PATCH", f"/forms?id=eq.{orgform}", vic, {"closes_at": None})
    check("Deadlines: nor clear one in Organizers", rows == [] and rows2 == [] and closes("polls", org) and closes("forms", orgform), f"{st} {st2}")
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closes_at": T1, "closed_by": P})
    check("Deadlines: who closed it still cannot be set alongside", refused(st) and closes("polls", fest) == "", f"{st} {rows}")

    # Reading: members only.
    st, rows = call("GET", f"/polls?id=eq.{org}&select=closes_at", pat)
    st2, rows2 = call("GET", "/polls?closes_at=not.is.null&select=id", pat)
    st3, rows3 = call("GET", "/forms?closes_at=not.is.null&select=id", vic)
    check("Deadlines: Pat and Vic see no Organizers closing times, not even by filtering on them",
          rows == [] and org not in [r["id"] for r in rows2 or []] and orgform not in [r["id"] for r in rows3 or []], f"{rows} {rows2} {rows3}")
    st, rows = call("GET", f"/polls?id=eq.{org}&select=closes_at", olive)
    check("Deadlines: Olive reads it (positive control)", st == 200 and rows and rows[0]["closes_at"], f"{st} {rows}")
    check("Deadlines: the summary says when it closes", "Poll, open until " in body(org) and " UTC, 0 votes" in body(org)
          and "Form, open until " in body(orgform), f"{body(org)!r} {body(orgform)!r}")
    st, rows = call("GET", f"/items?id=eq.{org}&select=body_text", pat)
    check("Deadlines: and is hidden from Pat", rows == [], str(rows))

    # The time itself.
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closes_at": at(-60)})
    st2, rows2 = call("PATCH", f"/forms?id=eq.{form}", olive, {"closes_at": at(-60)})
    check("Deadlines: a closing time in the past is refused", st == 400 and st2 == 400 and "future" in json.dumps(rows) and closes("polls", fest) == "", f"{st} {st2} {rows}")
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closes_at": at(400 * 86400)})
    check("Deadlines: and one more than a year ahead", st == 400 and "year" in json.dumps(rows) and closes("polls", fest) == "", f"{st} {rows}")
    st, rows = call("PATCH", f"/polls?id=eq.{org}", olive, {"closes_at": T2})
    st2, rows2 = call("PATCH", f"/polls?id=eq.{org}", olive, {"closes_at": None})
    check("Deadlines: Olive moves and clears it (positive control)", st == 200 and st2 == 200 and closes("polls", org) == "" and "Poll, open, 0 votes" in body(org), f"{st} {st2} {body(org)!r}")

    # Scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("PATCH", f"/polls?id=eq.{org}", scoped, {"closes_at": T1})
    st2, rows2 = call("PATCH", f"/polls?id=eq.{fest}", scoped, {"closes_at": T1})
    check("Deadlines: a #festival-scoped token sets it in #festival only", rows == [] and closes("polls", org) == "" and st2 == 200 and rows2, f"{st} {rows} {st2} {rows2}")
    call("PATCH", f"/polls?id=eq.{fest}", olive, {"closes_at": None})
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/forms?id=eq.{orgform}&select=closes_at", helper)
    st2, _ = call("PATCH", f"/forms?id=eq.{orgform}", helper, {"closes_at": None})
    st3, _ = call("DELETE", f"/polls?id=eq.{org}", helper)
    check("Deadlines: the assistant reads a closing time but cannot change it or delete", st == 200 and rows and rows[0]["closes_at"]
          and refused(st2) and refused(st3) and closes("forms", orgform), f"{st} {rows} {st2} {st3}")

    # The time passes: closed by itself.
    soon = at(3)
    st, _ = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closes_at": soon})
    st2, _ = call("PATCH", f"/forms?id=eq.{form}", olive, {"closes_at": soon})
    st3, _ = call("POST", "/poll_votes", pat, {"poll_id": fest, "choice_id": ch["Early"]})
    st4, _ = call("POST", "/form_responses", pat, {"form_id": form, "answers": {q: "Pat"}})
    check("Deadlines: before the time, Pat votes and answers (positive control)", st == 200 and st2 == 200 and st3 == 201 and st4 == 201, f"{st} {st2} {st3} {st4}")
    time.sleep(3.5)
    check("Deadlines: once the time has passed, the poll and the form count as closed", oq(f"select weft_private.poll_closed('{fest}') and weft_private.form_closed('{form}')") == "t"
          and oq(f"select closed::text from weft.polls where id = '{fest}'") == "false")
    st, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Late"]})
    st2, _ = call("POST", "/poll_votes", vic, {"poll_id": fest, "choice_id": ch["Late"]})
    st3, _ = call("DELETE", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat)
    st4, _ = call("POST", "/poll_choices", olive, {"poll_id": fest, "label": "Too late"})
    check("Deadlines: nobody votes, changes or withdraws a vote, and choices are not added", all(refused(x) for x in (st, st2, st3, st4))
          and oq(f"select choice_id from weft.poll_votes where poll_id = '{fest}' and voter_id = '{P}'") == ch["Early"], f"{st} {st2} {st3} {st4}")
    st, _ = call("PATCH", f"/form_responses?form_id=eq.{form}&respondent_id=eq.{P}", pat, {"answers": {q: "Pat P."}})
    st2, _ = call("POST", "/form_responses", vic, {"form_id": form, "answers": {q: "Vic"}})
    st3, _ = call("POST", "/form_questions", olive, {"form_id": form, "label": "Too late"})
    check("Deadlines: nobody answers or changes an answer, and questions are not added", all(refused(x) for x in (st, st2, st3))
          and oq(f"select answers->>'{q}' from weft.form_responses where form_id = '{form}'") == "Pat", f"{st} {st2} {st3}")
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", pat, {"closed": False, "closes_at": None})
    check("Deadlines: Pat cannot reopen it by clearing the time", rows == [] and closes("polls", fest) != "", f"{st} {rows}")
    st, rows = call("PATCH", f"/polls?id=eq.{fest}", olive, {"closes_at": None})
    st2, _ = call("PATCH", f"/poll_votes?poll_id=eq.{fest}&voter_id=eq.{P}", pat, {"choice_id": ch["Late"]})
    check("Deadlines: Olive reopens the poll by clearing the time, and votes change again (positive control)", st == 200 and st2 == 200, f"{st} {st2} {rows}")
    # Closed by hand, then the time passes: reopening by hand clears the passed time.
    call("PATCH", f"/forms?id=eq.{form}", olive, {"closes_at": at(2)})
    call("PATCH", f"/forms?id=eq.{form}", olive, {"closed": True})
    time.sleep(2.5)
    st, rows = call("PATCH", f"/forms?id=eq.{form}", olive, {"closed": False})
    st2, _ = call("PATCH", f"/form_responses?form_id=eq.{form}&respondent_id=eq.{P}", pat, {"answers": {q: "Pat P."}})
    check("Deadlines: reopening a form by hand clears a time that has passed, so answers change again", st == 200 and rows and rows[0]["closes_at"] is None and st2 == 200, f"{st} {rows} {st2}")
    st, rows = call("GET", f"/audit?space_id=eq.{SID['festival']}&table_name=eq.polls&select=old_row", pat)
    st2, rows2 = call("GET", f"/audit?space_id=eq.{SID['organizers']}&table_name=in.(polls,forms)&select=op", pat)
    check("Deadlines: closing time changes are in the audit log, for members of the space only",
          any((r["old_row"] or {}).get("closes_at") for r in rows or []) and rows2 == [], f"{len(rows or [])} {rows2}")

    # Moves and deletes follow the space.
    call("PATCH", f"/polls?id=eq.{org}", olive, {"closes_at": T1})
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/polls?id=eq.{org}&select=closes_at", pat)
    check("Deadlines: a poll moved into #festival shows Pat its closing time", st == 200 and rows and rows[0]["closes_at"], f"{st} {rows}")
    st, _ = call("PATCH", f"/items?id=eq.{form}", olive, {"space_id": SID["organizers"]})
    st2, rows = call("GET", f"/forms?id=eq.{form}&select=closes_at", pat)
    st3, rows3 = call("PATCH", f"/forms?id=eq.{form}", olive, {"closes_at": T1})
    check("Deadlines: a form moved to Organizers hides it from Pat; Olive still sets it", st == 200 and rows == [] and st3 == 200 and rows3, f"{st} {rows} {st3}")
    for i in (org, fest, form, orgform):
        call("DELETE", f"/items?id=eq.{i}", olive)
    check("Deadlines: deleting removes the polls, forms and their closing times",
          oq(f"select (select count(*) from weft.polls where id in ('{org}', '{fest}')) + (select count(*) from weft.forms where id in ('{form}', '{orgform}'))") == "0")


def key_results_from_tasks():
    """059: a key result can count done tasks out of all tasks in a task list in the goal set's own space. Members
    see the link, editors set and clear it (the 041 rules); the numbers are kept by the database from the tasks;
    moves and deletes clear the link, and a moved set's clean-up is recorded under the space it left."""
    pat, vic, olive = mint("u-pub"), mint("u-vol"), mint("u-org")
    O, P = uid("user", "u-org"), uid("user", "u-pub")
    oq = lambda sql: owner_sql(sql)
    mk = lambda space, kind, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/items", olive, {"space_id": SID[space], "kind": kind, "title": title}))
    task = lambda lst, title, **kw: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/tasks", olive, {"list_id": lst, "title": title, **kw}))
    kr = lambda i: (lambda r: r[0] if r else {})(json.loads(oq(f"select coalesce(json_agg(k), '[]') from weft.key_results k where id = '{i}'") or "[]"))
    nums = lambda i: (lambda k: (k.get("tasklist_id"), float(k.get("current_value", -1)), float(k.get("target_value", -1)), float(k.get("start_value", -1)), k.get("unit")))(kr(i))
    fest, org = mk("festival", "goalset", "KRT festival goals"), mk("organizers", "goalset", "KRT-SECRET org goals")
    fl, ol, vl = mk("festival", "tasklist", "KRT festival prep"), mk("organizers", "tasklist", "KRT-SECRET org list"), mk("volunteers", "tasklist", "KRT volunteer list")
    empty, doc = mk("festival", "tasklist", "KRT empty list"), mk("festival", "document", "KRT a document")
    st, rows = call("POST", "/goals", olive, {"set_id": fest, "title": "Get the festival ready"})
    fg = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/goals", olive, {"set_id": org, "title": "KRT-SECRET org goal"})
    og = rows[0]["id"] if st == 201 else None
    check("KR from tasks: Olive makes goal sets, goals and task lists in #festival and Organizers", all((fest, org, fl, ol, vl, empty, doc, fg, og)))
    t1, t2 = task(fl, "Book the stage", done=True), task(fl, "Print the posters")
    t3 = task(fl, "Hang the bunting", assignee_id=P)
    task(ol, "KRT-SECRET contract", done=True)

    # Linking: editors yes; the numbers come from the list, whatever the client sends.
    st, rows = call("POST", "/key_results", olive, {"goal_id": fg, "title": "Prep tasks done", "tasklist_id": fl, "start_value": 5, "target_value": 99, "current_value": 50, "unit": "x"})
    fk = rows[0]["id"] if st == 201 else None
    check("KR from tasks: Olive links a key result to a #festival task list (positive control); 1 of 3 done, from 0, unit tasks, numbers sent are ignored",
          fk and rows[0]["tasklist_id"] == fl and float(rows[0]["current_value"]) == 1 and float(rows[0]["target_value"]) == 3
          and float(rows[0]["start_value"]) == 0 and rows[0]["unit"] == "tasks" and abs(float(rows[0]["progress"]) - 1 / 3) < 1e-9 and rows[0]["value_updated_by"] == O, f"{st} {rows}")
    st, rows = call("GET", f"/key_results?id=eq.{fk}&select=tasklist_id,list:items!key_results_tasklist_id_fkey(title)", pat)
    check("KR from tasks: Pat (viewer) reads the link and the list's name (positive control)", st == 200 and rows and rows[0]["tasklist_id"] == fl and rows[0]["list"]["title"] == "KRT festival prep", f"{st} {rows}")
    for target, why in ((ol, "a task list in another space (Organizers)"), (vl, "a task list in Volunteers"), (doc, "an item that is not a task list"), (uid("item", "no-such-list"), "an id that is nothing")):
        st, rows = call("POST", "/key_results", olive, {"goal_id": fg, "title": "bad link", "tasklist_id": target})
        check(f"KR from tasks: linking to {why} is refused", st == 400 and "same space" in json.dumps(rows), f"{st} {rows}")
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"tasklist_id": ol})
    check("KR from tasks: nor can an existing link be pointed at an Organizers list", st == 400 and nums(fk)[0] == fl, f"{st} {rows}")
    st, rows = call("POST", "/key_results", olive, {"goal_id": og, "title": "KRT-SECRET signed", "tasklist_id": ol})
    ok_ = rows[0]["id"] if st == 201 else None
    check("KR from tasks: Olive links an Organizers key result to an Organizers list (positive control)", ok_ and nums(ok_)[1:3] == (1.0, 1.0), f"{st} {rows}")

    # Viewers, outsiders, scope and the assistant.
    st, rows = call("POST", "/key_results", pat, {"goal_id": fg, "title": "pwned", "tasklist_id": fl})
    st2, rows2 = call("PATCH", f"/key_results?id=eq.{fk}", pat, {"tasklist_id": None})
    st3, rows3 = call("PATCH", f"/key_results?id=eq.{fk}", vic, {"tasklist_id": empty})
    check("KR from tasks: Pat and Vic (viewers in #festival) cannot add, clear or change a link", refused(st) and rows2 == [] and rows3 == [] and nums(fk)[0] == fl, f"{st} {st2} {st3}")
    st, rows = call("GET", f"/key_results?tasklist_id=eq.{ol}&select=id", pat)
    st2, rows2 = call("GET", "/key_results?tasklist_id=not.is.null&select=id", vic)
    check("KR from tasks: Pat and Vic find no Organizers key result by filtering on its list", st == 200 and rows == [] and ok_ not in [r["id"] for r in rows2 or []], f"{rows} {rows2}")
    st, rows = call("POST", "/key_results", pat, {"goal_id": og, "title": "x", "tasklist_id": ol})
    check("KR from tasks: Pat cannot link in Organizers either, and is not told why beyond no", refused(st) and "same space" not in json.dumps(rows), f"{st} {rows}")
    scoped = mint("u-org", scope="festival")
    st, rows = call("PATCH", f"/key_results?id=eq.{ok_}", scoped, {"tasklist_id": None})
    st2, rows2 = call("GET", f"/key_results?id=in.({fk},{ok_})&select=id", scoped)
    check("KR from tasks: a #festival-scoped token neither sees nor clears the Organizers link", rows == [] and nums(ok_)[0] == ol
          and st2 == 200 and [r["id"] for r in rows2] == [fk], f"{st} {rows} {rows2}")
    helper = mint("u-org", assistant=True)
    st, rows = call("GET", f"/key_results?id=eq.{ok_}&select=tasklist_id", helper)
    st2, _ = call("PATCH", f"/key_results?id=eq.{ok_}", helper, {"tasklist_id": None})
    st3, _ = call("DELETE", f"/key_results?id=eq.{ok_}", helper)
    check("KR from tasks: the assistant reads a link but cannot clear it or delete", st == 200 and rows and rows[0]["tasklist_id"] == ol
          and refused(st2) and refused(st3) and nums(ok_)[0] == ol, f"{st} {st2} {st3}")
    st, _ = call("POST", "/key_results", olive, {"goal_id": fg, "title": "forged", "tasklist_id": fl, "created_by": P})
    st2, _ = call("POST", "/key_results", olive, {"goal_id": fg, "title": "forged", "tasklist_id": fl, "value_updated_by": P})
    check("KR from tasks: authorship and the value stamp of a linked key result cannot be forged", refused(st) and refused(st2), f"{st} {st2}")

    # The numbers follow the tasks, stamped by whoever changed them.
    call("PATCH", f"/tasks?id=eq.{t2}", olive, {"done": True})
    k = kr(fk)
    check("KR from tasks: Olive ticks off a task; the key result is 2 of 3 at once, stamped by her", nums(fk)[1:3] == (2.0, 3.0) and k["value_updated_by"] == O, str(k))
    st, rows = call("PATCH", f"/tasks?id=eq.{t3}", pat, {"done": True})
    k = kr(fk)
    check("KR from tasks: Pat (a viewer) ticks off the task assigned to Pat; 3 of 3 = 100%, stamped by Pat", st == 200 and rows and nums(fk)[1:3] == (3.0, 3.0)
          and float(k["progress"]) == 1 and k["value_updated_by"] == P, f"{st} {k}")
    t4 = task(fl, "Sweep up")
    check("KR from tasks: a new task counts at once (3 of 4)", nums(fk)[1:3] == (3.0, 4.0), str(nums(fk)))
    call("PATCH", f"/tasks?id=eq.{t1}", olive, {"done": False})
    call("DELETE", f"/tasks?id=eq.{t4}", olive)
    check("KR from tasks: reopening and deleting tasks count too (2 of 3)", nums(fk)[1:3] == (2.0, 3.0), str(nums(fk)))
    call("PATCH", f"/tasks?id=eq.{t1}", olive, {"title": "Book the main stage"})
    st, rows = call("GET", f"/audit?row_id=eq.{fk}&select=op", olive)
    n_audit = len(rows or [])
    call("PATCH", f"/tasks?id=eq.{t1}", olive, {"title": "Book the stage"})
    st, rows = call("GET", f"/audit?row_id=eq.{fk}&select=op", olive)
    check("KR from tasks: renaming a task does not touch the key result", len(rows or []) == n_audit and nums(fk)[1:3] == (2.0, 3.0), f"{n_audit} {len(rows or [])}")
    st, rows = call("PATCH", f"/key_results?id=eq.{fk}", olive, {"current_value": 40, "target_value": 50})
    check("KR from tasks: typing numbers into a linked key result changes nothing (they come from the list)", st == 200 and nums(fk)[1:3] == (2.0, 3.0), f"{st} {rows}")
    body = oq(f"select body_text from weft.items where id = '{fest}'") or ""
    check("KR from tasks: the set's summary reads the counted numbers", "- Prep tasks done: 2 of 3 tasks (from 0), 67%" in body, body)

    # An empty list, unlinking, and the typed rule still in force.
    st, rows = call("POST", "/key_results", olive, {"goal_id": fg, "title": "Empty", "tasklist_id": empty})
    ek = rows[0]["id"] if st == 201 else None
    check("KR from tasks: a key result can follow an empty list: 0 of 0 is 0%", ek and float(rows[0]["target_value"]) == 0 and float(rows[0]["progress"]) == 0, f"{st} {rows}")
    st, rows = call("PATCH", f"/key_results?id=eq.{ek}", olive, {"tasklist_id": None})
    check("KR from tasks: unlinking an empty one leaves a valid typed key result (0 of 1)", st == 200 and rows and rows[0]["tasklist_id"] is None
          and float(rows[0]["target_value"]) == 1 and float(rows[0]["current_value"]) == 0, f"{st} {rows}")
    st, _ = call("POST", "/key_results", olive, {"goal_id": fg, "title": "typed", "target_value": 0})
    check("KR from tasks: a typed key result with target equal to start is still refused", st == 400, str(st))
    st, rows = call("PATCH", f"/key_results?id=eq.{ek}", olive, {"current_value": 1})
    check("KR from tasks: once unlinked, its value is updated by hand again (positive control)", st == 200 and rows and float(rows[0]["progress"]) == 1, f"{st} {rows}")

    # Deleting the list clears the link and keeps the last numbers.
    st, rows = call("POST", "/key_results", olive, {"goal_id": fg, "title": "Prep again", "tasklist_id": fl})
    fk2 = rows[0]["id"] if st == 201 else None
    tmp = mk("festival", "tasklist", "KRT short-lived list")
    task(tmp, "a", done=True); task(tmp, "b")
    call("PATCH", f"/key_results?id=eq.{fk2}", olive, {"tasklist_id": tmp})
    check("KR from tasks: Olive points a link at another #festival list (positive control)", nums(fk2)[:3] == (tmp, 1.0, 2.0), str(nums(fk2)))
    st, _ = call("DELETE", f"/items?id=eq.{tmp}", olive)
    check("KR from tasks: deleting the list clears the link and keeps 1 of 2", st in (200, 204) and nums(fk2)[:3] == (None, 1.0, 2.0), str(nums(fk2)))

    # Moves follow the space.
    call("PATCH", f"/key_results?id=eq.{fk2}", olive, {"tasklist_id": fl})
    st, _ = call("PATCH", f"/items?id=eq.{fl}", olive, {"space_id": SID["volunteers"]})
    st2, rows = call("GET", f"/key_results?id=in.({fk},{fk2})&select=tasklist_id,current_value", pat)
    check("KR from tasks: a task list moved to Volunteers stops counting for #festival goals; Pat sees the links gone, the numbers kept",
          st == 200 and len(rows) == 2 and all(r["tasklist_id"] is None and float(r["current_value"]) == 2 for r in rows), f"{st} {rows}")
    t5 = call("POST", "/tasks", olive, {"list_id": fl, "title": "after the move", "done": True})
    check("KR from tasks: and tasks added to it there no longer move them", nums(fk)[1:3] == (2.0, 3.0), str(nums(fk)))
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/key_results?id=eq.{ok_}&select=tasklist_id,current_value,target_value", pat)
    check("KR from tasks: an Organizers set moved into #festival loses its link to the Organizers list; Pat sees the key result unlinked",
          st == 200 and rows and rows[0]["tasklist_id"] is None and nums(ok_)[0] is None, f"{st} {rows}")
    st, rows = call("GET", "/audit?table_name=eq.key_results&select=row_id,space_id,old_row", pat)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{ok_}&select=space_id,old_row", olive)
    st3, rows3 = call("GET", f"/items?id=eq.{ol}&select=id", pat)
    check("KR from tasks: Pat finds no trace of the Organizers list, not in the audit log nor by id", st == 200 and ol not in json.dumps(rows) and ok_ not in [r["row_id"] for r in rows]
          and rows3 == [], f"{[r['row_id'] for r in rows or []]}")
    check("KR from tasks: the clean-up is in the audit log under Organizers, for Olive (positive control)",
          any(r["space_id"] == SID["organizers"] and (r["old_row"] or {}).get("tasklist_id") == ol for r in rows2 or []), str(rows2))
    for i in (fest, org, fl, ol, vl, empty, doc):
        call("DELETE", f"/items?id=eq.{i}", olive)
    check("KR from tasks: deleting the sets removes their key results", oq(f"select count(*) from weft.key_results where id in ('{fk}', '{fk2}', '{ok_}', '{ek}')") == "0")


def idea_next_steps():
    """060: an owner adds a planned idea as a task to a list in the board's own space (weft.idea_to_task), and gives a
    short reason when declining one. Members read both; only owners set them; moves and deletes clear the link, and a
    moved board's clean-up is recorded under the space it left."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    A = uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    mk = lambda space, kind, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/items", olive, {"space_id": SID[space], "kind": kind, "title": title}))
    idea = lambda board, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/ideas", olive, {"board_id": board, "title": title}))
    task = lambda lst, title: (lambda r: r[1][0]["id"] if r[0] == 201 else None)(call("POST", "/tasks", olive, {"list_id": lst, "title": title}))
    col = lambda i, c: oq(f"select coalesce({c}::text, '-') from weft.ideas where id = '{i}'")
    ntasks = lambda title: oq(f"select count(*) from weft.tasks where title = '{title}'")
    to_task = lambda tok, i, lst: call("POST", "/rpc/idea_to_task", tok, {"p_idea": i, "p_list": lst})
    fest, org = mk("festival", "ideaboard", "NSI festival ideas"), mk("organizers", "ideaboard", "NSI-SECRET org ideas")
    fl, ol, vl = mk("festival", "tasklist", "NSI festival prep"), mk("organizers", "tasklist", "NSI-SECRET org list"), mk("volunteers", "tasklist", "NSI volunteer list")
    doc = mk("festival", "document", "NSI a document")
    f1, f2, f3 = idea(fest, "NSI water refill point"), idea(fest, "NSI fireworks"), idea(fest, "NSI bike racks")
    o1, o2 = idea(org, "NSI-SECRET raise prices"), idea(org, "NSI-SECRET new sponsor")
    check("Next steps: Olive makes boards, ideas, task lists in #festival, Organizers and Volunteers", all((fest, org, fl, ol, vl, doc, f1, f2, f3, o1, o2)))
    for i in (f1, f3, o2):
        call("PATCH", f"/ideas?id=eq.{i}", alex, {"status": "planned"})

    # A planned idea becomes a task: owners, a list in the same space, once.
    st, row = to_task(alex, f1, fl)
    t1 = row.get("id") if st == 200 and isinstance(row, dict) else None
    check("Next steps: Alex (owner) adds a planned idea as a task to a #festival list (positive control): titled like the idea, made by Alex, linked",
          t1 and row["title"] == "NSI water refill point" and row["list_id"] == fl and row["created_by"] == A and not row["done"] and col(f1, "task_id") == t1, f"{st} {row}")
    st, rows = call("GET", f"/ideas?id=eq.{f1}&select=task_id,task:tasks!ideas_task_id_fkey(title,done,list:items!tasks_list_id_fkey(title))", pat)
    check("Next steps: Pat (viewer) sees the idea's task and its list (positive control)", st == 200 and rows and rows[0]["task_id"] == t1
          and rows[0]["task"]["list"]["title"] == "NSI festival prep", f"{st} {rows}")
    st, rows = to_task(alex, f1, fl)
    check("Next steps: an idea becomes a task only once", st == 400 and "already a task" in json.dumps(rows) and ntasks("NSI water refill point") == "1", f"{st} {rows}")
    st, rows = to_task(alex, f2, fl)
    check("Next steps: a new (not planned) idea does not become a task", st == 400 and "planned" in json.dumps(rows) and ntasks("NSI fireworks") == "0", f"{st} {rows}")
    for target, why in ((ol, "an Organizers list"), (vl, "a Volunteers list"), (doc, "a document"), (uid("item", "no-such-list"), "nothing")):
        st, rows = to_task(alex, f3, target)
        check(f"Next steps: a #festival idea cannot become a task in {why}", st == 400 and "same space" in json.dumps(rows) and ntasks("NSI bike racks") == "0", f"{st} {rows}")
    st, rows = to_task(olive, f3, fl)
    check("Next steps: Olive (editor) cannot add an idea as a task, is told why, and no stray task is left", st == 403 and "owner of the space" in json.dumps(rows)
          and ntasks("NSI bike racks") == "0" and col(f3, "task_id") == "-", f"{st} {rows}")
    st, rows = to_task(pat, f3, fl)
    st2, rows2 = to_task(vic, f3, fl)
    check("Next steps: Pat and Vic (viewers) cannot either, and no task is made", refused(st) and refused(st2) and ntasks("NSI bike racks") == "0", f"{st} {st2}")
    st, rows = to_task(pat, o2, ol)
    check("Next steps: Pat cannot add an Organizers idea, and is told only that it is not there", refused(st) and "no such idea" in json.dumps(rows)
          and col(o2, "task_id") == "-" and ntasks("NSI-SECRET new sponsor") == "0", f"{st} {rows}")
    scoped = mint("u-alex", scope="festival")
    st, rows = to_task(scoped, o2, ol)
    check("Next steps: a #festival-scoped token of Alex's cannot add an Organizers idea", refused(st) and col(o2, "task_id") == "-", f"{st} {rows}")
    helper = mint("u-alex", assistant=True)
    st, rows = call("GET", f"/ideas?id=eq.{f1}&select=task_id,decline_reason", helper)
    st2, _ = to_task(helper, f3, fl)
    st3, _ = call("PATCH", f"/ideas?id=eq.{f1}", helper, {"task_id": None})
    st4, _ = call("DELETE", f"/ideas?id=eq.{f1}", helper)
    check("Next steps: the assistant reads the link (positive control) but cannot add, clear or delete", st == 200 and rows and rows[0]["task_id"] == t1
          and refused(st2) and refused(st3) and refused(st4) and col(f1, "task_id") == t1, f"{st} {st2} {st3} {st4}")

    # Linking directly: owners, a planned idea, a task in the same space.
    t3 = task(fl, "NSI existing task")
    otask = task(ol, "NSI-SECRET org task")
    st, rows = call("PATCH", f"/ideas?id=eq.{f3}", olive, {"task_id": t3})
    st2, rows2 = call("PATCH", f"/ideas?id=eq.{f3}", pat, {"task_id": t3})
    check("Next steps: Olive (told why) and Pat cannot link an idea to a task", st == 403 and "owner of the space" in json.dumps(rows) and rows2 == [] and col(f3, "task_id") == "-", f"{st} {st2} {rows2}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f3}", alex, {"task_id": otask})
    check("Next steps: an owner cannot link a #festival idea to an Organizers task", st == 400 and "same space" in json.dumps(rows) and col(f3, "task_id") == "-", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f2}", alex, {"task_id": t3})
    check("Next steps: nor link an idea that is not planned", st == 400 and col(f2, "task_id") == "-", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f3}", alex, {"task_id": t3})
    st2, rows2 = call("PATCH", f"/ideas?id=eq.{f3}", alex, {"task_id": None})
    check("Next steps: an owner links a planned idea to an existing #festival task and unlinks it (positive control)",
          st == 200 and rows and rows[0]["task_id"] == t3 and st2 == 200 and rows2 and rows2[0]["task_id"] is None, f"{st} {st2}")
    st, _ = call("POST", "/ideas", olive, {"board_id": fest, "title": "NSI forged link", "task_id": t3})
    st2, _ = call("POST", "/ideas", olive, {"board_id": fest, "title": "NSI forged reason", "decline_reason": "x"})
    check("Next steps: a new idea cannot come with a task or a reason", refused(st) and refused(st2) and ntasks("NSI forged link") == "0"
          and oq("select count(*) from weft.ideas where title like 'NSI forged%'") == "0", f"{st} {st2}")

    # Declining with a reason: owners only, only on a declined idea, shown to members.
    st, rows = call("PATCH", f"/ideas?id=eq.{f2}", alex, {"status": "declined", "decline_reason": "  Too   costly\n this year "})
    check("Next steps: Alex declines an idea with a reason, kept on one line (positive control)", st == 200 and rows and rows[0]["decline_reason"] == "Too costly this year", f"{st} {rows}")
    st, rows = call("GET", f"/ideas?id=eq.{f2}&select=decline_reason", pat)
    check("Next steps: Pat reads the reason (positive control)", st == 200 and rows and rows[0]["decline_reason"] == "Too costly this year", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f2}", olive, {"decline_reason": "rewritten by Olive"})
    st2, rows2 = call("PATCH", f"/ideas?id=eq.{f2}", pat, {"decline_reason": "pwned"})
    check("Next steps: Olive (told why) and Pat cannot change the reason", st == 403 and "owner of the space" in json.dumps(rows) and rows2 == []
          and col(f2, "decline_reason") == "Too costly this year", f"{st} {rows} {st2}")
    st, rows = call("PATCH", f"/ideas?id=eq.{f3}", alex, {"decline_reason": "not declined"})
    check("Next steps: a reason cannot be given for an idea that is not declined", st == 400 and "declined idea" in json.dumps(rows) and col(f3, "decline_reason") == "", f"{st} {rows}")
    st, _ = call("PATCH", f"/ideas?id=eq.{f2}", alex, {"decline_reason": "x" * 301})
    check("Next steps: a reason over 300 characters is refused", st == 400 and col(f2, "decline_reason") == "Too costly this year", str(st))
    st, rows = call("PATCH", f"/ideas?id=eq.{f2}", alex, {"decline_reason": "The fire service said no"})
    check("Next steps: an owner changes the reason (positive control)", st == 200 and rows and rows[0]["decline_reason"] == "The fire service said no", f"{st} {rows}")
    st, rows = call("PATCH", f"/ideas?id=eq.{o1}", alex, {"status": "declined", "decline_reason": "NSI-REASON-SECRET budget"})
    check("Next steps: Alex declines an Organizers idea with a reason (positive control)", st == 200 and rows and rows[0]["decline_reason"] == "NSI-REASON-SECRET budget", f"{st} {rows}")
    st, rows = call("GET", "/ideas?decline_reason=like.*NSI-REASON*&select=id", pat)
    st2, rows2 = call("GET", "/ideas?decline_reason=like.*NSI-REASON*&select=id", vic)
    check("Next steps: Pat and Vic cannot find the Organizers reason by filtering", st == 200 and rows == [] and st2 == 200 and rows2 == [], f"{rows} {rows2}")
    st, rows = call("POST", "/rpc/search", olive, {"p_q": "NSI-REASON-SECRET"})
    st2, rows2 = call("POST", "/rpc/search", pat, {"p_q": "NSI-REASON-SECRET"})
    check("Next steps: search finds the board by its reason for Olive, not for Pat", any(r["id"] == org for r in rows or []) and rows2 == [], f"{rows} {rows2}")
    st, rows = call("PATCH", f"/ideas?id=eq.{o1}", scoped, {"decline_reason": "scoped"})
    check("Next steps: the #festival-scoped token cannot change an Organizers reason", rows == [] and col(o1, "decline_reason") == "NSI-REASON-SECRET budget", f"{st} {rows}")

    # The board's text, and the task's state following it.
    body = oq(f"select body_text from weft.items where id = '{fest}'") or ""
    check("Next steps: the board's text names the open task and the reason", "Idea: NSI water refill point (planned, 0 votes, suggested by Olive Organizer, task open)" in body
          and "Declined because: The fire service said no" in body, body)
    st, _ = call("PATCH", f"/tasks?id=eq.{t1}", olive, {"done": True})
    body = oq(f"select body_text from weft.items where id = '{fest}'") or ""
    check("Next steps: ticking off the task updates the board's text (task done)", st == 200 and "suggested by Olive Organizer, task done)" in body, body)
    st, rows = call("PATCH", f"/ideas?id=eq.{f2}", alex, {"status": "new"})
    body = oq(f"select body_text from weft.items where id = '{fest}'") or ""
    check("Next steps: an idea taken out of Declined loses its reason", st == 200 and rows and rows[0]["decline_reason"] == "" and "fire service" not in body, f"{st} {rows}")

    # Deletes and moves follow the space.
    st, _ = call("DELETE", f"/tasks?id=eq.{t1}", olive)
    check("Next steps: deleting the task clears the link (the idea stays)", st in (200, 204) and col(f1, "task_id") == "-" and col(f1, "status") == "planned", str(st))
    st, row = to_task(alex, o2, ol)
    ot = row.get("id") if st == 200 and isinstance(row, dict) else None
    check("Next steps: Alex adds an Organizers idea as a task in an Organizers list (positive control)", ot and col(o2, "task_id") == ot, f"{st} {row}")
    st, _ = call("PATCH", f"/items?id=eq.{org}", olive, {"space_id": SID["festival"]})
    st2, rows = call("GET", f"/ideas?id=eq.{o2}&select=task_id", pat)
    check("Next steps: an Organizers board moved into #festival loses its link to the Organizers task; Pat sees the idea unlinked",
          st == 200 and rows and rows[0]["task_id"] is None and col(o2, "task_id") == "-", f"{st} {rows}")
    st, rows = call("GET", "/audit?table_name=eq.ideas&select=row_id,space_id,old_row", pat)
    st2, rows2 = call("GET", f"/audit?row_id=eq.{o2}&select=space_id,old_row", olive)
    st3, rows3 = call("GET", f"/tasks?id=eq.{ot}&select=id", pat)
    check("Next steps: Pat finds no trace of the Organizers task, not in the audit log nor by id", st == 200 and ot not in json.dumps(rows) and rows3 == [], f"{st} {st3}")
    check("Next steps: the clean-up is in the audit log under Organizers, for Olive (positive control)",
          any(r["space_id"] == SID["organizers"] and (r["old_row"] or {}).get("task_id") == ot for r in rows2 or []), str(rows2))
    st, row = to_task(alex, f3, fl)
    ft = row.get("id") if st == 200 and isinstance(row, dict) else None
    st2, _ = call("PATCH", f"/items?id=eq.{fl}", olive, {"space_id": SID["volunteers"]})
    check("Next steps: a task list moved to Volunteers stops being the task of #festival ideas (the task stays in the list)",
          ft and st2 == 200 and col(f3, "task_id") == "-" and oq(f"select count(*) from weft.tasks where id = '{ft}'") == "1", f"{st} {st2}")
    for i in (fest, org, fl, ol, vl, doc):
        call("DELETE", f"/items?id=eq.{i}", olive)
    check("Next steps: deleting the boards removes their ideas", oq(f"select count(*) from weft.ideas where id in ('{f1}', '{f2}', '{f3}', '{o1}', '{o2}')") == "0")


def seen_by():
    """Seen by on announcements: a "Got it" button; each member reads their own, editors and owners read all."""
    pat, vic, olive, alex = mint("u-pub"), mint("u-vol"), mint("u-org"), mint("u-alex")
    P, V, O, A = uid("user", "u-pub"), uid("user", "u-vol"), uid("user", "u-org"), uid("user", "u-alex")
    oq = lambda sql: owner_sql(sql)
    soon = oq("select to_char(now() + interval '3 days', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')")
    acks = lambda a: oq(f"select count(*) from weft.announcement_acks where announcement_id = '{a}'")
    st, rows = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "Wear your badge", "expires_at": soon, "ask_ack": True})
    fest = rows[0]["id"] if st == 201 else None
    check("Seen by: Olive (editor) posts a #festival notice that asks for Got it (positive control)", fest and rows[0]["ask_ack"] is True, f"{st} {rows}")
    st, rows = call("POST", "/announcements", olive, {"space_id": SID["organizers"], "title": "ACK-ORG-SECRET budget", "expires_at": soon, "ask_ack": True})
    org = rows[0]["id"] if st == 201 else None
    st, rows = call("POST", "/announcements", olive, {"space_id": SID["festival"], "title": "Just so you know", "expires_at": soon})
    plain = rows[0]["id"] if st == 201 else None
    check("Seen by: a notice does not ask for Got it unless the poster says so", plain and rows[0]["ask_ack"] is False, f"{st} {rows}")
    # Pressing it: every member, viewers included; only your own; only in your channels.
    st, rows = call("POST", "/announcement_acks", pat, {"announcement_id": fest})
    check("Seen by: Pat (viewer) presses Got it in #festival (positive control), recorded as Pat by the database",
          st == 201 and rows and rows[0]["user_id"] == P, f"{st} {rows}")
    st, _ = call("POST", "/announcement_acks", vic, {"announcement_id": fest})
    call("POST", "/announcement_acks", olive, {"announcement_id": org})
    check("Seen by: Vic (viewer) presses it too", st == 201, str(st))
    st, _ = call("POST", "/announcement_acks", pat, {"announcement_id": fest})
    check("Seen by: pressing twice adds nothing", st == 409 and acks(fest) == "2", str(st))
    st, _ = call("POST", "/announcement_acks", pat, {"announcement_id": org})
    st2, _ = call("POST", "/announcement_acks", vic, {"announcement_id": org})
    check("Seen by: Pat and Vic cannot press Got it on an Organizers notice", refused(st) and refused(st2) and acks(org) == "1", f"{st} {st2}")
    st, _ = call("POST", "/announcement_acks", olive, {"announcement_id": fest, "user_id": A})
    st2, _ = call("POST", "/announcement_acks", olive, {"announcement_id": fest, "created_at": "2020-01-01T00:00:00Z"})
    check("Seen by: Olive cannot press it as Alex, nor set the time (authorship cannot be forged)", refused(st) and refused(st2) and acks(fest) == "2", f"{st} {st2}")
    st, _ = call("PATCH", f"/announcement_acks?announcement_id=eq.{fest}&user_id=eq.{P}", pat, {"announcement_id": plain})
    check("Seen by: a Got it cannot be changed or moved to another notice", refused(st), str(st))
    # Reading: your own; editors and owners read everyone's.
    for who, tok, me in (("Pat", pat, P), ("Vic", vic, V)):
        st, rows = call("GET", f"/announcement_acks?announcement_id=eq.{fest}&select=user_id", tok)
        check(f"Seen by: {who} (viewer) reads only their own Got it", st == 200 and [r["user_id"] for r in rows] == [me], f"{st} {rows}")
    for who, tok in (("Olive (editor)", olive), ("Alex (owner)", alex)):
        st, rows = call("GET", f"/announcement_acks?announcement_id=eq.{fest}&select=user_id", tok)
        check(f"Seen by: {who} reads who pressed it in #festival (positive control)", st == 200 and {r["user_id"] for r in rows} == {P, V}, f"{st} {rows}")
    st, rows = call("GET", f"/announcement_acks?announcement_id=eq.{org}&select=user_id", pat)
    st2, rows2 = call("GET", "/announcement_acks?select=announcement_id", vic)
    check("Seen by: Pat and Vic read nothing about the Organizers notice", st == 200 and rows == [] and st2 == 200 and {r["announcement_id"] for r in rows2} <= {fest}, f"{rows} {rows2}")
    st, rows = call("GET", f"/announcements?id=eq.{fest}&select=id,acks:announcement_acks(user_id)", pat)
    check("Seen by: embedded in the notice, Pat still sees only her own", st == 200 and rows and [r["user_id"] for r in rows[0]["acks"]] == [P], str(rows))
    # Only on notices that ask, and only while showing.
    st, body = call("POST", "/announcement_acks", pat, {"announcement_id": plain})
    check("Seen by: a notice that does not ask cannot be pressed", st == 400 and "Got it" in json.dumps(body), f"{st} {body}")
    # Who may ask: editors and owners, not viewers.
    st, rows = call("PATCH", f"/announcements?id=eq.{plain}", pat, {"ask_ack": True})
    check("Seen by: Pat (viewer) cannot make a notice ask for Got it", rows == [] and oq(f"select ask_ack from weft.announcements where id = '{plain}'") == "f", f"{st} {rows}")
    st, rows = call("PATCH", f"/announcements?id=eq.{plain}", olive, {"ask_ack": True})
    check("Seen by: Olive (editor) turns it on afterwards (positive control)", st == 200 and rows and rows[0]["ask_ack"] is True, f"{st} {rows}")
    call("PATCH", f"/announcements?id=eq.{plain}", olive, {"expires_at": oq("select to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI:SS.USOF')")})
    st, body = call("POST", "/announcement_acks", pat, {"announcement_id": plain})
    check("Seen by: an ended notice cannot be pressed", st == 400 and "ended" in json.dumps(body), f"{st} {body}")
    # Taking it back: only your own.
    st, rows = call("DELETE", f"/announcement_acks?announcement_id=eq.{fest}&user_id=eq.{V}", pat)
    st2, rows2 = call("DELETE", f"/announcement_acks?announcement_id=eq.{org}", vic)
    check("Seen by: Pat cannot take back Vic's Got it, Vic cannot remove Olive's in Organizers", rows == [] and rows2 == [] and acks(fest) == "2" and acks(org) == "1", f"{st} {st2}")
    st, rows = call("DELETE", f"/announcement_acks?announcement_id=eq.{fest}&user_id=eq.{P}", pat)
    check("Seen by: Pat takes back her own (positive control)", st == 200 and len(rows) == 1 and acks(fest) == "1", f"{st} {rows}")
    # Channel scope and the assistant.
    scoped = mint("u-org", scope="festival")
    st, rows = call("GET", "/announcement_acks?select=announcement_id", scoped)
    check("Seen by: a #festival-scoped token reads only #festival Got its", st == 200 and rows and {r["announcement_id"] for r in rows} <= {fest, plain}, str(rows))
    st, _ = call("POST", "/announcement_acks", mint("u-alex", scope="festival"), {"announcement_id": org})
    check("Seen by: nor presses one in Organizers", refused(st), str(st))
    helper = mint("u-org", assistant=True)
    st, _ = call("GET", f"/announcement_acks?announcement_id=eq.{fest}", helper)
    st2, _ = call("DELETE", f"/announcement_acks?announcement_id=eq.{fest}", helper)
    st3, _ = call("POST", "/announcement_acks", helper, {"announcement_id": fest})
    check("Seen by: the assistant cannot read, delete or press Got its", refused(st) and refused(st2) and refused(st3) and acks(fest) == "1", f"{st} {st2} {st3}")
    # Nothing in the audit log (every member can read it); notices carry no names.
    check("Seen by: no audit rows name who pressed", oq("select count(*) from weft.audit where table_name = 'announcement_acks'") == "0")
    # Following the space: leaving the channel, deleting the notice, deleting the channel.
    st, ch = call("POST", "/rpc/create_channel", olive, {"p_name": "ack test"})
    call("POST", "/members", olive, {"space_id": ch, "user_id": P, "role": "viewer"}, prefer="return=minimal")
    st, rows = call("POST", "/announcements", olive, {"space_id": ch, "title": "Read me", "expires_at": soon, "ask_ack": True})
    cn = rows[0]["id"] if st == 201 else None
    st, _ = call("POST", "/announcement_acks", pat, {"announcement_id": cn})
    check("Seen by: added as a viewer, Pat presses Got it there (positive control)", st == 201, str(st))
    call("DELETE", f"/members?space_id=eq.{ch}&user_id=eq.{P}", olive)
    st, _ = call("POST", "/announcement_acks", pat, {"announcement_id": cn})
    check("Seen by: removed from the channel, her Got it is gone and she cannot press again", acks(cn) == "0" and refused(st), str(st))
    call("POST", "/announcement_acks", olive, {"announcement_id": cn})
    call("DELETE", f"/spaces?id=eq.{ch}", olive)
    check("Seen by: deleting the channel deletes its notices' Got its", acks(cn) == "0" and oq(f"select count(*) from weft.announcements where id = '{cn}'") == "0")
    st, _ = call("DELETE", f"/announcements?id=eq.{fest}", olive)
    check("Seen by: deleting a notice deletes its Got its", st in (200, 204) and acks(fest) == "0", str(st))
    for a in (org, plain):
        call("DELETE", f"/announcements?id=eq.{a}", olive)


def teeth():
    """Loosen one policy on purpose and confirm the suite would catch it, then restore it."""
    owner_sql("create policy teeth_leak on weft.items for select to weft_user using (true)")
    try:
        st, rows = call("GET", "/items?title=eq.Host%20contacts", mint("u-pub"))
        caught = st == 200 and len(rows) == 1
    finally:
        owner_sql("drop policy teeth_leak on weft.items")
    st, rows = call("GET", "/items?title=eq.Host%20contacts", mint("u-pub"))
    check("Teeth: a loosened policy makes Pat's Host contacts check fail", caught, "")
    check("Teeth: policy restored, Pat sees nothing again", st == 200 and rows == [], "")


if __name__ == "__main__":
    read_matrix()
    writes()
    assistant_and_scope()
    audit_and_tokens()
    assistant_era()
    tables()
    tasks()
    boards()
    polls()
    forms()
    links()
    contacts()
    glossary()
    decisions()
    qa()
    ideas()
    idea_next_steps()
    checklists()
    expenses()
    inventory()
    due_back_dates()
    goals()
    key_results_from_tasks()
    announcements()
    seen_by()
    kudos()
    timeline()
    journal()
    meetings()
    rsvps()
    repeating_events()
    repeating_tasks()
    task_comments()
    meeting_decisions()
    poll_form_deadlines()
    bookings()
    repeating_bookings()
    shifts()
    copy_shifts()
    time_off()
    away_warnings()
    retros()
    profiles()
    who_knows_what()
    kudos_on_profiles()
    people()
    trees()
    prefs_and_files()
    more_on_the_calendar()
    search()
    index_the_rest()
    wikis()
    if "--teeth" in sys.argv:
        teeth()
    width = max(len(n) for n, _, _ in results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {'' if ok else detail}")
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
