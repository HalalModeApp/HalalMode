-- Force the API's connections to be rebuilt.
--
-- PostgREST's pool is wedged: every connection is held by a matching call that
-- will not return, so it cannot serve requests and cannot even rebuild its own
-- schema cache. It does not recover on its own, because nothing holding a
-- connection ever finishes.
--
-- Terminating them is safe. They are stateless API connections; PostgREST
-- reconnects immediately and any request killed here was already failing with
-- a 503. Targeted at the pool's own role so nothing else is disturbed.

do $$
declare
  v_killed integer := 0;
  v_pid integer;
begin
  for v_pid in
    select a.pid
    from pg_stat_activity a
    join pg_roles r on r.oid = a.usesysid
    where a.datname = current_database()
      and a.pid <> pg_backend_pid()
      and r.rolname = 'authenticator'
  loop
    begin
      perform pg_terminate_backend(v_pid);
      v_killed := v_killed + 1;
    exception when others then
      -- Not permitted to signal that backend; keep going rather than abort the
      -- whole recovery for one connection.
      null;
    end;
  end loop;

  insert into halal_mode_private.audit_events (actor_id, subject_id, event_type, metadata)
  values (null, null, 'api_pool_reset',
          jsonb_build_object('terminated', v_killed, 'at', now()))
  on conflict do nothing;
exception when others then
  raise notice 'pool reset finished with %', sqlerrm;
end;
$$;
