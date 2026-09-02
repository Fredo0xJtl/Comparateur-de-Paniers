import { type StoreKey, type StoreLocatorResult } from '../../types/domain';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

const BRAND_QUERY: Record<StoreKey, string> = {
  leclerc: 'E.Leclerc',
  hyperu: 'Hyper U'
};

// La cadence d'appel (politique Nominatim : 1 requête/seconde maximum, sous
// peine de bannissement d'IP) est imposée en amont par
// storeLocatorService.reserveRemoteRequest(), qui la fait respecter via
// IndexedDB — donc de façon persistante d'un rechargement à l'autre, ce qu'un
// compteur en mémoire dans ce module ne saurait pas faire.
const SEARCH_TIMEOUT_MS = 8_000;

type NominatimResult = {
  osm_type: 'node' | 'way' | 'relation';
  osm_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    postcode?: string;
  };
};

export async function searchNominatimStores(input: {
  storeKey: StoreKey;
  city: string;
}): Promise<StoreLocatorResult[]> {
  const query = `${BRAND_QUERY[input.storeKey]} ${input.city}`;
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '8');

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    });
  } catch {
    throw new Error('La recherche de magasins est indisponible.');
  }

  if (!response.ok) {
    throw new Error('La recherche de magasins est indisponible.');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('La recherche de magasins est indisponible.');
  }

  if (!Array.isArray(payload)) {
    throw new Error('La recherche de magasins est indisponible.');
  }

  return payload
    .filter(isNominatimResult)
    .map((result) => toStoreLocatorResult(result, input.storeKey));
}

function isNominatimResult(value: unknown): value is NominatimResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('osm_type' in value) &&
    ('osm_id' in value) &&
    ('display_name' in value) &&
    ('lat' in value) &&
    ('lon' in value)
  );
}

function toStoreLocatorResult(result: NominatimResult, storeKey: StoreKey): StoreLocatorResult {
  const address = result.address;
  const city = address?.city ?? address?.town ?? address?.village;
  const addressLine = [address?.house_number, address?.road].filter(Boolean).join(' ') || undefined;
  return {
    id: `${storeKey}-${result.osm_type}-${result.osm_id}`,
    storeKey,
    displayName: result.display_name,
    address: addressLine,
    city,
    postalCode: address?.postcode,
    latitude: Number(result.lat),
    longitude: Number(result.lon),
    osmType: result.osm_type,
    osmId: result.osm_id
  };
}
