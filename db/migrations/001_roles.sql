-- 001 roles
-- authenticator: the role PostgREST logs in as. It can do nothing itself; it only switches
--                to the role named in each request's token (or weft_anon without one).
-- weft_anon:     requests without a token. Granted nothing.
-- weft_user:     every signed-in person. One role for all; the user is the token's `sub` claim.
-- weft_assistant: the assistant acting for a user (`sub` = the asking user). Never granted delete.
-- Run with: psql -v auth_pw=... (the password comes from stacks/weft/.env)

do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'weft_anon') then
    create role weft_anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'weft_user') then
    create role weft_user nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'weft_assistant') then
    create role weft_assistant nologin;
  end if;
end $$;

alter role authenticator password :'auth_pw';
grant weft_anon, weft_user, weft_assistant to authenticator;
