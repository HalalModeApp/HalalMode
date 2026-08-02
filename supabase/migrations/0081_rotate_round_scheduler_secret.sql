-- Rotate the round scheduler secret.
--
-- The previous value was read aloud into a terminal and captured in a
-- screenshot during development. Nothing is known to have leaked, and it is a
-- trigger credential rather than a data one — the worst it buys is the ability
-- to start a round early. But a credential that has been photographed is not a
-- secret any more, and this one costs nothing to replace.
--
-- Both cron jobs read it from the vault at call time rather than holding a copy,
-- so replacing the stored value is the whole rotation. Nothing needs
-- rescheduling and nothing needs redeploying.
--
-- The new value is generated in the database and never leaves it. It is not in
-- this file, not in the migration output, and not in the repository; read it
-- from Dashboard -> Project Settings -> Vault if you need it by hand.

do $$
declare
  v_id uuid;
  -- Two v4 UUIDs rather than pgcrypto's gen_random_bytes, which lives in the
  -- extensions schema here and would make this migration depend on where an
  -- extension happens to be installed. gen_random_uuid is core in PG13+ and
  -- draws from the same cryptographic source; two of them is 244 random bits.
  v_secret text := replace(gen_random_uuid()::text, '-', '')
                || replace(gen_random_uuid()::text, '-', '');
  v_count int;
begin
  select id into v_id
  from vault.secrets
  where name = 'halal_mode_round_scheduler'
  order by created_at desc
  limit 1;

  if v_id is null then
    perform vault.create_secret(
      v_secret,
      'halal_mode_round_scheduler',
      'Shared secret for the Madinah Fajr round generation cron.'
    );
  else
    -- Updated rather than appended, so exactly one value carries the name and
    -- the retired one is not left sitting decryptable beside it.
    perform vault.update_secret(v_id, v_secret);
  end if;

  select count(*) into v_count
  from vault.secrets where name = 'halal_mode_round_scheduler';
  assert v_count = 1,
    format('exactly one scheduler secret should carry that name; found %s', v_count);

  -- The check the edge function performs on every call, run here against the
  -- value just stored. A rotation that quietly broke round generation would
  -- otherwise not surface until the next Fajr.
  assert public.verify_round_scheduler_secret(v_secret),
    'the rotated secret must satisfy the scheduler check';
  assert not public.verify_round_scheduler_secret('not-the-secret'),
    'the scheduler check must still reject a wrong secret';
end;
$$;
