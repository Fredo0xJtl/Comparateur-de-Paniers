import { afterEach, describe, expect, it } from 'vitest';
import {
  isVerboseDiagnosticsEnabled,
  loadVerboseDiagnosticsFlag,
  setVerboseDiagnosticsEnabled
} from './verbose-diagnostics.js';

afterEach(() => {
  // Le flag vit en mémoire de module — le remettre à son défaut (OFF) entre
  // les tests pour ne pas faire fuiter l'état de l'un vers l'autre.
  setVerboseDiagnosticsEnabled(false);
});

describe('verbose-diagnostics', () => {
  it('est désactivé par défaut', () => {
    expect(isVerboseDiagnosticsEnabled()).toBe(false);
  });

  it('setVerboseDiagnosticsEnabled active/désactive explicitement', () => {
    setVerboseDiagnosticsEnabled(true);
    expect(isVerboseDiagnosticsEnabled()).toBe(true);
    setVerboseDiagnosticsEnabled(false);
    expect(isVerboseDiagnosticsEnabled()).toBe(false);
  });

  it('loadVerboseDiagnosticsFlag active le flag quand le storage le confirme', async () => {
    const storageArea = { get: async () => ({ verboseDiagnostics: true }) };
    await loadVerboseDiagnosticsFlag(storageArea);
    expect(isVerboseDiagnosticsEnabled()).toBe(true);
  });

  it("loadVerboseDiagnosticsFlag reste désactivé si le storage n'a rien (première utilisation)", async () => {
    const storageArea = { get: async () => ({}) };
    await loadVerboseDiagnosticsFlag(storageArea);
    expect(isVerboseDiagnosticsEnabled()).toBe(false);
  });

  // Fail-closed : si le storage échoue (quota, contexte déchargé...), le
  // flag reste sur sa valeur par défaut plutôt que de faire planter le
  // démarrage du service worker.
  it('loadVerboseDiagnosticsFlag ne lève jamais si storageArea.get échoue', async () => {
    const storageArea = { get: async () => { throw new Error('storage indisponible'); } };
    await expect(loadVerboseDiagnosticsFlag(storageArea)).resolves.toBeUndefined();
    expect(isVerboseDiagnosticsEnabled()).toBe(false);
  });
});
