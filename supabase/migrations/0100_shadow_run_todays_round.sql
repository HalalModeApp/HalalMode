-- Run the new matcher against today's real data, without anyone seeing it.
--
-- `reciprocal_matching_v1` has been false since it was written, so every live
-- round is still produced by the legacy band matcher and none of the v1 scoring
-- work has ever run on real members. Shadow mode computes the identical round
-- and writes only to `shadow_round_edges`, which nothing reads — so this is
-- safe to fire at the live project and is the only way to see what flipping the
-- flag would actually do before flipping it.

-- Only where rounds have actually been generated. A fresh database — CI, or a
-- developer's reset — would otherwise post to the production URL while setting
-- itself up. 0101 replaces this one-off with a function, which is the right
-- shape for an action; this stays guarded rather than deleted, because it has
-- already run on the live project.
do $$
begin
  if exists (select 1 from round_generation_runs) then
    perform net.http_post(
      url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round?mode=shadow',
      headers := jsonb_build_object(
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_round_scheduler' order by created_at desc limit 1),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  end if;
end;
$$;
