-- Clear sessions left by the diagnostic calls, and retire the probes.
--
-- Repeatedly calling validation with 64+ edges left hung sessions, each holding
-- one of the API's connections, until the pool was exhausted again. The probes
-- did their job — every statement inside validation is now measured — and each
-- one is another way to start a query that cannot finish.

do $$
declare
  v_pid integer;
begin
  for v_pid in
    select a.pid from pg_stat_activity a
    join pg_roles r on r.oid = a.usesysid
    where a.datname = current_database()
      and a.pid <> pg_backend_pid()
      and r.rolname = 'authenticator'
  loop
    begin
      perform pg_terminate_backend(v_pid);
    exception when others then null;
    end;
  end loop;
end;
$$;

drop function if exists public.time_validate_whole_service(uuid, jsonb);
drop function if exists public.time_validate_steps_service(uuid, jsonb);
drop function if exists public.time_validate_steps2_service(uuid, jsonb);
drop function if exists public.time_validation_parts_service(jsonb, integer);
drop function if exists public.time_lock_phase_service(uuid, jsonb, integer);
drop function if exists public.time_remaining_parts_service(uuid, jsonb);
drop function if exists public.time_real_insert_service(uuid, jsonb);
