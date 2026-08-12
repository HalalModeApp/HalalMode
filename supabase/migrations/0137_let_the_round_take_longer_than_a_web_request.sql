-- Give round building the time a round takes.
--
-- The real ceiling was never the gateway's 125 seconds or the 60 I set on some
-- functions. Every statement arriving through the API runs as a role with an
-- 8-second statement timeout, and that is what has been cancelling the round.
--
-- Eight seconds is exactly right for a member's request. Nobody should be able
-- to make the database work for longer than that on their behalf, and lifting
-- it globally would remove a real protection to solve a problem that only one
-- job has.
--
-- So it is lifted for that one job. Building the day's round is a scheduled
-- background task with the whole morning available, not somebody waiting on a
-- screen, and it is reachable only by the service role. 110 seconds keeps it
-- under the gateway's own limit, so it still fails as an error rather than a
-- severed connection.
--
-- With the shortlist in front of it the work now fits comfortably:
--
--   pairs before any filtering      44,720
--   after the cheap pre-filter      34,575
--   after a shortlist of 40 each    12,105   (built in 164ms)
--   per-pair cost                    1.71ms
--   so, about                          21 seconds
--
-- This is the immediate fix, not the final shape. Twenty-one seconds at 432
-- members is fine; the same arithmetic at five thousand is not, and the answer
-- there is to page candidate generation the way finalization is now paged —
-- many short statements rather than one long one. That is a change to a
-- security-sensitive function and deserves its own pass, not a hurried one
-- appended here.

alter function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  set statement_timeout = '110s';

alter function public.matching_member_signals_service(uuid)
  set statement_timeout = '110s';

alter function public.matching_candidate_edges_service(uuid, uuid, uuid, integer)
  set statement_timeout = '110s';
