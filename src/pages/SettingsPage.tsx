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
import { getSettings, updateSettings } from '../features/settings/settingsService';
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
      setBackupMessage('Export JSON prêt. Vérifie le résumé avant de télécharger.');
    } catch (error) {
      console.error('Export local backup a échoué :', error);
      setBackupStatus('error');
      setBackupMessage('Impossible de générer l’export local.');
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
    setBackupMessage('Export JSON généré localement.');
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
      setBackupMessage(error instanceof Error ? error.message : 'Import JSON invalide.');
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
      <div>
        <p className="eyebrow">Paramètres</p>
          <h2 id="settings-title">Préférences locales</h2>
          <p className="lead">
          Gérez le seuil d’économie, les données locales, la mémoire Drive et les options avancées.
        </p>
      </div>

      <div className="settingsPanel">
        <div>
          <h3>Données de démonstration</h3>
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

      <div className="settingsPanel">
        <div>
          <h3>Réinitialisation « paramètres d'usine »</h3>
          <p>
            Supprime définitivement TOUTES les données locales (produits, magasins, prix, listes,
            paniers validés, réglages) — rien n'est remis à la place, contrairement à « Réinitialiser »
            ci-dessus. Aucun export automatique n'est fait avant : télécharge une sauvegarde JSON si tu
            veux la garder. Action irréversible, sans upload.
          </p>
        </div>
        {!pendingWipeConfirm ? (
          <button
            className="dangerButton"
            type="button"
            onClick={() => setPendingWipeConfirm(true)}
            disabled={wipeStatus === 'working'}
          >
            Tout effacer (usine)
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
            Toutes les données locales ont été effacées. Note : certaines pages réamorcent
            automatiquement des données de démonstration à la prochaine navigation si leur table est
            vide (comportement existant, indépendant de ce bouton).
          </p>
        )}
        {wipeStatus === 'error' && (
          <p className="panelText panelTextDanger">L'effacement complet a échoué.</p>
        )}
      </div>

      <div className="settingsPanel">
        <div>
          <h3>Mémoire de recherche Drive</h3>
          <p>
            L’extension retient 14 jours les produits jugés « introuvables » chez un magasin, pour ne
            pas relancer une recherche vouée à l’échec à chaque rafraîchissement. Vider cette mémoire
            force une nouvelle recherche pour tous les produits au prochain rafraîchissement — utile si
            un produit a été écarté à tort (bug corrigé, faux négatif).
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

      <div className="settingsPanel">
        <div>
          <h3>Options avancées</h3>
          <p>
            Ces options restent locales. Le remplissage d’un panier n’est lancé qu’après une action
            visible et un consentement explicite ; il ne valide jamais la commande ni le paiement.
          </p>
        </div>
        {settingsStatus === 'loading' && <p className="panelText">Chargement des préférences...</p>}
        {settingsStatus === 'error' && (
          <p className="panelText panelTextDanger">Impossible de charger ou modifier les préférences.</p>
        )}
        {settings && (
          <>
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
              <span>Afficher l’ajout panier expérimental</span>
            </label>
            <p className="panelText">
              Affiche aussi les liens directs. Le bouton de validation peut demander à l’extension de
              remplir le panier après ton accord ; vérifie toujours prix, quantités et substitutions sur
              le site officiel avant toute commande.
            </p>
          </>
        )}
      </div>

      <div className="settingsPanel">
        <div>
          <h3>Export/import local</h3>
          <p>
            Le fichier JSON peut contenir tes habitudes d’achat, magasins, prix et listes. Il reste
            généré localement, sans upload.
          </p>
          {settings && (
            <p className={isBackupStale(settings.lastBackupExportedAt) ? 'panelText panelTextWarning' : 'panelText'}>
              {formatBackupReminder(settings.lastBackupExportedAt)}
            </p>
          )}
        </div>
        <fieldset className="checkboxGroup">
          <legend>Données à exporter</legend>
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
            Preparer export JSON
          </button>
          <label className="buttonLink fileButton">
            Importer JSON
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
          L’export ne contient que les catégories cochées ci-dessus. L’import remplace les données
          locales des catégories présentes dans le fichier seulement (fusion sélective) — le reste de
          tes données locales n’est jamais touché — et seulement après confirmation.
        </p>
        {backupMessage && (
          <p className={backupStatus === 'error' ? 'panelText panelTextDanger' : 'panelText'}>
            {backupMessage}
          </p>
        )}
        {pendingExportSummary && (
          <div className="confirmPanel">
            <p>
              Export prêt : {pendingExportSummary.products} produit(s),{' '}
              {pendingExportSummary.shoppingListItems} article(s), {pendingExportSummary.stores}{' '}
              magasin(s), {pendingExportSummary.priceSnapshots} prix et{' '}
              {pendingExportSummary.validatedBaskets} panier(s) validé(s).
            </p>
            <button className="primaryButton" type="button" onClick={() => void handleDownloadPreparedBackup()}>
              Telecharger JSON
            </button>
            <button
              className="secondaryButton"
              type="button"
              onClick={() => {
                setPendingExport(null);
                setPendingExportSummary(null);
                setBackupMessage('Export annule.');
              }}
            >
              Annuler
            </button>
          </div>
        )}
        {pendingImport && (
          <div className="confirmPanel">
            <p>
              Confirmer le remplacement des données locales par cette sauvegarde JSON ? Seules les
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
    return 'Toutes les données sont locales uniquement (aucun serveur) — aucun export effectué pour l’instant.';
  }
  const daysSince = Math.floor((Date.now() - new Date(lastBackupExportedAt).getTime()) / (24 * 60 * 60 * 1000));
  if (daysSince >= BACKUP_REMINDER_DAYS) {
    return `Dernier export il y a ${daysSince} jours — pense à en refaire un.`;
  }
  if (daysSince === 0) {
    return 'Dernier export : aujourd’hui.';
  }
  return `Dernier export il y a ${daysSince} jour(s).`;
}
