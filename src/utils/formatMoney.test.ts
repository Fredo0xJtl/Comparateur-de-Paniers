import { describe, expect, it } from 'vitest';
import { formatEuro } from './formatMoney';

describe('formatEuro', () => {
  it('formate au français avec 2 décimales', () => {
    expect(formatEuro(0)).toBe('0,00 €');
    expect(formatEuro(1.35)).toBe('1,35 €');
    expect(formatEuro(1234.5)).toBe('1234,50 €');
    expect(formatEuro(-0.07)).toBe('-0,07 €');
    expect(formatEuro(0.1 + 0.2)).toBe('0,30 €');
  });
});
