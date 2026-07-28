# Handoff notes

Context for the next agent picking this up. Read this before `README.md`.

## Where things stand

The app is **built and verified**: `npx tsc --noEmit` is clean under `strict` with
Expo Router typed routes enforced, and `npx expo export --platform ios --no-bytecode`
bundles 1669 modules successfully.

It runs **end to end on bundled mock data** with no Supabase project. `EXPO_PUBLIC_USE_MOCKS=1`
is the default. Every screen is reachable: today's set → profile → mutual match →
question picking → double-blind answers → alignment recap → conversation.

Nothing has been run on a real device yet.

## Design source of truth

`Halal Mode 2030.dc.html` in the Claude Design project
(`a0416134-e950-44e4-9992-8625f4fc4600`) is the reference for all visual and
interaction decisions. When something here looks arbitrary, check it there first —
most of it is deliberate.

There is also an older React/Vite prototype under `uploads/halal-mode-Gemini-Claude/`
in that project. Its domain model was reused. Its 3D balloon scene was **not** —
the reference explicitly replaced WebGL balloons with the arc carousel, and that
decision should not be reverted without a reason.

## What is deliberately not built yet

Ranked by what unblocks the most:

1. **Auth screens.** `supabase.auth` is configured with AsyncStorage persistence
   and ready; there is simply no sign-in / sign-up / OTP UI. The app assumes a
   signed-in member. This is the top blocker for any real-device testing.
2. **Onboarding flow.** `profiles.onboarding_complete` exists in the schema and
   the matcher filters on it, but nothing sets it.
3. **Voice recording.** `AudioGreeting` is real UI with real progress and timing,
   but the audio is simulated. Needs `expo-audio` plus a Storage bucket.
4. **Arabic RTL.** Scaffolded only: `textAr` exists on every question, Beiruti
   covers the script, and the language toggle persists to AsyncStorage. The layout
   is not mirrored and the copy is not translated.
5. **Photo moderation.** Policy forbids beauty and face-altering filters; nothing
   enforces it.
6. **Realtime chat.** Messages are fetched with `staleTime: 0`; Supabase Realtime
   is not subscribed.

## Gotchas that will cost you time

**Do not run `git add -A` from outside this directory.** There is a stray unrelated
git repo at `C:\Users\Mohammed\.git` (an abandoned "commentplace" project from
Sept 2024). Staging from within it walks the entire home directory and takes
minutes. This project now has its own repo, so staying inside it is fine.

**Hermes bytecode fails locally on Windows.** The `hermesc.exe` shipped in
react-native 0.81.5 rejects private class fields in React Native's *own* `DOMRect`.
This reproduces on a stock project with no app code and with `babel.config.js`
removed entirely — it is the toolchain, not this app. EAS Build (Linux/macOS) is
unaffected. To bundle locally, pass `--no-bytecode`.

**Keep dependency versions on SDK 54.** Installing `babel-preset-expo` manually
pulled v57 against SDK 54 and broke the build. Use `npx expo install`, and
`npx expo install --check` to verify.

## Conventions to follow

- Design tokens live in `src/theme/tokens.ts`. Do not hardcode colours, radii or
  springs anywhere else.
- Typography has jobs, not sizes. `Text` takes a `variant`; Playfair
  (`display`, `quote`) is for human sentences, Beiruti for mechanics and labels.
  Do not mix them up — it is the whole typographic idea.
- Every function in `src/api/` has a mock branch and a Supabase branch. Keep both
  working; the mock path is what makes the app demoable.
- Motion is sprung, not timed. Reuse `motion.arc`.

## Privacy rules — treat these as non-negotiable

These are enforced in Postgres, not the client, and that is on purpose. Do not
move any of them into the app layer for convenience.

- `selection_scores` has RLS enabled and **no policy at all**. Nobody reads it,
  including its owner. Exposing it turns it into the popularity rating the product
  refuses to be.
- `question_answers` has RLS enabled and **no policy**. `submit_answer()` is the
  only read path, and it returns the other side's answer only after writing yours.
  A client-side blur would be bypassable with a debugger.
- A member can read `introduction_selections` where they are the *viewer*, never
  where they are the *subject*. There must be no query that answers "who kept me".
- Private preferences never leave the owner's session. The matcher reads both
  sides only inside `security definer` functions that return matches, never rows.
- No browsing. A profile is readable only while you have a live introduction to
  that person or an open connection with them.

## The matcher

`supabase/migrations/0004_matcher.sql` is the highest-risk file in the repo and
has never been run against a real database. It builds a pair graph first and
derives both sides' cards from it, because reciprocity —

> if Mo appears in Lama's set, Lama appears in Mo's set

— cannot be produced by querying candidates independently per user. Twin rows are
linked via `reciprocal_id` so reciprocity is auditable.

If you touch it, verify: reciprocity holds for every pair; both sides are
rank-capped so introductions distribute fairly; the band window stays ±1 rather
than exact so nobody is sealed into one range; and `passes_criteria` is still
checked in **both** directions.

## Suggested order of work

1. Stand up a real Supabase project, run the four migrations, seed a few dozen
   profiles of both genders, and run `generate_round_for_pairs` — verify
   reciprocity holds before building anything else on top of it.
2. Auth + onboarding, so the app is usable on a device.
3. Flip `EXPO_PUBLIC_USE_MOCKS=0` and fix what breaks in the Supabase branches of
   `src/api/` — those paths are written but untested.
4. Realtime chat, voice notes, RTL.
