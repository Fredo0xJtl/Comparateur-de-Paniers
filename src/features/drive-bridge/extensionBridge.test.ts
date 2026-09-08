// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_UNAVAILABLE_MESSAGE, createExtensionBridge, type BridgeMessageEvent } from './extensionBridge';

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

    const result = expect(bridge.detectDriveExtension()).rejects.toThrow(EXTENSION_UNAVAILABLE_MESSAGE);
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

  it('affiche le badge sans activation explicite en build de développement (import.meta.env.DEV)', async () => {
    // Vitest tourne en mode dev (import.meta.env.DEV === true) : le badge
    // doit apparaître même sans le flag localStorage, pour rester un repère
    // toujours visible pendant le développement. En production, il reste
    // opt-in (voir le test précédent et verboseDiagnostics.ts).
    vi.useFakeTimers();
    document.body.innerHTML = '';
    localStorage.removeItem('driveVerboseDiagnostics');
    const bridge = createExtensionBridge({
      messageTarget: createSilentMessageTarget(),
      origin: 'https://192.168.99.15:5174',
      timeoutMs: 25,
      createNonce: () => 'nonce-bridge-123'
    });

    const result = expect(bridge.detectDriveExtension()).rejects.toThrow(EXTENSION_UNAVAILABLE_MESSAGE);
    await vi.advanceTimersByTimeAsync(25);
    await result;

    expect(document.getElementById('drive-price-splitter-pwa-debug-badge')?.textContent).toContain(
      'aucune réponse extension'
    );
    vi.useRealTimers();
  });
});

// Ce message porte deux publics d'un coup, et l'ordre compte. Il s'affiche
// presque toujours parce que le connecteur n'est pas installé — le cas d'un
// débutant, qui doit trouver là comment l'installer. Il couvre aussi
// l'auto-hébergement, seul endroit où quelqu'un apprend qu'il doit déclarer
// son adresse dans les réglages du connecteur, faute de quoi l'extension
// paraît installée, active, et pourtant « indisponible ». Perdre l'une des
// deux moitiés remet silencieusement un des deux publics dans l'impasse.
describe('EXTENSION_UNAVAILABLE_MESSAGE', () => {
  it('oriente d’abord le débutant vers l’installation', () => {
    expect(EXTENSION_UNAVAILABLE_MESSAGE).toMatch(/^Le connecteur Firefox ne répond pas\./);
    expect(EXTENSION_UNAVAILABLE_MESSAGE).toMatch(/Aide/);
  });

  it('garde la sortie de secours pour qui héberge l’application lui-même', () => {
    expect(EXTENSION_UNAVAILABLE_MESSAGE).toMatch(/hébergez cette application vous-même/);
    expect(EXTENSION_UNAVAILABLE_MESSAGE).toMatch(/réglages du connecteur/);
  });

  it('est le seul message utilisé par les services qui constatent l’absence d’extension', async () => {
    // Sans cette constante partagée, la même situation s'expliquait
    // différemment selon l'écran où on la rencontrait.
    const bridge = createExtensionBridge({
      messageTarget: createSilentMessageTarget(),
      origin: 'https://exemple.test',
      timeoutMs: 1
    });
    await expect(bridge.detectDriveExtension()).rejects.toThrow(EXTENSION_UNAVAILABLE_MESSAGE);
  });
});
