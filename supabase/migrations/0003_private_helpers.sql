-- Keep RLS helper functions out of the public REST API (/rest/v1/rpc/*).
create schema if not exists private;
grant usage on schema private to authenticated, service_role;
alter function public.is_org_member(uuid) set schema private;
alter function public.can_approve(uuid) set schema private;
revoke execute on function private.is_org_member(uuid) from public, anon;
revoke execute on function private.can_approve(uuid) from public, anon;
grant execute on function private.is_org_member(uuid) to authenticated, service_role;
grant execute on function private.can_approve(uuid) to authenticated, service_role;
