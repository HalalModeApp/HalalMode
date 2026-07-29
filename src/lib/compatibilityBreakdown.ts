import type { CompatibilityBreakdownItem, CompatibilityTopic, RecapVerdict } from '@/types';

const topics: readonly CompatibilityTopic[] = [
  'values',
  'marriage_timing',
  'location_and_relocation',
  'family_plans',
  'conversation',
];

const verdicts: readonly RecapVerdict[] = ['aligned', 'discuss'];

/**
 * Allows the recap UI to consume only the intentionally small, server-derived
 * contract. Extra fields, duplicate topics, and malformed payloads are
 * discarded so no private data can accidentally become displayable here.
 */
export function sanitizeCompatibilityBreakdown(value: unknown): CompatibilityBreakdownItem[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<CompatibilityTopic>();
  const result: CompatibilityBreakdownItem[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const topic = candidate.topic;
    const verdict = candidate.verdict;
    if (
      typeof topic !== 'string' ||
      typeof verdict !== 'string' ||
      !topics.includes(topic as CompatibilityTopic) ||
      !verdicts.includes(verdict as RecapVerdict) ||
      seen.has(topic as CompatibilityTopic)
    ) continue;

    seen.add(topic as CompatibilityTopic);
    result.push({
      topic: topic as CompatibilityTopic,
      verdict: verdict as RecapVerdict,
    });
  }

  return result;
}
