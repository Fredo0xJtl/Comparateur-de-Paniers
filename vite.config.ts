import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
// Import dynamique plus bas, pas ici : `vite-plugin-mkcert` charge undici dès
// son `require`, qui référence le global `File` absent en Node < 20. Un
// import statique casserait le chargement de ce fichier de config (donc
// `vite build`) sur tout environnement dont le Node est trop ancien — ex. le
// Raspberry Pi en Node 18, qui ne fait que le build de prod, jamais le dev
// server.

export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = [react()];
  if (command === 'serve') {
    // HTTPS local requis pour le scan caméra sur le LAN, uniquement en dev.
    const { default: mkcert } = await import('vite-plugin-mkcert');
    plugins.push(mkcert());
  }

  return {
    // Chemin public sous lequel l'application est servie. Vaut '/' partout où
    // elle est servie à la racine d'un domaine ou d'un hôte : dev server,
    // `vite preview`, et le Raspberry derrière Caddy. Une publication sur
    // GitHub Pages, elle, sert l'application sous un SOUS-CHEMIN
    // (`/Comparateur-de-Paniers/`) : tous les chemins absolus commençant par
    // '/' y désigneraient alors la racine du domaine, donc des fichiers qui
    // n'existent pas — page blanche garantie (dette identifiée dès l'audit du
    // 01/09 sous le nom AUD-01, restée ouverte jusqu'au 05/09).
    //
    // Piloté par une variable d'environnement plutôt que codé en dur pour que
    // RIEN ne change dans l'usage quotidien : `npm run build` produit toujours
    // une version servie à la racine. Seul `npm run build:pages` produit la
    // version destinée à GitHub Pages.
    base: process.env.PUBLIC_BASE ?? '/',
    plugins,
    server: {
      // Exposed on all interfaces (not just loopback) so the phone can reach the
      // dev server over the LAN for scan/camera testing. Accepted risk: personal
      // home network, HTTPS via mkcert, and the extension bridge now checks an
      // app-identity marker before wiring up (see index.html +
      // extension/bridge/pwa-bridge.js) rather than trusting host/origin alone.
      host: true,
      port: 5174,
      strictPort: true
    },
    // Port fixe et DIFFÉRENT de `server.port` pour `vite preview` (build de
    // production servie en local) : IndexedDB
    // est isolée par origine complète (protocole+hôte+port), donc tourner sur un
    // port distinct suffit à séparer les vraies données (mémoire, paniers,
    // produits) des données de test de la version dev, sans aucun code dédié.
    // vite-plugin-mkcert active aussi HTTPS ici (même certificat que le dev
    // server), donc le téléphone peut y accéder sur le LAN comme en dev.
    preview: {
      host: true,
      port: 4174,
      strictPort: true
    }
  };
});
