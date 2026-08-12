-- Why nothing I bounded was actually bounded.
--
-- `lock_timeout` does not apply to advisory locks. It bounds waits for table
-- and row locks only; `pg_advisory_xact_lock` waits forever regardless. So the
-- 15-second ceiling added earlier was never in force on the one lock that
-- mattered — validation takes the global 'matching-legal-consent-epoch' lock
-- before it checks anything, and every caller queues there.
--
-- That is the whole mechanism, and it explains what looked like several
-- unrelated faults:
--
--   a run killed mid-write leaves its session holding that global lock
--   every later run blocks on it, forever, including batched ones
--   each blocked call holds one of the API's connections while it waits
--   ten of them take the entire pool, and the API answers 503 to everyone
--
-- The batching was not wrong and is not the fix on its own: a batch that waits
-- forever on the same lock is just a smaller thing stuck in the same queue.
--
-- Waiting is now attempted rather than assumed. If the lock cannot be had
-- promptly the call fails with a clear error and releases its connection,
-- which is recoverable. The safety property the lock protects is unchanged —
-- nothing proceeds without holding it.

create or replace function halal_mode_private.take_matching_lock(p_key text, p_salt bigint)
returns void
language plpgsql
set search_path = pg_catalog, public as $$
declare
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
begin
  loop
    if pg_try_advisory_xact_lock(hashtextextended(p_key, p_salt)) then
      return;
    end if;
    if clock_timestamp() > v_deadline then
      raise exception 'MATCHING_LOCK_BUSY: could not take % within 10s', p_key
        using errcode = '55P03';
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function halal_mode_private.take_matching_lock(text, bigint)
  from public, anon, authenticated, service_role;

-- Free whatever is still wedged, of either shape. Without this the pool stays
-- full and the API stays down, because the holders never time out on their own.
do $$
declare
  v_killed integer := 0;
  v_pid integer;
begin
  for v_pid in
    select pid from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and xact_start is not null
      and now() - xact_start > interval '20 seconds'
      and (query ilike '%matching_shadow%' or query ilike '%validate_frozen%')
  loop
    perform pg_terminate_backend(v_pid);
    v_killed := v_killed + 1;
  end loop;
  raise notice 'released % wedged matching sessions', v_killed;
end;
$$;
