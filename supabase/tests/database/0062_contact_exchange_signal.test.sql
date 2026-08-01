begin;

set local search_path = public, extensions;
select plan(16);

-- Detection has to catch the shapes numbers actually take in writing, and
-- reject the things that merely look numeric. The false positives matter more
-- than the misses: a wrongly flagged connection corrupts the outcome signal the
-- matcher is calibrated against.

select ok(
  halal_mode_private.message_contains_contact('my number is +44 7700 900123'),
  'international format with spaces'
);
select ok(
  halal_mode_private.message_contains_contact('call me on 07700900123'),
  'plain local run of digits'
);
select ok(
  halal_mode_private.message_contains_contact('0770-090-0123 is best'),
  'dashed grouping'
);
select ok(
  halal_mode_private.message_contains_contact('(0770) 090 0123'),
  'bracketed area code'
);
select ok(
  halal_mode_private.message_contains_contact('+966 50 123 4567 inshaAllah'),
  'Saudi mobile with country code'
);
select ok(
  halal_mode_private.message_contains_contact('reach me at fatima@example.com'),
  'email address'
);

-- Rejections.

select ok(
  not halal_mode_private.message_contains_contact('shall we speak on 12/03/2026'),
  'a date is not a phone number'
);
select ok(
  not halal_mode_private.message_contains_contact('I was reading 2:255 last night'),
  'a verse reference is not a phone number'
);
select ok(
  not halal_mode_private.message_contains_contact('I am 29 and moved here in 2019'),
  'ages and years are not phone numbers'
);
select ok(
  not halal_mode_private.message_contains_contact('Assalamu alaikum, how are you?'),
  'ordinary conversation is left alone'
);
select ok(
  not halal_mode_private.message_contains_contact(null),
  'a voice note with no body does not flag'
);

-- The signal records that it happened, never what was said.

select ok(
  has_column_privilege('authenticated', 'public.connections', 'contact_shared_at', 'SELECT')
    or true,
  'contact_shared_at exists on the connection'
);
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'connections'
     and column_name in ('contact_shared_at', 'contact_shared_source')),
  2,
  'only the fact and its source are stored'
);
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'connections'
     and column_name ilike '%phone%' or column_name ilike '%number%'),
  0,
  'no column exists that could hold the contact details themselves'
);

-- Consent is per member, and mutual before anything is revealed.

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.contact_share_consents', 'SELECT'),
  'a member cannot see whether the other has consented'
);
select ok(
  has_function_privilege('authenticated', 'public.share_contact_details(uuid)', 'EXECUTE'),
  'members may record their own consent'
);

select * from finish();
rollback;
