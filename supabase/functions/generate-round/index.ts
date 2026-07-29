/** Creates the daily introduction round at the planned Madinah Fajr time. */
import { createClient } from 'jsr:@supabase/supabase-js@2';

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

async function fajrForMadinahDate(cycleDate: string) {
  const response = await fetch(
    `https://api.aladhan.com/v1/timingsByCity/${cycleDate}?city=Medina&country=Saudi%20Arabia&method=4`
  );
  if (!response.ok) throw new Error('Could not retrieve Madinah prayer times');
  const payload = await response.json() as { data?: { timings?: { Fajr?: string } } };
  const pieces = (payload.data?.timings?.Fajr ?? '').match(/\d{1,2}/g)?.map(Number) ?? [];
  const hour = pieces[0];
  const minute = pieces[1];
  if (hour === undefined || minute === undefined) throw new Error('Madinah Fajr time was unavailable');
  return { hour, minute };
}

async function madinahFajrWindow(now = new Date()) {
  const current = madinahParts(now);
  const { hour, minute } = await fajrForMadinahDate(current.date);
  const currentMinutes = current.hour * 60 + current.minute;
  const fajrMinutes = hour * 60 + minute;
  return { cycleDate: current.date, due: currentMinutes >= fajrMinutes && currentMinutes < fajrMinutes + 15 };
}

function nextMadinahDate(cycleDate: string) {
  const tomorrow = new Date(`${cycleDate}T00:00:00+03:00`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return madinahParts(tomorrow).date;
}

function madinahInstant(cycleDate: string, hour: number, minute: number) {
  return new Date(`${cycleDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);
}

async function planTomorrowFajr(now = new Date()) {
  const today = madinahParts(now).date;
  const cycleDate = nextMadinahDate(today);
  const { hour, minute } = await fajrForMadinahDate(cycleDate);
  // fajrForMadinahDate validates the upstream response and parsed time.
  // Madinah is permanently UTC+3. pg_cron schedules in UTC on Supabase.
  return {
    cycleDate,
    schedule: `${minute} ${(hour + 21) % 24} * * *`,
    startsAt: madinahInstant(cycleDate, hour, minute).toISOString(),
  };
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const suppliedSecret = request.headers.get('x-cron-secret') ?? '';
  const verified = await client.rpc('verify_round_scheduler_secret', {
    p_secret: suppliedSecret,
  });
  if (verified.error || verified.data !== true) {
    return new Response('Forbidden', { status: 403 });
  }
  if (new URL(request.url).searchParams.get('mode') === 'plan') {
    const plan = await planTomorrowFajr();
    const result = await client.rpc('set_madinah_fajr_cron', { p_schedule: plan.schedule });
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    return Response.json({ plannedFor: plan.cycleDate, scheduleUtc: plan.schedule });
  }
  const timing = await madinahFajrWindow();
  if (!timing.due) {
    return Response.json({ skipped: 'Outside the Madinah Fajr window', cycleDate: timing.cycleDate });
  }

  // A second cron attempt or retry cannot generate another daily cycle.
  const cycle = await client.from('round_generation_runs').insert({ cycle_date: timing.cycleDate });
  if (cycle.error?.code === '23505') {
    return Response.json({ skipped: 'Madinah Fajr cycle already ran', cycleDate: timing.cycleDate });
  }
  if (cycle.error) return Response.json({ error: cycle.error.message }, { status: 500 });

  // Keep the round live until the next daily Madinah Fajr reset.
  const nextFajr = await planTomorrowFajr();
  const expiresAt = nextFajr.startsAt;
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
