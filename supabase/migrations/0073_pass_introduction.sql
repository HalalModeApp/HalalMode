-- Give `explicit_pass` a way to be written.
--
-- 0050 added the enum value and four later migrations read it — the prefilter,
-- the plan validator, the finaliser and now the expiry in 0070 all branch on
-- it. Nothing has ever produced one. Every "no" a member has ever given has
-- been recorded as `released`, which the matcher treats as situational, so the
-- distinction those four call sites are careful about has been describing a
-- state that could not occur.
--
-- A pass is deliberately not a separate gesture in the interface. Asking people
-- to choose between two kinds of no, on every face, every day, would make a
-- quiet screen into an interrogation — and the second option would be picked by
-- mood as much as by meaning. It is inferred instead from how long a profile
-- was actually read, and then confirmed once, in the member's own words, before
-- the round is submitted.
--
-- Upgrading a release rather than replacing it: by the time the member confirms,
-- the release has already been recorded. The conflict clause is what makes this
-- the same decision reconsidered rather than a second one.

create or replace function public.pass_introduction(p_introduction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_viewer uuid := auth.uid();
  v_introduction introductions%rowtype;
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform halal_mode_private.require_current_legal_consents(v_viewer);

  -- Same gate as release_introduction: the member's own live, unsubmitted
  -- round. A pass cannot be applied to someone else's card, or after the fact.
  select i.* into v_introduction
  from introductions i
  join rounds r on r.id = i.round_id
  where i.id = p_introduction_id
    and i.viewer_id = v_viewer
    and r.user_id = v_viewer
    and r.submitted_at is null
    and r.expires_at > now();

  if v_introduction is null then
    raise exception 'Introduction is not available' using errcode = '42501';
  end if;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  values (v_introduction.id, v_viewer, v_introduction.subject_id, 'explicit_pass')
  on conflict (introduction_id) do update
    set viewer_id = excluded.viewer_id,
        subject_id = excluded.subject_id,
        decision = 'explicit_pass',
        decided_at = now()
    where introduction_selections.viewer_id = v_viewer;
end;
$$;

comment on function public.pass_introduction(uuid) is
  'Records a deliberate pass rather than a release. Holds for explicit_pass_cooldown_days and then expires; a second pass, months later, retires the pair. The subject is never told.';

revoke all on function public.pass_introduction(uuid) from public, anon;
grant execute on function public.pass_introduction(uuid) to authenticated;
