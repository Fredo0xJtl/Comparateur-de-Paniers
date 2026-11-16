// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormatNoticesPanel } from './CoveragePanels';

afterEach(cleanup);

// Résumé « formats différents » (16/11) : doit nommer le produit et montrer,
// avant le conseil, le format de la liste face à celui de chaque magasin.
describe('FormatNoticesPanel', () => {
  it('n’affiche rien quand tous les formats concordent', () => {
    const { container } = render(<FormatNoticesPanel notices={[]} productNameById={new Map()} />);
    expect(container.innerHTML).toBe('');
  });

  it('montre le format demandé et celui de chaque magasin, avec le paquet retenu', () => {
    render(
      <FormatNoticesPanel
        notices={[
          {
            itemId: 'item-jus',
            productId: 'prod-jus',
            requested: '1 L',
            selectedStoreKey: 'leclerc',
            byStore: { leclerc: '3 L', hyperu: '2 L' },
            selectedDiffersFromList: true,
            storesDiffer: true
          }
        ]}
        productNameById={new Map([['prod-jus', 'Jus d’orange']])}
      />
    );

    expect(screen.getByRole('heading', { name: '1 produit n’a pas le même format partout' })).toBeTruthy();
    expect(screen.getByText('Jus d’orange')).toBeTruthy();
    expect(screen.getByText('Ta liste : 1 L · Leclerc : 3 L (retenu) · Hyper U : 2 L')).toBeTruthy();
  });
});
