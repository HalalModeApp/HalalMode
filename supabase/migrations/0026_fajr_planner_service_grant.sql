-- The Fajr Edge Function uses the service role for both generation and the
-- day-before planning path. The planner RPC is intentionally internal, but it
-- must be explicitly executable by that server caller after the public revoke.
grant execute on function set_madinah_fajr_cron(text) to service_role;
