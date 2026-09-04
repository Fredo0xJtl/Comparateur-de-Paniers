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

// Applique le thème choisi à toute l'app via un attribut sur <html> : le CSS
// (voir styles.css) prévoit des overrides `[data-theme="dark"]` /
// `[data-theme="light"]` qui priment sur la préférence système. 'system' (ou
// absent) retire l'attribut pour revenir au comportement d'origine, piloté
// uniquement par `prefers-color-scheme`. Appelé au démarrage de l'app (App.tsx)
// et immédiatement lors du changement dans Réglages, pour un retour visuel
// instantané sans attendre l'écriture en base.
export function applyTheme(theme: UserSettings['theme']) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}
