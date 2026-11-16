// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductForm } from './ProductForm';
import { emptyProductForm } from './productService';

afterEach(cleanup);

describe('ProductForm', () => {
  it('garde les champs avancés repliés mais soumis, avec des libellés lisibles', () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(
      <ProductForm
        values={{ ...emptyProductForm, name: 'Lait' }}
        errors={{}}
        idPrefix="t"
        submitLabel="Enregistrer"
        onChange={onChange}
        onSubmit={onSubmit}
      />
    );
    const details = screen.getByText('Plus de précisions (facultatif)').closest('details');
    expect(details?.open).toBe(false);
    expect(screen.getByRole('option', { name: 'au litre' })).toHaveProperty('value', 'liter');
    fireEvent.change(screen.getByLabelText('Comparer les prix…'), { target: { value: 'liter' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ comparisonUnit: 'liter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
