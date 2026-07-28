-- Row Level Security.
--
-- Default posture: deny. Every table below is enabled, and tables with no
-- policy (selection_scores, question_answers) are therefore unreachable from
-- anon and authenticated roles entirely — reachable only through the
-- security-definer functions in 0003.

alter table profiles                enable row level security;
alter table private_preferences     enable row level security;
alter table selection_scores        enable row level security;
alter table rounds                  enable row level security;
alter table introductions           enable row level security;
alter table introduction_selections enable row level security;
alter table connections             enable row level security;
alter table question_picks          enable row level security;
alter table question_answers        enable row level security;
alter table messages                enable row level security;
alter table blocks                  enable row level security;
alter table reports                 enable row level security;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create policy "own profile is readable"
  on profiles for select
  using (id = auth.uid());

-- A profile is visible to someone else only while that person actually has an
-- introduction to them, or an open connection with them. There is no browse.
create policy "introduced profiles are readable"
  on profiles for select
  using (
    exists (
      select 1 from introductions i
      where i.subject_id = profiles.id
        and i.viewer_id = auth.uid()
    )
    or exists (
      select 1 from connections c
      where c.closed_at is null
        and (
          (c.user_a = auth.uid() and c.user_b = profiles.id) or
          (c.user_b = auth.uid() and c.user_a = profiles.id)
        )
    )
  );

create policy "own profile is writable"
  on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Private preferences — strictly owner-only, in both directions
-- ---------------------------------------------------------------------------

create policy "own preferences only"
  on private_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- selection_scores: no policy on purpose. Nobody reads their own score either —
-- exposing it would turn it into the popularity rating the product refuses to be.

-- ---------------------------------------------------------------------------
-- Rounds and introductions
-- ---------------------------------------------------------------------------

create policy "own rounds"
  on rounds for select
  using (user_id = auth.uid());

create policy "own introductions"
  on introductions for select
  using (viewer_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Selections
--
-- A member may read and write their own decisions. Crucially there is no policy
-- allowing a subject to read rows where they are the subject — that is what
-- keeps "who chose me" unknowable until the matcher says it is mutual.
-- ---------------------------------------------------------------------------

create policy "own selections readable"
  on introduction_selections for select
  using (viewer_id = auth.uid());

create policy "own selections writable"
  on introduction_selections for insert
  with check (
    viewer_id = auth.uid()
    and exists (
      select 1 from introductions i
      where i.id = introduction_id
        and i.viewer_id = auth.uid()
    )
  );

create policy "own selections updatable"
  on introduction_selections for update
  using (viewer_id = auth.uid())
  with check (viewer_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Connections and conversation
-- ---------------------------------------------------------------------------

create policy "own connections"
  on connections for select
  using (user_a = auth.uid() or user_b = auth.uid());

create policy "own question picks"
  on question_picks for all
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from connections c
      where c.id = connection_id
        and c.closed_at is null
        and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

-- question_answers: no policy. `submit_answer` is the only path in or out, so
-- the double-blind reveal cannot be bypassed by querying the table directly.

create policy "messages in own open connections"
  on messages for select
  using (
    exists (
      select 1 from connections c
      where c.id = connection_id
        and c.closed_at is null
        and c.stage = 'open'
        and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

create policy "send to own open connections"
  on messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from connections c
      where c.id = connection_id
        and c.closed_at is null
        and c.stage = 'open'
        and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------------

create policy "own blocks"
  on blocks for all
  using (blocker_id = auth.uid())
  with check (blocker_id = auth.uid());

create policy "own reports are writable"
  on reports for insert
  with check (reporter_id = auth.uid());

-- Reporters cannot read reports back. Nothing about moderation outcomes leaks
-- to either party.
