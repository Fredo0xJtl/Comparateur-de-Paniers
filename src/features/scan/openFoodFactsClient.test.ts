import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupOpenFoodFactsProduct } from './openFoodFactsClient';

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupOpenFoodFactsProduct', () => {
  // Cas réel confirmé par diagnostic (30/08) : product_name = "Orangensaft"
  // (allemand, langue du contributeur d'origine) alors que product_name_fr
  // porte la traduction française exploitable par la recherche des drives.
  it('prefers product_name_fr over product_name when both exist and differ', async () => {
    mockFetchOnce({
      status: 1,
      product: {
        product_name: 'Orangensaft',
        product_name_fr: "Tropicana 100% oranges pressées sans pulpe 1 L",
        brands: 'Tropicana'
      }
    });

    const result = await lookupOpenFoodFactsProduct('3502110009449');

    expect(result).toEqual({
      name: "Tropicana 100% oranges pressées sans pulpe 1 L",
      brand: 'Tropicana'
    });
  });

  it('falls back to product_name when product_name_fr is absent', async () => {
    mockFetchOnce({
      status: 1,
      product: {
        product_name: 'Riz Basmati Lustucru',
        brands: 'Lustucru'
      }
    });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toEqual({ name: 'Riz Basmati Lustucru', brand: 'Lustucru' });
  });

  it('falls back to product_name when product_name_fr is blank', async () => {
    mockFetchOnce({
      status: 1,
      product: {
        product_name: 'Emmental râpé fondant PRESIDENT',
        product_name_fr: '   ',
        brands: 'Président'
      }
    });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toEqual({ name: 'Emmental râpé fondant PRESIDENT', brand: 'Président' });
  });

  it('returns null when neither name field is usable', async () => {
    mockFetchOnce({ status: 1, product: { brands: 'Marque' } });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toBeNull();
  });

  it('returns null when the response is not ok', async () => {
    mockFetchOnce({}, false);

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toBeNull();
  });

  it('returns null when the product is not found (status !== 1)', async () => {
    mockFetchOnce({ status: 0 });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error, timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network error'))
    );

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toBeNull();
  });

  it('omits brand when brands field is absent', async () => {
    mockFetchOnce({ status: 1, product: { product_name: 'Produit sans marque' } });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result).toEqual({ name: 'Produit sans marque' });
  });

  // Cas réel confirmé par diagnostic (01/09) : brands = "Nestlé, La Laitière"
  // (vérifié sur l'API OFF réelle). L'ancien comportement (premier élément)
  // retenait "Nestlé" — un mot que Leclerc n'affiche jamais sur cette fiche
  // (le rayon affiche "La Laitière") — et la recherche échouait totalement.
  // Aucune des deux marques ne figure dans le nom : on retient la dernière,
  // la plus spécifique selon la convention OFF (groupe → marque commerciale).
  it('prefers the last brand over the first when none appears in the name (OFF lists group before brand)', async () => {
    mockFetchOnce({
      status: 1,
      product: {
        product_name: 'Le Petit Pot de Crème au Chocolat',
        brands: 'Nestlé, La Laitière'
      }
    });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result?.brand).toBe('La Laitière');
  });

  // Cas réel vérifié sur l'API OFF (01/09) : brands = "Danone, Centrale,
  // Jebli", et "Jebli" apparaît aussi dans le nom du produit — la preuve la
  // plus forte (présence dans le nom) doit l'emporter sur la simple position
  // dans la liste, y compris quand la marque cherchée n'est pas la dernière.
  it('prefers a brand that appears in the product name over the last-in-list heuristic', async () => {
    mockFetchOnce({
      status: 1,
      product: {
        product_name: 'Jebli رايبي',
        brands: 'Danone, Centrale, Jebli'
      }
    });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result?.brand).toBe('Jebli');
  });

  it('matches a brand in the name regardless of case and accents', async () => {
    mockFetchOnce({
      status: 1,
      product: {
        product_name: 'Emmental râpé fondant PRESIDENT',
        brands: 'Groupe Lactalis, Président'
      }
    });

    const result = await lookupOpenFoodFactsProduct('1234567890123');

    expect(result?.brand).toBe('Président');
  });
});

describe('parsing du champ quantity : lots écrits en toutes lettres', () => {
  // Miroir du correctif appliqué à extension/shared/quantity-parser.js. Les
  // deux formats sont confrontés l'un à l'autre (quantitiesMatch) pour trier
  // les candidats par format cible : si un seul des deux parseurs multiplie,
  // le bon format passe pour un format différent et le tri se dégrade
  // silencieusement. Le champ `quantity` d'OFF est saisi à la main, donc pas
  // toujours normalisé en "6 x 1 L".
  it('multiplie par le nombre de contenants annoncé', async () => {
    mockFetchOnce({
      status: 1,
      product: { product_name: 'Lait demi écrémé', quantity: '6 briques de 1L' }
    });
    const result = await lookupOpenFoodFactsProduct('3256224234494');
    expect(result?.baseQuantity).toBe(6000);
    expect(result?.baseUnit).toBe('ml');
  });

  it('ne multiplie pas sans "de" : le poids annoncé est celui du lot', async () => {
    mockFetchOnce({
      status: 1,
      product: { product_name: 'Jambon', quantity: '6 tranches 200g' }
    });
    const result = await lookupOpenFoodFactsProduct('3256224234494');
    expect(result?.baseQuantity).toBe(200);
    expect(result?.baseUnit).toBe('g');
  });

  it('laisse inchangé le format multiplicateur déjà normalisé', async () => {
    mockFetchOnce({
      status: 1,
      product: { product_name: 'Lait demi écrémé', quantity: '6 x 1 L' }
    });
    const result = await lookupOpenFoodFactsProduct('3256224234494');
    expect(result?.baseQuantity).toBe(6000);
    expect(result?.baseUnit).toBe('ml');
  });
});
