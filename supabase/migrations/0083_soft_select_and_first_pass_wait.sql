-- Three things: a bug, a longer wait after a first pass, and soft select.
--
-- ---------------------------------------------------------------------------
-- 1. Submitting a round erased the pass that had just been made
-- ---------------------------------------------------------------------------
--
-- submit_round_selections writes a row per introduction, kept or released, with
-- `on conflict (introduction_id) do update set decision = excluded.decision`.
-- A pass is recorded before submission — pass_introduction requires an
-- unsubmitted round — so the submit that followed it a moment later overwrote
-- 'explicit_pass' straight back to 'released'.
--
-- The count on pair_exposure survived, being a different table, so the rank
-- penalty worked. The ban did not: all four places that hold a passed pair
-- apart read the decision, and by the time they looked it said 'released'. A
-- second pass has therefore never actually banned anybody.
--
-- Missed because both the live check in 0080 and the pgTAP suite called
-- pass_introduction on its own and never followed it with a submission — the
-- one sequence a real member always performs.
--
-- Fixed with a trigger rather than by restating submit_round_selections, for
-- the same reason as the cooldown: several functions write this table, the
-- invariant belongs to the column, and a future writer should get it right
-- without having to know this happened.

create or replace function halal_mode_private.keep_deliberate_decisions()
returns trigger
language plpgsql
set search_path = pg_catalog, public as $$
begin
  -- Keeping somebody always wins: a member who passed and then kept has plainly
  -- changed their mind, and the later act is the true one. What must not happen
  -- is a bulk 'released' sweep quietly undoing a decision made on purpose.
  if new.decision = 'released'
     and old.decision in ('explicit_pass', 'soft_select') then
    new.decision := old.decision;
    new.decided_at := old.decided_at;
  end if;
  return new;
end;
$$;

drop trigger if exists introduction_selections_keep_deliberate
  on public.introduction_selections;
create trigger introduction_selections_keep_deliberate
  before update on public.introduction_selections
  for each row execute function halal_mode_private.keep_deliberate_decisions();

revoke all on function halal_mode_private.keep_deliberate_decisions()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A first pass now costs real time
-- ---------------------------------------------------------------------------
--
-- It used to cost rank and nothing else, leaving the pair on the ordinary
-- two-to-twenty-one day wait everybody gets for having been shown. That is too
-- light for a deliberate no: the member said they did not want this person, and
-- seeing them again the same week reads as not having been listened to.
--
-- A floor rather than a replacement, so a weak pair that already owed three
-- weeks is not shortened to thirty days by the pass.

create or replace function public.pass_introduction(p_introduction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_viewer uuid := auth.uid();
  v_introduction introductions%rowtype;
  v_cfg jsonb;
  v_ban_after int;
  v_first_wait int;
  v_passes int;
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform halal_mode_private.require_current_legal_consents(v_viewer);

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

  v_cfg := halal_mode_private.active_matching_config();
  v_ban_after := coalesce((v_cfg ->> 'explicit_pass_ban_after')::int, 2);
  v_first_wait := coalesce((v_cfg ->> 'explicit_pass_first_cooldown_days')::int, 30);

  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, explicit_pass_count, cooldown_until
  )
  values (
    least(v_viewer, v_introduction.subject_id),
    greatest(v_viewer, v_introduction.subject_id),
    1,
    now() + make_interval(days => v_first_wait)
  )
  on conflict (user_low, user_high) do update
    set explicit_pass_count = pe.explicit_pass_count + 1,
        -- Greatest, so a pass lengthens a wait and never shortens one.
        cooldown_until = greatest(
          coalesce(pe.cooldown_until, now()),
          now() + make_interval(days => v_first_wait)
        )
  returning pe.explicit_pass_count into v_passes;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  values (
    v_introduction.id, v_viewer, v_introduction.subject_id,
    case
      when v_passes >= v_ban_after then 'explicit_pass'::selection_decision
      else 'released'::selection_decision
    end
  )
  on conflict (introduction_id) do update
    set viewer_id = excluded.viewer_id,
        subject_id = excluded.subject_id,
        decision = excluded.decision,
        decided_at = now()
    where introduction_selections.viewer_id = v_viewer;
end;
$$;

comment on function public.pass_introduction(uuid) is
  'Records a deliberate pass. The first costs the pair rank and a month of quiet; from the second it also holds them apart for explicit_pass_cooldown_days. Never closes a pair for good — only a member does that, by hiding someone.';

revoke all on function public.pass_introduction(uuid) from public, anon;
grant execute on function public.pass_introduction(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Soft select
-- ---------------------------------------------------------------------------
--
-- Every outcome until now has been a shade of no. But a free member keeps one
-- of five: the person they read for longest after the one they kept is not a
-- rejection, they are a casualty of the budget. Recording that as an ordinary
-- release throws away the strongest positive signal a round produces.
--
-- Unlike a pass, this is not confirmed. A pass is an accusation of sorts and
-- gets a question; this only says "we noticed", costs the member nothing if it
-- is wrong, and asking would turn a quiet screen into a quiz. It is as private
-- as every other selection: the subject is never told, here or anywhere.

alter table halal_mode_private.pair_exposure
  add column if not exists soft_select_count smallint not null default 0;

comment on column halal_mode_private.pair_exposure.soft_select_count is
  'Times this pair was read at length but left unkept for want of a slot. Lifts the pair prior, which raises both its rank and, through the score, how soon it may return.';

create or replace function public.soft_select_introduction(p_introduction_id uuid)
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

  -- A pair that has been passed is not soft selected, whatever the reading time
  -- says. The member has already answered that question in the other direction.
  if exists (
    select 1 from halal_mode_private.pair_exposure
    where user_low = least(v_viewer, v_introduction.subject_id)
      and user_high = greatest(v_viewer, v_introduction.subject_id)
      and explicit_pass_count > 0
  ) then
    return;
  end if;

  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, soft_select_count
  )
  values (
    least(v_viewer, v_introduction.subject_id),
    greatest(v_viewer, v_introduction.subject_id),
    1
  )
  on conflict (user_low, user_high) do update
    set soft_select_count = pe.soft_select_count + 1;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  values (
    v_introduction.id, v_viewer, v_introduction.subject_id,
    'soft_select'::selection_decision
  )
  on conflict (introduction_id) do update
    set viewer_id = excluded.viewer_id,
        subject_id = excluded.subject_id,
        decision = 'soft_select'::selection_decision,
        decided_at = now()
    where introduction_selections.viewer_id = v_viewer
      and introduction_selections.decision = 'released';
end;
$$;

comment on function public.soft_select_introduction(uuid) is
  'Records that this member read the subject at length but had no keep left to give. Private, never disclosed, and never applied to a pair that has been passed.';

revoke all on function public.soft_select_introduction(uuid) from public, anon;
grant execute on function public.soft_select_introduction(uuid) to authenticated;
