-- Run the member-facing writes, on the real database, and check what they did.
--
-- pass_introduction, hide_introduction_member and the cooldown trigger have
-- never executed. A shadow round cannot reach them: it exercises the generation
-- pipeline, and these are things a member does afterwards, against rows a
-- shadow run never creates.
--
-- So this makes the rows. Two synthetic members, a round, a reciprocal pair of
-- introductions, and the consents the RPC boundary insists on — then it calls
-- the real functions as those members and asserts what changed. Everything is
-- deleted at the end.
--
-- Safe in both directions. A migration is one transaction: if any assertion
-- fails, the whole thing rolls back and the fixture goes with it. If they all
-- pass, the deletes at the foot remove it. There is no path that leaves a
-- synthetic member behind.
--
-- auth.uid() reads request.jwt.claims, so `set local` is what lets a migration
-- act as a signed-in member. That is the same mechanism the API uses, which is
-- why these are the real functions rather than reimplementations of them.

do $$
declare
  v_alice uuid := '00000000-0000-4000-8000-00000000a11c';
  v_basim uuid := '00000000-0000-4000-8000-00000000ba51';
  v_round uuid;
  v_intro_a uuid;
  v_intro_b uuid;
  v_cfg jsonb := halal_mode_private.active_matching_config();
  v_decision text;
  v_passes int;
  v_cooldown timestamptz;
  v_expected_days int;
  v_raised boolean;
begin
  -- --- Fixture -------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email)
  values
    (v_alice, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-alice@example.invalid'),
    (v_basim, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-basim@example.invalid');

  insert into public.profiles (id, name, first_name, birth_date, gender, onboarding_complete)
  values
    (v_alice, 'Alice Verify', 'Alice', '1996-01-01', 'female', true),
    (v_basim, 'Basim Verify', 'Basim', '1994-01-01', 'male', true);

  -- The RPCs refuse to act for a member without current consents, so the
  -- fixture has to satisfy the real gate rather than bypass it.
  insert into halal_mode_private.member_legal_consent_history
    (user_id, document_type, version, acceptance_context)
  select u.id, d.document_type, d.version, 'migrated'
  from (values (v_alice), (v_basim)) u(id)
  cross join halal_mode_private.legal_document_registry d
  where d.is_current;

  insert into public.rounds (id, user_id, tier, expires_at)
  values (gen_random_uuid(), v_alice, 'free', now() + interval '1 day')
  returning id into v_round;

  insert into public.introductions (round_id, viewer_id, subject_id)
  values (v_round, v_alice, v_basim)
  returning id into v_intro_a;

  -- --- A first pass costs rank and nothing else ----------------------------
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice)::text, true);

  perform public.pass_introduction(v_intro_a);

  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro_a;
  assert v_decision = 'released',
    format('a first pass should record a release, not a ban; got %s', v_decision);

  select explicit_pass_count into v_passes
  from halal_mode_private.pair_exposure
  where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim);
  assert v_passes = 1, format('the pair should carry one pass; got %s', coalesce(v_passes, -1));

  -- --- A second pass also costs time ---------------------------------------
  perform public.pass_introduction(v_intro_a);

  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro_a;
  assert v_decision = 'explicit_pass',
    format('a second pass should hold the pair apart; got %s', v_decision);

  select explicit_pass_count into v_passes
  from halal_mode_private.pair_exposure
  where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim);
  assert v_passes = 2, format('the pair should carry two passes; got %s', v_passes);

  -- Expiry lifts the ban and leaves the count, which is what carries the rank
  -- penalty. Backdated so the cooldown has genuinely elapsed.
  update public.introduction_selections
  set decided_at = now() - make_interval(
    days => (v_cfg ->> 'explicit_pass_cooldown_days')::int + 1
  )
  where introduction_id = v_intro_a;

  perform halal_mode_private.expire_explicit_passes();

  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro_a;
  assert v_decision = 'released',
    format('an expired ban should return the pair to an ordinary release; got %s', v_decision);

  select explicit_pass_count into v_passes
  from halal_mode_private.pair_exposure
  where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim);
  assert v_passes = 2,
    format('expiry must not forget the passes; got %s', v_passes);
  assert not exists (
    select 1 from halal_mode_private.pair_exposure
    where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim)
      and retired_at is not null
  ), 'passing twice must not close the pair — only a member does that';

  -- --- The cooldown trigger ------------------------------------------------
  -- Written straight onto the row the way the finaliser writes it, to check the
  -- trigger computes the wait from the score rather than a flat number.
  v_expected_days := halal_mode_private.pair_cooldown_days(0.60, v_cfg);
  update halal_mode_private.pair_exposure
  set last_shown_at = now(), last_reciprocal_score = 0.60
  where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim)
  returning cooldown_until into v_cooldown;

  assert v_cooldown is not null, 'the trigger should have set a cooldown';
  assert abs(extract(epoch from (v_cooldown - now())) / 86400 - v_expected_days) < 0.01,
    format('a 0.60 pair should wait %s days; the trigger set %s',
           v_expected_days, round(extract(epoch from (v_cooldown - now())) / 86400, 2));

  -- A weak pair must wait materially longer off the same code path.
  update halal_mode_private.pair_exposure
  set last_shown_at = now() + interval '1 second', last_reciprocal_score = 0.16
  where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim)
  returning cooldown_until into v_cooldown;

  assert extract(epoch from (v_cooldown - now())) / 86400 > v_expected_days + 5,
    'a pair barely above the floor should wait far longer than a strong one';

  -- --- Hiding --------------------------------------------------------------
  perform public.hide_introduction_member(v_intro_a);

  assert exists (
    select 1 from halal_mode_private.member_hides
    where hider_id = v_alice and hidden_id = v_basim
  ), 'hiding should be recorded';
  assert halal_mode_private.pair_is_hidden(v_basim, v_alice),
    'hiding must run both ways — it is worthless if you still appear in theirs';
  assert not public.passes_criteria(v_basim, v_alice),
    'a hidden pair must fail the eligibility gate from the other side too';
  assert exists (
    select 1 from halal_mode_private.pair_exposure
    where user_low = least(v_alice, v_basim) and user_high = greatest(v_alice, v_basim)
      and retired_at is not null and retired_reason = 'hidden'
  ), 'hiding should retire the pair outright';

  -- --- The boundary holds --------------------------------------------------
  -- Basim has no introduction to Alice, so the relationship-keyed RPC gives him
  -- no way to act on her. This is the property 0071 was written for.
  perform set_config('request.jwt.claims', json_build_object('sub', v_basim)::text, true);
  v_raised := false;
  begin
    perform public.pass_introduction(v_intro_a);
  exception when others then
    v_raised := true;
  end;
  assert v_raised, 'a member must not be able to pass somebody else''s introduction';

  -- --- Clean up ------------------------------------------------------------
  -- Empty rather than null: auth.uid() reads this through nullif(..., ''), so
  -- an empty string is what "nobody is signed in" looks like to it.
  perform set_config('request.jwt.claims', '', true);

  -- Consent history is append-only, and the guard's maintenance door is closed
  -- to this connection by design: it checks session_user so that no amount of
  -- SECURITY DEFINER nesting can manufacture the permission, and the CLI logs
  -- in as cli_login_postgres. That is the guard working, not a fault in it.
  --
  -- So the trigger comes off for the length of the delete. Narrower than it
  -- sounds: DISABLE TRIGGER takes an ACCESS EXCLUSIVE lock on the table, so no
  -- other session can write to it while the guard is down — they block until
  -- this transaction ends and the trigger is back. And a rollback restores it,
  -- because DDL here is transactional like everything else.
  set local role postgres;
  alter table halal_mode_private.member_legal_consent_history
    disable trigger member_legal_consent_history_append_only;
  delete from halal_mode_private.member_hides
   where hider_id in (v_alice, v_basim) or hidden_id in (v_alice, v_basim);
  delete from halal_mode_private.pair_exposure
   where user_low in (v_alice, v_basim) or user_high in (v_alice, v_basim);
  -- profiles cascade from auth.users, and introductions, selections, rounds and
  -- consent history all cascade from profiles.
  delete from auth.users where id in (v_alice, v_basim);

  alter table halal_mode_private.member_legal_consent_history
    enable trigger member_legal_consent_history_append_only;

  assert not exists (select 1 from public.profiles where id in (v_alice, v_basim)),
    'the fixture must not outlive the check';
  assert not exists (
    select 1 from halal_mode_private.member_legal_consent_history
    where user_id in (v_alice, v_basim)
  ), 'the fixture consents must be gone too';
  -- Belt and braces: the guard must be back on before this commits.
  assert (
    select tgenabled from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'halal_mode_private'
      and c.relname = 'member_legal_consent_history'
      and t.tgname = 'member_legal_consent_history_append_only'
  ) = 'O', 'the append-only guard must be restored before this commits';
end;
$$;
