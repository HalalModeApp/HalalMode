-- Run the sender, and give it a way to prove itself.
--
-- Same shape as round generation and the deletion worker: the secret is
-- generated in the database, never leaves it, and is read from the vault at
-- call time — so rotating it is one update and nothing needs redeploying.
--
-- Every two minutes. Notifications are queued the moment something happens and
-- messages are deliberately held for two, so this is as often as it needs to
-- be and rare enough to cost nothing. The generous timeout and the JWT setting
-- are both here because their absence has already broken a scheduled job in
-- this project once each.

create or replace function public.verify_notification_worker_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public, vault as $$
  select coalesce(
    p_secret = (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'halal_mode_notification_worker'
      order by created_at desc
      limit 1
    ),
    false
  );
$$;

revoke all on function public.verify_notification_worker_secret(text) from public, anon, authenticated;
grant execute on function public.verify_notification_worker_secret(text) to service_role;

do $$
declare
  v_id uuid;
  v_secret text := replace(gen_random_uuid()::text, '-', '')
                || replace(gen_random_uuid()::text, '-', '');
begin
  select id into v_id
  from vault.secrets
  where name = 'halal_mode_notification_worker'
  order by created_at desc
  limit 1;

  if v_id is null then
    perform vault.create_secret(
      v_secret, 'halal_mode_notification_worker',
      'Shared secret for the notification sending cron.'
    );
  else
    perform vault.update_secret(v_id, v_secret);
  end if;

  assert public.verify_notification_worker_secret(v_secret),
    'the stored secret must satisfy the worker check';
  assert not public.verify_notification_worker_secret('not-the-secret'),
    'the worker check must still reject a wrong secret';

  if exists (select 1 from cron.job where jobname = 'halal-mode-send-notifications') then
    perform cron.unschedule('halal-mode-send-notifications');
  end if;

  perform cron.schedule(
    'halal-mode-send-notifications',
    '*/2 * * * *',
    $job$
      select net.http_post(
        url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/send-notifications',
        headers := jsonb_build_object(
          'x-notification-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_notification_worker' order by created_at desc limit 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );

  assert exists (
    select 1 from cron.job
    where jobname = 'halal-mode-send-notifications' and active
  ), 'the notification sender must be scheduled and active';
end;
$$;
