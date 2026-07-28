-- The function reads the real daily Umm al-Qura Fajr time for Madinah. This
-- record makes the frequent scheduler safe: at most one cycle can run a day.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table round_generation_runs (
  cycle_date date primary key,
  created_at timestamptz not null default now()
);

alter table round_generation_runs enable row level security;

select cron.schedule(
  'halal-mode-madinah-fajr',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round',
      headers := jsonb_build_object(
        'Authorization', 'Bearer sb_publishable_76oRAMvYDJSJ8y7DkaizTQ_DCEmKF5_',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $$
);
