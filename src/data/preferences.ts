import type {
  FamilyGoals,
  MarriageTimeline,
  RelocationPreference,
  ReligiousPractice,
} from '@/types';

/**
 * Build vocabulary for the private preference editor.
 *
 * Deliberately long and deliberately neutral — no term here ranks above
 * another. The point is to describe, so introductions land better, not to grade.
 */
export const BUILD_OPTIONS = [
  'Petite',
  'Slim',
  'Slender',
  'Lean',
  'Tall & Lean',
  'Average',
  'Fit / Active',
  'Athletic',
  'Toned',
  'Muscular',
  'Medium / Solid',
  'Curvy',
  'Full-Figured',
  'Plus Size',
  'Broad',
  'Stocky',
  'Robust / Sturdy',
] as const;

/** Quick-pick radii under the distance slider, in kilometres. */
export const RADIUS_PRESETS = [25, 50, 100, 250, 500] as const;

export const HEIGHT_RANGE = { min: 140, max: 210 } as const;
export const AGE_RANGE = { min: 18, max: 70 } as const;
export const DISTANCE_RANGE = { min: 10, max: 500 } as const;

export const PRACTICE_LABELS: Record<ReligiousPractice, string> = {
  very_practicing: 'Very practicing',
  practicing: 'Practicing',
  moderate: 'Moderate',
  learning: 'Learning',
};

export const TIMELINE_LABELS: Record<MarriageTimeline, string> = {
  within_3_months: 'Within 3 months',
  within_6_months: 'Within 6 months',
  within_1_year: 'Within a year',
  '1_to_2_years': 'One to two years',
};

export const RELOCATION_LABELS: Record<RelocationPreference, string> = {
  open: 'Open to relocating',
  preferred_local: 'Prefers local',
  strictly_local: 'Staying put',
  willing_abroad: 'Willing to move abroad',
};

export const FAMILY_GOAL_LABELS: Record<FamilyGoals, string> = {
  wants_children_soon: 'Children soon',
  wants_children_later: 'Children later',
  open_to_children: 'Open to children',
  no_children: 'No children',
};

/** Converts centimetres to the feet-and-inches line shown beside the slider. */
export function formatHeightImperial(cm: number): string {
  const totalInches = Math.round(cm / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${feet}′ ${inches}″`;
}

export const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina',
  'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahrain', 'Bangladesh',
  'Belarus', 'Belgium', 'Benin', 'Bosnia and Herzegovina', 'Brazil', 'Brunei',
  'Bulgaria', 'Burkina Faso', 'Cameroon', 'Canada', 'Chad', 'Chile', 'China',
  'Comoros', 'Côte d’Ivoire', 'Croatia', 'Cyprus', 'Czechia', 'Denmark',
  'Djibouti', 'Egypt', 'Eritrea', 'Estonia', 'Ethiopia', 'Finland', 'France',
  'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Guinea', 'Hungary',
  'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Italy', 'Japan', 'Jordan',
  'Kazakhstan', 'Kenya', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Lebanon', 'Libya',
  'Lithuania', 'Luxembourg', 'Malaysia', 'Maldives', 'Mali', 'Malta',
  'Mauritania', 'Mauritius', 'Mexico', 'Morocco', 'Mozambique', 'Netherlands',
  'New Zealand', 'Niger', 'Nigeria', 'North Macedonia', 'Norway', 'Oman',
  'Pakistan', 'Palestine', 'Philippines', 'Poland', 'Portugal', 'Qatar',
  'Romania', 'Russia', 'Saudi Arabia', 'Senegal', 'Serbia', 'Sierra Leone',
  'Singapore', 'Slovakia', 'Slovenia', 'Somalia', 'South Africa', 'Spain',
  'Sri Lanka', 'Sudan', 'Sweden', 'Switzerland', 'Syria', 'Tajikistan',
  'Tanzania', 'Thailand', 'Togo', 'Tunisia', 'Turkey', 'Turkmenistan', 'Uganda',
  'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States',
  'Uzbekistan', 'Yemen', 'Zambia', 'Zimbabwe',
] as const;
