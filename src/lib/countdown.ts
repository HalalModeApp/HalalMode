/**
 * How long until the next set, in words.
 *
 * Shown under "resets at Fajr in London", so it answers the question that line
 * raises: yes, but when? Coarse on purpose — hours and minutes, seconds only in
 * the last minute. A ticking second hand on a marriage app would make a quiet
 * daily ritual feel like a countdown to a deadline, which is the opposite of
 * what the round is for.
 */

export interface Countdown {
  hours: number;
  minutes: number;
  seconds: number;
  /** True once the moment has passed. */
  done: boolean;
}

export function countdownTo(target: string | null | undefined, now: number = Date.now()): Countdown | null {
  if (!target) return null;
  const at = Date.parse(target);
  if (Number.isNaN(at)) return null;

  const remaining = Math.max(0, at - now);
  return {
    hours: Math.floor(remaining / 3_600_000),
    minutes: Math.floor((remaining % 3_600_000) / 60_000),
    seconds: Math.floor((remaining % 60_000) / 1_000),
    done: remaining <= 0,
  };
}

/**
 * The refresh interval that keeps the display honest without waking the phone
 * every second: once a minute while there are minutes left, once a second only
 * in the final minute.
 */
export function countdownTick(value: Countdown | null): number {
  if (!value || value.done) return 60_000;
  return value.hours === 0 && value.minutes === 0 ? 1_000 : 60_000;
}
