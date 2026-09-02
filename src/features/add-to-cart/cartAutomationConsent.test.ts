import { describe, expect, it } from 'vitest';
import { CART_AUTOMATION_CONSENT_VERSION, grantCartAutomationConsent, hasCurrentCartAutomationConsent } from './cartAutomationConsent';

describe('consentement au remplissage automatique', () => {
  it('refuse une absence de consentement ou une version devenue obsolète', () => {
    expect(hasCurrentCartAutomationConsent({})).toBe(false);
    expect(hasCurrentCartAutomationConsent({ cartAutomationConsentVersion: 0 })).toBe(false);
  });

  it('accepte uniquement la version explicite courante', () => {
    const patch = grantCartAutomationConsent('2026-09-01T12:00:00.000Z');
    expect(patch).toEqual({
      cartAutomationConsentVersion: CART_AUTOMATION_CONSENT_VERSION,
      cartAutomationConsentedAt: '2026-09-01T12:00:00.000Z'
    });
    expect(hasCurrentCartAutomationConsent(patch)).toBe(true);
  });
});
