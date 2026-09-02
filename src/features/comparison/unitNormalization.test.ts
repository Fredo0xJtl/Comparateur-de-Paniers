import { describe, expect, it } from 'vitest';
import { calculateLineTotal, calculateUnitPrice } from './unitNormalization';

describe('unitNormalization', () => {
  it('calculates price per liter from milliliters', () => {
    expect(calculateUnitPrice({ price: 1.8, quantity: 1500, unit: 'ml', comparisonUnit: 'liter' })).toBe(1.2);
  });

  it('calculates line total from item quantity', () => {
    expect(calculateLineTotal({ unitPrice: 1.89, wantedQuantity: 3 })).toBe(5.67);
  });
});
