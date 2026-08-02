-- Name both sides of where a configuration version came from.
--
-- 0089 added `machine_tuned boolean`, which says what a row is not. Reading a
-- version and learning `machine_tuned = false` tells you the tuner did not
-- write it; it does not tell you a person sat down and decided something.
--
-- The instinct to name the other side is right, but a second boolean would be
-- the wrong shape: two flags can be set at once, or neither, and a row that
-- claims to be both hand-written and machine-tuned means nothing at all. One
-- column that names both origins cannot contradict itself.
--
-- 'policy' rather than 'hand_crafted' because it describes what the row *is* — a
-- decision about how the product should behave — rather than how it was
-- produced. And a checked text column takes a third origin later without a
-- schema change: a rollback to earlier params, an experiment arm, or an import
-- from another environment are all plausible, and none of them is a boolean.

alter table halal_mode_private.matching_config
  add column if not exists source text not null default 'policy'
  check (source in ('policy', 'tuning'));

update halal_mode_private.matching_config
set source = case when machine_tuned then 'tuning' else 'policy' end;

alter table halal_mode_private.matching_config drop column machine_tuned;

comment on column halal_mode_private.matching_config.source is
  'Who decided this version: ''policy'' for a person, ''tuning'' for the weight tuner. The tuner keeps its own detailed trail in matching_weight_adjustments; this exists so the history can be read for decisions without wading through automatic nudges.';

create or replace function halal_mode_private.tune_matching_weights()
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb;
  weights jsonb;
  next_weights jsonb := '{}'::jsonb;
  from_version int;
  to_version int;
  max_step numeric;
  min_w numeric;
  max_w numeric;
  min_samples int;
  gain numeric;
  total numeric := 0;
  row_lift record;
  criterion text;
  old_w numeric;
  new_w numeric;
  moved int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Weight tuning requires service role' using errcode = '42501';
  end if;

  cfg := halal_mode_private.active_matching_config();
  from_version := halal_mode_private.active_matching_config_version();
  if coalesce((cfg ->> 'tuning_enabled')::boolean, false) is not true then
    return jsonb_build_object('skipped', 'tuning_disabled');
  end if;

  weights := coalesce(cfg -> 'weights', '{}'::jsonb);
  max_step := coalesce((cfg ->> 'max_weight_step')::numeric, 0.02);
  min_w := coalesce((cfg ->> 'min_criterion_weight')::numeric, 0.01);
  max_w := coalesce((cfg ->> 'max_criterion_weight')::numeric, 0.35);
  min_samples := coalesce((cfg ->> 'tuning_min_samples')::int, 200);
  gain := coalesce((cfg ->> 'tuning_gain')::numeric, 0.5);

  -- Start from the current weights; anything without enough evidence stays put.
  next_weights := weights;

  for row_lift in
    select * from halal_mode_private.criterion_lift()
  loop
    criterion := row_lift.criterion;
    if not (weights ? criterion) then continue; end if;
    if row_lift.sample_size < min_samples then continue; end if;

    old_w := (weights ->> criterion)::numeric;
    new_w := old_w * (1 + gain * row_lift.lift);

    -- Bounded in both senses: a limited move, inside a reviewed range.
    new_w := least(old_w + max_step, greatest(old_w - max_step, new_w));
    new_w := least(max_w, greatest(min_w, new_w));

    if abs(new_w - old_w) < 0.0005 then continue; end if;
    next_weights := next_weights || jsonb_build_object(criterion, round(new_w, 4));
    moved := moved + 1;
  end loop;

  if moved = 0 then
    return jsonb_build_object('skipped', 'no_criterion_had_enough_evidence');
  end if;

  -- Renormalise so the weights still describe shares of one whole.
  select sum((value #>> '{}')::numeric) into total from jsonb_each(next_weights);
  if total is null or total <= 0 then
    return jsonb_build_object('skipped', 'degenerate_weights');
  end if;
  select jsonb_object_agg(key, round(((value #>> '{}')::numeric / total), 4))
  into next_weights from jsonb_each(next_weights);

  -- The version comes from the sequence rather than max + 1, so a policy change
  -- landing at the same moment cannot collide with this one on the primary key.
  insert into halal_mode_private.matching_config (params, notes, activated_at, source)
  values (
    cfg || jsonb_build_object('weights', next_weights),
    'Automatic weight adjustment from observed mutual first choices.',
    now(),
    'tuning'
  )
  returning version into to_version;

  for row_lift in select * from halal_mode_private.criterion_lift() loop
    if not (weights ? row_lift.criterion) then continue; end if;
    insert into halal_mode_private.matching_weight_adjustments (
      from_version, to_version, criterion, old_weight, new_weight,
      observed_lift, sample_size
    ) values (
      from_version, to_version, row_lift.criterion,
      (weights ->> row_lift.criterion)::numeric,
      (next_weights ->> row_lift.criterion)::numeric,
      row_lift.lift, row_lift.sample_size
    );
  end loop;

  return jsonb_build_object(
    'from_version', from_version,
    'to_version', to_version,
    'criteria_moved', moved,
    'weights', next_weights
  );
end;
$$;

do $$
declare
  v_result jsonb;
  v_before int;
begin
  assert (select count(*) from halal_mode_private.matching_config
          where source = 'policy') =
         (select count(*) from halal_mode_private.matching_config),
    'every version so far was decided by a person';

  select count(*) into v_before from halal_mode_private.matching_config;
  v_result := public.tune_matching_weights_service();
  assert v_result ? 'skipped',
    format('the tuner should still decline with no evidence; it returned %s', v_result);
  assert (select count(*) from halal_mode_private.matching_config) = v_before,
    'a declined tuning run must still not insert a version';

  -- The column must refuse anything it does not name, or it is a comment.
  begin
    insert into halal_mode_private.matching_config (params, notes, source)
    values ('{}'::jsonb, 'invalid source', 'guesswork');
    raise exception 'the source check should have refused an unnamed origin';
  exception
    when check_violation then null;
  end;
end;
$$;
