import { buildMockRound } from '@/data/mock';
import { requireSupabase, USE_MOCKS } from '@/lib/supabase';
import { hydrateProfileMedia } from '@/api/profileMedia';
import {
  normalizeDailyRoundStatus,
  normalizeNarrowingCriterion,
  type DailyRoundStatus,
  type NarrowingCriterion,
} from '@/lib/dailyRoundState';
import { TIER_LIMITS, type IntroductionRound, type MembershipTier } from '@/types';

export interface CurrentRoundState {
  status: DailyRoundStatus;
  round: IntroductionRound | undefined;
  /**
   * Set only with `filters_too_narrow`: the member's own must-have that is
   * costing them the most. Never names another member or a pool size.
   */
  narrowingCriterion: NarrowingCriterion | null;
}

/**
 * Fetches the member's current round.
 *
 * The round is generated server-side as a *reciprocal* set: if someone appears
 * here, this member appears in theirs for the same round. That symmetry is the
 * reason this cannot be a client-side query over a profiles table.
 */
export async function fetchCurrentRoundState(
  tier: MembershipTier
): Promise<CurrentRoundState> {
  if (USE_MOCKS) {
    return {
      status: 'ready',
      round: buildMockRound(TIER_LIMITS[tier].introductions),
      narrowingCriterion: null,
    };
  }

  const client = requireSupabase();
  const { data, error } = await client.rpc('get_current_round_state');
  if (error) throw error;
  const payload = data && typeof data === 'object'
    ? data as { status?: unknown; round?: IntroductionRound | null; criterion?: unknown }
    : {};
  const round = payload.round ?? undefined;
  const status = normalizeDailyRoundStatus(payload.status);
  const narrowingCriterion = normalizeNarrowingCriterion(payload.criterion);
  if (!round) {
    return {
      // A contradictory `ready` response must not render an empty carousel.
      status: status === 'ready' ? 'no_suitable_introductions' : status,
      round: undefined,
      narrowingCriterion,
    };
  }
  return {
    status: round.introductions.length > 0 ? 'ready' : status,
    narrowingCriterion,
    round: {
      ...round,
      introductions: await Promise.all(
        round.introductions.map(async (introduction) => ({
          ...introduction,
          profile: await hydrateProfileMedia(introduction.profile),
        }))
      ),
    },
  };
}

/**
 * Commits the member's keeps for the round.
 *
 * Selections are written privately. The other side is told nothing unless and
 * until they select back — no read receipts, no "someone likes you" nudge.
 * `mutualProfileIds` contains mutuals that received an active conversation
 * slot. `waitingMutualProfileIds` contains earned mutuals held privately until
 * both members have capacity; older clients can safely ignore that new field.
 */
export async function submitKeeps(
  roundId: string,
  keptIntroductionIds: string[]
): Promise<{ mutualProfileIds: string[]; waitingMutualProfileIds?: string[] }> {
  if (USE_MOCKS) {
    // The sample flow always mutuals on the first keep so the match reveal,
    // question flow and recap are all reachable without a second device.
    await new Promise((resolve) => setTimeout(resolve, 450));
    const first = keptIntroductionIds[0];
    return {
      mutualProfileIds: first ? [first.replace('intro-', '')] : [],
    };
  }

  const client = requireSupabase();
  // Order carries the rank: the first element is this member's first choice.
  // A free member keeps exactly one, so theirs is rank 1 by definition; a
  // Premium member is asked which of their keeps comes first. Mutual first
  // choice is the metric all of this is judged against, and without an order it
  // is unmeasurable for Premium.
  const { data, error } = await client.rpc('submit_round_selections_ranked', {
    p_round_id: roundId,
    p_ordered_introduction_ids: keptIntroductionIds,
  });
  if (error) throw error;
  return data as {
    mutualProfileIds: string[];
    waitingMutualProfileIds?: string[];
  };
}

/**
 * Records that an introduction was released. Fire-and-forget from the UI's
 * point of view — the arc animates immediately and this reconciles behind it.
 *
 * The server uses release events to tune the private selection score. Nobody is
 * ever told they were passed over.
 */
export async function releaseIntroduction(
  introductionId: string
): Promise<void> {
  if (USE_MOCKS) return;

  const client = requireSupabase();
  const { error } = await client.rpc('release_introduction', {
    p_introduction_id: introductionId,
  });
  if (error) throw error;
}
