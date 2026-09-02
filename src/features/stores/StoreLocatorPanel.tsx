import { useEffect, useState, type FormEvent } from 'react';
import { db } from '../../db/db';
import { type StoreKey, type StoreLocatorResult, type UserStore } from '../../types/domain';
import {
  findStores as defaultFindStores,
  listSelectedStores as defaultListSelectedStores,
  saveStoreDriveUrl as defaultSaveStoreDriveUrl,
  selectUserStore as defaultSelectUserStore
} from './storeLocatorService';

type LocatorServices = {
  findStores: typeof defaultFindStores;
  listSelectedStores: typeof defaultListSelectedStores;
  selectUserStore: typeof defaultSelectUserStore;
  saveStoreDriveUrl: typeof defaultSaveStoreDriveUrl;
};

const STORE_LABELS: Record<StoreKey, string> = {
  leclerc: 'E.Leclerc',
  hyperu: 'Hyper U / Courses U'
};

export function StoreLocatorPanel({ services }: { services?: Partial<LocatorServices> }) {
  const locatorServices: LocatorServices = {
    findStores: services?.findStores ?? defaultFindStores,
    listSelectedStores: services?.listSelectedStores ?? defaultListSelectedStores,
    selectUserStore: services?.selectUserStore ?? defaultSelectUserStore,
    saveStoreDriveUrl: services?.saveStoreDriveUrl ?? defaultSaveStoreDriveUrl
  };
  const [storeKey, setStoreKey] = useState<StoreKey>('leclerc');
  const [city, setCity] = useState('');
  const [results, setResults] = useState<StoreLocatorResult[]>([]);
  const [selectedStores, setSelectedStores] = useState<UserStore[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let ignore = false;
    void locatorServices
      .listSelectedStores()
      .then((stores) => {
        if (!ignore) {
          setSelectedStores(stores);
        }
      })
      .catch(() => {
        if (!ignore) {
          setMessage('Impossible de charger les magasins enregistrés.');
        }
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('loading');
    setMessage('');
    setResults([]);
    try {
      const nextResults = await locatorServices.findStores({ storeKey, city });
      setResults(nextResults);
      setStatus('ready');
      setMessage(
        nextResults.length === 0
          ? 'Aucun magasin correspondant trouvé. Essaie une ville voisine.'
          : `${nextResults.length} magasin(s) trouvé(s).`
      );
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'La recherche de magasins a échoué.');
    }
  }

  async function handleSelect(result: StoreLocatorResult) {
    setStatus('loading');
    try {
      const selected = await locatorServices.selectUserStore(result);
      setSelectedStores((current) => [
        ...current.filter((store) => store.storeKey !== selected.storeKey),
        selected
      ]);
      setStatus('ready');
      setMessage(`${STORE_LABELS[selected.storeKey]} (${formatShortLocation(selected) || 'ville inconnue'}) enregistré.`);
    } catch {
      setStatus('error');
      setMessage("Impossible d'enregistrer ce magasin localement.");
    }
  }

  async function handleSaveDriveUrl(storeId: string, driveUrl: string) {
    try {
      const updated = await locatorServices.saveStoreDriveUrl(storeId, driveUrl);
      setSelectedStores((current) => current.map((store) => (store.id === storeId ? updated : store)));
      const label = formatStoreLocationLabel(updated);
      setMessage(updated.driveUrl ? `URL Drive enregistrée : ${label}.` : `URL Drive retirée : ${label}.`);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : "Impossible d'enregistrer l'URL Drive.");
    }
  }

  async function handleCreateManualStore(storeKey: StoreKey, driveUrl: string) {
    try {
      const timestamp = new Date().toISOString();
      const storeId = `manual-${storeKey}-${Date.now()}`;
      // Une saisie manuelle répétée (URL corrigée, nouvelle tentative après
      // une erreur...) ne doit jamais laisser derrière elle un ancien
      // enregistrement du même magasin : `id` change à chaque appel
      // (basé sur Date.now()), donc sans ce nettoyage préalable chaque
      // ressaisie ajoutait une ligne userStores en plus au lieu de
      // remplacer la précédente — listSelectedStores() les renvoyait
      // ensuite toutes, faisant tourner la collecte Drive plusieurs fois
      // de suite sur le même magasin (confirmé : cycle de recherches
      // répété autant de fois que de lignes en doublon).
      await db.transaction('rw', db.userStores, async () => {
        await db.userStores.where('storeKey').equals(storeKey).delete();
        await db.userStores.add({
          id: storeId,
          storeKey,
          displayName: STORE_LABELS[storeKey],
          createdAt: timestamp,
          updatedAt: timestamp
        });
      });
      const updated = await locatorServices.saveStoreDriveUrl(storeId, driveUrl);
      setSelectedStores((current) => {
        const filtered = current.filter((s) => s.storeKey !== storeKey);
        return [...filtered, updated];
      });
      setMessage(`URL Drive enregistrée pour ${STORE_LABELS[storeKey]}.`);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : "Impossible d'enregistrer l'URL Drive.");
    }
  }

  return (
    <div className="settingsPanel storeLocatorPanel">
      <div>
        <h3>Mes magasins</h3>
        <p>Choisis le point de vente qui servira de référence aux futures données de prix.</p>
      </div>

      <div className="selectedStoreList" aria-label="Magasins sélectionnés">
        {(['leclerc', 'hyperu'] as const).map((storeKey) => {
          const store = selectedStores.find((s) => s.storeKey === storeKey);
          return (
            <div key={storeKey} className="selectedStoreCard">
              <strong>{STORE_LABELS[storeKey]}</strong>
              {store ? (
                <>
                  <span>{formatStoreLocationLabel(store)}</span>
                  <StoreDriveUrlField store={store} onSave={handleSaveDriveUrl} />
                </>
              ) : (
                <>
                  <span>Pas encore enregistré</span>
                  <StoreDriveUrlFieldEmpty storeKey={storeKey} onSaveManualUrl={handleCreateManualStore} />
                </>
              )}
            </div>
          );
        })}
      </div>

      <form className="productForm" onSubmit={(event) => void handleSearch(event)}>
        <label>
          <span>Enseigne</span>
          <select
            name="storeKey"
            value={storeKey}
            onChange={(event) => setStoreKey(event.currentTarget.value as StoreKey)}
          >
            <option value="leclerc">E.Leclerc</option>
            <option value="hyperu">Hyper U / Courses U</option>
          </select>
        </label>
        <label>
          <span>Ville</span>
          <input
            name="city"
            autoComplete="address-level2"
            maxLength={100}
            required
            value={city}
            onChange={(event) => setCity(event.currentTarget.value)}
          />
        </label>
        <p className="panelText panelTextWarning">
          Au clic sur « Rechercher », l'enseigne et la ville sont envoyées à OpenStreetMap. Aucun
          autre renseignement n'est transmis.
        </p>
        <button className="primaryButton" type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? 'Recherche...' : 'Rechercher'}
        </button>
      </form>

      {message && (
        <p className={status === 'error' ? 'panelText panelTextDanger' : 'panelText'} role="status">
          {message}
        </p>
      )}

      {results.length > 0 && (
        <div className="storeResultList">
          {results.map((result) => (
            <article key={result.id} className="storeResult">
              <div>
                <h4>{result.displayName}</h4>
                <p>{[result.postalCode, result.city].filter(Boolean).join(' ')}</p>
              </div>
              <button
                className="secondaryButton"
                type="button"
                disabled={status === 'loading'}
                onClick={() => void handleSelect(result)}
              >
                Choisir ce magasin
              </button>
            </article>
          ))}
        </div>
      )}

      <small className="osmAttribution">
        Adresses © contributeurs OpenStreetMap, données ODbL.
      </small>
    </div>
  );
}

function formatShortLocation(store: UserStore) {
  return [store.postalCode, store.city].filter(Boolean).join(' ');
}

// The city/postal code shown on the card comes from the OSM search made when
// the store was first picked — it never changes if the user later pastes a
// different Drive URL by hand (a common way to switch to a different branch
// without re-searching). Both sites' URLs actually spell out the real branch
// name and city (e.g. leclercdrive.fr/magasin-123456-123456-belleville---le-parc.aspx
// -> city "Belleville", branch "Le Parc"; coursesu.com/drive-hyperu-vernouillet ->
// "Vernouillet") — prefer that over the stale OSM city once a URL is saved.
function formatStoreLocationLabel(store: UserStore) {
  if (store.driveUrl) {
    const label = extractDriveUrlLabel(store.driveUrl, store.storeKey);
    if (label) return label;
  }
  return formatShortLocation(store) || 'Localisation inconnue';
}

function extractDriveUrlLabel(driveUrl: string, storeKey: StoreKey): string | null {
  try {
    const url = new URL(driveUrl);
    if (storeKey === 'leclerc') {
      const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
      const withoutExtension = lastSegment.replace(/\.[a-z0-9]+$/i, '');
      const withoutPrefix = withoutExtension.replace(/^magasin-/i, '');
      const [cityPart, namePart] = withoutPrefix.split('---');
      const city = cityPart
        ? titleCase(
            cityPart
              .split('-')
              .filter((token) => token && !/^\d+$/.test(token))
              .join(' ')
          )
        : '';
      const name = namePart ? titleCase(namePart.replace(/-/g, ' ')) : '';
      if (name && city) return `${name}, ${city}`;
      return name || city || null;
    }
    // Courses U / Hyper U: path like "/drive-hyperu-vernouillet" — strip the
    // generic "drive"/"hyperu"/"u"/"courses" tokens, what's left is the city.
    const segment = url.pathname.split('/').filter(Boolean)[0] ?? '';
    const city = segment
      .split('-')
      .filter((token) => token && !/^(drive|hyperu|u|courses)$/i.test(token))
      .join(' ');
    return city ? titleCase(city) : null;
  } catch {
    return null;
  }
}

function titleCase(value: string) {
  return value
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function StoreDriveUrlField({
  store,
  onSave
}: {
  store: UserStore;
  onSave: (storeId: string, driveUrl: string) => Promise<void>;
}) {
  const [value, setValue] = useState(store.driveUrl ?? '');
  const [saving, setSaving] = useState(false);
  // The shared `message` banner in the parent panel renders far below this
  // field (after the search form) — a save here produced no feedback
  // visible without scrolling down, which read as "the button does
  // nothing". This local, inline confirmation sits right under the button
  // that was actually clicked.
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setValue(store.driveUrl ?? '');
  }, [store.driveUrl]);

  useEffect(() => {
    if (!justSaved) return undefined;
    const timer = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const placeholder =
    store.storeKey === 'leclerc'
      ? 'https://fdXX-courses.leclercdrive.fr/magasin-...'
      : 'https://www.coursesu.com/...';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setJustSaved(false);
    try {
      await onSave(store.id, value);
      setJustSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="storeDriveUrlForm" onSubmit={(event) => void handleSubmit(event)}>
      <label>
        <span>URL Drive du magasin (pour l'actualisation des prix)</span>
        <input
          type="url"
          inputMode="url"
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <p className="panelText panelTextWarning">
        Ouvre ton magasin sur le site du Drive, puis copie l'adresse affichée dans la barre du
        navigateur une fois le catalogue ouvert. Sans cette URL, l'actualisation utilise la page
        d'accueil générique, moins fiable.
      </p>
      <button className="secondaryButton" type="submit" disabled={saving}>
        {saving ? 'Enregistrement...' : 'Enregistrer l\'URL Drive'}
      </button>
      {justSaved && (
        <p className="panelText" role="status">
          ✓ URL enregistrée.
        </p>
      )}
    </form>
  );
}

function StoreDriveUrlFieldEmpty({
  storeKey,
  onSaveManualUrl
}: {
  storeKey: StoreKey;
  onSaveManualUrl: (storeKey: StoreKey, driveUrl: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return undefined;
    const timer = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const placeholder =
    storeKey === 'leclerc'
      ? 'https://fdXX-courses.leclercdrive.fr/magasin-...'
      : 'https://www.coursesu.com/...';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    setJustSaved(false);
    try {
      await onSaveManualUrl(storeKey, value);
      setValue('');
      setJustSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="storeDriveUrlForm" onSubmit={(event) => void handleSubmit(event)}>
      <label>
        <span>URL Drive du magasin (pour l'actualisation des prix)</span>
        <input
          type="url"
          inputMode="url"
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <p className="panelText panelTextWarning">
        Ouvre ton magasin sur le site du Drive, puis copie l'adresse affichée dans la barre du
        navigateur une fois le catalogue ouvert.
      </p>
      <button className="secondaryButton" type="submit" disabled={saving || !value.trim()}>
        {saving ? 'Enregistrement...' : 'Enregistrer l\'URL Drive'}
      </button>
      {justSaved && (
        <p className="panelText" role="status">
          ✓ URL enregistrée.
        </p>
      )}
    </form>
  );
}
