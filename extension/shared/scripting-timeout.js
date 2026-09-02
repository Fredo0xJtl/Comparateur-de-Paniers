// `scripting.executeScript` (WebExtensions MV3) peut ne jamais se résoudre du
// tout — onglet déchargé par Android en pleine injection, page qui ne finit
// jamais de charger — et contrairement à chaque boucle d'attente bornée des
// deux collecteurs, cet unique `await` n'a lui-même aucune limite de temps.
// Ces boucles ne revérifient leur propre échéance qu'ENTRE deux appels,
// jamais PENDANT un appel en cours : un seul appel qui reste bloqué gèle donc
// toute la collecte indéfiniment — sans erreur, sans diagnostic, et même le
// chien de garde de 15 minutes du job-runner (job-runner.js) ne peut rien y
// faire (annuler son signal ne fait qu'agiter un drapeau que personne ne
// revérifiera avant la fin de cet appel qui ne finit jamais).
//
// Un timeout dur par appel comble cette lacune. Chemin nominal inchangé :
// `executeScript` répond normalement en quelques centaines de millisecondes,
// bien avant que le minuteur n'entre en jeu — seul un appel réellement figé
// finit par lever cette erreur.
const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;

export async function executeScriptWithTimeout(scripting, params, timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      scripting.executeScript(params),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SCRIPT_EXECUTION_TIMEOUT')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
