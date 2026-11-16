import { useEffect, useMemo, useState } from 'react';
import { resetDemoData } from '../db/seed';
import { wipeAllLocalData } from '../db/maintenance';
import {
  exportLocalBackup,
  importLocalBackup,
  parseLocalBackup,
  summarizeLocalBackup,
  type BackupTableKey,
  type LocalBackup,
  type LocalBackupSummary
} from '../features/backup/backupService';
import { clearDriveSearchMemory } from '../features/drive-bridge/driveRefreshService';
import { applyTheme, getSettings, updateSettings } from '../features/settings/settingsService';
import { type UserSettings } from '../types/domain';

const MAX_BACKUP_FILE_BYTES = 2 * 1024 * 1024;

// Regroupement des tables techniques en catégories compréhensibles pour
// l'utilisateur — demande explicite du 01/09 : pouvoir exporter juste les
// produits, ou juste les prix, etc. plutôt que systématiquement tout.
// `productCandidates` (fiches produit par magasin) est rattaché à "Prix" :
// sans relevé de prix associé, une fiche seule n'a pas d'utilité isolée.
const BACKUP_GROUPS: Array<{ key: string; label: string; tables: BackupTableKey[] }> = [
  { key: 'products', label: 'Produits', tables: ['products'] },
  { key: 'stores', label: 'Magasins', tables: ['userStores'] },
  { key: 'lists', label: 'Listes de courses', tables: ['shoppingLists', 'shoppingListItems'] },
  { key: 'prices', label: 'Prix (fiches + relevés)', tables: ['productCandidates', 'priceSnapshots'] },
  { key: 'overrides', label: 'Corrections manuelles', tables: ['driveManualOverrides'] },
  { key: 'baskets', label: 'Paniers validés', tables: ['validatedBaskets'] },
  { key: 'settings', label: 'Réglages', tables: ['settings'] }
];

export function SettingsPage() {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [backupStatus, setBackupStatus] = useState<'idle' | 'working' | 'ready' | 'error'>('idle');
  const [backupMessage, setBackupMessage] = useState('');
  const [pendingExport, setPendingExport] = useState<LocalBackup | null>(null);
  const [pendingExportSummary, setPendingExportSummary] = useState<LocalBackupSummary | null>(null);
  const [pendingImport, setPendingImport] = useState<LocalBackup | null>(null);
  const [searchMemoryStatus, setSearchMemoryStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [wipeStatus, setWipeStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [pendingWipeConfirm, setPendingWipeConfirm] = useState(false);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(
    () => new Set(BACKUP_GROUPS.map((group) => group.key))
  );

  const selectedTables = useMemo(
    () =>
      BACKUP_GROUPS.filter((group) => selectedGroupKeys.has(group.key)).flatMap((group) => group.tables),
    [selectedGroupKeys]
  );

  function toggleBackupGroup(groupKey: string, checked: boolean) {
    setSelectedGroupKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(groupKey);
      else next.delete(groupKey);
      return next;
    });
  }

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const loadedSettings = await getSettings();
        if (!ignore) {
          setSettings(loadedSettings);
          setSettingsStatus('ready');
        }
      } catch {
        if (!ignore) {
          setSettingsStatus('error');
        }
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, []);

  async function handleResetDemoData() {
    setStatus('saving');
    try {
      await resetDemoData();
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  async function handleWipeAllData() {
    setWipeStatus('working');
    try {
      await wipeAllLocalData();
      setPendingWipeConfirm(false);
      setWipeStatus('done');
      // Recharge tout l'état affiché (réglages notamment) plutôt que de le
      // laisser pointer sur des valeurs qui n'existent plus en base.
      const nextSettings = await getSettings();
      setSettings(nextSettings);
      setSettingsStatus('ready');
    } catch {
      setWipeStatus('error');
    }
  }

  async function handleClearSearchMemory() {
    setSearchMemoryStatus('saving');
    try {
      await clearDriveSearchMemory();
      setSearchMemoryStatus('saved');
    } catch {
      setSearchMemoryStatus('error');
    }
  }

  async function handleExperimentalAddToCartChange(enabled: boolean) {
    setSettingsStatus('loading');
    try {
      const nextSettings = await updateSettings({ experimentalAddToCart: enabled });
      setSettings(nextSettings);
      setSettingsStatus('ready');
    } catch {
      setSettingsStatus('error');
    }
  }

  async function handleThemeChange(theme: NonNullable<UserSettings['theme']>) {
    applyTheme(theme); // effet immédiat, avant même la confirmation d'écriture
    setSettingsStatus('loading');
    try {
      const nextSettings = await updateSettings({ theme });
      setSettings(nextSettings);
      setSettingsStatus('ready');
    } catch {
      setSettingsStatus('error');
    }
  }

  async function handleOpenFoodFactsNameSearchChange(enabled: boolean) {
    setSettingsStatus('loading');
    try {
      const nextSettings = await updateSettings({ openFoodFactsNameSearch: enabled });
      setSettings(nextSettings);
      setSettingsStatus('ready');
    } catch {
      setSettingsStatus('error');
    }
  }

  async function handlePrepareExportBackup() {
    setBackupStatus('working');
    setBackupMessage('');
    setPendingExport(null);
    setPendingExportSummary(null);
    try {
      const backup = await exportLocalBackup(selectedTables);
      setPendingExport(backup);
      setPendingExportSummary(summarizeLocalBackup(backup));
      setBackupStatus('ready');
      setBackupMessage('Sauvegarde prête. Vérifie le résumé avant de la télécharger.');
    } catch (error) {
      console.error('Export local backup a échoué :', error);
      setBackupStatus('error');
      setBackupMessage('Impossible de créer la sauvegarde.');
    }
  }

  async function handleDownloadPreparedBackup() {
    if (!pendingExport) {
      return;
    }

    const json = JSON.stringify(pendingExport, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `drive-price-splitter-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setBackupMessage('Sauvegarde créée sur ton téléphone.');
    const nextSettings = await updateSettings({ lastBackupExportedAt: new Date().toISOString() });
    setSettings(nextSettings);
  }

  async function handleImportFile(file: File | null) {
    setPendingImport(null);
    setPendingExport(null);
    setPendingExportSummary(null);
    setBackupMessage('');
    if (!file) {
      return;
    }

    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setBackupStatus('error');
      setBackupMessage('Sauvegarde trop volumineuse. Limite actuelle : 2 Mo.');
      return;
    }

    setBackupStatus('working');
    try {
      const text = await file.text();
      const backup = parseLocalBackup(text);
      setPendingImport(backup);
      setBackupStatus('ready');
      setBackupMessage(
        `Sauvegarde prête à importer : ${backup.data.products.length} produit(s), ${backup.data.shoppingListItems.length} article(s) de liste et ${backup.data.validatedBaskets.length} panier(s) validé(s).`
      );
    } catch (error) {
      setBackupStatus('error');
      setBackupMessage(error instanceof Error ? error.message : 'Fichier de sauvegarde invalide.');
    }
  }

  async function handleConfirmImport() {
    if (!pendingImport) {
      return;
    }

    setBackupStatus('working');
    try {
      const report = await importLocalBackup(pendingImport);
      setPendingImport(null);
      setBackupStatus('ready');
      setBackupMessage(
        `Import terminé : ${report.products} produit(s), ${report.shoppingListItems} article(s) de liste et ${report.validatedBaskets} panier(s) validé(s) restauré(s).`
      );
      const nextSettings = await getSettings();
      setSettings(nextSettings);
      setSettingsStatus('ready');
    } catch {
      setBackupStatus('error');
      setBackupMessage('Impossible d’importer cette sauvegarde.');
    }
  }

  return (
    <section className="pageStack" aria-labelledby="settings-title">
      <div className="pageTitle">
        <h2 id="settings-title">Réglages</h2>
          <p className="lead">
          Apparence, options, sauvegarde de tes données et remise à zéro. Rien ici n’est nécessaire pour commencer.
        </p>
      </div>

      {import.meta.env.DEV && (
        <div className="settingsPanel">
          <div>
            <h3>Données de démonstration (dev)</h3>
            <p>Réinitialise les produits mockés stockés localement dans IndexedDB.</p>
          </div>
          <button className="primaryButton" type="button" onClick={handleResetDemoData}>
            {status === 'saving' ? 'Réinitialisation...' : 'Réinitialiser'}
          </button>
          {status === 'saved' && <p className="panelText">Données de démonstration réinitialisées.</p>}
          {status === 'error' && (
            <p className="panelText panelTextDanger">La réinitialisation locale a échoué.</p>
          )}
        </div>
      )}

      <div className="settingsPanel">
        <div>
          <h3>Options</h3>
          <p>
            Ces options restent sur ton téléphone. Le remplissage d’un panier ne démarre qu’après ton
            accord, et l’application ne commande ni ne paie jamais à ta place.
          </p>
        </div>
        {settingsStatus === 'loading' && <p className="panelText">Chargement des préférences...</p>}
        {settingsStatus === 'error' && (
          <p className="panelText panelTextDanger">Impossible de charger ou modifier les préférences.</p>
        )}
        {settings && (
          <>
            <fieldset className="checkboxGroup">
              <legend>Apparence</legend>
              {(
                [
                  { value: 'system', label: 'Suivre le téléphone' },
                  { value: 'light', label: 'Clair' },
                  { value: 'dark', label: 'Sombre' }
                ] as const
              ).map((option) => (
                <label className="checkboxLabel" key={option.value}>
                  <input
                    type="radio"
                    name="theme"
                    checked={(settings.theme ?? 'system') === option.value}
                    onChange={() => void handleThemeChange(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
            <label className="checkboxLabel">
              <input
                id="experimental-add-to-cart"
                name="experimentalAddToCart"
                checked={settings.experimentalAddToCart}
                type="checkbox"
                onChange={(event) =>
                  void handleExperimentalAddToCartChange(event.currentTarget.checked)
                }
              />
              <span>Remplir le panier du magasin pour moi (expérimental)</span>
            </label>
            <p className="panelText">
              Avec cette option, l’application peut remplir le panier sur le site du magasin, mais
              seulement après ton accord. Elle ne commande et ne paie jamais. Vérifie toujours le
              panier sur le site du magasin avant de commander.
            </p>
            <label className="checkboxLabel">
              <input
                id="open-food-facts-name-search"
                name="openFoodFactsNameSearch"
                checked={settings.openFoodFactsNameSearch === true}
                type="checkbox"
                onChange={(event) =>
                  void handleOpenFoodFactsNameSearchChange(event.currentTarget.checked)
                }
              />
              <span>Retrouver un produit par son nom (Open Food Facts)</span>
            </label>
            <p className="panelText">
              Ajoute un bouton pour retrouver la marque, le format et le code-barres d’un produit à
              partir de son nom. Open Food Facts est une base de données libre de produits
              alimentaires. Sans cette option, rien de ce que tu tapes ne quitte ton téléphone ; avec
              elle, les mots tapés lui sont envoyés, seulement quand tu touches le bouton.
            </p>
          </>
        )}
      </div>

      <div className="settingsPanel">
        <div>
          <h3>Sauvegarder ou restaurer mes données</h3>
          <p>
            Le fichier de sauvegarde peut contenir tes habitudes d’achat, tes magasins, tes prix et
            tes listes. Il est créé sur ton téléphone et n’est envoyé nulle part.
          </p>
          {settings && (
            <p className={isBackupStale(settings.lastBackupExportedAt) ? 'panelText panelTextWarning' : 'panelText'}>
              {formatBackupReminder(settings.lastBackupExportedAt)}
            </p>
          )}
        </div>
        <fieldset className="checkboxGroup">
          <legend>Données à sauvegarder</legend>
          {BACKUP_GROUPS.map((group) => (
            <label className="checkboxLabel" key={group.key}>
              <input
                type="checkbox"
                checked={selectedGroupKeys.has(group.key)}
                onChange={(event) => toggleBackupGroup(group.key, event.currentTarget.checked)}
              />
              <span>{group.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="cardActions">
          <button
            className="secondaryButton"
            type="button"
            onClick={() => void handlePrepareExportBackup()}
            disabled={backupStatus === 'working' || selectedTables.length === 0}
            title={selectedTables.length === 0 ? 'Sélectionne au moins une catégorie de données.' : undefined}
          >
            Préparer la sauvegarde
          </button>
          <label className="buttonLink fileButton">
            Restaurer une sauvegarde
            <input
              id="backup-import-file"
              name="backupImportFile"
              accept="application/json,.json"
              type="file"
              onChange={(event) => void handleImportFile(event.currentTarget.files?.[0] ?? null)}
            />
          </label>
        </div>
        <p className="panelText">
          Le fichier ne contient que les catégories cochées ci-dessus. Restaurer une sauvegarde
          remplace seulement les catégories présentes dans le fichier ; le reste de tes données n’est
          jamais touché. Rien n’est remplacé sans ta confirmation.
        </p>
        {backupMessage && (
          <p className={backupStatus === 'error' ? 'panelText panelTextDanger' : 'panelText'}>
            {backupMessage}
          </p>
        )}
        {pendingExportSummary && (
          <div className="confirmPanel">
            <p>
              Sauvegarde prête : {pendingExportSummary.products} produit(s),{' '}
              {pendingExportSummary.shoppingListItems} article(s), {pendingExportSummary.stores}{' '}
              magasin(s), {pendingExportSummary.priceSnapshots} prix et{' '}
              {pendingExportSummary.validatedBaskets} panier(s) validé(s).
            </p>
            <button className="primaryButton" type="button" onClick={() => void handleDownloadPreparedBackup()}>
              Télécharger la sauvegarde
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => {
                setPendingExport(null);
                setPendingExportSummary(null);
                setBackupMessage('Sauvegarde annulée.');
              }}
            >
              Annuler
            </button>
          </div>
        )}
        {pendingImport && (
          <div className="confirmPanel">
            <p>
              Confirmer le remplacement de tes données par cette sauvegarde ? Seules les
              catégories présentes dans le fichier sont remplacées ({formatIncludedGroups(pendingImport.includedTables)}) —
              le reste de tes données locales reste intact. Cette action ne contacte aucun serveur.
            </p>
            <button className="dangerButton" type="button" onClick={() => void handleConfirmImport()}>
              Remplacer
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => {
                setPendingImport(null);
                setBackupMessage('Import annulé.');
              }}
            >
              Annuler
            </button>
          </div>
        )}
      </div>

      <div className="settingsPanel">
        <div>
          <h3>Produits introuvables retenus</h3>
          <p>
            Le connecteur retient pendant 3 jours les produits qu’il n’a pas trouvés dans un magasin,
            pour ne pas les rechercher en vain à chaque mise à jour des prix. Si tu vides cette liste,
            tous les produits seront cherchés à nouveau à la prochaine mise à jour. C’est utile si un
            produit a été écarté à tort.
          </p>
        </div>
        <button className="primaryButton" type="button" onClick={() => void handleClearSearchMemory()}>
          {searchMemoryStatus === 'saving' ? 'Vidage...' : 'Vider la mémoire de recherche'}
        </button>
        {searchMemoryStatus === 'saved' && <p className="panelText">Mémoire de recherche vidée.</p>}
        {searchMemoryStatus === 'error' && (
          <p className="panelText panelTextDanger">Le vidage de la mémoire de recherche a échoué.</p>
        )}
      </div>

      {/* Volontairement en tout dernier de la page : la seule action
          irréversible et destructive de tous les réglages. Jusqu'ici affichée
          en 2e position, avant même les réglages courants — un nouvel
          utilisateur ouvrant Réglages tombait d'abord sur un gros bouton
          rouge "Tout effacer" (retour explicite du 04/09, audit visuel
          mobile avant release publique). */}
      <div className="settingsPanel">
        <div>
          <h3>Tout effacer</h3>
          <p>
            Supprime définitivement TOUTES tes données sur cet appareil (produits, magasins, prix,
            listes, paniers validés, réglages). Rien n’est remis à la place. Aucune sauvegarde n’est
            faite automatiquement avant : fais une sauvegarde si tu veux tout garder. Cette action est
            définitive.
          </p>
        </div>
        {!pendingWipeConfirm ? (
          <button
            className="dangerButton"
            type="button"
            onClick={() => setPendingWipeConfirm(true)}
            disabled={wipeStatus === 'working'}
          >
            Tout effacer
          </button>
        ) : (
          <div className="confirmPanel">
            <p>Vraiment tout effacer ? Cette action est irréversible et ne peut pas être annulée.</p>
            <button className="dangerButton" type="button" onClick={() => void handleWipeAllData()}>
              {wipeStatus === 'working' ? 'Effacement...' : 'Oui, tout effacer'}
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => setPendingWipeConfirm(false)}
              disabled={wipeStatus === 'working'}
            >
              Annuler
            </button>
          </div>
        )}
        {wipeStatus === 'done' && (
          <p className="panelText">
            Toutes tes données ont été effacées de cet appareil.
          </p>
        )}
        {wipeStatus === 'error' && (
          <p className="panelText panelTextDanger">L'effacement complet a échoué.</p>
        )}
      </div>
    </section>
  );
}

function formatIncludedGroups(includedTables: BackupTableKey[]) {
  const included = new Set(includedTables);
  const labels = BACKUP_GROUPS.filter((group) => group.tables.some((table) => included.has(table))).map(
    (group) => group.label
  );
  return labels.length > 0 ? labels.join(', ') : 'aucune';
}

const BACKUP_REMINDER_DAYS = 14;

function isBackupStale(lastBackupExportedAt: string | undefined) {
  if (!lastBackupExportedAt) return true;
  const daysSince = (Date.now() - new Date(lastBackupExportedAt).getTime()) / (24 * 60 * 60 * 1000);
  return daysSince >= BACKUP_REMINDER_DAYS;
}

function formatBackupReminder(lastBackupExportedAt: string | undefined) {
  if (!lastBackupExportedAt) {
    return 'Toutes les données sont locales uniquement (aucun serveur) — aucune sauvegarde faite pour l’instant.';
  }
  const daysSince = Math.floor((Date.now() - new Date(lastBackupExportedAt).getTime()) / (24 * 60 * 60 * 1000));
  if (daysSince >= BACKUP_REMINDER_DAYS) {
    return `Dernière sauvegarde il y a ${daysSince} jours — pense à en refaire une.`;
  }
  if (daysSince === 0) {
    return 'Dernière sauvegarde : aujourd’hui.';
  }
  return `Dernière sauvegarde il y a ${daysSince} jour(s).`;
}
