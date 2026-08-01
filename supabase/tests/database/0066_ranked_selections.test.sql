begin;

set local search_path = public, extensions;
select plan(8);

-- Rank is a private ordering. Nothing about it may reach the other member: being
-- told you were somebody's third choice is exactly the comparison this product
-- exists to avoid.

select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.record_selection_ranks(uuid, uuid, uuid[])', 'EXECUTE'),
  'members cannot write a rank directly'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.mutual_first_choices', 'SELECT'),
  'members cannot read who ranked whom first'
);
select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.matching_outcome_metrics(timestamptz)', 'EXECUTE'),
  'outcome metrics are service-role only'
);
select ok(
  has_function_privilege('authenticated', 'public.submit_round_selections_ranked(uuid, uuid[])', 'EXECUTE'),
  'members submit their own ordered keeps'
);

-- The column exists, is bounded, and is optional for non-keeps.

select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'introduction_selections' and column_name = 'rank'),
  1,
  'rank is recorded on the selection'
);
select col_is_null('public', 'introduction_selections', 'rank',
  'released, passed and expired rows carry no rank');

-- One first choice per member. A second rank 1 is a contradiction, not a tie.
select ok(
  (select count(*) from pg_indexes
   where schemaname = 'public' and indexname = 'introduction_selections_rank_idx') = 1,
  'a member cannot hold two selections at the same rank'
);

-- Mutual first choice is stricter than a mutual match: both must have said one.
select ok(
  (select count(*) from pg_views
   where schemaname = 'halal_mode_private' and viewname = 'mutual_first_choices') = 1,
  'mutual first choice is derived, not stored twice'
);

select * from finish();
rollback;
