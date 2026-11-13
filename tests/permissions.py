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
    check("Tasks: Pat cannot tick off a task, even one assigned to her", st == 200 and rows == [] and oq(f"select done from weft.tasks where id = '{ft}'") == "f", f"{st} {rows}")
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
    check("Tasks: a #festival-scoped token sees only #festival tasks", st == 200 and [r["list_id"] for r in rows] == [fest], str(rows))
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


# ---------------------------------------------------------------- people (channels, members, accounts)
TEST_SIGNIN = os.environ.get("WEFT_SIGNIN", "http://127.0.0.1:3211/auth/test-login")


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


# ---------------------------------------------------------------- teeth
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
    people()
    trees()
    prefs_and_files()
    search()
    wikis()
    if "--teeth" in sys.argv:
        teeth()
    width = max(len(n) for n, _, _ in results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {'' if ok else detail}")
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
