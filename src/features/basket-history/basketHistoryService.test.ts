import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import {
  confirmBasketRealized,
  getSavingsSummary,
  recordValidatedBasket,
  updateValidatedBasketCartFillStatus
} from './basketHistoryService';

const input = {
  storeKey: 'leclerc' as const,
  items: [{ productId: 'p1', productName: 'Produit', quantity: 1, lineTotal: 2 }],
  total: 2,
  savings: 1.25,
  operationKey: 'proof-v1:p1:leclerc',
  calculationProof: {
    format: 'comparateur-panier-calculation-proof' as const,
    formatVersion: 1 as const,
    createdAt: '2026-09-01T10:00:00.000Z',
    engineVersion: 1 as const,
    trustStatus: 'trusted' as const,
    lines: [{ itemId: 'i1', productId: 'p1', lineTotal: 2 }]
  }
};

describe('basketHistoryService — niveaux de gain', () => {
  beforeEach(async () => { await db.delete(); await db.open(); });

  it('ne compte comme réalisé ni un panier seulement validé, ni un remplissage échoué ou partiel', async () => {
    const basket = await recordValidatedBasket(input);
    expect(await getSavingsSummary()).toEqual({ estimated: 1.25, validated: 1.25, realized: 0 });
    await updateValidatedBasketCartFillStatus(basket.id, 'failed');
    expect((await getSavingsSummary()).realized).toBe(0);
    await updateValidatedBasketCartFillStatus(basket.id, 'partial');
    expect((await getSavingsSummary()).realized).toBe(0);
  });

  it('compte une seule fois un remplissage réussi', async () => {
    const first = await recordValidatedBasket(input);
    const duplicate = await recordValidatedBasket(input);
    expect(duplicate.id).toBe(first.id);
    await updateValidatedBasketCartFillStatus(first.id, 'done');
    expect(await getSavingsSummary()).toEqual({ estimated: 1.25, validated: 1.25, realized: 1.25 });
  });

  it('compte une confirmation manuelle explicite et conserve la preuve', async () => {
    const basket = await recordValidatedBasket({ ...input, operationKey: 'manual:p1' });
    await confirmBasketRealized(basket.id, '2026-09-01T11:00:00.000Z');
    const stored = await db.validatedBaskets.get(basket.id);
    expect(stored?.realizationSource).toBe('manual_confirmation');
    expect(stored?.calculationProof?.engineVersion).toBe(1);
    expect((await getSavingsSummary()).realized).toBe(1.25);
  });
});
