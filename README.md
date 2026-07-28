# Halal Mode

A Muslim marriage app built around **fewer, more intentional introductions** — not endless profiles, not swiping, not doom scrolling.

Members receive a small, reciprocal set of introductions, keep only who they genuinely want to meet, and connect only when the interest is mutual. Before free conversation opens, both people answer five compatibility questions under a double blind and read a neutral alignment recap.

The visual and interaction design follows `Halal Mode 2030.dc.html`.

---

## Stack

| Layer | Choice |
| --- | --- |
| App | Expo SDK 54, React Native 0.81, TypeScript (strict) |
| Routing | Expo Router (typed routes) |
| Motion | React Native Reanimated 4 + Gesture Handler |
| Data | TanStack Query |
| Forms | React Hook Form + Zod |
| Backend | Supabase — Postgres, Auth, Storage, Edge Functions, RLS |
| Builds | EAS Build / Submit / Update |

## Getting started

```bash
npm install
```

```bash
cp .env.example .env
```

The app ships with `EXPO_PUBLIC_USE_MOCKS=1`, so it runs end-to-end against bundled sample content with **no Supabase project required**. Every screen and the full introduction → match → questions → recap → conversation flow is reachable out of the box.

```bash
npm start
```

To run against a real backend, set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` and flip `EXPO_PUBLIC_USE_MOCKS=0`.

```bash
npm run typecheck
```

## Project layout

```
app/                      Expo Router routes
  (tabs)/                 daily · connections · you
  introduction/[id]       full profile for one card
  match/[id]              mutual-interest reveal
  connection/[id]/        questions → answers → recap → chat
  gallery/[id]            photo viewer
src/
  api/                    data access; each call has a mock and a Supabase path
  components/
    introductions/        ArcCarousel, HeroCard, PopBurst, AudioGreeting
    navigation/           floating tab rail, brand header
    ui/                   Text, Button, Chip, Card, Field, sliders, dialogs
    you/                  profile / private preferences / settings tabs
  data/                   question library, preference vocabularies, sample content
  state/                  round interaction state, session preferences
  theme/tokens.ts         every colour, radius, type ramp and spring
  types/                  domain model, mirrored by the SQL schema
supabase/
  migrations/             schema, RLS, functions, reciprocal matcher
  functions/generate-round/  scheduled round generation
```

## Design decisions worth knowing

**The arc, not a 3D scene.** The earlier prototype rendered balloons in WebGL. This build uses one portrait at full size with the day's set curving beneath it on a sprung arc (`src/components/introductions/ArcCarousel.tsx`). Inactive faces recede, the centred one gets the frame. Above five introductions — a Plus round — the arc becomes two centred rows, because an arc of ten is unreadable.

**Round state lives above the navigator.** `RoundProvider` sits outside the tabs so opening a profile and coming back does not forget which introductions were let go.

**Typography carries the brand.** Playfair Display for human sentences, Beiruti for mechanics and labels — Beiruti also covers Arabic, which matters for the RTL work. Alabaster and near-black, one warm gold accent, uppercase micro-labels instead of icons.

**Motion is sprung, not timed.** The reference's `cubic-bezier(.22,1,.36,1)` reads as a spring; `motion.arc` in the tokens is that spring, shared by the carousel and the tab indicator.

## Privacy model

This is the part of the product that most needs to be right, so it is enforced in the database rather than the client.

- **Private preferences never leave the owner's session.** `private_preferences` is `auth.uid() = user_id` for select *and* write. The matcher reads both sides' rows only inside `security definer` functions that return matches — never the rows.
- **Selection scores are unreadable by everyone**, including their owner. `selection_scores` has RLS enabled and no policy at all. Exposing it would turn it into the popularity rating the product refuses to be.
- **Being chosen is invisible unless mutual.** A member can read rows in `introduction_selections` where they are the *viewer*, never where they are the *subject*. There is no query that answers "who kept me".
- **The double blind is server-side.** `question_answers` has RLS enabled with no policy; `submit_answer()` is the only read path and returns the other side's answer only after writing yours. Answers are write-once. A client-side blur would be theatre.
- **No browsing.** A profile is readable only while you have a live introduction to that person or an open connection with them.

## The reciprocal matcher

The defining constraint is that introductions come in pairs:

> if Mo appears in Lama's set, Lama appears in Mo's set

That cannot be produced by querying candidates independently per user, so `generate_round_for_pairs()` (`supabase/migrations/0004_matcher.sql`) builds a pair graph first and derives both sides' cards from it, then links the twin rows via `reciprocal_id` so reciprocity is auditable.

Pairing considers mutual private criteria (checked in both directions), adjacent score bands, blocks, prior exposure, and a randomness term. Both sides are rank-capped so introductions are distributed fairly rather than concentrating on whoever matches everyone. The band window is ±1 rather than exact, so nobody is sealed into one range.

Non-mutual keeps expire quietly via `expire_stale_rounds()`. Neither side is told anything happened.

### Deploying the backend

```bash
supabase db push
```

```bash
supabase functions deploy generate-round --no-verify-jwt
```

Then schedule it (the function checks an `x-cron-secret` header, since it is deployed without JWT verification):

```sql
select cron.schedule('halal-mode-round', '0 4 * * *', $$
  select net.http_post(
    url := 'https://<project>.supabase.co/functions/v1/generate-round',
    headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_secret'))
  );
$$);
```

## Tier limits

| | Free | Plus |
| --- | --- | --- |
| Introductions per round | 5 | 10 |
| May keep | 1 | 3 |
| Open connections | 3 | 5 |

Limits are mirrored in `TIER_LIMITS` for instant UI response, but `submit_round_selections()` re-checks them server-side. Flipping the local value buys nothing.

## Known constraints

- **Hermes bytecode compilation fails on Windows** with the `hermesc.exe` shipped in `react-native@0.81.5` — it rejects private class fields in React Native's own `DOMRect`. This reproduces on a stock project with no app code, and does not affect EAS Build (Linux/macOS). To bundle locally, pass `--no-bytecode`:
  ```bash
  npx expo export --platform ios --no-bytecode
  ```
- **Voice notes play a simulated waveform.** The player UI, progress and timing are real; recording and playback need `expo-audio` wiring and a Storage bucket.
- **Arabic RTL is scaffolded, not finished.** The question library carries `textAr`, Beiruti covers the script, and the language toggle persists — but the layout has not been mirrored or the copy translated.
- **Auth screens are not built.** The app assumes a signed-in member; `supabase.auth` is configured and ready to wire up.
- Photography throughout the sample data is placeholder.
