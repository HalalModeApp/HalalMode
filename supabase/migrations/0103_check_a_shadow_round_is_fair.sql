-- Is the round the new matcher planned actually fair, and actually reciprocal?
--
-- Pair counts alone cannot answer that. Thirty-five pairs across fourteen
-- members averages five each, and would read identically whether everyone got
-- five or half the cohort got nine and the rest got one. Averages are exactly
-- where an unfair round hides.
--
-- Two properties decide whether the flag can be turned on. Every member should
-- receive the introductions their tier allows, and if A is shown B then B must
-- be shown A — the promise the whole product rests on. This reports the spread
-- and any breach of reciprocity, without returning who anyone is.

create or replace function public.shadow_round_shape_service(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  with per_member as (
    select viewer_id, count(*) as shown
    from halal_mode_private.shadow_round_edges
    where run_id = p_run_id
    group by viewer_id
  ), one_sided as (
    select count(*) as broken
    from halal_mode_private.shadow_round_edges e
    where e.run_id = p_run_id
      and not exists (
        select 1 from halal_mode_private.shadow_round_edges back
        where back.run_id = e.run_id
          and back.viewer_id = e.subject_id
          and back.subject_id = e.viewer_id
      )
  )
  select jsonb_build_object(
    'members_served', (select count(*) from per_member),
    'fewest_shown', (select min(shown) from per_member),
    'most_shown', (select max(shown) from per_member),
    'average_shown', (select round(avg(shown), 2) from per_member),
    'one_sided_edges', (select broken from one_sided),
    'total_edges', (select count(*) from halal_mode_private.shadow_round_edges where run_id = p_run_id)
  );
$$;

revoke all on function public.shadow_round_shape_service(uuid) from public, anon, authenticated;
grant execute on function public.shadow_round_shape_service(uuid) to service_role;
