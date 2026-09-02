import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureDemoData } from '../../db/seed';
import { getSettings, updateSettings } from './settingsService';

describe('settingsService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('keeps experimental add-to-cart disabled by default', async () => {
    await ensureDemoData();

    const settings = await getSettings();

    expect(settings.experimentalAddToCart).toBe(false);
  });

  it('updates experimental settings without resetting other preferences', async () => {
    await ensureDemoData();

    const settings = await updateSettings({ experimentalAddToCart: true });

    expect(settings.experimentalAddToCart).toBe(true);
    expect(settings.savingThresholdEuro).toBe(3);
    expect(settings.autoDecisionMinConfidence).toBe(75);
  });
});
