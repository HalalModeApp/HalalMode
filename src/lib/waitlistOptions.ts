/**
 * The age ranges the waitlist offers.
 *
 * Deliberately here rather than beside the network call: this list is data, and
 * it is written down a second time as a check constraint on the table, so a
 * test compares the two. That test has to import it without dragging in the
 * Supabase client, which is the practical reason it does not live in the API
 * module — and the honest reason is that a list of options was never an API
 * concern in the first place.
 *
 * Kept in step with `waitlist_age_range` in migration 0093.
 */
export const AGE_RANGES = ['18-24', '25-29', '30-34', '35-39', '40-49', '50+'] as const;

export type AgeRange = (typeof AGE_RANGES)[number];
