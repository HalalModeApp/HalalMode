import { requireSupabase, USE_MOCKS } from '@/lib/supabase';

export type ReportReason = 'harassment' | 'misrepresentation' | 'safety_concern' | 'other';

export interface BlockedMember {
  id: string;
  firstName: string;
  city: string;
  country: string;
  blockedAt: string;
}

export async function fetchMyBlockedMembers(): Promise<BlockedMember[]> {
  if (USE_MOCKS) return [];
  const client = requireSupabase();
  const { data, error } = await client.rpc('get_my_blocked_members');
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((item) => ({
    id: String(item.id),
    firstName: String(item.firstName ?? ''),
    city: String(item.city ?? ''),
    country: String(item.country ?? ''),
    blockedAt: String(item.blockedAt),
  }));
}

export async function unblockMyMember(memberId: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('unblock_my_member', { p_blocked_user_id: memberId });
  if (error) throw error;
}

export async function reportConnectionMember(connectionId: string, reason: ReportReason): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('report_connection_member', {
    p_connection_id: connectionId,
    p_reason: reason,
  });
  if (error) throw error;
}

export async function blockConnectionMember(connectionId: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('block_connection_member', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
}

export async function reportIntroductionMember(
  introductionId: string,
  reason: ReportReason
): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('report_introduction_member', {
    p_introduction_id: introductionId,
    p_reason: reason,
  });
  if (error) throw error;
}

export async function blockIntroductionMember(introductionId: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('block_introduction_member', {
    p_introduction_id: introductionId,
  });
  if (error) throw error;
}

/**
 * Hiding is mutual, permanent and silent, and carries no moderation meaning —
 * it is for recognising someone from life rather than for anything they did.
 * Keyed on the relationship like every other action here, so the server derives
 * who is being hidden instead of trusting an id from the client.
 */
export async function hideConnectionMember(connectionId: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('hide_connection_member', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
}

export async function hideIntroductionMember(introductionId: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { error } = await client.rpc('hide_introduction_member', {
    p_introduction_id: introductionId,
  });
  if (error) throw error;
}
