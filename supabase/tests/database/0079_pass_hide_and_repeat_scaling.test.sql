begin;

set local search_path = public, extensions;
select plan(25);

-- The three strengths of "no", and the repetition scaling that sits behind
-- them. Covers migrations 0070 through 0079.
--
-- Migration 0080 checked the same behaviour against the hosted database, once,
-- because there was nowhere else to run it. That was worth doing and is not
-- worth keeping: it had to build a fixture on a live database and then delete
-- it again, which meant taking the append-only guard off consent history to
-- clean up after itself. Here the whole test rolls back, so there is no
-- cleanup, no guard to disable, and no reason to be careful about what a
-- failure leaves behind.

-- --- Fixture ----------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000007001', 'nomodel-a@example.test'),
  ('00000000-0000-0000-0000-000000007002', 'nomodel-b@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country,
  latitude, longitude, bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000007001', 'Pass A', 'A', '1996-01-01', 'female',
   'Madinah', 'Saudi Arabia', 24.4670, 39.6110, repeat('a', 50), array['a.jpg'], true),
  ('00000000-0000-0000-0000-000000007002', 'Pass B', 'B', '1994-01-01', 'male',
   'Madinah', 'Saudi Arabia', 24.4675, 39.6115, repeat('b', 50), array['b.jpg'], true);

-- Preferences matter here beyond the RPC boundary: passes_criteria returns false
-- for a member with none, so the hiding checks below would pass for the wrong
-- reason without them. They are what makes the pair eligible to begin with.
insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000007001', 18, 60, array['Saudi Arabia'], 500, now()),
  ('00000000-0000-0000-0000-000000007002', 18, 60, array['Saudi Arabia'], 500, now());

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select u.id, d.document_type, d.version, 'reacceptance'
from (values
  ('00000000-0000-0000-0000-000000007001'::uuid),
  ('00000000-0000-0000-0000-000000007002'::uuid)
) u(id)
cross join halal_mode_private.legal_document_registry d
where d.is_current;

insert into rounds (id, user_id, tier, expires_at) values
  ('00000000-0000-0000-0000-00000000700a', '00000000-0000-0000-0000-000000007001',
   'free', now() + interval '1 day');

insert into introductions (id, round_id, viewer_id, subject_id) values
  ('00000000-0000-0000-0000-00000000700b', '00000000-0000-0000-0000-00000000700a',
   '00000000-0000-0000-0000-000000007001', '00000000-0000-0000-0000-000000007002');

-- The pair is genuinely eligible before anything below happens, so the checks
-- that it stops being eligible are measuring the change rather than the setup.
select ok(
  passes_criteria('00000000-0000-0000-0000-000000007001',
                  '00000000-0000-0000-0000-000000007002')
  and passes_criteria('00000000-0000-0000-0000-000000007002',
                      '00000000-0000-0000-0000-000000007001'),
  'the fixture pair is eligible in both directions to start with'
);

-- --- A first pass costs rank and nothing else -------------------------------

do $$
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000007001","role":"authenticated"}',
    true
  );
  perform public.pass_introduction('00000000-0000-0000-0000-00000000700b');
end $$;

select is(
  (select decision::text from introduction_selections
   where introduction_id = '00000000-0000-0000-0000-00000000700b'),
  'released',
  'a first pass records an ordinary release, so nothing filters the pair out'
);
select is(
  (select explicit_pass_count::int from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  1,
  'the pair carries the pass, which is what costs it rank'
);

-- --- A second pass also costs time ------------------------------------------

do $$
begin
  perform public.pass_introduction('00000000-0000-0000-0000-00000000700b');
end $$;

select is(
  (select decision::text from introduction_selections
   where introduction_id = '00000000-0000-0000-0000-00000000700b'),
  'explicit_pass',
  'a second pass holds the pair apart'
);
select is(
  (select explicit_pass_count::int from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  2,
  'and is counted'
);

-- Backdated past the cooldown so expiry has something to do.
update introduction_selections
set decided_at = now() - make_interval(
  days => (halal_mode_private.active_matching_config()
           ->> 'explicit_pass_cooldown_days')::int + 1
)
where introduction_id = '00000000-0000-0000-0000-00000000700b';

do $$ begin perform halal_mode_private.expire_explicit_passes(); end $$;

select is(
  (select decision::text from introduction_selections
   where introduction_id = '00000000-0000-0000-0000-00000000700b'),
  'released',
  'expiry lifts the ban'
);
select is(
  (select explicit_pass_count::int from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  2,
  'expiry keeps the count, which is what carries the rank penalty'
);
select ok(
  (select retired_at is null from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  'passing twice does not close the pair — only a member does that'
);

-- --- A submission must not undo the decision that preceded it ---------------
--
-- submit_round_selections writes kept-or-released for every introduction in the
-- round, and a pass is made before submission because pass_introduction requires
-- an unsubmitted round. Until 0083 the submit that followed a moment later
-- overwrote 'explicit_pass' straight back to 'released', so the ban never
-- happened. Both the live check in 0080 and the first version of this file
-- called pass_introduction on its own and never followed it with the one
-- sequence every real member performs.

-- Expiry above has already returned this row to 'released', so put the ban back
-- before testing that a sweep cannot take it away.
update introduction_selections
set decision = 'explicit_pass'
where introduction_id = '00000000-0000-0000-0000-00000000700b';

update introduction_selections
set decision = 'released'
where introduction_id = '00000000-0000-0000-0000-00000000700b';

select is(
  (select decision::text from introduction_selections
   where introduction_id = '00000000-0000-0000-0000-00000000700b'),
  'explicit_pass',
  'a bulk release sweep cannot undo a deliberate pass'
);

update introduction_selections
set decision = 'kept'
where introduction_id = '00000000-0000-0000-0000-00000000700b';

select is(
  (select decision::text from introduction_selections
   where introduction_id = '00000000-0000-0000-0000-00000000700b'),
  'kept',
  'but keeping somebody wins — a member who changed their mind meant the later act'
);

update introduction_selections
set decision = 'explicit_pass'
where introduction_id = '00000000-0000-0000-0000-00000000700b';

-- --- A first pass costs a month ---------------------------------------------

select ok(
  (select cooldown_until from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002')
  >= now() + make_interval(days => (halal_mode_private.active_matching_config()
                                    ->> 'explicit_pass_first_cooldown_days')::int - 1),
  'a pass buys a month of quiet, not the ordinary repeat wait'
);
select ok(
  (halal_mode_private.active_matching_config()
   ->> 'explicit_pass_first_cooldown_days')::int
  > (halal_mode_private.active_matching_config()
     ->> 'max_repeat_cooldown_days')::int,
  'and always more than simply not being chosen'
);

-- --- The cooldown scales with the estimate ----------------------------------

update halal_mode_private.pair_exposure
set last_shown_at = now(), last_reciprocal_score = 0.60
where user_low = '00000000-0000-0000-0000-000000007001'
  and user_high = '00000000-0000-0000-0000-000000007002';

select is(
  (select cooldown_until from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  now() + make_interval(days => halal_mode_private.pair_cooldown_days(
    0.60, halal_mode_private.active_matching_config()
  )),
  'the trigger sets the wait from the score rather than a flat number'
);

update halal_mode_private.pair_exposure
set last_shown_at = now() + interval '1 second', last_reciprocal_score = 0.16
where user_low = '00000000-0000-0000-0000-000000007001'
  and user_high = '00000000-0000-0000-0000-000000007002';

select ok(
  (select cooldown_until from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002')
  > now() + interval '14 days',
  'a pair barely above the floor waits weeks, freeing the slot for somebody new'
);

-- Writes that are not a showing must not reset a cooldown already running.
update halal_mode_private.pair_exposure
set explicit_pass_count = explicit_pass_count
where user_low = '00000000-0000-0000-0000-000000007001'
  and user_high = '00000000-0000-0000-0000-000000007002';

select ok(
  (select cooldown_until from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002')
  > now() + interval '14 days',
  'an unrelated write to the pair leaves the running cooldown alone'
);

-- --- The curve --------------------------------------------------------------
--
-- These mirror repeatGenerosity() and pairCooldownDays() in
-- src/matching/estimate.ts. The two implementations have parted company once
-- already: 0077 shipped the SQL side linear after the TypeScript gained an
-- exponent, which would have handed middling pairs a fortnight they had not
-- earned, with both halves looking correct read on their own.

select is(
  halal_mode_private.repeat_generosity(
    (halal_mode_private.active_matching_config() ->> 'min_reciprocal_score')::numeric,
    halal_mode_private.active_matching_config()
  ),
  0::numeric,
  'a pair at the score floor has earned no patience'
);
select is(
  halal_mode_private.repeat_generosity(
    (halal_mode_private.active_matching_config() ->> 'repeat_generous_score')::numeric,
    halal_mode_private.active_matching_config()
  ),
  1::numeric,
  'a pair at the anchor has earned all of it'
);
select is(
  halal_mode_private.repeat_generosity(0.375, halal_mode_private.active_matching_config()),
  0.25::numeric,
  'halfway up the range earns a quarter, not half — the curve is what reserves
   the short waits for the top rather than for everyone above average'
);
select ok(
  halal_mode_private.pair_cooldown_days(0.60, halal_mode_private.active_matching_config())
  < halal_mode_private.pair_cooldown_days(0.30, halal_mode_private.active_matching_config()),
  'the wait runs against the estimate, not with it'
);

-- --- Soft select ------------------------------------------------------------
--
-- The one positive outcome. Refused outright on a pair that has been passed:
-- the member already answered that question in the other direction.

do $$
begin
  perform public.soft_select_introduction('00000000-0000-0000-0000-00000000700b');
end $$;

select is(
  (select coalesce(soft_select_count, 0)::int from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  0,
  'a passed pair is never soft selected, whatever the reading time said'
);

-- A clean pair, to see it actually record.
insert into rounds (id, user_id, tier, expires_at) values
  ('00000000-0000-0000-0000-00000000700c', '00000000-0000-0000-0000-000000007002',
   'free', now() + interval '1 day');
insert into introductions (id, round_id, viewer_id, subject_id) values
  ('00000000-0000-0000-0000-00000000700d', '00000000-0000-0000-0000-00000000700c',
   '00000000-0000-0000-0000-000000007002', '00000000-0000-0000-0000-000000007001');

do $$
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000007002","role":"authenticated"}',
    true
  );
  -- Clear the passes so this pair is eligible for the positive signal.
  update halal_mode_private.pair_exposure set explicit_pass_count = 0
  where user_low = '00000000-0000-0000-0000-000000007001'
    and user_high = '00000000-0000-0000-0000-000000007002';
  perform public.soft_select_introduction('00000000-0000-0000-0000-00000000700d');
end $$;

select is(
  (select soft_select_count::int from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  1,
  'reading somebody at length and having no keep left is recorded'
);
select is(
  (select decision::text from introduction_selections
   where introduction_id = '00000000-0000-0000-0000-00000000700d'),
  'soft_select',
  'and is its own outcome, not an ordinary release'
);

do $$
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000007001","role":"authenticated"}',
    true
  );
end $$;

-- --- Hiding -----------------------------------------------------------------

do $$
begin
  perform public.hide_introduction_member('00000000-0000-0000-0000-00000000700b');
end $$;

select ok(
  halal_mode_private.pair_is_hidden('00000000-0000-0000-0000-000000007002',
                                    '00000000-0000-0000-0000-000000007001'),
  'hiding runs both ways — it is worthless if you still appear in theirs'
);
select ok(
  not passes_criteria('00000000-0000-0000-0000-000000007002',
                      '00000000-0000-0000-0000-000000007001'),
  'a hidden pair fails the eligibility gate from the side that did not hide'
);
select is(
  (select retired_reason from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000007001'
     and user_high = '00000000-0000-0000-0000-000000007002'),
  'hidden',
  'hiding retires the pair outright, whatever its score does later'
);

-- --- The boundary holds -----------------------------------------------------

do $$
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000007002","role":"authenticated"}',
    true
  );
end $$;

select throws_ok(
  $$ select public.pass_introduction('00000000-0000-0000-0000-00000000700b') $$,
  '42501',
  null,
  'a member cannot pass an introduction that is not theirs'
);

-- --- Grants -----------------------------------------------------------------

select ok(
  has_function_privilege('authenticated', 'public.pass_introduction(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.hide_introduction_member(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.hide_connection_member(uuid)', 'EXECUTE'),
  'members can pass and hide through the relationship-scoped entry points'
);
select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.expire_explicit_passes()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'halal_mode_private.hide_pair(uuid, uuid)', 'EXECUTE')
  and not has_table_privilege('authenticated', 'halal_mode_private.member_hides', 'SELECT'),
  'and cannot reach the machinery behind them, or read who has hidden whom'
);
select ok(
  has_function_privilege('authenticated', 'public.soft_select_introduction(uuid)', 'EXECUTE'),
  'soft select is a member action like the rest'
);

select * from finish();
rollback;
