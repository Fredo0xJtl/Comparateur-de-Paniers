import { type ProductCandidate } from '../../types/domain';

export type AddToCartAction = {
  kind: 'open_product_page' | 'open_search_page';
  label: 'Ouvrir pour ajout manuel';
  url: string;
  warning: string;
};

type AddToCartOptions = {
  experimentalAddToCart: boolean;
};

const manualWarning =
  'Expérimental : validation manuelle requise. Vérifie le prix, la quantité et le panier sur le site officiel.';

export function buildAddToCartAction(
  candidate: ProductCandidate | undefined,
  options: AddToCartOptions
): AddToCartAction | null {
  if (!options.experimentalAddToCart || !candidate) {
    return null;
  }

  if (isExternalUrl(candidate.productUrl)) {
    return {
      kind: 'open_product_page',
      label: 'Ouvrir pour ajout manuel',
      url: candidate.productUrl,
      warning: manualWarning
    };
  }

  if (isExternalUrl(candidate.searchUrl)) {
    return {
      kind: 'open_search_page',
      label: 'Ouvrir pour ajout manuel',
      url: candidate.searchUrl,
      warning: manualWarning
    };
  }

  return null;
}

function isExternalUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
  } catch {
    return false;
  }
}
