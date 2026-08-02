-- Check the 0083 fix on the real database.
--
-- The bug it repairs is the kind that reads as correct and does nothing:
-- pass_introduction wrote 'explicit_pass', the submission a moment later
-- overwrote it with 'released', and every filter that holds a passed pair apart
-- then looked at a row that no longer said so. Both the earlier live check and
-- the pgTAP suite called pass_introduction on its own, so neither saw it.
--
-- The pgTAP suite now covers this properly and runs on every push. This exists
-- because that suite only runs where Docker runs, and the fix is worth
-- confirming against the live database once rather than trusting a test nobody
-- has yet been able to execute.
--
-- Same shape as 0080: one transaction, so a failed assertion rolls the fixture
-- back, and passing assertions reach the deletes at the foot.

do $$
declare
  v_a uuid := '00000000-0000-4000-8000-00000000c0a1';
  v_b uuid := '00000000-0000-4000-8000-00000000c0b2';
  v_round uuid := '00000000-0000-4000-8000-00000000c0d1';
  v_intro uuid := '00000000-0000-4000-8000-00000000c0e1';
  v_cfg jsonb := halal_mode_private.active_matching_config();
  v_decision text;
  v_days numeric;
  v_soft int;
begin
  insert into auth.users (id, email) values
    (v_a, 'verify-soft-a@example.invalid'),
    (v_b, 'verify-soft-b@example.invalid');
  insert into public.profiles (id, name, first_name, birth_date, gender, onboarding_complete)
  values
    (v_a, 'Soft A', 'A', '1996-01-01', 'female', true),
    (v_b, 'Soft B', 'B', '1994-01-01', 'male', true);
  insert into halal_mode_private.member_legal_consent_history
    (user_id, document_type, version, acceptance_context)
  select u.id, d.document_type, d.version, 'migrated'
  from (values (v_a), (v_b)) u(id)
  cross join halal_mode_private.legal_document_registry d
  where d.is_current;
  insert into public.rounds (id, user_id, tier, expires_at)
  values (v_round, v_a, 'free', now() + interval '1 day');
  insert into public.introductions (id, round_id, viewer_id, subject_id)
  values (v_intro, v_round, v_a, v_b);

  perform set_config('request.jwt.claims', json_build_object('sub', v_a)::text, true);

  -- --- A first pass now costs a month --------------------------------------
  perform public.pass_introduction(v_intro);

  select extract(epoch from (cooldown_until - now())) / 86400 into v_days
  from halal_mode_private.pair_exposure
  where user_low = least(v_a, v_b) and user_high = greatest(v_a, v_b);

  assert v_days > (v_cfg ->> 'max_repeat_cooldown_days')::numeric,
    format('a pass must cost more time than not being chosen; got %s days', round(v_days, 1));
  assert abs(v_days - (v_cfg ->> 'explicit_pass_first_cooldown_days')::numeric) < 0.01,
    format('expected %s days after a first pass, got %s',
           v_cfg ->> 'explicit_pass_first_cooldown_days', round(v_days, 1));

  -- --- A soft select is refused on a pair that was passed ------------------
  perform public.soft_select_introduction(v_intro);
  select coalesce(soft_select_count, 0) into v_soft
  from halal_mode_private.pair_exposure
  where user_low = least(v_a, v_b) and user_high = greatest(v_a, v_b);
  assert v_soft = 0, 'a passed pair must not also be soft selected';

  -- --- The submission cannot undo the pass ---------------------------------
  perform public.pass_introduction(v_intro);
  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro;
  assert v_decision = 'explicit_pass',
    format('a second pass should ban; got %s', v_decision);

  -- Exactly what submit_round_selections does to every introduction in a round.
  update public.introduction_selections
  set decision = 'released', decided_at = now()
  where introduction_id = v_intro;

  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro;
  assert v_decision = 'explicit_pass',
    format('a submission must not undo the pass that preceded it; got %s', v_decision);

  update public.introduction_selections
  set decision = 'kept', decided_at = now()
  where introduction_id = v_intro;

  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro;
  assert v_decision = 'kept',
    format('but keeping somebody must still win; got %s', v_decision);

  -- --- Soft select records on a clean pair ---------------------------------
  update halal_mode_private.pair_exposure set explicit_pass_count = 0
  where user_low = least(v_a, v_b) and user_high = greatest(v_a, v_b);
  update public.introduction_selections set decision = 'released'
  where introduction_id = v_intro;

  perform public.soft_select_introduction(v_intro);

  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro;
  assert v_decision = 'soft_select',
    format('soft select should be its own outcome; got %s', v_decision);
  select soft_select_count into v_soft
  from halal_mode_private.pair_exposure
  where user_low = least(v_a, v_b) and user_high = greatest(v_a, v_b);
  assert v_soft = 1, format('the lift should be counted once; got %s', v_soft);

  -- And it survives the same sweep, for the same reason.
  update public.introduction_selections set decision = 'released'
  where introduction_id = v_intro;
  select decision::text into v_decision
  from public.introduction_selections where introduction_id = v_intro;
  assert v_decision = 'soft_select', 'a sweep must not undo a soft select either';

  -- --- Clean up ------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  set local role postgres;
  alter table halal_mode_private.member_legal_consent_history
    disable trigger member_legal_consent_history_append_only;

  delete from halal_mode_private.pair_exposure
   where user_low in (v_a, v_b) or user_high in (v_a, v_b);
  delete from auth.users where id in (v_a, v_b);

  alter table halal_mode_private.member_legal_consent_history
    enable trigger member_legal_consent_history_append_only;

  assert not exists (select 1 from public.profiles where id in (v_a, v_b)),
    'the fixture must not outlive the check';
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
