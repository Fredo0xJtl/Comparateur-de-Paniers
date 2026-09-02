import { executeScriptWithTimeout } from '../../shared/scripting-timeout.js';

export function classifyLeclercPage(snapshot) {
  if (!snapshot || !isLeclercHostname(snapshot.hostname)) {
    return { state: 'wrong_host', code: 'UNEXPECTED_HOST' };
  }
  if (snapshot.hasCaptcha) {
    return { state: 'blocked', code: 'CAPTCHA_REQUIRED' };
  }
  // Page d'erreur technique générique du back-office Leclerc
  // ("pgeWCSDxxx_Erreur.aspx", "Désolé, ce service est momentanément
  // indisponible") — observée en réel le 2026-08-28 : la page ne finissait
  // jamais son chargement, ce qui bloquait scripting.executeScript
  // indéfiniment avant l'ajout du timeout dédié (scripting-timeout.js).
  // Reconnue ici pour un diagnostic clair (panne côté site) plutôt qu'un
  // générique UNSUPPORTED_PAGE/SCRIPT_EXECUTION_TIMEOUT si elle finit par
  // charger sans bloquer le script.
  if (snapshot.hasSiteError) {
    return { state: 'blocked', code: 'LECLERC_SITE_ERROR' };
  }
  if (snapshot.hasStorePrompt && !snapshot.hasCatalog) {
    return { state: 'store_required', code: 'DRIVE_SELECTION_REQUIRED' };
  }
  if (snapshot.hasCatalog) {
    return { state: 'catalog_ready', code: null };
  }
  return { state: 'unknown', code: 'UNSUPPORTED_PAGE' };
}

function isLeclercHostname(value) {
  return value === 'leclercdrive.fr' || value?.endsWith('.leclercdrive.fr');
}

// `timeoutMs` optionnel (passé tel quel à executeScriptWithTimeout, qui a
// déjà sa propre valeur par défaut si `undefined`) : un appelant qui veut
// juste un signal "l'onglet répond-il encore ?" rapide (ex: sonde de survie
// après un SCRIPT_EXECUTION_TIMEOUT ailleurs, voir collectLeclercStore) n'a
// pas besoin de la pleine fenêtre par défaut — sans ce paramètre, il n'y
// avait aucun moyen de réduire ce budget pour cet usage précis.
export async function probeLeclercTab({ scripting, tabId, timeoutMs }) {
  const results = await executeScriptWithTimeout(
    scripting,
    {
      target: { tabId },
      func: readPublicLeclercPageState
    },
    timeoutMs
  );
  const snapshot = results?.[0]?.result;
  return { ...classifyLeclercPage(snapshot), snapshot };
}

function readPublicLeclercPageState() {
  const visibleText = document.body?.innerText?.slice(0, 100_000).toLowerCase() ?? '';
  const inputs = [...document.querySelectorAll('input')];
  const links = [...document.querySelectorAll('a[href]')];
  const productSignals = document.querySelectorAll(
    '[data-product-id], [data-product], [itemtype*="Product"], article[class*="product" i]'
  );
  const hasPostalInput = inputs.some((input) => {
    const signal = `${input.name} ${input.id} ${input.placeholder} ${input.autocomplete}`.toLowerCase();
    return /postal|zip|code.{0,8}postal/.test(signal);
  });
  const hasProductLink = links.some((link) => /produit|product|article/i.test(link.href));

  return {
    hostname: location.hostname,
    pathname: location.pathname,
    title: document.title.slice(0, 300),
    hasCaptcha: /captcha|pas un robot|robot/.test(visibleText),
    hasSiteError:
      /pgewcsd\d+_erreur/i.test(location.pathname) || /momentan[ée]ment indisponible/.test(visibleText),
    hasStorePrompt:
      hasPostalInput || /choisissez votre magasin|saisis mon code postal|sélectionner un drive/.test(visibleText),
    hasCatalog:
      productSignals.length > 0 ||
      (hasProductLink && /ajouter au panier|mes produits|nos produits|rayons/.test(visibleText)),
    productSignalCount: Math.min(productSignals.length, 10_000)
  };
}
