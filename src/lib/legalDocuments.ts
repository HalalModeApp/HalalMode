/** Mock/offline display metadata only. Live version authority is the server registry. */
export const LEGAL_DOCUMENT_FALLBACKS = {
  terms: {
    type: 'terms',
    version: '2026-07-29',
    title: 'Terms of Service',
    effectiveDate: '2026-07-29',
    url: 'https://halalmo.de/terms',
  },
  privacy: {
    type: 'privacy',
    version: '2026-07-29',
    title: 'Privacy Notice',
    effectiveDate: '2026-07-29',
    url: 'https://halalmo.de/privacy',
  },
} as const;
