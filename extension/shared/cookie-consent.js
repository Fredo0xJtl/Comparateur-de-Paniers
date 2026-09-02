import { executeScriptWithTimeout } from './scripting-timeout.js';

// Both Leclerc and Courses U show a OneTrust (or equivalent) cookie consent
// modal on first load. Until it's dismissed, the underlying page never
// renders real content — search results stay empty and every downstream
// selector reads the consent widget's own DOM instead (its "eur"-containing
// French copy was even producing false-positive product-price diagnostics).
export async function dismissCookieConsentOnPage() {
  // Reject non-essential cookies first — only fall back to accepting when no
  // reject option is offered, since the collection only needs the page to
  // render (strictly necessary cookies), not tracking/ad consent.
  const oneTrustReject = document.querySelector('#onetrust-reject-all-handler');
  if (oneTrustReject) {
    oneTrustReject.click();
    return { dismissed: true, mode: 'onetrust_reject' };
  }

  const rejectCandidate = [...document.querySelectorAll('button, a[role="button"], [role="button"]')].find(
    (element) => {
      const text = (element.textContent || '').trim();
      const container = element.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [role="dialog"]');
      return container && /tout refuser|refuser tout|continuer sans accepter|^refuser$/i.test(text);
    }
  );
  if (rejectCandidate) {
    rejectCandidate.click();
    return { dismissed: true, mode: 'heuristic_reject' };
  }

  // Audit sécurité du 30/08 (MEDIUM #7, choix explicite de l'utilisateur :
  // fail-closed strict plutôt que consentir au tracking à sa place). Avant
  // ce correctif, l'absence de bouton de refus reconnu faisait cliquer
  // "Tout accepter" en silence — jamais plus : si un bouton d'acceptation
  // existe (donc une bannière bloque bien la page, comme documenté en tête
  // de fichier) mais qu'aucun refus n'a pu être identifié, on ne clique
  // plus rien du tout et on le signale explicitement à l'appelant
  // (CONSENT_REJECT_UNAVAILABLE) plutôt que de rendre un simple
  // `dismissed: false` indiscernable d'une page sans bannière du tout.
  // Risque assumé : si le VRAI bouton de refus d'un des deux sites n'est
  // pas reconnu par l'heuristique ci-dessus, ce magasin cessera de
  // fonctionner (voir ensureLeclercCatalogReady / ensureCoursesUCatalogReady)
  // jusqu'à correction de l'heuristique — à surveiller au prochain test réel.
  const oneTrustAccept = document.querySelector('#onetrust-accept-btn-handler');
  const acceptCandidate =
    oneTrustAccept ||
    [...document.querySelectorAll('button, a[role="button"], [role="button"]')].find((element) => {
      const text = (element.textContent || '').trim();
      const container = element.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [role="dialog"]');
      return container && /tout accepter|accepter tout|j'accepte|^accepter$/i.test(text);
    });
  if (acceptCandidate) {
    return { dismissed: false, code: 'CONSENT_REJECT_UNAVAILABLE' };
  }

  return { dismissed: false };
}

export async function runCookieConsentDismissal(scripting, tabId) {
  try {
    const results = await executeScriptWithTimeout(scripting, {
      target: { tabId },
      func: dismissCookieConsentOnPage
    });
    return results?.[0]?.result ?? { dismissed: false };
  } catch {
    return { dismissed: false };
  }
}
