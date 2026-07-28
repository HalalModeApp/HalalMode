/**
 * Scheduled round generation.
 *
 * Invoked once per matching cycle (dawn, per region) by a cron trigger. All the
 * real work is in `generate_round_for_pairs` — this is the authenticated shell
 * that runs it with the service-role key and reports what happened.
 *
 * Deploy:  supabase functions deploy generate-round --no-verify-jwt
 * Schedule: select cron.schedule('halal-mode-round', '0 4 * * *', $$ ... $$);
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET');

Deno.serve(async (request: Request) => {
  // The function is deployed without JWT verification so cron can reach it, so
  // it carries its own shared secret instead.
  if (request.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Rounds run until the next cycle. Twenty hours leaves a quiet gap rather
  // than rolling straight into the next set.
  const expiresAt = new Date(Date.now() + 20 * 3600 * 1000).toISOString();

  const expired = await client.rpc('expire_stale_rounds');
  if (expired.error) {
    return Response.json({ error: expired.error.message }, { status: 500 });
  }

  const generated = await client.rpc('generate_round_for_pairs', {
    p_expires_at: expiresAt,
  });
  if (generated.error) {
    return Response.json({ error: generated.error.message }, { status: 500 });
  }

  return Response.json({
    expiredSelections: expired.data,
    pairsCreated: generated.data,
    expiresAt,
  });
});
