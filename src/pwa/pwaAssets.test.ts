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
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: '/icon.svg',
          type: 'image/svg+xml',
          purpose: 'any'
        }),
        expect.objectContaining({
          src: '/icon-512.png',
          type: 'image/png',
          purpose: 'any'
        }),
        expect.objectContaining({
          src: '/icon-maskable-512.png',
          type: 'image/png',
          purpose: 'maskable'
        })
      ])
    );
  });

  it('keeps the service worker same-origin and static-asset focused', () => {
    const serviceWorker = readProjectFile('public/sw.js');

    expect(serviceWorker).not.toMatch(/https?:\/\//);
    expect(serviceWorker).toContain("event.request.method !== 'GET'");
    expect(serviceWorker).toContain('requestUrl.origin !== self.location.origin');
    expect(serviceWorker).not.toContain('indexedDB');
    expect(serviceWorker).not.toContain('priceSnapshots');
  });

  it('registers the service worker only for production builds', () => {
    const mainSource = readProjectFile('src/main.tsx');

    expect(mainSource).toContain('import.meta.env.PROD');
    expect(mainSource).toContain("navigator.serviceWorker.register('/sw.js')");
  });
});
