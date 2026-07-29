export type LegalDocumentType = 'terms' | 'privacy';

export interface CurrentLegalDocument {
  type: LegalDocumentType;
  version: string;
  title: string;
  effectiveDate: string;
  url: string;
}

export interface LegalConsentStatus {
  /** Fails closed: only the literal server value `false` means current. */
  required: boolean;
  currentDocuments: CurrentLegalDocument[];
}

export function normalizeLegalConsentStatus(value: unknown): LegalConsentStatus {
  const payload = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const rawDocuments = Array.isArray(payload.currentDocuments)
    ? payload.currentDocuments
    : [];
  const currentDocuments = rawDocuments
    .map(normalizeLegalDocument)
    .filter((document): document is CurrentLegalDocument => document !== null);
  const terms = currentDocuments.filter((document) => document.type === 'terms');
  const privacy = currentDocuments.filter((document) => document.type === 'privacy');
  if (currentDocuments.length !== 2 || terms.length !== 1 || privacy.length !== 1) {
    throw new Error('Current legal documents are unavailable.');
  }
  return {
    required: payload.required !== false,
    currentDocuments,
  };
}

export function documentFromStatus(
  status: LegalConsentStatus | undefined,
  type: LegalDocumentType
): CurrentLegalDocument | undefined {
  return status?.currentDocuments.find((document) => document.type === type);
}

function normalizeLegalDocument(value: unknown): CurrentLegalDocument | null {
  if (!value || typeof value !== 'object') return null;
  const document = value as Record<string, unknown>;
  const type = document.type;
  const version = document.version;
  const title = document.title;
  const effectiveDate = document.effectiveDate;
  const url = document.url;
  if ((type !== 'terms' && type !== 'privacy')
    || typeof version !== 'string' || version.trim().length === 0
    || typeof title !== 'string' || title.trim().length < 2
    || typeof effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
    || typeof url !== 'string' || !url.startsWith('https://')) return null;
  return { type, version, title, effectiveDate, url };
}
