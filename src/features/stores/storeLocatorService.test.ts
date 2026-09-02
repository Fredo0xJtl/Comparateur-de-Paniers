import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/db';
import { type StoreLocatorResult } from '../../types/domain';
import { createStoreLocatorService } from './storeLocatorService';

const result: StoreLocatorResult = {
  id: 'node-123',
  storeKey: 'leclerc',
  displayName: 'E.Leclerc Nantes',
  address: '1 Rue Exemple, 44000 Nantes, France',
  postalCode: '44000',
  city: 'Nantes',
  latitude: 47.2184,
  longitude: -1.5536,
  osmType: 'node',
  osmId: 123
};

describe('storeLocatorService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('caches a normalized search for 24 hours', async () => {
    const search = vi.fn(async () => [result]);
    let now = Date.parse('2026-07-17T10:00:00.000Z');
    const service = createStoreLocatorService({ search, now: () => now });

    await expect(service.findStores({ storeKey: 'leclerc', city: ' Nantes ' })).resolves.toEqual([
      result
    ]);
    now += 60_000;
    await expect(service.findStores({ storeKey: 'leclerc', city: 'nantes' })).resolves.toEqual([
      result
    ]);

    expect(search).toHaveBeenCalledTimes(1);
    expect(await db.storeSearchCache.get('leclerc:nantes')).toBeDefined();
  });

  it('blocks two uncached remote searches less than one second apart across service instances', async () => {
    const search = vi.fn(async () => [result]);
    let now = 10_000;
    const service = createStoreLocatorService({ search, now: () => now });

    await service.findStores({ storeKey: 'leclerc', city: 'Nantes' });
    now += 500;

    const reloadedService = createStoreLocatorService({ search, now: () => now });
    await expect(reloadedService.findStores({ storeKey: 'leclerc', city: 'Rennes' })).rejects.toThrow(
      'Patiente une seconde avant une nouvelle recherche.'
    );
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('replaces only the selected store for the same brand', async () => {
    const service = createStoreLocatorService({ search: vi.fn(), now: () => 12_000 });
    await service.selectUserStore(result);
    await service.selectUserStore({ ...result, id: 'way-456', osmType: 'way', osmId: 456 });

    const stores = await service.listSelectedStores();
    expect(stores).toHaveLength(1);
    expect(stores[0]).toMatchObject({ storeKey: 'leclerc', osmId: 456, address: result.address });
  });

  it('should clear city and displayName when URL parsing fails (BUG FIX)', async () => {
    const service = createStoreLocatorService({ search: vi.fn(), now: () => 15_000 });

    const store = {
      id: 'store-leclerc-123',
      storeKey: 'leclerc' as const,
      displayName: 'Old Store Name',
      postalCode: '75000',
      city: 'Old City',
      address: '123 Old Street',
      latitude: 48.5,
      longitude: 2.5,
      osmType: 'node',
      osmId: 123,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };

    await db.userStores.put(store);

    // Invalid Leclerc URL that will fail parsing (no city segment)
    const invalidUrl = 'https://leclercdrive.fr/';
    const saved = await service.saveStoreDriveUrl('store-leclerc-123', invalidUrl);

    // Bug fix: city and displayName should be cleared (not kept from old store)
    expect(saved.city).toBe('');
    expect(saved.displayName).toBe('');
    expect(saved.driveUrl).toBe(invalidUrl);

    // Verify the stored value
    const retrieved = await db.userStores.get('store-leclerc-123');
    expect(retrieved?.city).toBe('');
    expect(retrieved?.displayName).toBe('');
  });

  it('should properly save city and displayName when URL parsing succeeds', async () => {
    const service = createStoreLocatorService({ search: vi.fn(), now: () => 16_000 });

    const store = {
      id: 'store-leclerc-456',
      storeKey: 'leclerc' as const,
      displayName: 'Old Store Name',
      postalCode: '75000',
      city: 'Old City',
      address: '123 Old Street',
      latitude: 48.5,
      longitude: 2.5,
      osmType: 'node',
      osmId: 456,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };

    await db.userStores.put(store);

    // Valid Leclerc URL
    const validUrl = 'https://leclercdrive.fr/magasin-123456-123456-belleville---le-parc.aspx';
    const saved = await service.saveStoreDriveUrl('store-leclerc-456', validUrl);

    // Should extract city and branch from URL
    expect(saved.city).toBe('Belleville');
    expect(saved.displayName).toBe('Le Parc Belleville');
    expect(saved.driveUrl).toBe(validUrl);

    // Verify the stored value
    const retrieved = await db.userStores.get('store-leclerc-456');
    expect(retrieved?.city).toBe('Belleville');
    expect(retrieved?.displayName).toBe('Le Parc Belleville');
  });

  it('restores driveUrl from localStorage backup if IndexedDB store lacks URL', async () => {
    // Create a mock localStorage with a backup URL
    const mockLocalStorageData = new Map<string, string>();
    mockLocalStorageData.set(
      'drive-url-backup',
      JSON.stringify({
        leclerc: 'https://leclercdrive.fr/magasin-restore-test'
      })
    );

    const mockLocalStorage = {
      getItem: (key: string) => mockLocalStorageData.get(key) ?? null,
      setItem: (key: string, value: string) => mockLocalStorageData.set(key, value),
      removeItem: (key: string) => mockLocalStorageData.delete(key),
      clear: () => mockLocalStorageData.clear(),
      key: (index: number) => Array.from(mockLocalStorageData.keys())[index] ?? null,
      length: mockLocalStorageData.size
    };

    // Temporarily override global localStorage
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = mockLocalStorage;

    try {
      // Add a store WITHOUT driveUrl to IndexedDB
      await db.userStores.add({
        id: 'store-leclerc-restore-123',
        storeKey: 'leclerc',
        displayName: 'Leclerc - Restore Test',
        city: 'Test City',
        osmId: 123,
        osmType: 'node',
        latitude: 48.5,
        longitude: 2.5,
        address: 'Test Address',
        postalCode: '75001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
        // Note: driveUrl is intentionally missing
      });

      // Call listSelectedStores which should restore the URL from localStorage
      const service = createStoreLocatorService({ search: vi.fn(), now: () => 17_000 });
      const stores = await service.listSelectedStores();

      // Verify that the URL was restored from localStorage
      expect(stores).toHaveLength(1);
      expect(stores[0].storeKey).toBe('leclerc');
      expect(stores[0].driveUrl).toBe('https://leclercdrive.fr/magasin-restore-test');

      // Verify it was also saved back to IndexedDB
      const saved = await db.userStores.get('store-leclerc-restore-123');
      expect(saved?.driveUrl).toBe('https://leclercdrive.fr/magasin-restore-test');
    } finally {
      // Restore original localStorage
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });
});
