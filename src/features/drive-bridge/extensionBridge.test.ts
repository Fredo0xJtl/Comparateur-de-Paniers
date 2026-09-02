// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionBridge, type BridgeMessageEvent } from './extensionBridge';

function createSilentMessageTarget() {
  const listeners = new Set<(event: BridgeMessageEvent) => void>();
  return {
    postMessage: vi.fn(),
    addEventListener(_type: 'message', listener: (event: BridgeMessageEvent) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: BridgeMessageEvent) => void) {
      listeners.delete(listener);
    }
  };
}

describe('createExtensionBridge diagnostics', () => {
  beforeEach(() => {
    // Le badge est attaché à documentElement, pas à body : vider body ne
    // suffit pas à l'enlever entre deux tests.
    document.getElementById('drive-price-splitter-pwa-debug-badge')?.remove();
    localStorage.removeItem('driveVerboseDiagnostics');
  });

  it('affiche un badge de timeout quand aucun résultat extension ne revient', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    // Le badge est un outil de diagnostic, jamais affiché à un utilisateur
    // de production : il faut l'activer explicitement (voir
    // verboseDiagnostics.ts).
    localStorage.setItem('driveVerboseDiagnostics', '1');
    const messageTarget = createSilentMessageTarget();
    const bridge = createExtensionBridge({
      messageTarget,
      origin: 'https://192.168.99.15:5174',
      timeoutMs: 25,
      createNonce: () => 'nonce-bridge-123'
    });

    const result = expect(bridge.detectDriveExtension()).rejects.toThrow('Extension Drive indisponible.');
    expect(document.getElementById('drive-price-splitter-pwa-debug-badge')?.textContent).toContain(
      'DPS PWA: ping envoyé'
    );

    await vi.advanceTimersByTimeAsync(25);
    await result;

    expect(document.getElementById('drive-price-splitter-pwa-debug-badge')?.textContent).toContain(
      'aucune réponse extension'
    );
    localStorage.removeItem('driveVerboseDiagnostics');
    vi.useRealTimers();
  });

  it("n'affiche aucun badge tant que le diagnostic verbeux n'est pas activé", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    localStorage.removeItem('driveVerboseDiagnostics');
    const bridge = createExtensionBridge({
      messageTarget: createSilentMessageTarget(),
      origin: 'https://192.168.99.15:5174',
      timeoutMs: 25,
      createNonce: () => 'nonce-bridge-123'
    });

    const result = expect(bridge.detectDriveExtension()).rejects.toThrow('Extension Drive indisponible.');
    await vi.advanceTimersByTimeAsync(25);
    await result;

    expect(document.getElementById('drive-price-splitter-pwa-debug-badge')).toBeNull();
    vi.useRealTimers();
  });
});
