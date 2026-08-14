/**
 * Drains the notification queue and delivers to Expo.
 *
 * Registering a device has worked for months and nothing has ever sent
 * anything. This is the missing half.
 *
 * It claims a bounded batch, posts it, and reports back what landed and what
 * did not — so a failure is retried rather than lost, and a token Apple or
 * Google has rejected is cleared instead of retried forever.
 *
 * Verifies itself against the vault the same way round generation and the
 * deletion worker do, so there is nothing to configure at deploy time.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

interface Claimed {
  id: number;
  user_id: string;
  kind: 'round_ready' | 'mutual_match' | 'new_message';
  payload: Record<string, unknown>;
  push_token: string;
  platform: string;
  locale: string;
}

/**
 * What a member reads on their lock screen.
 *
 * Never a name, never message text. A notification says something happened;
 * the app says what, once they are inside it and the other person's privacy
 * is governed by the same rules as every other screen.
 */
function wording(kind: Claimed['kind'], locale: string): { title: string; body: string } {
  const arabic = locale.startsWith('ar');
  switch (kind) {
    case 'round_ready':
      return arabic
        ? { title: 'مجموعتك جاهزة', body: 'تعارفات اليوم بانتظارك.' }
        : { title: 'Your set is ready', body: 'Today’s introductions are waiting.' };
    case 'mutual_match':
      return arabic
        ? { title: 'تعارف متبادل', body: 'شخص اخترته اختارك أيضًا.' }
        : { title: 'You matched', body: 'Someone you chose chose you back.' };
    case 'new_message':
      return arabic
        ? { title: 'رسالة جديدة', body: 'لديك رسالة في إحدى محادثاتك.' }
        : { title: 'New message', body: 'You have a message waiting.' };
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const verified = await client.rpc('verify_notification_worker_secret', {
    p_secret: request.headers.get('x-notification-worker-secret') ?? '',
  });
  if (verified.error || verified.data !== true) {
    return new Response('Forbidden', { status: 403 });
  }

  const claimed = await client.rpc('claim_notifications_service', { p_limit: 100 });
  if (claimed.error) {
    return Response.json({ error: claimed.error.message }, { status: 500 });
  }

  const rows = (claimed.data ?? []) as Claimed[];
  if (rows.length === 0) return Response.json({ claimed: 0, sent: 0, failed: 0 });

  const messages = rows.map((row) => {
    const { title, body } = wording(row.kind, row.locale ?? 'en');
    return {
      to: row.push_token,
      title,
      body,
      sound: 'default',
      // Lets the app open the right screen without putting anything private
      // in the payload.
      data: { kind: row.kind },
    };
  });

  const sent: number[] = [];
  const failed: { id: number; error: string }[] = [];

  // Expo takes up to 100 per request and answers with one ticket per message,
  // in order.
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const text = await response.text();
      for (const row of rows) failed.push({ id: row.id, error: `push ${response.status}: ${text.slice(0, 120)}` });
    } else {
      const payload = await response.json() as { data?: { status: string; message?: string; details?: { error?: string } }[] };
      const tickets = payload.data ?? [];
      rows.forEach((row, index) => {
        const ticket = tickets[index];
        if (!ticket) {
          failed.push({ id: row.id, error: 'no ticket returned' });
        } else if (ticket.status === 'ok') {
          sent.push(row.id);
        } else {
          // `DeviceNotRegistered` is read on the database side and clears the
          // token, so an uninstalled app stops being retried.
          failed.push({ id: row.id, error: ticket.details?.error ?? ticket.message ?? 'unknown' });
        }
      });
    }
  } catch (error) {
    for (const row of rows) {
      failed.push({ id: row.id, error: error instanceof Error ? error.message : 'transport failed' });
    }
  }

  const settled = await client.rpc('settle_notifications_service', {
    p_sent: sent,
    p_failed: failed,
  });
  if (settled.error) {
    return Response.json({ error: settled.error.message, sent: sent.length }, { status: 500 });
  }

  return Response.json({ claimed: rows.length, sent: sent.length, failed: failed.length });
});
