/**
 * Domain model. Kept deliberately close to the Postgres schema in
 * `supabase/migrations` so rows map onto these types without a translation layer.
 */

import type { AppLocale } from '@/i18n/locales';

/** @deprecated Use AppLocale from the central locale registry in new code. */
export type Language = AppLocale;

export type Gender = 'male' | 'female';

export type ReligiousPractice =
  | 'very_practicing'
  | 'practicing'
  | 'moderate'
  | 'learning';

export type MarriageTimeline =
  | 'within_3_months'
  | 'within_6_months'
  | 'within_1_year'
  | '1_to_2_years';

export type RelocationPreference =
  | 'open'
  | 'preferred_local'
  | 'strictly_local'
  | 'willing_abroad';

export type FamilyGoals =
  | 'wants_children_soon'
  | 'wants_children_later'
  | 'open_to_children'
  | 'no_children';

export type MembershipTier = 'free' | 'premium';

export interface ProfileMediaSource {
  /** Renderable HTTPS/mock URL. Private Storage paths are signed before use. */
  displayUrl: string;
  /** Bucket-relative path retained for owner mutation; absent for legacy URLs. */
  storagePath?: string;
}

/** Daily introduction, keep, and active-conversation limits by membership. */
export const TIER_LIMITS: Record<
  MembershipTier,
  { introductions: number; keeps: number; openConnections: number }
> = {
  free: { introductions: 5, keeps: 1, openConnections: 5 },
  premium: { introductions: 10, keeps: 3, openConnections: 10 },
};

/**
 * The publicly visible half of a member. Everything here may be shown to
 * someone in an introduction. Anything private lives in `PrivatePreferences`
 * and never crosses the wire to another member.
 */
export interface Profile {
  id: string;
  name: string;
  /** First name only — used everywhere the tone should be personal. */
  firstName: string;
  age: number;
  gender: Gender;
  occupation: string;
  education?: string;
  city: string;
  country: string;
  bio: string;
  photos: string[];
  /** Structured media references; `photos` remains the render-ready legacy key. */
  photoMedia?: ProfileMediaSource[];
  chips: string[];
  religiousPractice: ReligiousPractice;
  timeline: MarriageTimeline;
  relocation: RelocationPreference;
  familyGoals: FamilyGoals;
  languagesSpoken: string[];
  isVerified: boolean;
  audioGreetingUrl?: string;
  audioGreetingStoragePath?: string;
  audioDurationSeconds?: number;
}

/**
 * Private to the owning member. The server never returns another member's row,
 * and RLS enforces that (see `0002_rls.sql`).
 */
export interface PrivatePreferences {
  minAge: number;
  maxAge: number;
  minHeightCm: number;
  maxHeightCm: number;
  preferredBuilds: string[];
  preferredCountries: string[];
  maxDistanceKm: number;
  preferredPractice: ReligiousPractice[];
  desiredTimeline: MarriageTimeline[];
  /** The member's own figures — stored privately, never rendered on a profile. */
  ownHeightCm: number;
  ownWeightKg?: number;
  ownBuild?: string;
}

/**
 * A single card in the current round. `agreements` are the pre-computed
 * overlaps the server is willing to disclose — never the underlying ranges.
 */
export interface Introduction {
  id: string;
  roundId: string;
  profile: Profile;
  /** Neutral overlap statements. Derived server-side from both private sets. */
  agreements: { label: string; value: string }[];
  /** Set locally the moment the member pops the balloon. */
  releasedAt?: string;
  /** Set locally when kept; confirmed by the server on submit. */
  keptAt?: string;
}

export interface IntroductionRound {
  id: string;
  /** ISO timestamp. Rounds reset at Fajr, not midnight. */
  opensAt: string;
  expiresAt: string;
  tier: MembershipTier;
  introductions: Introduction[];
  /** True once the member has submitted their keeps for this round. */
  submitted: boolean;
}

export type QuestionCategory =
  | 'faith'
  | 'family'
  | 'money'
  | 'conflict'
  | 'future'
  | 'work'
  | 'home'
  | 'health';

export interface CompatibilityQuestion {
  id: string;
  category: QuestionCategory;
  text: string;
  textAr: string;
}

/** Who put this question on the shared list. Drives the "Chosen by" line. */
export type QuestionOrigin = 'me' | 'them' | 'both';

export interface QuestionAnswer {
  questionId: string;
  origin: QuestionOrigin;
  myAnswer: string;
  /**
   * Double-blind: populated by the server only once *my* answer is submitted.
   * Until then it is undefined and the UI renders the blurred lock state.
   */
  theirAnswer?: string;
  mySubmittedAt?: string;
  theirSubmittedAt?: string;
}

export type RecapVerdict = 'aligned' | 'discuss';

/**
 * A high-level, server-derived compatibility signal shown after both members
 * complete the icebreaker. It intentionally carries no preference values,
 * ranking, or explanation of why either person was selected.
 */
export type CompatibilityTopic =
  | 'values'
  | 'marriage_timing'
  | 'location_and_relocation'
  | 'family_plans'
  | 'conversation';

export interface CompatibilityBreakdownItem {
  topic: CompatibilityTopic;
  verdict: RecapVerdict;
}

export interface RecapItem {
  questionId: string;
  /** Short neutral heading, e.g. "Prayer as rhythm". */
  heading: string;
  verdict: RecapVerdict;
  /** One neutral sentence. Never a score, never a judgement. */
  note: string;
}

export type ConnectionStage =
  | 'choosing_questions'
  | 'answering'
  | 'recap'
  | 'open';

export interface Connection {
  id: string;
  profile: Profile;
  createdAt: string;
  stage: ConnectionStage;
  /** Server-derived progress for the two-sided question handoff. */
  myQuestionPicksSubmitted?: boolean;
  theirQuestionPicksSubmitted?: boolean;
  /** The five agreed questions, in display order. */
  questions: QuestionAnswer[];
  recap?: RecapItem[];
  /**
   * Optional privacy-preserving signals calculated server-side. The client
   * must never infer these from another member's private preferences.
   */
  compatibilityBreakdown?: CompatibilityBreakdownItem[];
  lastMessage?: string;
  lastMessageAt?: string;
  unread: boolean;
}

export interface ChatMessage {
  id: string;
  connectionId: string;
  sender: 'me' | 'them';
  text?: string;
  voiceUrl?: string;
  voiceDurationSeconds?: number;
  createdAt: string;
  /** Set only after the other member has opened the message. */
  readAt?: string;
}
