import { describe, expect, it } from 'vitest';
import { normalizeProductForm, validateProductForm } from './productService';

describe('productService', () => {
  it('requires a product name and a valid comparison unit', () => {
    const result = validateProductForm({
      name: '   ',
      brand: '',
      barcode: '',
      category: '',
      variant: '',
      comparisonUnit: 'invalid',
      allowDifferentFormat: true,
      allowPrivateLabel: true
    });

    expect(result.isValid).toBe(false);
    expect(result.errors.name).toBe('Nom obligatoire');
    expect(result.errors.comparisonUnit).toBe('Unité de comparaison invalide');
  });

  it('trims text fields and keeps only barcode digits', () => {
    const normalized = normalizeProductForm({
      name: '  Thé glacé  ',
      brand: '  Marque  ',
      barcode: ' 301 234-567 ',
      category: '',
      variant: '',
      comparisonUnit: 'liter',
      allowDifferentFormat: true,
      allowPrivateLabel: false
    });

    expect(normalized.name).toBe('Thé glacé');
    expect(normalized.brand).toBe('Marque');
    expect(normalized.barcode).toBe('301234567');
  });
});
