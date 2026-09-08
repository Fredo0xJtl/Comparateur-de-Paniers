import {
  addCustomOrigin,
  normalizeCustomOrigin,
  readCustomOrigins,
  removeCustomOrigin,
  writeCustomOrigins
} from '../shared/custom-origins.js';

const runtime = globalThis.browser ?? globalThis.chrome;

const status = document.querySelector('#status');
const manifest = runtime.runtime.getManifest();
document.querySelector('#extension-version').textContent = `Version ${manifest.version}`;

// Firefox (namespace `browser`) ignore le callback de sendMessage et renvoie
// une promesse ; Chrome (namespace `chrome`) fait l'inverse. Passer un
// callback à Firefox laissait cette ligne de statut vide pour toujours — le
// même défaut que celui qui faisait afficher "Extension Drive indisponible"
// au PWA (voir extension/bridge/pwa-bridge.js).
function showStatus(response) {
  status.textContent = response?.available
    ? `Extension ${response.extensionVersion} prête, protocole ${response.protocolVersion}.`
    : "Impossible de joindre le service local de l'extension.";
}

if (globalThis.browser?.runtime?.sendMessage) {
  runtime.runtime
    .sendMessage({ type: 'DRIVE_CONNECTOR_STATUS' })
    .then(showStatus)
    .catch(() => showStatus(undefined));
} else {
  runtime.runtime.sendMessage({ type: 'DRIVE_CONNECTOR_STATUS' }, showStatus);
}

// --- Adresses où le pont est actif ------------------------------------------

const builtinList = document.querySelector('#builtin-origins');
const customList = document.querySelector('#custom-origins');
const emptyNotice = document.querySelector('#custom-origins-vide');
const form = document.querySelector('#ajout-origine');
const field = document.querySelector('#champ-origine');
const message = document.querySelector('#origine-message');

// Miroir en mémoire de la liste enregistrée. Indispensable, et pas seulement
// pratique : `permissions.request` doit partir DANS le gestionnaire de clic,
// sans le moindre `await` avant lui, sinon Firefox considère que le geste de
// l'utilisateur est perdu et refuse la demande. Les contrôles préalables
// (doublon, limite) doivent donc être synchrones.
let customEntries = [];

function showMessage(text, isError = false) {
  message.textContent = text;
  message.dataset.erreur = isError ? 'oui' : 'non';
}

function renderBuiltinOrigins() {
  const matches = (manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []);
  builtinList.replaceChildren(
    ...(matches.length > 0 ? matches : ['—']).map((match) => {
      const item = document.createElement('li');
      // Affiché tel quel, texte brut : le « /* » final fait partie du motif et
      // dire la vérité vaut mieux qu'une adresse maquillée.
      item.textContent = match;
      return item;
    })
  );
}

function renderCustomOrigins() {
  emptyNotice.hidden = customEntries.length > 0;
  customList.replaceChildren(
    ...customEntries.map((entry) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      // `granted` est renseigné par `refresh()` en interrogeant Firefox.
      // L'utilisateur peut retirer une autorisation depuis « Gérer les
      // extensions » sans passer par ici : afficher l'adresse comme active
      // alors que le pont ne fonctionne plus enverrait chercher la panne au
      // mauvais endroit.
      label.textContent = entry.granted === false ? `${entry.origin} (autorisation retirée)` : entry.origin;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Retirer';
      button.addEventListener('click', () => removeEntry(entry));
      item.append(label, button);
      return item;
    })
  );
}

async function refresh() {
  const stored = await readCustomOrigins(runtime.storage.local);
  customEntries = await Promise.all(
    stored.map(async (entry) => {
      try {
        return { ...entry, granted: await runtime.permissions.contains({ origins: [entry.hostPattern] }) };
      } catch {
        // Impossible de savoir : on n'affiche alors aucune mention plutôt
        // qu'une information fausse dans un sens ou dans l'autre.
        return entry;
      }
    })
  );
  renderCustomOrigins();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const normalized = normalizeCustomOrigin(field.value);
  if (!normalized.ok) {
    showMessage(normalized.error, true);
    return;
  }
  const added = addCustomOrigin(customEntries, normalized.entry);
  if (!added.ok) {
    showMessage(added.error, true);
    return;
  }

  // Appel direct, sans await préalable : voir le commentaire sur
  // `customEntries` plus haut. C'est Firefox qui affiche la demande, nomme
  // l'adresse concernée et enregistre la réponse — l'extension ne s'accorde
  // rien elle-même.
  runtime.permissions
    .request({ origins: [normalized.entry.hostPattern] })
    .then(async (granted) => {
      if (!granted) {
        showMessage('Autorisation refusée : l’extension ne se connectera pas à cette adresse.', true);
        return;
      }
      await writeCustomOrigins(runtime.storage.local, added.entries);
      await refresh();
      field.value = '';
      showMessage(
        `L’extension est maintenant active sur ${normalized.entry.origin}. Rechargez la page du Comparateur de Paniers.`
      );
    })
    .catch(() => {
      showMessage('La demande d’autorisation n’a pas abouti.', true);
    });
});

async function removeEntry(entry) {
  const remaining = removeCustomOrigin(customEntries, entry.origin);
  // Le stockage d'abord : si le retrait de la permission échoue, l'adresse
  // n'est déjà plus dans la liste blanche vérifiée par le service worker.
  // L'ordre inverse laisserait une adresse encore autorisée dans une page
  // qui prétend le contraire.
  await writeCustomOrigins(runtime.storage.local, remaining);
  let permissionRemoved = true;
  try {
    permissionRemoved = (await runtime.permissions.remove({ origins: [entry.hostPattern] })) !== false;
  } catch {
    permissionRemoved = false;
  }
  await refresh();
  if (permissionRemoved) {
    showMessage(`${entry.origin} n’est plus autorisée.`);
    return;
  }
  // L'extension n'accepte déjà plus rien de cette adresse (le service worker
  // vérifie la liste enregistrée), mais l'autorisation Firefox subsiste et
  // seul le gestionnaire d'extensions peut encore la retirer : le taire
  // laisserait une permission accordée que plus rien n'affiche.
  showMessage(
    `${entry.origin} n’est plus autorisée par l’extension. Firefox conserve toutefois l’autorisation d’accès : ` +
      'retirez-la depuis « Modules complémentaires » → Comparateur de Paniers → Autorisations.',
    true
  );
}

renderBuiltinOrigins();
refresh().catch(() => showMessage('Impossible de lire les adresses enregistrées.', true));
