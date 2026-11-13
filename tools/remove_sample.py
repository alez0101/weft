#!/usr/bin/env python3
"""SQL that removes the sample data (db/reset.sh --sample, tools/gen_seed.py) from a Weft that real people
now use: the four sample accounts, their channels and direct messages, their personal spaces and Weft
conversations, and everything in those spaces (messages, documents, wiki pages, whiteboards, tables,
events, audit rows). Everything else stays, including the help and admin wikis and real accounts' own
spaces. Anything a sample account created in a space that stays is handed to the first real admin.

Refuses (and changes nothing) unless an active admin that is not a sample account exists.
Back up first (tools/backup.sh). Usage:
    python3 -I tools/remove_sample.py | docker compose -p weft-core ... exec -T postgres psql -U weft_owner -d weft
"""
import csv
import os
import uuid

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NS = uuid.UUID("6f1c2a52-5a2f-4c9e-9a0e-7b1f0d3e5a11")   # same namespace as gen_seed.py
uid = lambda *p: str(uuid.uuid5(NS, "/".join(p)))
rows = lambda name: list(csv.DictReader(open(os.path.join(ROOT, "data", "sample", f"{name}.csv"))))

users = rows("users")
user_ids = [uid("user", u["user_id"]) for u in users]
emails = [u["email"].lower() for u in users]
space_keys = [s["space_id"] for s in rows("spaces")] + ["dm-alex-olive", "dm-olive-vic"]
space_keys += [f"{k}-{u['user_id']}" for u in users for k in ("assistant", "personal")]
space_ids = [uid("space", k) for k in space_keys]
arr = lambda xs: "array[" + ",".join(f"'{x}'" for x in xs) + "]"
U, S, E = f"{arr(user_ids)}::uuid[]", f"{arr(space_ids)}::uuid[]", f"{arr(emails)}::text[]"

print(f"""begin;
set local search_path = weft, weft_private;
do $$
declare keeper uuid; n_users int; n_spaces int;
begin
  select id into keeper from weft.users
   where is_admin and not disabled and not is_assistant and id <> all({U})
   order by created_at limit 1;
  if keeper is null then raise exception 'no real admin would remain: make a real account admin first'; end if;
  -- Hand over what sample accounts created in spaces that stay.
  update weft.spaces set created_by = keeper where created_by = any({U}) and id <> all({S});
  update weft.items  set created_by = keeper where created_by = any({U}) and space_id <> all({S});
  update weft.events set created_by = keeper where created_by = any({U}) and space_id <> all({S});
  update weft.table_rows set created_by = keeper where created_by = any({U});
  delete from weft.messages where author_id = any({U}) and space_id <> all({S});
  -- The sample spaces and everything in them (messages, items, events, members cascade).
  delete from weft_private.proposals where space_id = any({S}) or asker = any({U});
  delete from weft.audit where space_id = any({S});
  delete from weft.spaces where id = any({S});
  get diagnostics n_spaces = row_count;
  delete from weft.audit where space_id = any({S});   -- the deletes above were audited too
  delete from weft_private.auth_links where lower(email) = any({E});
  delete from weft_private.admin_log where user_id = any({U}) or actor_id = any({U});
  delete from weft.users where id = any({U});
  get diagnostics n_users = row_count;
  raise notice 'removed % sample accounts and % sample spaces; their things in other spaces now belong to %', n_users, n_spaces, keeper;
end $$;
commit;""")
