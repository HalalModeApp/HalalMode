import type {
  ChatMessage,
  Connection,
  Introduction,
  IntroductionRound,
  PrivatePreferences,
  Profile,
  RecapItem,
} from '@/types';

/**
 * Bundled sample content so the app runs end-to-end with no Supabase project.
 * Enabled by `EXPO_PUBLIC_USE_MOCKS=1`. Photography is placeholder, exactly as
 * the reference notes.
 */

const unsplash = (id: string, w = 900) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&q=80&w=${w}`;

/** Neutral context shots appended to every gallery — no other faces. */
const CONTEXT_SHOTS = [
  unsplash('photo-1499750310107-5fef28a66643'),
  unsplash('photo-1517248135467-4c7edcad34c4'),
  unsplash('photo-1493857671505-72967e2e2760'),
];

function gallery(portraitId: string): string[] {
  return [unsplash(portraitId), ...CONTEXT_SHOTS];
}

export const MOCK_PROFILES: Profile[] = [
  {
    id: 'c1',
    name: 'Amina Rahmani',
    firstName: 'Amina',
    age: 26,
    gender: 'female',
    occupation: 'Clinical neuroscientist',
    education: 'PhD, King’s College London',
    city: 'London',
    country: 'United Kingdom',
    bio: 'Fascinated by how the brain learns. I balance research with sourdough, classical calligraphy and community work. Looking for a practicing, kind partner who values open communication.',
    photos: gallery('photo-1573496359142-b8d87734a5a2'),
    chips: ['Practicing', 'Marriage within a year', 'Calligraphy', 'Volunteering'],
    religiousPractice: 'practicing',
    timeline: 'within_1_year',
    relocation: 'preferred_local',
    familyGoals: 'wants_children_soon',
    languagesSpoken: ['English', 'Arabic', 'French'],
    isVerified: true,
    audioDurationSeconds: 16,
  },
  {
    id: 'c2',
    name: 'Yasmine Benali',
    firstName: 'Yasmine',
    age: 25,
    gender: 'female',
    occupation: 'UX strategist',
    education: 'BA, Manchester School of Art',
    city: 'Manchester',
    country: 'United Kingdom',
    bio: 'Art director by day, tea drinker by night. I value tranquility, prayers on time and quiet conversation over noise.',
    photos: gallery('photo-1544005313-94ddf0286df2'),
    chips: ['Very practicing', 'Within 6 months', 'Digital art', 'Quran recitation'],
    religiousPractice: 'very_practicing',
    timeline: 'within_6_months',
    relocation: 'open',
    familyGoals: 'wants_children_soon',
    languagesSpoken: ['English', 'Arabic'],
    isVerified: true,
    audioDurationSeconds: 14,
  },
  {
    id: 'c3',
    name: 'Maryam El-Farouk',
    firstName: 'Maryam',
    age: 27,
    gender: 'female',
    occupation: 'Fintech product manager',
    education: 'MSc, LSE',
    city: 'London',
    country: 'United Kingdom',
    bio: 'Ambitious at work, but home is where my heart rests. Tennis, North African cooking, and Seerah study.',
    photos: gallery('photo-1524504388940-b1c1722653e1'),
    chips: ['Practicing', 'Within a year', 'Tennis', 'Culinary arts'],
    religiousPractice: 'practicing',
    timeline: 'within_1_year',
    relocation: 'preferred_local',
    familyGoals: 'wants_children_later',
    languagesSpoken: ['English', 'Arabic'],
    isVerified: true,
    audioDurationSeconds: 18,
  },
  {
    id: 'c4',
    name: 'Layla Al-Hassan',
    firstName: 'Layla',
    age: 24,
    gender: 'female',
    occupation: 'Pediatric physiotherapist',
    education: 'BSc, University of Birmingham',
    city: 'Birmingham',
    country: 'United Kingdom',
    bio: 'Helping children walk and heal fills my days. Nature walks, herbal gardening, quiet evenings with a book.',
    photos: gallery('photo-1567532939604-b6b5b0db2604'),
    chips: ['Very practicing', 'Within 6 months', 'Gardening', 'Poetry'],
    religiousPractice: 'very_practicing',
    timeline: 'within_6_months',
    relocation: 'preferred_local',
    familyGoals: 'wants_children_soon',
    languagesSpoken: ['English', 'Arabic'],
    isVerified: true,
    audioDurationSeconds: 12,
  },
  {
    id: 'c5',
    name: 'Salma Qureshi',
    firstName: 'Salma',
    age: 28,
    gender: 'female',
    occupation: 'Environmental lawyer',
    education: 'LLM, Cambridge',
    city: 'Cambridge',
    country: 'United Kingdom',
    bio: 'Advocating for climate justice and ethical living. Ocean swimming, pottery, long discussions on ethics.',
    photos: gallery('photo-1531746020798-e6953c6e8e04'),
    chips: ['Practicing', 'Within a year', 'Pottery', 'Ocean swimming'],
    religiousPractice: 'practicing',
    timeline: 'within_1_year',
    relocation: 'open',
    familyGoals: 'wants_children_soon',
    languagesSpoken: ['English', 'Urdu'],
    isVerified: true,
    audioDurationSeconds: 20,
  },
  {
    id: 'c6',
    name: 'Zainab Mansour',
    firstName: 'Zainab',
    age: 26,
    gender: 'female',
    occupation: 'Heritage restorer',
    education: 'MA, Edinburgh College of Art',
    city: 'Edinburgh',
    country: 'United Kingdom',
    bio: 'Preserving sacred geometry and old stone mosques. Landscape photography, herbal tea, museum walks.',
    photos: gallery('photo-1534528741775-53994a69daeb'),
    chips: ['Very practicing', 'Within a year', 'Islamic arts', 'Photography'],
    religiousPractice: 'very_practicing',
    timeline: 'within_1_year',
    relocation: 'preferred_local',
    familyGoals: 'wants_children_soon',
    languagesSpoken: ['English', 'Arabic'],
    isVerified: true,
    audioDurationSeconds: 15,
  },
  {
    id: 'c7',
    name: 'Soraya Kaddouri',
    firstName: 'Soraya',
    age: 25,
    gender: 'female',
    occupation: 'Biomedical engineer',
    education: 'MEng, Oxford',
    city: 'Oxford',
    country: 'United Kingdom',
    bio: 'Designing prosthetic tech for children. Moroccan pastries, cycling by the river, memorising Surahs.',
    photos: gallery('photo-1580489944761-15a19d654956'),
    chips: ['Practicing', 'Within 6 months', 'Cycling', 'Quran study'],
    religiousPractice: 'practicing',
    timeline: 'within_6_months',
    relocation: 'open',
    familyGoals: 'wants_children_soon',
    languagesSpoken: ['English', 'French', 'Arabic'],
    isVerified: true,
    audioDurationSeconds: 17,
  },
];

/**
 * Overlaps the server is willing to disclose. Note these are *statements of
 * agreement*, never the underlying ranges — the private filters stay private on
 * both sides.
 */
const AGREEMENTS: Record<string, { label: string; value: string }[]> = {
  c1: [
    { label: 'Timeline', value: 'Within a year' },
    { label: 'Children', value: 'Soon, both' },
    { label: 'City', value: 'London, both staying' },
  ],
  c2: [
    { label: 'Timeline', value: 'Six months' },
    { label: 'Children', value: 'Soon, both' },
    { label: 'Relocation', value: 'Open, both' },
  ],
  c3: [
    { label: 'Timeline', value: 'Within a year' },
    { label: 'Children', value: 'Later, both' },
    { label: 'City', value: 'London' },
  ],
  c4: [
    { label: 'Timeline', value: 'Six months' },
    { label: 'Children', value: 'Soon, both' },
    { label: 'Relocation', value: 'Prefers local' },
  ],
  c5: [
    { label: 'Timeline', value: 'Within a year' },
    { label: 'Children', value: 'Soon, both' },
    { label: 'Relocation', value: 'Open, both' },
  ],
  c6: [
    { label: 'Timeline', value: 'Within a year' },
    { label: 'Children', value: 'Soon, both' },
    { label: 'City', value: 'Edinburgh' },
  ],
  c7: [
    { label: 'Timeline', value: 'Six months' },
    { label: 'Children', value: 'Soon, both' },
    { label: 'Relocation', value: 'Open, both' },
  ],
};

export const MOCK_SELF: Profile = {
  id: 'me',
  name: 'Zayd Al-Mansoor',
  firstName: 'Zayd',
  age: 29,
  gender: 'male',
  occupation: 'Architectural designer',
  education: 'MArch, UCL',
  city: 'London',
  country: 'United Kingdom',
  bio: 'Passionate about sustainable Islamic design, morning coffee routines and weekend hiking. Seeking an intentional partner to build a serene home and journey towards Jannah together.',
  photos: [
    unsplash('photo-1507003211169-0a1dd7228f2d'),
    unsplash('photo-1492562080023-ab3db95bfbce'),
    unsplash('photo-1500648767791-00dcc994a43e'),
  ],
  chips: ['Practicing', 'Within a year', 'Hiking', 'Design'],
  religiousPractice: 'practicing',
  timeline: 'within_1_year',
  relocation: 'open',
  familyGoals: 'wants_children_soon',
  languagesSpoken: ['English', 'Arabic'],
  isVerified: true,
};

export const MOCK_PREFERENCES: PrivatePreferences = {
  minAge: 23,
  maxAge: 30,
  minHeightCm: 160,
  maxHeightCm: 178,
  preferredBuilds: ['Slim', 'Average', 'Athletic'],
  preferredCountries: [
    'United Kingdom',
    'United States',
    'Canada',
    'Turkey',
    'Saudi Arabia',
    'United Arab Emirates',
    'Germany',
  ],
  maxDistanceKm: 100,
  preferredPractice: ['very_practicing', 'practicing'],
  desiredTimeline: ['within_6_months', 'within_1_year'],
  ownHeightCm: 182,
  ownWeightKg: 78,
  ownBuild: 'Fit / Active',
};

/** Builds a round of the given size from the sample pool. */
export function buildMockRound(size: number): IntroductionRound {
  const now = new Date();
  const introductions: Introduction[] = MOCK_PROFILES.slice(0, size).map(
    (profile) => ({
      id: `intro-${profile.id}`,
      roundId: 'round-1',
      profile,
      agreements: AGREEMENTS[profile.id] ?? [],
    })
  );

  return {
    id: 'round-1',
    opensAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 20 * 3600 * 1000).toISOString(),
    tier: size > 5 ? 'premium' : 'free',
    introductions,
    submitted: false,
  };
}

const MOCK_RECAP: RecapItem[] = [
  {
    questionId: 'q1',
    heading: 'Prayer as rhythm',
    verdict: 'aligned',
    note: 'Both described shared Fajr without policing.',
  },
  {
    questionId: 'q2',
    heading: 'First year of marriage',
    verdict: 'aligned',
    note: 'Small, two incomes, weekly family dinners.',
  },
  {
    questionId: 'q3',
    heading: 'Financial responsibility',
    verdict: 'aligned',
    note: 'You provide; her income stays hers by choice.',
  },
  {
    questionId: 'q4',
    heading: 'Conflict in the first ten minutes',
    verdict: 'aligned',
    note: 'Both said pause, then sit down calmly.',
  },
  {
    questionId: 'q5',
    heading: 'Where you live in five years',
    verdict: 'discuss',
    note: 'She needs London while her father is unwell. You wrote “open, but not indefinitely”.',
  },
];

/**
 * Mirrors the server contract for the post-icebreaker compatibility view.
 * These are deliberately broad signals only: no private filter, score, or
 * person-specific explanation is ever sent to the other member.
 */
const MOCK_COMPATIBILITY_BREAKDOWN = [
  { topic: 'values', verdict: 'aligned' },
  { topic: 'marriage_timing', verdict: 'aligned' },
  { topic: 'location_and_relocation', verdict: 'discuss' },
  { topic: 'family_plans', verdict: 'aligned' },
  { topic: 'conversation', verdict: 'aligned' },
] as const;

/** Their answers — revealed only once the member submits their own. */
export const MOCK_THEIR_ANSWERS: Record<string, string> = {
  q1: 'Fajr together when we can, and never guilt-tripping each other about the ones we miss. Rhythm, not policing.',
  q2: 'Small and unglamorous. Two salaries, one flat, Thursday dinners with both families, and a lot of learning how the other person likes silence.',
  q3: 'You provide the household as a duty; my income is mine and I will still put it in when it matters. One honest look at the numbers each month.',
  q4: 'We stop. Fifteen minutes apart, then we sit down. No raised voices, no leaving the house, no involving family in the first hour.',
  q5: 'I would like to stay in London near my parents while my father is unwell. After that, I am genuinely open — including abroad.',
};

export const MOCK_CONNECTIONS: Connection[] = [
  {
    id: 'conn-1',
    profile: MOCK_PROFILES[0]!,
    createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    stage: 'open',
    questions: [
      { questionId: 'q1', origin: 'both', myAnswer: '', mySubmittedAt: undefined },
      { questionId: 'q2', origin: 'them', myAnswer: '' },
      { questionId: 'q3', origin: 'me', myAnswer: '' },
      { questionId: 'q4', origin: 'both', myAnswer: '' },
      { questionId: 'q5', origin: 'them', myAnswer: '' },
    ],
    recap: MOCK_RECAP,
    compatibilityBreakdown: [...MOCK_COMPATIBILITY_BREAKDOWN],
    lastMessage: 'Then we should talk about where we would live.',
    lastMessageAt: new Date(Date.now() - 3600_000).toISOString(),
    unread: true,
  },
  {
    id: 'conn-2',
    profile: MOCK_PROFILES[3]!,
    createdAt: new Date(Date.now() - 6 * 86400_000).toISOString(),
    stage: 'answering',
    questions: [
      { questionId: 'q1', origin: 'both', myAnswer: '' },
      { questionId: 'q4', origin: 'me', myAnswer: '' },
      { questionId: 'q7', origin: 'them', myAnswer: '' },
      { questionId: 'q9', origin: 'both', myAnswer: '' },
      { questionId: 'q10', origin: 'them', myAnswer: '' },
    ],
    lastMessage: 'Waiting on your answers',
    lastMessageAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    unread: false,
  },
  {
    id: 'conn-3',
    profile: MOCK_PROFILES[5]!,
    createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
    stage: 'choosing_questions',
    questions: [],
    lastMessage: 'Choose your five questions',
    lastMessageAt: new Date(Date.now() - 4 * 86400_000).toISOString(),
    unread: false,
  },
];

export const MOCK_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    connectionId: 'conn-1',
    sender: 'them',
    text: 'Assalamu alaikum. Your answer about the cool-off pause stayed with me — my family shouts first and apologises later.',
    createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
  },
  {
    id: 'm2',
    connectionId: 'conn-1',
    sender: 'me',
    text: 'Wa alaikum assalam. It took me years to learn it. I would rather be slow than loud.',
    createdAt: new Date(Date.now() - 3 * 86400_000 + 600_000).toISOString(),
    readAt: new Date(Date.now() - 3 * 86400_000 + 1_200_000).toISOString(),
  },
  {
    id: 'm3',
    connectionId: 'conn-1',
    sender: 'them',
    text: 'Then we should talk about where we would live. That is the one we disagreed on.',
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  },
  {
    id: 'm4',
    connectionId: 'conn-1',
    sender: 'them',
    voiceUrl: 'mock://voice-1',
    voiceDurationSeconds: 22,
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
  },
  {
    id: 'm5',
    connectionId: 'conn-1',
    sender: 'me',
    voiceUrl: 'mock://voice-2',
    voiceDurationSeconds: 14,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
  },
];

/** Conversation openers surfaced under the recap and above the composer. */
export const CONVERSATION_STARTERS = [
  'Ask about relocation',
  'Invite families',
  'Suggest a call',
];
