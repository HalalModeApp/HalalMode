/**
 * Runs every fifteen minutes, but creates a daily introduction round only in
 * the real Fajr window for Madinah (Umm al-Qura calculation).
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CRON_SECRET = Deno.env.get('CRON_SECRET');
const MADINAH_TIME_ZONE = 'Asia/Riyadh';

function madinahParts(date = new Date()) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: MADINAH_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => values.find((part) => part.type === type)?.value ?? '';
  return { date: `${read('year')}-${read('month')}-${read('day')}`, hour: Number(read('hour')), minute: Number(read('minute')) };
}

async function madinahFajrWindow(now = new Date()) {
  const current = madinahParts(now);
  const response = await fetch(
    `https://api.aladhan.com/v1/timingsByCity/${current.date}?city=Medina&country=Saudi%20Arabia&method=4`
  );
  if (!response.ok) throw new Error('Could not retrieve Madinah prayer times');
  const payload = await response.json() as { data?: { timings?: { Fajr?: string } } };
  const pieces = (payload.data?.timings?.Fajr ?? '').match(/\d{1,2}/g)?.map(Number) ?? [];
  const hour = pieces[0];
  const minute = pieces[1];
  if (hour === undefined || minute === undefined) throw new Error('Madinah Fajr time was unavailable');
  const currentMinutes = current.hour * 60 + current.minute;
  const fajrMinutes = hour * 60 + minute;
  return { cycleDate: current.date, due: currentMinutes >= fajrMinutes && currentMinutes < fajrMinutes + 15 };
}

Deno.serve(async (request: Request) => {
  const hasSecret = request.headers.get('x-cron-secret') === CRON_SECRET;
  const hasPublishableKey = request.headers.get('authorization') === `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`;
  if (!hasSecret && !hasPublishableKey) return new Response('Forbidden', { status: 403 });

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const timing = await madinahFajrWindow();
  if (!hasSecret && !timing.due) {
    return Response.json({ skipped: 'Outside the Madinah Fajr window', cycleDate: timing.cycleDate });
  }

  // A second cron attempt or retry cannot generate another daily cycle.
  const cycle = await client.from('round_generation_runs').insert({ cycle_date: timing.cycleDate });
  if (cycle.error?.code === '23505') {
    return Response.json({ skipped: 'Madinah Fajr cycle already ran', cycleDate: timing.cycleDate });
  }
  if (cycle.error) return Response.json({ error: cycle.error.message }, { status: 500 });

  const expiresAt = new Date(Date.now() + 20 * 3600 * 1000).toISOString();
  const expired = await client.rpc('expire_stale_rounds');
  if (expired.error) {
    await client.from('round_generation_runs').delete().eq('cycle_date', timing.cycleDate);
    return Response.json({ error: expired.error.message }, { status: 500 });
  }
  const generated = await client.rpc('generate_round_for_pairs', { p_expires_at: expiresAt });
  if (generated.error) {
    await client.from('round_generation_runs').delete().eq('cycle_date', timing.cycleDate);
    return Response.json({ error: generated.error.message }, { status: 500 });
  }
  return Response.json({ expiredSelections: expired.data, pairsCreated: generated.data, expiresAt, cycleDate: timing.cycleDate });
});
