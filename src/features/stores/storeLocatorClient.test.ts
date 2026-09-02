import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchNominatimStores } from './storeLocatorClient';

describe('searchNominatimStores', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses Nominatim results into StoreLocatorResult entries', async () => {
    const payload = [
      {
        osm_type: 'node',
        osm_id: 123,
        display_name: 'E.Leclerc, Rue Exemple, Nantes',
        lat: '47.2184',
        lon: '-1.5536',
        address: {
          house_number: '1',
          road: 'Rue Exemple',
          city: 'Nantes',
          postcode: '44000'
        }
      }
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload)
      })
    );

    const results = await searchNominatimStores({ storeKey: 'leclerc', city: 'Nantes' });

    expect(results).toEqual([
      {
        id: 'leclerc-node-123',
        storeKey: 'leclerc',
        displayName: 'E.Leclerc, Rue Exemple, Nantes',
        address: '1 Rue Exemple',
        city: 'Nantes',
        postalCode: '44000',
        latitude: 47.2184,
        longitude: -1.5536,
        osmType: 'node',
        osmId: 123
      }
    ]);
  });

  it('throws a French error message when the network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(searchNominatimStores({ storeKey: 'leclerc', city: 'Nantes' })).rejects.toThrow(
      'La recherche de magasins est indisponible.'
    );
  });

  it('throws when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(searchNominatimStores({ storeKey: 'hyperu', city: 'Rennes' })).rejects.toThrow(
      'La recherche de magasins est indisponible.'
    );
  });

  it('throws when the payload is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ error: 'nope' }) })
    );

    await expect(searchNominatimStores({ storeKey: 'hyperu', city: 'Rennes' })).rejects.toThrow(
      'La recherche de magasins est indisponible.'
    );
  });
});
