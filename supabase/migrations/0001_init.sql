-- Halal Mode — core schema.
--
-- Two rules shape everything below:
--   1. Private preferences and selection scores never leave the server.
--   2. Selections are invisible unless they are mutual.
--
-- Anything that would let a client infer who chose them, who passed on them, or
-- how they compare to anyone else is deliberately unreachable from the API.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type gender as enum ('male', 'female');

create type religious_practice as enum (
  'very_practicing', 'practicing', 'moderate', 'learning'
);

create type marriage_timeline as enum (
  'within_3_months', 'within_6_months', 'within_1_year', '1_to_2_years'
);

create type relocation_preference as enum (
  'open', 'preferred_local', 'strictly_local', 'willing_abroad'
);

create type family_goals as enum (
  'wants_children_soon', 'wants_children_later', 'open_to_children', 'no_children'
);

create type membership_tier as enum ('free', 'plus');

create type selection_decision as enum ('kept', 'released', 'expired');

create type connection_stage as enum (
  'choosing_questions', 'answering', 'recap', 'open', 'closed'
);

-- ---------------------------------------------------------------------------
-- Profiles — the public half of a member
-- ---------------------------------------------------------------------------

create table profiles (
  id                uuid primary key references auth.users on delete cascade,
  name              text not null,
  first_name        text not null,
  birth_date        date not null,
  gender            gender not null,
  occupation        text not null default '',
  education         text,
  city              text not null default '',
  country           text not null default '',
  -- Coarse location for distance filtering. Never returned to other members;
  -- only the derived "within N km" boolean reaches the matcher.
  latitude          double precision,
  longitude         double precision,
  bio               text not null default '',
  photos            text[] not null default '{}',
  chips             text[] not null default '{}',
  religious_practice religious_practice not null default 'practicing',
  timeline          marriage_timeline not null default 'within_1_year',
  relocation        relocation_preference not null default 'open',
  family_goals      family_goals not null default 'wants_children_soon',
  languages_spoken  text[] not null default '{}',
  audio_greeting_url text,
  audio_duration_seconds int,
  tier              membership_tier not null default 'free',
  is_verified       boolean not null default false,
  is_paused         boolean not null default false,
  onboarding_complete boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index profiles_active_idx
  on profiles (gender, is_paused)
  where onboarding_complete and not is_paused;

comment on column profiles.photos is
  'Storage paths in the `photos` bucket. Beauty/face-altering filters are a policy violation, enforced at moderation.';

-- ---------------------------------------------------------------------------
-- Private preferences — readable only by the owner
-- ---------------------------------------------------------------------------

create table private_preferences (
  user_id            uuid primary key references profiles on delete cascade,
  min_age            int not null default 18 check (min_age >= 18),
  max_age            int not null default 40,
  min_height_cm      int not null default 150,
  max_height_cm      int not null default 200,
  preferred_builds   text[] not null default '{}',
  preferred_countries text[] not null default '{}',
  max_distance_km    int not null default 100,
  preferred_practice religious_practice[] not null default '{}',
  desired_timeline   marriage_timeline[] not null default '{}',
  -- The member's own figures. Never rendered on a profile, never returned to
  -- another member — only compared inside the matcher.
  own_height_cm      int,
  own_weight_kg      int,
  own_build          text,
  updated_at         timestamptz not null default now(),
  check (min_age <= max_age),
  check (min_height_cm <= max_height_cm)
);

-- ---------------------------------------------------------------------------
-- Selection score — private, internal, never displayed
-- ---------------------------------------------------------------------------

create table selection_scores (
  user_id        uuid primary key references profiles on delete cascade,
  -- Rolling rate at which this member is kept when shown. Not an attractiveness
  -- rating and never surfaced in any API response.
  score          numeric(5,4) not null default 0.5000,
  -- Coarse band the matcher pairs within. Bands are broad on purpose so nobody
  -- is pinned to a narrow tier.
  band           smallint not null default 3 check (band between 1 and 5),
  times_shown    int not null default 0,
  times_kept     int not null default 0,
  last_recomputed_at timestamptz not null default now()
);

comment on table selection_scores is
  'Internal only. No RLS policy grants select to any role other than service_role.';

-- ---------------------------------------------------------------------------
-- Rounds and introductions
-- ---------------------------------------------------------------------------

create table rounds (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  tier       membership_tier not null,
  opens_at   timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index rounds_open_per_user_idx
  on rounds (user_id)
  where submitted_at is null;

create table introductions (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references rounds on delete cascade,
  -- Whose round this card belongs to.
  viewer_id     uuid not null references profiles on delete cascade,
  -- Who is being shown.
  subject_id    uuid not null references profiles on delete cascade,
  -- The reciprocal twin. Guarantees that if Mo sees Lama, Lama sees Mo.
  reciprocal_id uuid references introductions on delete set null,
  agreements    jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  unique (round_id, subject_id),
  check (viewer_id <> subject_id)
);

create index introductions_viewer_idx on introductions (viewer_id, round_id);

-- ---------------------------------------------------------------------------
-- Selections — private until mutual
-- ---------------------------------------------------------------------------

create table introduction_selections (
  introduction_id uuid primary key references introductions on delete cascade,
  viewer_id       uuid not null references profiles on delete cascade,
  subject_id      uuid not null references profiles on delete cascade,
  decision        selection_decision not null,
  decided_at      timestamptz not null default now()
);

create index selections_pair_idx on introduction_selections (viewer_id, subject_id);

comment on table introduction_selections is
  'A row here is visible only to its own viewer. Being kept by someone is never readable by the subject unless a matching row exists in the other direction.';

-- ---------------------------------------------------------------------------
-- Connections — created only on mutual keeps
-- ---------------------------------------------------------------------------

create table connections (
  id           uuid primary key default gen_random_uuid(),
  -- Stored ordered so the unique index prevents duplicate pairs.
  user_a       uuid not null references profiles on delete cascade,
  user_b       uuid not null references profiles on delete cascade,
  stage        connection_stage not null default 'choosing_questions',
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  check (user_a < user_b)
);

create unique index connections_pair_idx on connections (user_a, user_b);

create table question_picks (
  connection_id uuid not null references connections on delete cascade,
  user_id       uuid not null references profiles on delete cascade,
  question_id   text not null,
  primary key (connection_id, user_id, question_id)
);

create table question_answers (
  connection_id uuid not null references connections on delete cascade,
  user_id       uuid not null references profiles on delete cascade,
  question_id   text not null,
  body          text not null,
  submitted_at  timestamptz not null default now(),
  primary key (connection_id, user_id, question_id)
);

comment on table question_answers is
  'Never selected directly by clients. `submit_answer` is the only read path, and it returns the other side''s row only once the caller''s own row exists.';

create table messages (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connections on delete cascade,
  sender_id     uuid not null references profiles on delete cascade,
  body          text,
  voice_path    text,
  voice_duration_seconds int,
  created_at    timestamptz not null default now(),
  check (body is not null or voice_path is not null)
);

create index messages_connection_idx on messages (connection_id, created_at);

-- ---------------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------------

create table blocks (
  blocker_id uuid not null references profiles on delete cascade,
  blocked_id uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles on delete cascade,
  subject_id  uuid not null references profiles on delete cascade,
  reason      text not null,
  detail      text,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
