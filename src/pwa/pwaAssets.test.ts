import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectRoot = new URL('../../', import.meta.url);

function readProjectFile(path: string) {
  return readFileSync(new URL(path, projectRoot), 'utf8');
}

describe('PWA assets', () => {
  it('defines an installable local manifest', () => {
    const manifest = JSON.parse(readProjectFile('public/manifest.webmanifest'));

    expect(manifest.name).toBe('Comparateur de Paniers');
    expect(manifest.short_name).toBe('Panier');
    expect(manifest.start_url).toBe('./');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: './icon.svg',
          type: 'image/svg+xml',
          purpose: 'any'
        }),
        expect.objectContaining({
          src: './icon-512.png',
          type: 'image/png',
          purpose: 'any'
        }),
        expect.objectContaining({
          src: './icon-maskable-512.png',
          type: 'image/png',
          purpose: 'maskable'
        })
      ])
    );
  });

  // Le manifeste est copié tel quel depuis public/ : Vite n'y réécrit aucun
  // chemin. Un chemin absolu y désignerait la racine du domaine, alors qu'une
  // publication GitHub Pages sert l'application sous `/<dépôt>/`. Les chemins
  // relatifs, eux, se résolvent contre l'URL du manifeste et restent corrects
  // dans les deux cas — d'où ce contrôle, qui empêche un retour discret aux
  // chemins absolus.
  it('keeps every manifest path relative so a sub-path deployment still works', () => {
    const manifest = JSON.parse(readProjectFile('public/manifest.webmanifest'));
    const paths = [manifest.start_url, manifest.scope, ...manifest.icons.map((icon) => icon.src)];

    for (const path of paths) {
      expect(path.startsWith('/')).toBe(false);
    }
  });

  it('keeps the service worker same-origin and static-asset focused', () => {
    const serviceWorker = readProjectFile('public/sw.js');

    expect(serviceWorker).not.toMatch(/https?:\/\//);
    expect(serviceWorker).toContain("event.request.method !== 'GET'");
    expect(serviceWorker).toContain('requestUrl.origin !== self.location.origin');
    expect(serviceWorker).not.toContain('indexedDB');
    expect(serviceWorker).not.toContain('priceSnapshots');
  });

  // Même raison que pour le manifeste : le service worker n'est pas transformé
  // par Vite. Il déduit son préfixe de sa propre URL plutôt que de le supposer
  // à la racine, sans quoi la mise en cache et le mode hors ligne échouent
  // silencieusement sur un déploiement en sous-chemin.
  it('derives its cached paths from its own location, never from the domain root', () => {
    const serviceWorker = readProjectFile('public/sw.js');

    expect(serviceWorker).toContain("new URL('./', self.location).pathname");
    expect(serviceWorker).not.toMatch(/caches\.match\('\/'\)/);
    expect(serviceWorker).not.toMatch(/STATIC_ASSETS = \['\/'/);
  });

  it('registers the service worker only for production builds', () => {
    const mainSource = readProjectFile('src/main.tsx');

    expect(mainSource).toContain('import.meta.env.PROD');
    expect(mainSource).toContain('navigator.serviceWorker.register(`${BASE_PATH}sw.js`)');
  });

  // Le routeur doit connaître le préfixe public, sinon il interprète
  // `/Comparateur-de-Paniers/` comme une route et n'affiche aucune page.
  it('passes the public base path to the router', () => {
    const mainSource = readProjectFile('src/main.tsx');

    expect(mainSource).toContain('import.meta.env.BASE_URL');
    expect(mainSource).toContain('<BrowserRouter basename={BASE_PATH}>');
  });
});
