-- Close the private matching internals to service_role again.
--
-- 0054 moved every service caller behind a public facade and revoked
-- service_role's direct execute on the three private workhorses, so that all
-- service access goes through functions that validate their run, their mode and
-- their config version.
--
-- 0069 restated matching_member_signals() to add the one-sided pick rate, and
-- re-applied the grant pattern from 0052 alongside it — the pattern that was in
-- force when the function was written, and that 0054 had deliberately ended.
-- The result was a private function reachable directly again.
--
-- Not an escalation: service_role is already the trusted role the edge function
-- runs as, so nothing became readable that was not readable through the facade.
-- What was lost is the guarantee that every service call goes through a
-- validated entry point, which is the only thing making the facade worth having.
--
-- The second such find in one sitting, and the same shape both times: a
-- restatement that reproduced the world as it was when its function was first
-- written. `create or replace` carries the body forward and leaves grants
-- alone; the danger is in the lines written *around* it out of habit.

revoke all on function halal_mode_private.matching_member_signals() from service_role;

do $$
begin
  assert not has_function_privilege(
    'service_role', 'halal_mode_private.matching_member_signals()', 'EXECUTE'
  ), 'service_role must reach member signals only through the public facade';

  -- The other two, checked here so this migration states the whole invariant
  -- rather than only the part that happened to break.
  assert not has_function_privilege(
    'service_role', 'halal_mode_private.matching_candidate_edges(uuid,uuid,integer)', 'EXECUTE'
  ), 'service_role must reach candidate edges only through the public facade';
  assert not has_function_privilege(
    'service_role',
    'halal_mode_private.persist_matching_round(uuid,jsonb,jsonb,timestamptz)',
    'EXECUTE'
  ), 'service_role must persist a round only through the public facade';

  -- And the facade itself must still be reachable, or this would be a fix that
  -- quietly broke round generation instead.
  assert has_function_privilege(
    'service_role', 'public.matching_member_signals_service(uuid)', 'EXECUTE'
  ), 'the public facade must remain callable by the service role';
end;
$$;
