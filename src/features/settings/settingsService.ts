import { db } from '../../db/db';
import { defaultSettings, ensureDemoData } from '../../db/seed';
import { type UserSettings } from '../../types/domain';

export async function getSettings() {
  await ensureDemoData();
  const stored = await db.settings.get('default');
  // Fusionner avec les valeurs par défaut (pas juste `?? defaultSettings`) :
  // un enregistrement déjà en base chez un utilisateur existant n'a pas les
  // champs ajoutés après coup (ex. `maxPriceAgeDays`) — sans ce merge, ils
  // resteraient `undefined` indéfiniment au lieu d'hériter d'une valeur saine.
  return stored ? { ...defaultSettings, ...stored } : defaultSettings;
}

export async function updateSettings(changes: Partial<Omit<UserSettings, 'id' | 'updatedAt'>>) {
  const current = await getSettings();
  const next: UserSettings = {
    ...current,
    ...changes,
    id: 'default',
    updatedAt: new Date().toISOString()
  };

  await db.settings.put(next);
  return next;
}
