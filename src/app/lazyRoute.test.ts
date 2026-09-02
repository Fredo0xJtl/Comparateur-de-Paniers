import { describe, expect, it, vi } from 'vitest';
import { loadWithRetry } from './lazyRoute';
import { isChunkLoadError } from './ErrorBoundary';

function Page() {
  return null;
}

describe('loadWithRetry', () => {
  it('returns the named export on the first successful load', async () => {
    const load = vi.fn().mockResolvedValue({ ScanPage: Page });

    await expect(loadWithRetry(load, 'ScanPage', 0)).resolves.toEqual({ default: Page });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries once after a transient network failure, then succeeds', async () => {
    // Cas visé : coupure réseau d'une seconde en mobilité. Sans nouvelle
    // tentative, React.lazy mémorise le rejet et la page reste inaccessible
    // jusqu'à un rechargement complet, même une fois le réseau revenu.
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ ScanPage: Page });

    await expect(loadWithRetry(load, 'ScanPage', 0)).resolves.toEqual({ default: Page });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second failure and surfaces the last error', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Failed to fetch dynamically imported module'));

    await expect(loadWithRetry(load, 'ScanPage', 0)).rejects.toThrow(
      'Failed to fetch dynamically imported module'
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reports a missing export instead of rendering undefined', async () => {
    const load = vi.fn().mockResolvedValue({ SomethingElse: Page });

    await expect(loadWithRetry(load, 'ScanPage', 0)).rejects.toThrow(/ScanPage/);
  });
});

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: /assets/ScanPage-abc.js',
    'error loading dynamically imported module',
    'ChunkLoadError: Loading chunk 3 failed',
    'importing a module script failed'
  ])('recognizes the browser wording %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('does not mistake an ordinary application error for a chunk failure', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
