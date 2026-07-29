/**
 * Deletes only already-paused, member-requested accounts. Deploy this function
 * with a high-entropy DELETION_WORKER_SECRET and invoke it from a trusted job.
 * The service-role key stays in Supabase Edge Function secrets.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

type DeletionRequest = { user_id: string; photo_paths: string[] | null; voice_path: string | null };

function equalSecret(left: string, right: string) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const workerSecret = Deno.env.get('DELETION_WORKER_SECRET') ?? '';
  if (!equalSecret(request.headers.get('x-deletion-worker-secret') ?? '', workerSecret)) {
    return new Response('Forbidden', { status: 403 });
  }

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const claimed = await client.rpc('claim_account_deletion_requests', { p_limit: 25 });
  if (claimed.error) return Response.json({ error: 'Could not claim deletion requests' }, { status: 500 });

  let deleted = 0;
  let failed = 0;
  for (const item of (claimed.data ?? []) as DeletionRequest[]) {
    try {
      const photoPaths = (item.photo_paths ?? []).filter(Boolean);
      if (photoPaths.length) {
        const result = await client.storage.from('profile-photos').remove(photoPaths);
        if (result.error) throw result.error;
      }
      if (item.voice_path) {
        const result = await client.storage.from('voice-introductions').remove([item.voice_path]);
        if (result.error) throw result.error;
      }
      const result = await client.auth.admin.deleteUser(item.user_id);
      if (result.error) throw result.error;
      deleted += 1;
    } catch (error) {
      failed += 1;
      await client.rpc('record_account_deletion_failure', {
        p_user_id: item.user_id,
        p_error: error instanceof Error ? error.message : 'Unknown finalization error',
      });
    }
  }
  return Response.json({ claimed: claimed.data?.length ?? 0, deleted, failed });
});
