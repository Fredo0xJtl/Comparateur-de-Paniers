import { describe, expect, it } from 'vitest';
import { appRoutes } from './navigation';

describe('appRoutes', () => {
  it('exposes the five MVP pages in navigation order', () => {
    expect(appRoutes.map((route) => route.path)).toEqual([
      '/',
      '/scan',
      '/produits',
      '/liste',
      '/comparaison',
      '/parametres'
    ]);
  });
});
