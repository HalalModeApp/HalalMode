-- Let us see what the scheduled jobs actually got back.
--
-- Every background job here is fired with `net.http_post`, which is
-- deliberately fire-and-forget: the cron command succeeds the moment the
-- request is queued, whatever the server later says. So `cron.job_run_details`
-- reports a healthy job even when the endpoint answered 403 every night.
--
-- That is how the deletion worker sat unnoticed: scheduled, plausible, and
-- refused. This reads the replies pg_net kept, which is the only place the
-- truth was ever written down.

create or replace function public.recent_worker_replies_service(p_limit integer default 10)
returns table (id bigint, status_code integer, content text, created timestamptz)
language sql
stable
security definer
set search_path = public, net as $$
  select r.id, r.status_code, left(r.content, 300), r.created
  from net._http_response r
  order by r.created desc
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.recent_worker_replies_service(integer) from public, anon, authenticated;
grant execute on function public.recent_worker_replies_service(integer) to service_role;

-- Fire the deletion worker once now, exactly as the cron does, so the wiring is
-- proven today rather than assumed until the first real erasure is due. With an
-- empty queue the worker claims nothing and deletes nothing.
select net.http_post(
  url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/finalize-account-deletions',
  headers := jsonb_build_object(
    'x-deletion-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_deletion_worker' order by created_at desc limit 1),
    'Content-Type', 'application/json'
  ),
  body := '{}'::jsonb
);
