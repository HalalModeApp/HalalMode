import { LEGAL_DOCUMENT_FALLBACKS } from '@/lib/legalDocuments';
import {
  normalizeLegalConsentStatus,
  type LegalConsentStatus,
} from '@/lib/legalConsent';
import { requireSupabase, USE_MOCKS } from '@/lib/supabase';

const mockStatus: LegalConsentStatus = {
  required: false,
  currentDocuments: [
    LEGAL_DOCUMENT_FALLBACKS.terms,
    LEGAL_DOCUMENT_FALLBACKS.privacy,
  ],
};

export async function fetchMyLegalConsentStatus(): Promise<LegalConsentStatus> {
  if (USE_MOCKS) return mockStatus;
  const { data, error } = await requireSupabase().rpc('get_my_legal_consent_status');
  if (error) throw error;
  return normalizeLegalConsentStatus(data);
}

export async function acceptCurrentLegalDocuments(): Promise<LegalConsentStatus> {
  if (USE_MOCKS) return mockStatus;
  const { data, error } = await requireSupabase().rpc('accept_current_legal_documents');
  if (error) throw error;
  return normalizeLegalConsentStatus(data);
}
