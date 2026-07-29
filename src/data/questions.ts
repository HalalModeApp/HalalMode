import type { AppLocale } from '@/i18n/locales';
import type { CompatibilityQuestion, QuestionCategory } from '@/types';

export const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  faith: 'Faith',
  family: 'Family',
  money: 'Money',
  conflict: 'Conflict',
  future: 'Future',
  work: 'Work',
  home: 'Home',
  health: 'Health',
};

/**
 * The question library.
 *
 * Every one is written to be answerable in a paragraph and impossible to answer
 * with a yes or a no — that is the bar the reference set, and it is what makes
 * the double-blind reveal worth doing.
 */
export const QUESTION_LIBRARY: CompatibilityQuestion[] = [
  {
    id: 'q1',
    category: 'faith',
    text: 'How do we make prayer a steady part of life at home, without having to remind each other?',
    textAr: 'كيف نجعل الصلاة إيقاع البيت، لا واجبًا نذكّر به بعضنا؟',
  },
  {
    id: 'q2',
    category: 'family',
    text: 'What does our first year of marriage actually look like, week to week?',
    textAr: 'كيف تبدو سنتنا الأولى في الزواج، أسبوعًا بأسبوع؟',
  },
  {
    id: 'q3',
    category: 'money',
    text: 'Who carries what financially, and how often do we look at it together?',
    textAr: 'من يتحمّل ماذا ماليًا، وكم مرة ننظر في ذلك معًا؟',
  },
  {
    id: 'q4',
    category: 'conflict',
    text: 'When we disagree badly, what happens in the first ten minutes?',
    textAr: 'حين نختلف بشدة، ماذا يحدث في الدقائق العشر الأولى؟',
  },
  {
    id: 'q5',
    category: 'future',
    text: 'Where do we live in five years, and whose family is nearby?',
    textAr: 'أين نعيش بعد خمس سنوات، وأي عائلة تكون قريبة منا؟',
  },
  {
    id: 'q6',
    category: 'work',
    text: 'How do we protect the hours that belong only to us?',
    textAr: 'كيف نحمي الساعات التي تخصّنا وحدنا؟',
  },
  {
    id: 'q7',
    category: 'home',
    text: 'How much of our life is shared publicly — photos, names, anything?',
    textAr: 'ما مقدار ما نشاركه من حياتنا علنًا — الصور، الأسماء، أي شيء؟',
  },
  {
    id: 'q8',
    category: 'faith',
    text: 'Whose scholars and opinions do we follow when we disagree on a ruling?',
    textAr: 'من نتبع من العلماء والآراء حين نختلف في مسألة فقهية؟',
  },
  {
    id: 'q9',
    category: 'family',
    text: 'What did your parents get right, and what will we not repeat?',
    textAr: 'ما الذي أصاب فيه والداك، وما الذي لن نكرره؟',
  },
  {
    id: 'q10',
    category: 'health',
    text: 'How honest are we about health, therapy and the things we are working on?',
    textAr: 'كم نحن صادقان بشأن الصحة والعلاج وما نعمل على إصلاحه؟',
  },
  {
    id: 'q11',
    category: 'money',
    text: 'What does "enough" look like to you — and what would we never borrow for?',
    textAr: 'ما معنى «الكفاية» بالنسبة لك، وما الذي لن نستدين من أجله أبدًا؟',
  },
  {
    id: 'q12',
    category: 'future',
    text: 'If one of us had to choose between a calling and a move, how do we decide?',
    textAr: 'لو اضطر أحدنا للاختيار بين دعوته وبين الانتقال، كيف نقرر؟',
  },
];

/** How many questions each side picks. The overlap becomes the shared five. */
export const QUESTIONS_TO_PICK = 5;

/**
 * One rendering boundary for question copy. New locales can provide a
 * translation without every connection screen learning about that locale.
 */
export function questionText(question: CompatibilityQuestion, locale: AppLocale): string {
  return question.translations?.[locale]
    ?? (locale === 'ar' ? question.textAr : undefined)
    ?? question.text;
}
