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

API = os.environ.get("WEFT_API", "http://127.0.0.1:3100")
ASSISTANT = "00000000-0000-4000-8000-00000000a001"
USERS = ["u-alex", "u-org", "u-vol", "u-pub"]
NAME = {"u-alex": "Alex", "u-org": "Olive", "u-vol": "Vic", "u-pub": "Pat"}

# Expected membership, from data/sample/members.csv plus the seeded DMs and personal spaces.
SPACES = {
    "u-alex": {"festival": "owner", "volunteers": "owner", "organizers": "owner", "dm-alex-olive": "editor", "personal-u-alex": "owner", "assistant-u-alex": "owner", "help": "owner"},
    "u-org": {"festival": "editor", "volunteers": "editor", "organizers": "editor", "dm-alex-olive": "editor", "dm-olive-vic": "editor", "personal-u-org": "owner", "assistant-u-org": "owner", "help": "viewer"},
    "u-vol": {"festival": "viewer", "volunteers": "editor", "dm-olive-vic": "editor", "personal-u-vol": "owner", "assistant-u-vol": "owner", "help": "viewer"},
    "u-pub": {"festival": "viewer", "personal-u-pub": "owner", "assistant-u-pub": "owner", "help": "viewer"},
}
SID = {k: uid("space", k) for s in SPACES.values() for k in s}
KEY_OF = {v: k for k, v in SID.items()}
# Which spaces were seeded with rows of each kind.
SEEDED = {
    "messages": {"festival", "volunteers", "organizers", "dm-alex-olive", "dm-olive-vic"},
    "items": {"festival", "volunteers", "organizers", "personal-u-alex", "help"},
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
    out = subprocess.run(["sudo", "docker", "compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1",
                          "-At", "-U", "weft_owner", "-d", "weft", "-c", sql],
                         cwd=os.path.join(ROOT, "stacks", "weft"), capture_output=True, text=True, check=True)
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
    if "--teeth" in sys.argv:
        teeth()
    width = max(len(n) for n, _, _ in results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {'' if ok else detail}")
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
