-- Trigger a background worker by hand, without inventing a migration to do it.
--
-- Firing one of these is an action, not a schema change, and a one-off
-- `net.http_post` sitting in a migration re-fires on every fresh database —
-- including CI, at the production URL. This is the same call the cron makes,
-- callable when a change needs proving today rather than at 03:20 tomorrow.
--
-- Service role only, and the worker name is checked against a fixed list, so
-- this cannot be pointed at an arbitrary URL. Each worker still verifies its
-- own secret at the other end; this only saves reaching into the vault by hand.

create or replace function public.fire_worker_service(p_worker text)
returns bigint
language plpgsql
security definer
set search_path = public, net, vault as $$
declare
  v_url text;
  v_secret_name text;
  v_header text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Firing a worker requires service role' using errcode = '42501';
  end if;

  case p_worker
    when 'finalize-deletions' then
      v_url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/finalize-account-deletions';
      v_secret_name := 'halal_mode_deletion_worker';
      v_header := 'x-deletion-worker-secret';
    when 'round-shadow' then
      -- Computes the full round and writes only to shadow_round_edges, which
      -- nothing reads. Safe to run against live data at any hour.
      v_url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round?mode=shadow';
      v_secret_name := 'halal_mode_round_scheduler';
      v_header := 'x-cron-secret';
    else
      raise exception 'Unknown worker %', p_worker using errcode = '22023';
  end case;

  return net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      v_header, (
        select decrypted_secret from vault.decrypted_secrets
        where name = v_secret_name order by created_at desc limit 1
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.fire_worker_service(text) from public, anon, authenticated;
grant execute on function public.fire_worker_service(text) to service_role;

do $$
begin
  assert (select count(*) from cron.job where jobname = 'halal-mode-finalize-deletions') = 1,
    'the deletion worker should be scheduled exactly once';
end;
$$;
