import { useEffect, useState } from 'react';
import { db } from '../../db/db';
import {
  type DriveImportedItemV1,
  type DriveJobStoreV1,
  type DriveListImportReportV1
} from '../drive-bridge/driveProtocol';
import {
  getExtensionBridge,
  type DriveListImportProgressEvent
} from '../drive-bridge/extensionBridge';
import { type StoreKey, type UserStore } from '../../types/domain';
import {
  applyListImport,
  loadProductsForMatching,
  matchImportedItems,
  type ImportCandidate,
  type ImportOutcome
} from './listImportService';

// Écran d'import des listes/favoris enregistrés sur le compte du magasin.
//
// Règle de conception (décision §13 du rapport de passation) : l'extension lit,
// l'utilisateur valide, la PWA écrit. Rien n'est ajouté au catalogue local ni à
// la liste de courses avant un clic explicite sur « Importer la sélection ».

const STORE_LABELS: Record<StoreKey, string> = {
  leclerc: 'Leclerc Drive (produits habituels)',
  hyperu: 'Courses U (mes listes)'
};

// Messages destinés à l'utilisateur, pas au développeur : chaque code d'échec
// dit ce qui s'est passé ET ce qu'il peut faire.
const ERROR_MESSAGES: Record<string, string> = {
  COURSESU_LOGIN_REQUIRED:
    "Tu n'es pas (ou plus) connecté à ton compte Courses U. Connecte-toi sur coursesu.com dans ce navigateur, puis relance l'import.",
  LECLERC_LOGIN_REQUIRED:
    "Tu n'es pas (ou plus) connecté à ton compte Leclerc Drive. Connecte-toi sur leclercdrive.fr dans ce navigateur, puis relance l'import.",
  COURSESU_LIST_EMPTY: 'Cette liste Courses U ne contient aucun produit.',
  LECLERC_LIST_EMPTY: "Aucun produit habituel trouvé sur ce compte Leclerc.",
  LECLERC_WRONG_PAGE:
    "La page des produits habituels n'a pas pu être atteinte. Vérifie que le drive enregistré dans les réglages est le bon.",
  SITE_BLOCKED:
    "Le site a affiché une vérification anti-robot. Ouvre-le toi-même dans le navigateur, passe la vérification, puis relance l'import.",
  IMPORT_URL_UNKNOWN:
    "Impossible de deviner l'adresse de la page de compte. Enregistre d'abord ton drive dans les réglages.",
  IMPORT_PAGE_TIMEOUT: "La page n'a pas fini de charger à temps. Réessaie dans un moment.",
  IMPORT_CANCELLED: 'Import annulé.',
  IMPORT_NO_RESULT: "La page n'a rien renvoyé. Réessaie, et signale-le si ça se reproduit.",
  IMPORT_FAILED: "L'import s'est interrompu. Réessaie, et signale-le si ça se reproduit."
};

type PickableList = { name: string; url: string };

export function ListImportPanel({ onImported }: { onImported?: () => void }) {
  const [stores, setStores] = useState<UserStore[]>([]);
  const [busyStoreKey, setBusyStoreKey] = useState<StoreKey | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [warning, setWarning] = useState('');
  const [pickableLists, setPickableLists] = useState<PickableList[] | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  useEffect(() => {
    let ignore = false;
    void db.userStores.toArray().then((rows) => {
      if (!ignore) setStores(rows);
    });
    return () => {
      ignore = true;
    };
  }, []);

  function resetResults() {
    setError('');
    setWarning('');
    setCandidates(null);
    setPickableLists(null);
    setOutcome(null);
  }

  async function runImport(store: UserStore, listUrl?: string) {
    resetResults();
    setBusyStoreKey(store.storeKey);
    setProgress('Ouverture de la page du magasin...');

    try {
      const response = await getExtensionBridge().startListImport(
        {
          protocolVersion: 1,
          jobId: `import-${crypto.randomUUID()}`,
          requestedAt: new Date().toISOString(),
          store: toDriveJobStore(store),
          ...(listUrl ? { listUrl } : {})
        },
        (event) => setProgress(describeProgress(event))
      );

      if (!response.accepted || !response.report) {
        setError(response.reason ?? "L'extension n'a pas accepté la demande d'import.");
        return;
      }
      await handleReport(response.report, store);
    } catch (caught) {
      // Message de l'extension volontairement non affiché tel quel : il peut
      // contenir des fragments d'URL de la session de l'utilisateur.
      setError(
        caught instanceof Error && caught.message.includes('expiré')
          ? "L'import a dépassé le temps imparti. Réessaie."
          : "L'extension n'a pas répondu. Vérifie qu'elle est bien installée et active."
      );
    } finally {
      setBusyStoreKey(null);
      setProgress('');
    }
  }

  async function handleReport(report: DriveListImportReportV1, store: UserStore) {
    if (!report.ok) {
      if (report.code === 'COURSESU_PICK_LIST' && Array.isArray(report.details?.lists)) {
        setPickableLists(report.details.lists as PickableList[]);
        return;
      }
      setError(ERROR_MESSAGES[report.code] ?? `L'import a échoué (${report.code}).`);
      return;
    }

    const existingProducts = await loadProductsForMatching();
    setCandidates(matchImportedItems(report.items, existingProducts));
    setSourceLabel(report.listName ? `${STORE_LABELS[store.storeKey]} — ${report.listName}` : STORE_LABELS[store.storeKey]);

    const warnings: string[] = [];
    if (report.partial && report.partialReason === 'LECLERC_DEPARTMENTS_NOT_FOUND') {
      warnings.push(
        "Les onglets de rayons n'ont pas été reconnus : seul le rayon affiché a été lu. Ouvre les autres rayons toi-même et relance l'import pour compléter."
      );
    }
    if (report.partial && report.partialReason === 'LECLERC_DEPARTMENTS_SKIPPED') {
      const skipped = report.skippedDepartments?.map((entry) => entry.label).join(', ');
      warnings.push(`Import incomplet : rayon(s) non lu(s) — ${skipped || 'rayon inconnu'}. Relance l'import pour compléter.`);
    }
    if (report.usedFallbackSelector) {
      warnings.push(
        'La page du magasin a changé de structure : la lecture a utilisé un repli. Vérifie la liste ci-dessous avant de valider.'
      );
    }
    setWarning(warnings.join(' '));
  }

  function toggleCandidate(index: number) {
    setCandidates((current) =>
      current
        ? current.map((candidate, position) =>
            position === index ? { ...candidate, selected: !candidate.selected } : candidate
          )
        : current
    );
  }

  function setAllSelected(selected: boolean) {
    setCandidates((current) => (current ? current.map((candidate) => ({ ...candidate, selected })) : current));
  }

  async function handleApply() {
    if (!candidates) return;
    setProgress('Import en cours...');
    try {
      const result = await applyListImport(candidates);
      setOutcome(result);
      setCandidates(null);
      onImported?.();
    } catch {
      setError("L'import local a échoué. Rien n'a été ajouté pour les produits restants.");
    } finally {
      setProgress('');
    }
  }

  const selectedCount = candidates?.filter((candidate) => candidate.selected).length ?? 0;
  const duplicateCount = candidates?.filter((candidate) => candidate.matchKind !== 'none').length ?? 0;

  return (
    <details className="shoppingListPanel">
      <summary>
        <span>Importer mes listes du magasin</span>
      </summary>

      <p className="panelText">
        Récupère les produits déjà enregistrés sur ton compte (produits habituels Leclerc, listes Courses U) au lieu de
        les ressaisir. Tu dois être connecté au site dans ce navigateur ; l'extension lit la page, elle ne saisit jamais
        ton mot de passe.
      </p>

      {stores.length === 0 && (
        <p className="panelText panelTextDanger">
          Aucun magasin enregistré. Ajoute d'abord ton drive dans les réglages.
        </p>
      )}

      <div className="cardActions">
        {stores.map((store) => (
          <button
            key={store.id}
            className="secondaryButton"
            type="button"
            disabled={busyStoreKey !== null}
            onClick={() => void runImport(store)}
          >
            {busyStoreKey === store.storeKey ? 'Import en cours...' : STORE_LABELS[store.storeKey]}
          </button>
        ))}
      </div>

      {progress && <p className="panelText">{progress}</p>}
      {error && <p className="panelText panelTextDanger">{error}</p>}
      {warning && <p className="panelText panelTextDanger">{warning}</p>}

      {pickableLists && (
        <div className="shoppingRows">
          <p className="panelText">Ton compte porte plusieurs listes. Laquelle veux-tu importer ?</p>
          {pickableLists.map((list) => {
            const store = stores.find((candidate) => candidate.storeKey === 'hyperu');
            return (
              <button
                key={list.url}
                className="secondaryButton"
                type="button"
                disabled={!store || busyStoreKey !== null}
                onClick={() => store && void runImport(store, list.url)}
              >
                {list.name}
              </button>
            );
          })}
        </div>
      )}

      {candidates && (
        <div className="shoppingRows">
          <p className="panelText">
            {candidates.length} produit(s) lu(s) sur « {sourceLabel} ».
            {duplicateCount > 0 &&
              ` ${duplicateCount} déjà dans ton catalogue — décoché(s) par défaut, coche-les pour les ajouter quand même à la liste de courses (aucune fiche en double ne sera créée).`}
          </p>

          <div className="cardActions">
            <button className="secondaryButton" type="button" onClick={() => setAllSelected(true)}>
              Tout cocher
            </button>
            <button className="secondaryButton" type="button" onClick={() => setAllSelected(false)}>
              Tout décocher
            </button>
          </div>

          {candidates.map((candidate, index) => (
            <article className="shoppingRow" key={`${candidate.item.name}-${index}`}>
              <label>
                <input
                  type="checkbox"
                  checked={candidate.selected}
                  onChange={() => toggleCandidate(index)}
                />
                <span>{candidate.item.name}</span>
              </label>
              <div>
                <p>{describeItem(candidate.item)}</p>
                {candidate.matchKind === 'barcode' && (
                  <p>Déjà dans ton catalogue (même code-barres).</p>
                )}
                {candidate.matchKind === 'name' && (
                  <p>Déjà dans ton catalogue (même nom et marque) — à vérifier, le rapprochement par nom peut se tromper.</p>
                )}
              </div>
            </article>
          ))}

          <div className="cardActions">
            <button
              className="primaryButton"
              type="button"
              disabled={selectedCount === 0}
              onClick={() => void handleApply()}
            >
              Importer la sélection ({selectedCount})
            </button>
            <button className="secondaryButton" type="button" onClick={resetResults}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {outcome && (
        <p className="panelText">
          {outcome.addedToList} produit(s) ajouté(s) à la liste de courses ({outcome.createdProducts} nouvelle(s) fiche(s),{' '}
          {outcome.reusedProducts} déjà connue(s)).
          {outcome.failed.length > 0 && ` ${outcome.failed.length} refusé(s) : ${outcome.failed.map((entry) => entry.name).join(', ')}.`}
        </p>
      )}
    </details>
  );
}

function describeItem(item: DriveImportedItemV1) {
  const parts = [item.brand, item.priceEuro !== undefined ? `${item.priceEuro.toFixed(2)} €` : null];
  if (item.quantity && item.quantity > 1) parts.push(`×${item.quantity}`);
  return parts.filter(Boolean).join(' · ') || 'Marque non renseignée';
}

function describeProgress(event: DriveListImportProgressEvent) {
  if (event.state === 'opening_page') return 'Ouverture de la page du magasin...';
  if (event.state === 'reading_list') return 'Lecture de la liste...';
  return `Rayon ${event.departmentIndex ?? '?'}/${event.departmentTotal ?? '?'} — ${event.departmentLabel ?? ''}`;
}

function toDriveJobStore(store: UserStore): DriveJobStoreV1 {
  return {
    storeKey: store.storeKey,
    localStoreId: store.id,
    displayName: store.displayName,
    ...(store.address ? { address: store.address } : {}),
    ...(store.city ? { city: store.city } : {}),
    ...(store.postalCode ? { postalCode: store.postalCode } : {}),
    ...(store.latitude !== undefined ? { latitude: store.latitude } : {}),
    ...(store.longitude !== undefined ? { longitude: store.longitude } : {}),
    ...(store.driveUrl ? { driveUrl: store.driveUrl } : {})
  };
}
