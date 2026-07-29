/**
 * Product analytics intentionally accepts only event metadata. Profile text,
 * answers, messages, media URLs, phone numbers, and identifiers are excluded
 * from this contract by type and runtime validation.
 */
export type ProductEventName =
  | 'auth_link_requested'
  | 'onboarding_completed'
  | 'daily_round_viewed'
  | 'interest_submitted'
  | 'connection_opened'
  | 'compatibility_recap_viewed'
  | 'message_sent'
  | 'report_submitted'
  | 'premium_sheet_viewed';

export type ProductEvent = {
  name: ProductEventName;
  occurredAt: string;
  properties?: Record<string, string | number | boolean>;
};

export type AnalyticsSink = (event: ProductEvent) => void | Promise<void>;

let sink: AnalyticsSink | null = null;

export function setAnalyticsSink(next: AnalyticsSink | null) {
  sink = next;
}

export function trackProductEvent(
  name: ProductEventName,
  properties?: ProductEvent['properties']
) {
  const safeProperties = sanitizeProperties(properties);
  const event: ProductEvent = {
    name,
    occurredAt: new Date().toISOString(),
    ...(Object.keys(safeProperties).length > 0 ? { properties: safeProperties } : {}),
  };
  void sink?.(event);
  return event;
}

function sanitizeProperties(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, property] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) continue;
    if (typeof property === 'string' || typeof property === 'number' || typeof property === 'boolean') {
      result[key] = property;
    }
  }
  return result;
}
