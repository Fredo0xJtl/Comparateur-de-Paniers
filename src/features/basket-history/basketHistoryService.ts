import { db } from '../../db/db';
import { type StoreKey, type ValidatedBasket, type ValidatedBasketItem } from '../../types/domain';

export type RecordValidatedBasketInput = {
  storeKey: StoreKey;
  items: ValidatedBasketItem[];
  total: number;
  savings: number;
  operationKey?: string;
  calculationProof?: ValidatedBasket['calculationProof'];
};

export async function recordValidatedBasket(input: RecordValidatedBasketInput): Promise<ValidatedBasket> {
  return db.transaction('rw', db.validatedBaskets, async () => {
    if (input.operationKey) {
      const existing = await db.validatedBaskets.where('operationKey').equals(input.operationKey).first();
      if (existing) return existing;
    }
    const basket: ValidatedBasket = {
      id: createId('basket'),
      storeKey: input.storeKey,
      total: input.total,
      savings: input.savings,
      items: input.items,
      validatedAt: new Date().toISOString(),
      operationKey: input.operationKey,
      calculationProof: input.calculationProof,
      cartFillStatus: 'not_attempted'
    };
    await db.validatedBaskets.add(basket);
    return basket;
  });
}

export async function updateValidatedBasketCartFillStatus(
  basketId: string,
  cartFillStatus: NonNullable<ValidatedBasket['cartFillStatus']>,
  cartFillMessage?: string
) {
  const realization = cartFillStatus === 'done'
    ? { realizedAt: new Date().toISOString(), realizationSource: 'cart_fill_done' as const }
    : {};
  await db.validatedBaskets.update(basketId, { cartFillStatus, cartFillMessage, ...realization });
}

export async function confirmBasketRealized(basketId: string, realizedAt = new Date().toISOString()) {
  await db.validatedBaskets.update(basketId, {
    realizedAt,
    realizationSource: 'manual_confirmation'
  });
}

// Appelé dès que le job d'ajout au panier démarre côté extension (avant
// d'attendre son résultat) — sans ça, un rechargement de page pendant
// l'attente perd le jobId en même temps que tout le reste du state React, et
// il n'y a alors plus aucun moyen de retrouver le rapport final déjà terminé
// côté extension.
export async function updateValidatedBasketCartFillJobId(basketId: string, cartFillJobId: string) {
  await db.validatedBaskets.update(basketId, { cartFillJobId, cartFillStatus: 'in_progress' });
}

export async function listValidatedBaskets(): Promise<ValidatedBasket[]> {
  return db.validatedBaskets.orderBy('validatedAt').reverse().toArray();
}

export async function getSavingsSummary(): Promise<{ estimated: number; validated: number; realized: number }> {
  const baskets = await db.validatedBaskets.toArray();
  const validated = baskets.reduce((sum, basket) => sum + basket.savings, 0);
  const realized = baskets.reduce((sum, basket) => {
    const isRealized = basket.cartFillStatus === 'done' || basket.realizationSource === 'manual_confirmation';
    return sum + (isRealized ? basket.savings : 0);
  }, 0);
  return {
    estimated: roundMoney(validated),
    validated: roundMoney(validated),
    realized: roundMoney(realized)
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
