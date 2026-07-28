-- New auth users have no profile until they deliberately complete onboarding.
-- A security-definer RPC is used because profile creation must be tied to
-- auth.uid(), never to a client-supplied user id.

create or replace function complete_onboarding(
  p_name text,
  p_first_name text,
  p_birth_date date,
  p_gender text,
  p_city text,
  p_country text
) returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'You must be signed in'; end if;
  perform set_config('app.onboarding_rpc', 'true', true);
  if length(trim(p_name)) < 2 or length(trim(p_first_name)) < 1 then
    raise exception 'Please provide your name';
  end if;
  if p_birth_date > current_date - interval '18 years' then
    raise exception 'You must be at least 18 years old';
  end if;
  if p_gender not in ('male', 'female') then raise exception 'Choose a gender'; end if;
  if length(trim(p_city)) < 2 or length(trim(p_country)) < 2 then
    raise exception 'Please provide your city and country';
  end if;

  insert into profiles (id, name, first_name, birth_date, gender, city, country, onboarding_complete)
  values (
    v_user_id, trim(p_name), trim(p_first_name), p_birth_date,
    p_gender::gender, trim(p_city), trim(p_country), true
  )
  on conflict (id) do update set
    name = excluded.name,
    first_name = excluded.first_name,
    birth_date = excluded.birth_date,
    gender = excluded.gender,
    city = excluded.city,
    country = excluded.country,
    onboarding_complete = true,
    updated_at = now();

  insert into private_preferences (user_id) values (v_user_id)
  on conflict (user_id) do nothing;
  insert into selection_scores (user_id) values (v_user_id)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function complete_onboarding(text, text, date, text, text, text) from public;
grant execute on function complete_onboarding(text, text, date, text, text, text) to authenticated;
