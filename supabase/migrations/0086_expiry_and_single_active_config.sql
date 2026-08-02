-- Two faults CI found the moment it could run.
--
-- ---------------------------------------------------------------------------
-- 1. The trigger that protects a pass also stopped it ever expiring
-- ---------------------------------------------------------------------------
--
-- 0083 added keep_deliberate_decisions so a submission could not sweep an
-- 'explicit_pass' back to 'released'. expire_explicit_passes performs exactly
-- that transition on purpose, so the guard reverted it silently and bans became
-- permanent — the opposite of what the whole cooldown exists for.
--
-- Missed because 0080 checked expiry before the trigger existed, and 0085
-- checked the trigger without re-checking expiry. Each migration verified its
-- own change against the world as it was when it was written.
--
-- A transaction-scoped flag, following the same shape the consent-history guard
-- already uses: the exception is named, narrow, and only reachable from a
-- private function that no member can call.

create or replace function halal_mode_private.keep_deliberate_decisions()
returns trigger
language plpgsql
set search_path = pg_catalog, public as $$
begin
  -- The expiry is the one legitimate downgrade. It says the cooldown is served,
  -- which is a decision about time rather than about the member's meaning.
  if coalesce(current_setting('app.expiring_explicit_passes', true), '') = 'true' then
    return new;
  end if;

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

create or replace function halal_mode_private.expire_explicit_passes()
returns integer
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cooldown_days int := coalesce(
    (halal_mode_private.active_matching_config() ->> 'explicit_pass_cooldown_days')::int,
    90
  );
  expired int := 0;
begin
  -- Scoped to this statement's transaction, so the guard is down only for the
  -- rows this function is about to touch and cannot be left open behind it.
  perform set_config('app.expiring_explicit_passes', 'true', true);

  update public.introduction_selections s
  set decision = 'released'
  where s.decision = 'explicit_pass'
    and s.decided_at < now() - make_interval(days => cooldown_days);

  get diagnostics expired = row_count;

  perform set_config('app.expiring_explicit_passes', 'false', true);
  return expired;
end;
$$;

revoke all on function halal_mode_private.expire_explicit_passes() from public, anon, authenticated;
revoke all on function halal_mode_private.keep_deliberate_decisions() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Eight configurations all claimed to be active
-- ---------------------------------------------------------------------------
--
-- Every config migration since 0049 has inserted its version with
-- `activated_at = now()` and left the previous rows activated too. Nothing
-- broke, because both accessors take `order by version desc limit 1` — but
-- "activated_at is not null" stopped meaning anything, and the schema's own
-- contract says exactly one version is active at a time.
--
-- The history is the point of the table, so old rows stay; they are simply no
-- longer claiming to be current. A trigger enforces it from here, because the
-- alternative is remembering to deactivate by hand in every future migration,
-- and eight in a row already show how that goes.

create or replace function halal_mode_private.single_active_matching_config()
returns trigger
language plpgsql
set search_path = pg_catalog, halal_mode_private as $$
begin
  if new.activated_at is null then return null; end if;
  update halal_mode_private.matching_config
  set activated_at = null
  where version <> new.version
    and activated_at is not null;
  return null;
end;
$$;

drop trigger if exists matching_config_single_active on halal_mode_private.matching_config;
create trigger matching_config_single_active
  after insert on halal_mode_private.matching_config
  for each row execute function halal_mode_private.single_active_matching_config();

revoke all on function halal_mode_private.single_active_matching_config()
  from public, anon, authenticated;

-- Retiring them turned out to be impossible while the params check applied to
-- every row. Each config version legitimately has the key set of its own era, so
-- the current validator rejects all seven predecessors — which made the history
-- table simultaneously immutable and invalid, and meant no old row could even be
-- stood down. The check belongs to whichever row claims to be current; a
-- deactivated version is a record of what was once true, not a promise about
-- today. Dropped first, because adding it back would re-validate rows that are
-- still activated at that moment.
alter table halal_mode_private.matching_config
  drop constraint if exists matching_config_params_check;

update halal_mode_private.matching_config
set activated_at = null
where activated_at is not null
  and version <> (select max(version) from halal_mode_private.matching_config);

alter table halal_mode_private.matching_config
  add constraint matching_config_params_check
  check (activated_at is null or halal_mode_private.matching_config_params_valid(params));

do $$
declare
  v_active int;
begin
  select count(*) into v_active
  from halal_mode_private.matching_config where activated_at is not null;
  assert v_active = 1,
    format('exactly one configuration should be active; found %s', v_active);

  assert halal_mode_private.active_matching_config_version()
       = (select max(version) from halal_mode_private.matching_config),
    'the active version should be the newest one';
end;
$$;
