import { describe, expect, it, vi } from 'vitest';
import { executeScriptWithTimeout } from './scripting-timeout.js';

describe('executeScriptWithTimeout', () => {
  it('renvoie le résultat normal quand executeScript répond avant le délai (chemin nominal inchangé)', async () => {
    const scripting = { executeScript: vi.fn().mockResolvedValue([{ result: { ok: true } }]) };
    const result = await executeScriptWithTimeout(scripting, { target: { tabId: 1 }, func: () => undefined }, 10_000);
    expect(result).toEqual([{ result: { ok: true } }]);
  });

  it("propage un rejet réel d'executeScript sans le confondre avec un timeout", async () => {
    const scripting = { executeScript: vi.fn().mockRejectedValue(new Error('Invalid tab ID')) };
    await expect(
      executeScriptWithTimeout(scripting, { target: { tabId: 1 }, func: () => undefined }, 10_000)
    ).rejects.toThrow('Invalid tab ID');
  });

  it("lève SCRIPT_EXECUTION_TIMEOUT si executeScript ne se résout jamais avant le délai — c'est tout le bug reproduit : une injection figée (onglet déchargé, page qui ne charge jamais) ne doit plus bloquer indéfiniment", async () => {
    vi.useFakeTimers();
    try {
      const scripting = { executeScript: vi.fn(() => new Promise(() => undefined)) };
      const pending = executeScriptWithTimeout(scripting, { target: { tabId: 1 }, func: () => undefined }, 10_000);
      const assertion = expect(pending).rejects.toThrow('SCRIPT_EXECUTION_TIMEOUT');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ne laisse aucun minuteur actif après une résolution normale (pas de fuite de setTimeout)", async () => {
    vi.useFakeTimers();
    try {
      const scripting = { executeScript: vi.fn().mockResolvedValue([{ result: 'ok' }]) };
      await executeScriptWithTimeout(scripting, { target: { tabId: 1 }, func: () => undefined }, 10_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
