export const CART_AUTOMATION_CONSENT_VERSION = 1 as const;

export type CartAutomationConsent = {
  cartAutomationConsentVersion?: number;
  cartAutomationConsentedAt?: string;
};

export function hasCurrentCartAutomationConsent(settings: CartAutomationConsent): boolean {
  return settings.cartAutomationConsentVersion === CART_AUTOMATION_CONSENT_VERSION;
}

export function grantCartAutomationConsent(consentedAt = new Date().toISOString()) {
  return {
    cartAutomationConsentVersion: CART_AUTOMATION_CONSENT_VERSION,
    cartAutomationConsentedAt: consentedAt
  };
}
