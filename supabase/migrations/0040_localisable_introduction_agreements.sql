-- Store semantic agreement keys only. The app renders them in the member's
-- language, while the server continues to reveal no private thresholds.
create or replace function public.agreement_summary(p_viewer uuid, p_subject uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a profiles%rowtype; b profiles%rowtype; result jsonb := '[]'::jsonb;
begin
  select * into a from profiles where id = p_viewer;
  select * into b from profiles where id = p_subject;
  if a.timeline = b.timeline then result := result || jsonb_build_array(jsonb_build_object('key', 'marriage_timing')); end if;
  if a.family_goals = b.family_goals then result := result || jsonb_build_array(jsonb_build_object('key', 'family_plans')); end if;
  if lower(trim(a.city)) = lower(trim(b.city)) and lower(trim(a.country)) = lower(trim(b.country)) then result := result || jsonb_build_array(jsonb_build_object('key', 'same_city'));
  elsif a.relocation = b.relocation then result := result || jsonb_build_array(jsonb_build_object('key', 'relocation')); end if;
  return result;
end;
$$;
revoke all on function public.agreement_summary(uuid, uuid) from public, anon, authenticated;
