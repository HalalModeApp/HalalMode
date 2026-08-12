/**
 * Erases accounts whose 30-day recovery window has passed.
 *
 * Requesting deletion already pauses the member and closes their connections
 * straight away; this is the second half, and until it runs on a schedule the
 * erasure the Privacy Notice promises never actually happens.
 *
 * The caller proves itself against the vault rather than an environment
 * variable, the same way round generation does. That keeps the secret in one
 * place — rotating it is a single update with nothing to redeploy — and means
 * deploying this function needs no secrets configured by hand.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

type DeletionRequest = { user_id: string; photo_paths: string[] | null; voice_path: string | null };

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const verified = await client.rpc('verify_deletion_worker_secret', {
    p_secret: request.headers.get('x-deletion-worker-secret') ?? '',
  });
  if (verified.error || verified.data !== true) {
    return new Response('Forbidden', { status: 403 });
  }
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
