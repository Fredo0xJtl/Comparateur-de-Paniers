import { describe, expect, it } from 'vitest';
import { chromiumManifest } from './build-chromium-extension.mjs';

describe('chromiumManifest', () => {
  it('conserve le service worker MV3 et retire les clés de documentation', () => {
    const manifest = chromiumManifest({
      manifest_version: 3,
      background: { service_worker: 'background/service-worker.js', type: 'module' },
      minimum_chrome_version: '109',
      '//note': 'interne'
    });

    expect(manifest.background).toEqual({ service_worker: 'background/service-worker.js', type: 'module' });
    expect(manifest.minimum_chrome_version).toBe('109');
    expect(Object.keys(manifest).filter((key) => key.startsWith('//'))).toEqual([]);
  });
});
