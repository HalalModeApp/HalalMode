-- Give the workers longer than five seconds, and stand the matcher down until
-- it has finished a round at size.
--
-- `net.http_post` defaults to a 5000 ms timeout. Every scheduled call in this
-- project has been using that default, which was invisible while the only
-- cohort was 14 members and the whole round planned in well under a second.
--
-- With 53 members — 660 possible pairings, 431 after filtering — a shadow run
-- recorded its candidate snapshot and then stopped dead: no pairs, no edges, no
-- error. The run row simply stops mid-way. That is the shape of a process that
-- was killed rather than one that failed, and the timeout is the thing holding
-- the knife. Whether pg_net giving up also tears down the function or merely
-- stops us hearing the answer, both are wrong, and both are fixed by asking for
-- an answer within a sensible time instead of an unrealistic one.
--
-- Round generation runs once at Fajr and has the whole morning; two minutes is
-- generous and still bounded.
--
-- The matcher flag goes back to false in the same change. It was enabled on
-- evidence from a 14-member pool, and a 53-member pool has now contradicted
-- that evidence. Tomorrow's Fajr run is the first live use of this code path,
-- and it is not going to be the first time anyone finds out whether it
-- completes. It goes back on when a shadow run finishes at size.

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
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.fire_worker_service(text) from public, anon, authenticated;
grant execute on function public.fire_worker_service(text) to service_role;

do $$
declare
  v_fajr_schedule text := coalesce(
    (select schedule from cron.job where jobname = 'halal-mode-madinah-fajr'),
    '0 2 * * *'
  );
begin
  -- Rescheduled rather than edited: cron.schedule replaces a job of the same
  -- name, and the existing Fajr timing is preserved rather than reset.
  perform cron.schedule(
    'halal-mode-madinah-fajr',
    v_fajr_schedule,
    $job$
      select net.http_post(
        url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round',
        headers := jsonb_build_object(
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_round_scheduler' order by created_at desc limit 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );

  perform cron.schedule(
    'halal-mode-finalize-deletions',
    '20 3 * * *',
    $job$
      select net.http_post(
        url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/finalize-account-deletions',
        headers := jsonb_build_object(
          'x-deletion-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_deletion_worker' order by created_at desc limit 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );

  update halal_mode_private.release_flags
  set enabled = false, updated_at = now()
  where key = 'reciprocal_matching_v1';

  assert not (select enabled from halal_mode_private.release_flags where key = 'reciprocal_matching_v1'),
    'the matcher must be stood down until it completes a round at size';
end;
$$;
