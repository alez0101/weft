-- 020 personal model keys ("bring your own key").
--
-- An admin setting decides whether people may add their own key (off by default). A personal key is
-- used only for that person's own questions, before the workspace's models; if it fails, the workspace
-- models answer. Personal keys are encrypted by the assistant service like the workspace keys, are never
-- returned to anyone (the owner sees the last four characters), and no admin screen or API shows them.
-- Only Anthropic and OpenAI, at addresses the server sets (not the person), so a personal setting can
-- never point the assistant at machines on the server's network.
set client_min_messages = warning;

create table if not exists weft_private.assistant_settings (
  id                  boolean primary key default true check (id),   -- exactly one row
  allow_personal_keys boolean not null default false,
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
insert into weft_private.assistant_settings (id) values (true) on conflict (id) do nothing;

create table if not exists weft_private.personal_providers (
  user_id         uuid primary key references weft.users (id) on delete cascade,
  kind            text not null check (kind in ('anthropic', 'openai')),
  model           text not null check (model ~ '^[A-Za-z0-9._:-]{1,80}$'),
  effort          text check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  key_ciphertext  text,
  key_hint        text,
  enabled         boolean not null default true,
  monthly_cap_usd numeric(10, 2) check (monthly_cap_usd is null or monthly_cap_usd >= 0),
  price_in        numeric(10, 4) not null default 0 check (price_in >= 0),    -- per million tokens, for the person's own tracking
  price_out       numeric(10, 4) not null default 0 check (price_out >= 0),
  updated_at      timestamptz not null default now()
);

-- What a person's own key has cost this month.
create or replace function weft_private.personal_month_cost(p_user uuid) returns numeric
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce(sum(cost_usd), 0) from weft_private.assistant_runs
  where slot = 'personal' and asker = p_user and ok and at >= date_trunc('month', now())
$$;

create or replace function weft_private.settings_get()
returns table (allow_personal_keys boolean, personal_keys bigint)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select s.allow_personal_keys, (select count(*) from weft_private.personal_providers where key_ciphertext is not null)
  from weft_private.assistant_settings s
$$;

create or replace function weft_private.settings_save(p_by uuid, p_allow boolean) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  update weft_private.assistant_settings set allow_personal_keys = p_allow, updated_at = now(), updated_by = p_by;
end $$;

-- The owner's view of their own setting (never the key).
create or replace function weft_private.personal_get(p_user uuid)
returns table (kind text, model text, effort text, has_key boolean, key_hint text, enabled boolean,
               monthly_cap_usd numeric, price_in numeric, price_out numeric, month_cost_usd numeric, updated_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select p.kind, p.model, p.effort, p.key_ciphertext is not null, p.key_hint, p.enabled,
         p.monthly_cap_usd, p.price_in, p.price_out, weft_private.personal_month_cost(p.user_id), p.updated_at
  from weft_private.personal_providers p where p.user_id = p_user
$$;

-- For the call: only if personal keys are allowed, the person's key is set and on, and the account is active.
create or replace function weft_private.personal_for_call(p_user uuid)
returns setof weft_private.personal_providers
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select p.* from weft_private.personal_providers p
  join weft.users u on u.id = p.user_id and not u.disabled
  where p.user_id = p_user and p.enabled and p.key_ciphertext is not null
    and (select allow_personal_keys from weft_private.assistant_settings)
$$;

create or replace function weft_private.personal_save(p_user uuid, p_kind text, p_model text, p_effort text,
  p_cap numeric, p_in numeric, p_out numeric, p_enabled boolean) returns void
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  insert into weft_private.personal_providers (user_id, kind, model, effort, monthly_cap_usd, price_in, price_out, enabled)
  values (p_user, p_kind, p_model, p_effort, p_cap, p_in, p_out, p_enabled)
  on conflict (user_id) do update set kind = excluded.kind, model = excluded.model, effort = excluded.effort,
    monthly_cap_usd = excluded.monthly_cap_usd, price_in = excluded.price_in, price_out = excluded.price_out,
    enabled = excluded.enabled, updated_at = now();
$$;

create or replace function weft_private.personal_set_key(p_user uuid, p_ciphertext text, p_hint text) returns void
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  update weft_private.personal_providers set key_ciphertext = p_ciphertext, key_hint = p_hint, updated_at = now()
  where user_id = p_user;
$$;

create or replace function weft_private.personal_delete(p_user uuid) returns void
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  delete from weft_private.personal_providers where user_id = p_user;
$$;

revoke all on weft_private.assistant_settings, weft_private.personal_providers from public, weft_user, weft_assistant;
do $$
declare f text;
begin
  foreach f in array array['weft_private.personal_month_cost(uuid)', 'weft_private.settings_get()', 'weft_private.settings_save(uuid, boolean)',
    'weft_private.personal_get(uuid)', 'weft_private.personal_for_call(uuid)',
    'weft_private.personal_save(uuid, text, text, text, numeric, numeric, numeric, boolean)',
    'weft_private.personal_set_key(uuid, text, text)', 'weft_private.personal_delete(uuid)'] loop
    execute format('revoke execute on function %s from public, weft_user, weft_assistant', f);
    execute format('grant execute on function %s to weft_assist', f);
  end loop;
end $$;
