const runtime = globalThis.browser ?? globalThis.chrome;

const status = document.querySelector('#status');
const version = runtime.runtime.getManifest().version;
document.querySelector('#extension-version').textContent = `Version ${version}`;

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
