-- Matcher V3 is intentionally shipped as an inactive config row.  Matcher V2
-- (greedy_global_v1) remains the active default until shadow evidence shows
-- that predicted mutual first choices improve without starving the pool.
-- The allocator enum is already validated by the database for the earlier
-- anchored prototype; the new run label is recorded by the Edge Function.

do $$
declare
  v_params jsonb;
begin
  select params
    into v_params
  from halal_mode_private.matching_config
  where activated_at is not null
  order by version desc
  limit 1;

  if v_params is null then
    raise exception 'Cannot seed Matcher V3 without an active matching config';
  end if;

  v_params := jsonb_set(
    v_params,
    '{allocator}',
    to_jsonb('anchored_maxmin_v1'::text),
    true
  );

  insert into halal_mode_private.matching_config (
    params,
    notes,
    activated_at,
    source
  )
  values (
    v_params,
    'Matcher V3 shadow candidate: anchors predicted mutual first choices',
    null,
    'policy'
  );
end;
$$;
