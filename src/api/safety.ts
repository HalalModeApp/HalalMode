import { requireSupabase, USE_MOCKS } from '@/lib/supabase';

export type ReportReason = 'harassment' | 'misrepresentation' | 'safety_concern' | 'other';

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
