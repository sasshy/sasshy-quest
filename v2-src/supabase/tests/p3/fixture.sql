create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema public, extensions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
