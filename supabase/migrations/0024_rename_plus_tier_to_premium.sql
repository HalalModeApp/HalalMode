-- Rename the persisted membership label without changing its enum type, table
-- columns, or limits. PostgreSQL preserves the existing enum value identity,
-- so current profile and round rows become `premium` atomically.

alter type membership_tier rename value 'plus' to 'premium';

-- Recompile the current policy under the new label so source inspection and
-- future migrations cannot accidentally retain the retired term.
create or replace function tier_limits(p_tier membership_tier)
returns table (introductions int, keeps int, open_connections int)
language sql immutable as $$
  select case when p_tier = 'premium' then 10 else 5 end,
         case when p_tier = 'premium' then 3 else 1 end,
         case when p_tier = 'premium' then 10 else 5 end;
$$;

revoke all on function tier_limits(membership_tier) from public, anon, authenticated;
