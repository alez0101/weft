-- 008 assistant: admin flag, a per-person assistant conversation, answer metadata,
-- model provider settings and the run log. Phase 3b.
-- Run with: psql -v assist_svc_pw=...
set client_min_messages = warning;

-- Platform admin: manages settings. Deliberately NOT referenced by any row-level policy,
-- so being admin never widens what you can see.
alter table weft.users add column if not exists is_admin boolean not null default false;

-- Each person's own conversation with the assistant is a one-person space of kind 'assistant'.
alter table weft.spaces drop constraint if exists spaces_kind_check;
alter table weft.spaces add constraint spaces_kind_check check (kind in ('channel', 'dm', 'personal', 'assistant'));
drop policy if exists spaces_delete on weft.spaces;
create policy spaces_delete on weft.spaces for delete to weft_user
  using (weft_private.is_owner(id) and kind not in ('personal', 'assistant'));
-- spaces_create (003) already limits people to channels and DMs.

-- Answer metadata (citations, which model answered, fallback reason). Only the assistant may write it.
alter table weft.messages add column if not exists meta jsonb;
grant insert (space_id, author_id, body, thread_root_id, meta) on weft.messages to weft_assistant;

-- ---------- provider settings and run log (weft_private: never exposed through the API) ----------
create table if not exists weft_private.providers (
  slot            text primary key check (slot in ('primary', 'secondary')),
  kind            text not null check (kind in ('anthropic', 'openai', 'ollama')),
  base_url        text,
  model           text not null,
  effort          text check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  key_ciphertext  text,          -- AES-256-GCM, encrypted by the assistant service; the DB never sees the key
  key_hint        text,          -- last four characters, for the admin screen
  monthly_cap_usd numeric(10, 2),
  price_in        numeric(10, 4) not null default 0,  -- USD per million input tokens
  price_out       numeric(10, 4) not null default 0,  -- USD per million output tokens
  enabled         boolean not null default true,
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);

create table if not exists weft_private.assistant_runs (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  asker           uuid not null,
  space_id        uuid not null,
  question_id     uuid not null,
  slot            text,
  kind            text,
  model           text,
  ok              boolean not null,
  fallback_reason text,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(12, 6),
  ms              int,
  error           text
);
create index if not exists assistant_runs_month_idx on weft_private.assistant_runs (slot, at);

-- Starting configuration: Anthropic primary (no key yet; an admin enters it in Settings), and an Ollama
-- fallback that is off until an admin gives it an address in Settings.
insert into weft_private.providers (slot, kind, base_url, model, effort, monthly_cap_usd, price_in, price_out, enabled)
values ('primary', 'anthropic', null, 'claude-opus-5-5', 'low', 10.00, 4.00, 20.00, true),
       ('secondary', 'ollama', null, 'qwen2.5:3b', null, null, 0, 0, false)
on conflict (slot) do nothing;

-- ---------- the assistant service's login and its functions ----------
do $$
begin
  if not exists (select from pg_roles where rolname = 'weft_assist') then
    create role weft_assist login;
  end if;
end $$;
alter role weft_assist password :'assist_svc_pw';

create or replace function weft_private.assist_is_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select is_admin from weft.users where id = p_user), false)
$$;

create or replace function weft_private.month_cost(p_slot text) returns numeric
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce(sum(cost_usd), 0) from weft_private.assistant_runs
  where slot = p_slot and ok and at >= date_trunc('month', now())
$$;

-- For the admin screen: everything except the ciphertext.
create or replace function weft_private.providers_public()
returns table (slot text, kind text, base_url text, model text, effort text, key_hint text, has_key boolean,
               monthly_cap_usd numeric, price_in numeric, price_out numeric, enabled boolean,
               month_cost_usd numeric, updated_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select p.slot, p.kind, p.base_url, p.model, p.effort, p.key_hint, p.key_ciphertext is not null,
         p.monthly_cap_usd, p.price_in, p.price_out, p.enabled, weft_private.month_cost(p.slot), p.updated_at
  from weft_private.providers p order by p.slot
$$;

-- For making calls: includes the ciphertext, which only the service can decrypt.
create or replace function weft_private.providers_for_call()
returns setof weft_private.providers
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select * from weft_private.providers order by slot
$$;

create or replace function weft_private.provider_save(p_slot text, p_kind text, p_base_url text, p_model text,
  p_effort text, p_cap numeric, p_price_in numeric, p_price_out numeric, p_enabled boolean, p_by uuid)
returns void language sql security definer set search_path = weft, weft_private, pg_temp as $$
  insert into weft_private.providers (slot, kind, base_url, model, effort, monthly_cap_usd, price_in, price_out, enabled, updated_by, updated_at)
  values (p_slot, p_kind, nullif(p_base_url, ''), p_model, p_effort, p_cap, p_price_in, p_price_out, p_enabled, p_by, now())
  on conflict (slot) do update set kind = excluded.kind, base_url = excluded.base_url, model = excluded.model,
    effort = excluded.effort, monthly_cap_usd = excluded.monthly_cap_usd, price_in = excluded.price_in,
    price_out = excluded.price_out, enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()
$$;

create or replace function weft_private.provider_set_key(p_slot text, p_ciphertext text, p_hint text, p_by uuid)
returns void language sql security definer set search_path = weft, weft_private, pg_temp as $$
  update weft_private.providers set key_ciphertext = p_ciphertext, key_hint = p_hint, updated_by = p_by, updated_at = now()
  where slot = p_slot
$$;

create or replace function weft_private.run_log(p_asker uuid, p_space uuid, p_question uuid, p_slot text, p_kind text,
  p_model text, p_ok boolean, p_fallback text, p_in int, p_out int, p_cost numeric, p_ms int, p_error text)
returns void language sql security definer set search_path = weft, weft_private, pg_temp as $$
  insert into weft_private.assistant_runs (asker, space_id, question_id, slot, kind, model, ok, fallback_reason,
    input_tokens, output_tokens, cost_usd, ms, error)
  values (p_asker, p_space, p_question, p_slot, p_kind, p_model, p_ok, p_fallback, p_in, p_out, p_cost, p_ms, p_error)
$$;

-- A person's own assistant conversation, created on first use.
create or replace function weft_private.assistant_space(p_user uuid) returns uuid
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v uuid;
begin
  select s.id into v from weft.spaces s join weft.members m on m.space_id = s.id
  where s.kind = 'assistant' and m.user_id = p_user limit 1;
  if v is null then
    insert into weft.spaces (kind, name, created_by) values ('assistant', 'Weft', p_user) returning id into v;
  end if;
  return v;
end $$;

revoke execute on function weft_private.assist_is_admin(uuid), weft_private.month_cost(text),
  weft_private.providers_public(), weft_private.providers_for_call(),
  weft_private.provider_save(text, text, text, text, text, numeric, numeric, numeric, boolean, uuid),
  weft_private.provider_set_key(text, text, text, uuid),
  weft_private.run_log(uuid, uuid, uuid, text, text, text, boolean, text, int, int, numeric, int, text),
  weft_private.assistant_space(uuid)
  from public, weft_user, weft_assistant;
grant usage on schema weft_private to weft_assist;
grant execute on function weft_private.assist_is_admin(uuid), weft_private.month_cost(text),
  weft_private.providers_public(), weft_private.providers_for_call(),
  weft_private.provider_save(text, text, text, text, text, numeric, numeric, numeric, boolean, uuid),
  weft_private.provider_set_key(text, text, text, uuid),
  weft_private.run_log(uuid, uuid, uuid, text, text, text, boolean, text, int, int, numeric, int, text),
  weft_private.assistant_space(uuid)
  to weft_assist;
-- The token service also makes sure every person has their assistant conversation.
grant execute on function weft_private.assistant_space(uuid) to weft_auth;

-- First sign-in now also creates the assistant conversation, and the bootstrap admin gets the flag.
create or replace function weft_private.provision_user(p_email text, p_name text, p_bootstrap boolean)
returns table (id uuid, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_id uuid;
begin
  select u.id into v_id from weft.users u where lower(u.email) = lower(p_email) and not u.is_assistant;
  if v_id is null then
    insert into weft.users (email, display_name) values (lower(p_email), p_name) returning users.id into v_id;
    insert into weft.spaces (kind, name, created_by) values ('personal', 'Personal', v_id);
  end if;
  perform weft_private.assistant_space(v_id);
  if p_bootstrap then
    update weft.users set is_admin = true where users.id = v_id;
    insert into weft.members (space_id, user_id, role)
    select s.id, v_id, 'owner' from weft.spaces s where s.kind = 'channel'
    on conflict (space_id, user_id) do update set role = 'owner';
  end if;
  return query select u.id, u.display_name from weft.users u where u.id = v_id;
end $$;
