/** Stable semantic selectors for native automation; do not use coordinates. */
export const testIds = {
  auth: { email: 'auth-email', submit: 'auth-send-link', language: 'auth-language' },
  onboarding: { next: 'onboarding-next', back: 'onboarding-back', submit: 'onboarding-submit' },
  daily: { reset: 'daily-reset', pop: 'daily-pop-mode', primary: 'daily-primary-action' },
  you: { profile: 'you-tab-profile', matching: 'you-tab-private', settings: 'you-tab-settings' },
  settings: {
    blocked: 'settings-blocked-members',
    blockedTitle: 'settings-blocked-title',
    notifications: 'settings-notifications',
    delete: 'settings-delete-account',
    deleteDialog: 'settings-delete-dialog',
  },
  recap: { compatibility: 'compatibility-breakdown', open: 'recap-open-connection' },
  chat: { call: 'chat-call', safety: 'chat-safety', composer: 'chat-composer', send: 'chat-send' },
} as const;
