-- Actually erase the accounts people asked us to erase.
--
-- Requesting deletion has always worked: the member is paused, their open
-- connections close, and the request is recorded. The second half never ran.
-- `finalize-account-deletions` was written, reviewed and left unscheduled, so
-- the 30-day recovery window expired and nothing happened at the end of it.
-- Both legal documents say we remove the account; this is what makes that true.
--
-- The worker proves itself against the vault rather than a deploy-time
-- environment variable, matching round generation. One place holds the secret,
-- rotation is a single update, and deploying the function needs nothing
-- configured by hand.

create or replace function public.verify_deletion_worker_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public, vault as $$
  select coalesce(
    p_secret = (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'halal_mode_deletion_worker'
      order by created_at desc
      limit 1
    ),
    false
  );
$$;

revoke all on function public.verify_deletion_worker_secret(text) from public, anon, authenticated;
grant execute on function public.verify_deletion_worker_secret(text) to service_role;

do $$
declare
  v_id uuid;
  -- Generated here and never leaving the database, same as the scheduler
  -- secret it sits beside. Read it from Dashboard -> Vault if it is ever
  -- needed by hand.
  v_secret text := replace(gen_random_uuid()::text, '-', '')
                || replace(gen_random_uuid()::text, '-', '');
begin
  select id into v_id
  from vault.secrets
  where name = 'halal_mode_deletion_worker'
  order by created_at desc
  limit 1;

  if v_id is null then
    perform vault.create_secret(
      v_secret,
      'halal_mode_deletion_worker',
      'Shared secret for the account deletion finalizer cron.'
    );
  else
    perform vault.update_secret(v_id, v_secret);
  end if;

  assert public.verify_deletion_worker_secret(v_secret),
    'the stored secret must satisfy the worker check';
  assert not public.verify_deletion_worker_secret('not-the-secret'),
    'the worker check must still reject a wrong secret';

  -- Erasure is only eligible 30 days after the request, so a daily pass is
  -- ample. 03:20 UTC keeps it clear of round generation around 01:30.
  if exists (select 1 from cron.job where jobname = 'halal-mode-finalize-deletions') then
    perform cron.unschedule('halal-mode-finalize-deletions');
  end if;

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
        body := '{}'::jsonb
      );
    $job$
  );

  assert exists (
    select 1 from cron.job
    where jobname = 'halal-mode-finalize-deletions' and active
  ), 'the deletion worker must be scheduled and active';
end;
$$;
