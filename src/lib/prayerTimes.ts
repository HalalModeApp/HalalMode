/**
 * Fajr, calculated rather than fetched.
 *
 * Rounds used to open at one instant worldwide — Fajr in Madinah — which is
 * 2:30am in London and the previous evening in Los Angeles. Giving everybody
 * their own dawn means knowing when dawn is where they are, for every member,
 * every day.
 *
 * Asking an API for that is one network call per member per day, which is a
 * cost, a dependency, and a thing that can be down at the exact moment the
 * rounds need building. Dawn is astronomy: the same inputs always give the same
 * answer, so it is computed here from the member's coordinates and the date.
 * No network, no key, no rate limit, and it works the same in a hundred years.
 *
 * The method is Umm al-Qura, which places Fajr when the sun is 18.5° below the
 * horizon — the same method the Madinah schedule already used, so nothing about
 * the app's idea of Fajr changes, only where it is measured.
 */

/** Umm al-Qura: the sun 18.5 degrees below the horizon. */
export const FAJR_ANGLE = 18.5;

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** Wrap into [0, 360). */
const wrap360 = (value: number) => ((value % 360) + 360) % 360;

/** Days since the J2000.0 epoch for midnight UTC on the given date. */
function daysSinceJ2000(year: number, month: number, day: number): number {
  // Julian day number at 00:00 UTC, by the standard civil-calendar formula.
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn =
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;
  return jdn - 0.5 - 2451545.0;
}

interface SunPosition {
  /** Degrees. */
  declination: number;
  /** Hours; the difference between apparent and mean solar time. */
  equationOfTime: number;
}

function sunPosition(d: number): SunPosition {
  const meanAnomaly = wrap360(357.529 + 0.98560028 * d);
  const meanLongitude = wrap360(280.459 + 0.98564736 * d);
  const eclipticLongitude = wrap360(
    meanLongitude + 1.915 * Math.sin(rad(meanAnomaly)) + 0.02 * Math.sin(rad(2 * meanAnomaly))
  );
  const obliquity = 23.439 - 0.00000036 * d;

  const declination = deg(Math.asin(Math.sin(rad(obliquity)) * Math.sin(rad(eclipticLongitude))));
  const rightAscension =
    wrap360(
      deg(
        Math.atan2(
          Math.cos(rad(obliquity)) * Math.sin(rad(eclipticLongitude)),
          Math.cos(rad(eclipticLongitude))
        )
      )
    ) / 15;

  // Both terms in hours. Wrapped into ±12 so the difference is the small
  // correction it should be rather than an almost-24-hour one.
  let equationOfTime = meanLongitude / 15 - rightAscension;
  while (equationOfTime > 12) equationOfTime -= 24;
  while (equationOfTime < -12) equationOfTime += 24;

  return { declination, equationOfTime };
}

/**
 * Hours before solar noon at which the sun sits `angle` degrees below the
 * horizon, or null where it never does — inside the polar circles in summer
 * there is no true dawn.
 */
function hoursBeforeNoon(latitude: number, declination: number, angle: number): number | null {
  const numerator =
    -Math.sin(rad(angle)) - Math.sin(rad(latitude)) * Math.sin(rad(declination));
  const denominator = Math.cos(rad(latitude)) * Math.cos(rad(declination));
  const cosHourAngle = numerator / denominator;
  if (cosHourAngle > 1 || cosHourAngle < -1) return null;
  return deg(Math.acos(cosHourAngle)) / 15;
}

/**
 * The instant of Fajr for a position, on a given calendar date in UTC terms.
 *
 * Returns null at extreme latitudes on dates where the sun never reaches the
 * Fajr angle; callers decide what to do rather than being handed a wrong time.
 */
export function fajrInstant(
  latitude: number,
  longitude: number,
  date: { year: number; month: number; day: number }
): Date | null {
  const d = daysSinceJ2000(date.year, date.month, date.day);
  const { declination, equationOfTime } = sunPosition(d);
  const hours = hoursBeforeNoon(latitude, declination, FAJR_ANGLE);
  if (hours === null) return null;

  // Solar noon in UTC hours, then step back to dawn.
  const solarNoonUtc = 12 - longitude / 15 - equationOfTime;
  const fajrUtcHours = solarNoonUtc - hours;

  const base = Date.UTC(date.year, date.month - 1, date.day);
  return new Date(base + fajrUtcHours * 3_600_000);
}

/**
 * The next Fajr strictly after `after` for a position.
 *
 * Rounds are built ahead and revealed at each member's dawn, so the question is
 * always "when is their next one", not "when was today's". Looks a few days
 * forward so a null from a polar summer does not become an infinite loop.
 */
export function nextFajrAfter(
  latitude: number,
  longitude: number,
  after: Date,
  maxDaysAhead = 4
): Date | null {
  for (let offset = -1; offset <= maxDaysAhead; offset += 1) {
    const probe = new Date(after.getTime() + offset * 86_400_000);
    const instant = fajrInstant(latitude, longitude, {
      year: probe.getUTCFullYear(),
      month: probe.getUTCMonth() + 1,
      day: probe.getUTCDate(),
    });
    if (instant && instant.getTime() > after.getTime()) return instant;
  }
  return null;
}
