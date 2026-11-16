-- 074 web search: an admin switch that lets the main (Anthropic) model search the web for facts that are not in
-- Weft (public dates, places, how-tos). Off by default. Searches run on Anthropic's side and cost money per search,
-- so the switch is workspace-wide and admin-only. Weft content never becomes readable by anyone new through it.
set client_min_messages = warning;

alter table weft_private.assistant_settings add column if not exists web_search boolean not null default false;

create or replace function weft_private.web_search_get() returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select web_search from weft_private.assistant_settings), false)
$$;

create or replace function weft_private.web_search_save(p_by uuid, p_on boolean) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  update weft_private.assistant_settings set web_search = p_on, updated_at = now(), updated_by = p_by;
end $$;

revoke execute on function weft_private.web_search_get(), weft_private.web_search_save(uuid, boolean) from public, weft_user, weft_assistant;
grant execute on function weft_private.web_search_get(), weft_private.web_search_save(uuid, boolean) to weft_assist;
