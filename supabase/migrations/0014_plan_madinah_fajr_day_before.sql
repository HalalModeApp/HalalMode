-- Plan tomorrow's precise Madinah Fajr time daily, then let the generator run
-- exactly once at that planned time instead of polling through the morning.
create or replace function set_madinah_fajr_cron(p_schedule text)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  if p_schedule !~ '^\d{1,2} \d{1,2} \* \* \*$' then
    raise exception 'Invalid cron schedule';
  end if;
  perform cron.alter_job(
    (select jobid from cron.job where jobname = 'halal-mode-madinah-fajr'),
    schedule := p_schedule
  );
end;
$$;
revoke all on function set_madinah_fajr_cron(text) from public;

select cron.unschedule('halal-mode-madinah-fajr');
select cron.schedule(
  'halal-mode-madinah-fajr',
  '0 2 * * *',
  $$
    select net.http_post(
      url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round',
      headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_76oRAMvYDJSJ8y7DkaizTQ_DCEmKF5_', 'Content-Type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);
select cron.schedule(
  'halal-mode-madinah-fajr-planner',
  '30 0,1 * * *',
  $$
    select net.http_post(
      url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round?mode=plan',
      headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_76oRAMvYDJSJ8y7DkaizTQ_DCEmKF5_', 'Content-Type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);
