import { describe, expect, it, vi } from 'vitest';
import { copyTextWithFallback } from './clipboard';

describe('copyTextWithFallback', () => {
  it('uses the legacy copy fallback when clipboard write fails', async () => {
    const legacyCopy = vi.fn(() => true);
    const result = await copyTextWithFallback('liste', {
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
      legacyCopy
    });

    expect(result).toBe('copied');
    expect(legacyCopy).toHaveBeenCalledWith('liste');
  });
});
