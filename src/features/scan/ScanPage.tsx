import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts } from '../../db/seed';
import {
  createProduct,
  emptyProductForm,
  markProductUsed,
  type ProductFormErrors,
  type ProductFormValues
} from '../products/productService';
import { ProductForm } from '../products/ProductForm';
import { searchProducts } from '../products/productSearch';
import {
  adoptStorePick,
  confirmProductFromText,
  createProductFromText,
  discardProductFromText
} from '../products/quickAddService';
import { addProductToActiveList } from '../shopping-list/shoppingListService';
import { runLivePick } from '../drive-bridge/driveRefreshService';
import { listSelectedStores } from '../stores/storeLocatorService';
import { storeLabels } from '../stores/storeLabels';
import { type Product, type StoreKey } from '../../types/domain';
import {
  applyContinuousAutofocus,
  createBarcodeDetector,
  createContinuousZxingDecoder,
  findProductByBarcode,
  isCameraScanSupported,
  listBackCameraDevices,
  normalizeBarcodeInput,
  pickBackCameraDeviceId,
  type CameraDeviceOption,
  type ZxingDecoder,
  addToScannedHistory,
  getScannedHistory
} from './barcodeScanner';
import {
  lookupOpenFoodFactsProduct,
  searchOpenFoodFactsProducts,
  type OpenFoodFactsProduct,
  type OpenFoodFactsSuggestion
} from './openFoodFactsClient';
import { getSettings } from '../settings/settingsService';
import {
  getCachedProduct,
  setCachedProduct,
  formatCacheAge,
  type CacheSource
} from './productCacheService';

function formatEuro(value: number) {
  return `${value.toFixed(2).replace('.', ',')} €`;
}

type ScanStatus = 'idle' | 'unsupported' | 'camera' | 'error';
// 'found' a existé ici (suggestion Open Food Facts en attente d'un clic de
// confirmation) mais un scan identifie le produit avec certitude : il n'y a
// plus d'état "en attente de confirmation", seulement idle/loading/not_found.
type OffLookupStatus = 'idle' | 'loading' | 'not_found';

export function ScanPage() {
  // Recherche par nom : premier des trois chemins d'ajout de cet écran
  // (nom → magasin → code-barres). Elle ne consulte que la base locale, donc
  // aucun mot tapé ne quitte l'appareil (voir productSearch.ts).
  const [nameQuery, setNameQuery] = useState('');
  const [knownProducts, setKnownProducts] = useState<Product[]>([]);
  const [configuredStores, setConfiguredStores] = useState<StoreKey[]>([]);
  const [storeSearchBusy, setStoreSearchBusy] = useState<StoreKey | null>(null);
  const [manualBarcode, setManualBarcode] = useState('');
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [foundProduct, setFoundProduct] = useState<Product | null>(null);
  const [missingBarcode, setMissingBarcode] = useState('');
  const [message, setMessage] = useState('');
  const [justScanned, setJustScanned] = useState(false);
  const [offLookupStatus, setOffLookupStatus] = useState<OffLookupStatus>('idle');
  const [cameraOptions, setCameraOptions] = useState<CameraDeviceOption[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(100);
  const [scannedHistory, setScannedHistory] = useState<string[]>([]);
  const [cacheSource, setCacheSource] = useState<CacheSource | null>(null);
  const [cacheAge, setCacheAge] = useState<string>('');
  const [barcodeBusy, setBarcodeBusy] = useState(false);
  const [offSearchEnabled, setOffSearchEnabled] = useState(false);
  const [offSuggestions, setOffSuggestions] = useState<OpenFoodFactsSuggestion[]>([]);
  const [offSearchStatus, setOffSearchStatus] = useState<'idle' | 'searching' | 'done'>('idle');
  const [manualFormOpen, setManualFormOpen] = useState(false);
  const [manualValues, setManualValues] = useState<ProductFormValues>(emptyProductForm);
  const [manualErrors, setManualErrors] = useState<ProductFormErrors>({});
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  // Ref plutôt que le seul état `barcodeBusy` : un double-clic/double-Entrée
  // sur "Rechercher en local" déclenche les deux handleBarcode() dans le
  // même tick, avant qu'un premier setBarcodeBusy(true) n'ait pu re-render —
  // les deux liraient encore `barcodeBusy === false`. La ref est mise à jour
  // de façon synchrone et bloque donc vraiment la seconde exécution, ce que
  // l'état seul (mis à jour de façon asynchrone) ne garantit pas.
  const barcodeBusyRef = useRef(false);
  const zxingDecoderRef = useRef<ZxingDecoder | null>(null);
  const detectorRef = useRef<ReturnType<typeof createBarcodeDetector>>(null);

  useEffect(() => stopCamera, []);

  useEffect(() => {
    void refreshKnownProducts();
    // Magasins réellement configurés dans les réglages : proposer « Chercher
    // chez Hyper U » alors qu'aucun magasin U n'est enregistré n'amènerait
    // que sur un échec quelques secondes plus tard.
    void listSelectedStores()
      .then((stores) => setConfiguredStores(stores.map((store) => store.storeKey)))
      .catch(() => setConfiguredStores([]));
    // Recherche Open Food Facts par nom : désactivée tant que l'utilisateur
    // ne l'a pas explicitement autorisée dans les réglages, le bouton n'étant
    // même pas affiché sinon.
    void getSettings()
      .then((settings) => setOffSearchEnabled(settings.openFoodFactsNameSearch === true))
      .catch(() => setOffSearchEnabled(false));
  }, []);

  async function refreshKnownProducts() {
    try {
      setKnownProducts(await listProducts());
    } catch {
      setKnownProducts([]);
    }
  }

  // Produit déjà connu : rien à créer, il rejoint simplement la liste active.
  async function handleAddKnownProduct(product: Product) {
    await addProductToActiveList(product.id);
    await markProductUsed(product);
    setNameQuery('');
    setFoundProduct(product);
    setMessage(`✓ ${product.name} ajouté à la liste active.`);
    await refreshKnownProducts();
  }

  // Dernier recours, quand aucun des chemins précédents n'aboutit : produit
  // vendu en vrac, absent des deux catalogues, ou connecteur indisponible.
  // Ce formulaire complet vivait sur la page Produits, qui offrait donc un
  // second écran d'ajout concurrent ; il est ici pour que l'ajout d'un
  // produit se fasse toujours au même endroit. Le nom déjà tapé est repris
  // pour ne pas le ressaisir.
  function openManualForm() {
    setManualValues({ ...emptyProductForm, name: nameQuery.trim() });
    setManualErrors({});
    setManualFormOpen(true);
  }

  // Contrairement à la recherche en magasin, rien n'est ambigu ici : c'est
  // l'utilisateur lui-même qui décrit le produit. Il rejoint donc la liste
  // directement, comme un produit scanné.
  async function handleCreateManualProduct() {
    const result = await createProduct(manualValues);
    setManualErrors(result.errors);
    if (!result.isValid || !result.product) {
      return;
    }
    await addProductToActiveList(result.product.id);
    await markProductUsed(result.product);
    setManualFormOpen(false);
    setManualValues(emptyProductForm);
    setNameQuery('');
    setFoundProduct(result.product);
    setMessage(`✓ ${result.product.name} créé et ajouté à ta liste.`);
    await refreshKnownProducts();
  }

  // Les mots tapés ne partent chez Open Food Facts que sur ce geste
  // explicite : la frappe elle-même reste locale. Le but n'est pas de
  // remplacer la recherche en magasin — Open Food Facts ne connaît aucun
  // catalogue de drive, ni aucun prix — mais de récupérer le CODE-BARRES du
  // produit. C'est lui, ensuite, qui permet de confirmer avec certitude la
  // fiche trouvée chez Leclerc ou Hyper U, là où un simple nom ne donne
  // jamais qu'une « correspondance probable » à valider à la main.
  async function handleSearchOpenFoodFacts() {
    const query = nameQuery.trim();
    if (!query || offSearchStatus === 'searching') {
      return;
    }
    setOffSearchStatus('searching');
    setMessage('');
    try {
      setOffSuggestions(await searchOpenFoodFactsProducts(query));
    } finally {
      setOffSearchStatus('done');
    }
  }

  // Une proposition retenue vaut exactement un scan de ce code-barres : on
  // repasse donc par handleBarcode plutôt que de recréer un produit ici.
  // Ce chemin sait déjà reconnaître un produit déjà présent en base (pas de
  // doublon), alimenter le cache et ajouter à la liste active.
  async function handleAdoptOffSuggestion(suggestion: OpenFoodFactsSuggestion) {
    setOffSuggestions([]);
    setOffSearchStatus('idle');
    setNameQuery('');
    await handleBarcode(suggestion.barcode);
    await refreshKnownProducts();
  }

  // Produit absent de la base : on le crée avec les mots tapés, puis on ouvre
  // le magasin sur cette recherche. L'utilisateur navigue librement et valide
  // la bonne fiche avec le bouton flottant du site ; on adopte alors le nom et
  // le format du catalogue, bien plus fiables que ce qu'il aurait saisi.
  //
  // Le produit est créé AVANT la sélection (runLivePick a besoin d'un
  // identifiant), mais il ne rejoint la liste QU'APRÈS validation d'une fiche.
  // Signalé le 03/09 : un produit tapé à la main était ajouté à la liste
  // immédiatement et y restait même quand aucune fiche n'était validée — donc
  // sans prix ni format, donc inutile au comparatif et à retirer à la main.
  async function handleSearchInStore(storeKey: StoreKey) {
    const query = nameQuery.trim();
    if (!query || storeSearchBusy) {
      return;
    }
    setStoreSearchBusy(storeKey);
    setFoundProduct(null);
    setMissingBarcode('');
    setMessage(
      `Ouverture de ${storeLabels[storeKey]}… Cherche le produit sur le site, ouvre sa fiche, puis touche « ✓ Valider ce produit ».`
    );
    try {
      const product = await createProductFromText(query);
      if (!product) {
        setMessage('Nom de produit vide ou invalide.');
        return;
      }
      const outcome = await runLivePick(
        product.id,
        product.name,
        undefined,
        storeKey,
        undefined,
        undefined,
        query
      );
      if (outcome.ok) {
        const updated = await adoptStorePick(product, outcome);
        await confirmProductFromText(updated);
        setNameQuery('');
        setFoundProduct(updated);
        setMessage(
          `✓ ${updated.name} ajouté à ta liste, validé chez ${storeLabels[storeKey]} à ${formatEuro(outcome.priceEuro)}.`
        );
      } else {
        // Rien n'a été validé : on ne laisse ni ligne de liste ni produit
        // orphelin derrière. L'utilisateur garde sa recherche à l'écran pour
        // réessayer, éventuellement dans l'autre magasin.
        await discardProductFromText(product);
        setFoundProduct(null);
        setMessage(
          `Aucune fiche validée chez ${storeLabels[storeKey]} (${outcome.reason}). « ${query} » n'a pas été ajouté à ta liste — réessaie, ou cherche dans l'autre magasin.`
        );
      }
      await refreshKnownProducts();
    } finally {
      setStoreSearchBusy(null);
    }
  }

  useEffect(() => {
    if (scanStatus !== 'camera' || !videoRef.current || !streamRef.current) {
      return;
    }
    const video = videoRef.current;
    video.srcObject = streamRef.current;
    void video.play();

    if (detectorRef.current) {
      const detector = detectorRef.current;
      scanTimerRef.current = window.setInterval(() => {
        void scanVideoFrame(detector);
      }, 700);
    } else {
      zxingDecoderRef.current = createContinuousZxingDecoder(video, handleScanSuccess, {
        brightness,
        contrast
      });
    }
  }, [scanStatus, brightness, contrast]);

  useEffect(() => {
    if (zxingDecoderRef.current) {
      zxingDecoderRef.current.setBrightness(brightness);
    }
  }, [brightness]);

  useEffect(() => {
    if (zxingDecoderRef.current) {
      zxingDecoderRef.current.setContrast(contrast);
    }
  }, [contrast]);

  function handleScanSuccess(barcode: string) {
    addToScannedHistory(barcode);
    setScannedHistory(getScannedHistory());
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    zxingDecoderRef.current?.stop();
    zxingDecoderRef.current = null;
    navigator.vibrate?.(120);
    setJustScanned(true);
    window.setTimeout(() => {
      setJustScanned(false);
      stopCamera();
      void handleBarcode(barcode);
    }, 350);
  }

  // Un scan identifie le produit avec certitude (contrairement à une
  // recherche manuelle par nom, ambiguë) : que le produit soit déjà connu en
  // local ou seulement trouvé sur Open Food Facts, il doit être créé (si
  // besoin) et ajouté à la liste active immédiatement, sans étape de
  // confirmation à cliquer. Retourne le produit créé/ajouté, ou null si la
  // création automatique échoue (ex. code-barres invalide) — dans ce cas
  // l'appelant retombe sur la saisie manuelle.
  async function createProductFromOffAndAdd(
    barcode: string,
    suggestion: Pick<OpenFoodFactsProduct, 'name' | 'brand' | 'baseQuantity' | 'baseUnit'>
  ): Promise<Product | null> {
    const result = await createProduct(
      {
        ...emptyProductForm,
        name: suggestion.name,
        brand: suggestion.brand ?? '',
        barcode
      },
      { baseQuantity: suggestion.baseQuantity, baseUnit: suggestion.baseUnit }
    );
    if (!result.isValid) {
      return null;
    }
    const products = await listProducts();
    const created = findProductByBarcode(products, barcode);
    if (!created) {
      return null;
    }
    // Le cache passe directement en 'local' : sans ça, un rescan du même
    // code-barres retrouverait l'entrée 'off' et recréerait un doublon du
    // produit à chaque fois au lieu de réutiliser celui qu'on vient de créer.
    await setCachedProduct(barcode, created, 'local');
    await addProductToActiveList(created.id);
    await markProductUsed(created);
    return created;
  }

  // Avant ce garde, un ajout auto sur CHAQUE chemin de handleBarcode (voir
  // plus haut) exposait à un double-traitement d'un même scan : un
  // double-clic/double-Entrée sur "Rechercher en local" pendant un lookup
  // Open Food Facts (jusqu'à 8s, voir openFoodFactsClient.ts) pouvait soit
  // incrémenter deux fois la quantité (addProductToActiveList), soit — plus
  // grave — créer deux produits distincts pour le même code-barres (le
  // schéma Dexie n'a pas de contrainte d'unicité sur `barcode`).
  async function handleBarcode(rawBarcode: string) {
    if (barcodeBusyRef.current) {
      return;
    }
    barcodeBusyRef.current = true;
    setBarcodeBusy(true);
    try {
      await handleBarcodeCore(rawBarcode);
    } finally {
      barcodeBusyRef.current = false;
      setBarcodeBusy(false);
    }
  }

  async function handleBarcodeCore(rawBarcode: string) {
    const barcode = normalizeBarcodeInput(rawBarcode);
    setFoundProduct(null);
    setMissingBarcode('');
    setOffLookupStatus('idle');
    setCacheSource(null);
    setCacheAge('');

    if (!barcode) {
      setMessage('Code-barres vide.');
      return;
    }

    const cached = await getCachedProduct(barcode);
    if (cached) {
      // Variable locale plutôt que l'état React `cacheAge` : `setCacheAge`
      // ci-dessous ne prend effet qu'au prochain rendu, donc lire l'état
      // dans un message construit dans la même fonction afficherait sa
      // valeur PRÉCÉDENTE (vide au tout premier scan, ou celle du scan
      // d'avant) plutôt que celle qu'on vient de calculer.
      const freshCacheAge = formatCacheAge(cached.cachedAt);
      setCacheSource(cached.source);
      setCacheAge(freshCacheAge);

      if (cached.source === 'local' && cached.productId) {
        const products = await listProducts();
        const product = products.find((p) => p.id === cached.productId);
        if (product) {
          await addProductToActiveList(product.id);
          await markProductUsed(product);
          setFoundProduct(product);
          setMessage(`✓ ${product.name} ajouté à la liste (en cache, ${freshCacheAge}).`);
          return;
        }
        // Produit référencé par le cache supprimé depuis — retombe sur la
        // recherche fraîche ci-dessous plutôt que d'échouer silencieusement.
      }

      if (cached.source === 'off' && cached.productName) {
        // Cache antérieur au correctif "ajout direct" (ou création
        // précédente non aboutie) : le produit n'existe pas encore en
        // local, on le crée et on l'ajoute maintenant.
        const created = await createProductFromOffAndAdd(barcode, {
          name: cached.productName,
          brand: cached.productBrand
        });
        if (created) {
          setFoundProduct(created);
          setMessage(`✓ ${created.name} ajouté à la liste (Open Food Facts, en cache).`);
        } else {
          setMissingBarcode(barcode);
          setOffLookupStatus('not_found');
          setMessage("Impossible d'ajouter ce produit automatiquement, utilise la saisie manuelle.");
        }
        return;
      }

      if (cached.source === 'not_found') {
        setMissingBarcode(barcode);
        setOffLookupStatus('not_found');
        setMessage(`Produit non trouvé (en cache, ${freshCacheAge})`);
        return;
      }
    }

    const products = await listProducts();
    const product = findProductByBarcode(products, barcode);

    if (product) {
      await setCachedProduct(barcode, product, 'local');
      setCacheSource('local');
      setCacheAge('à l\'instant');
      await addProductToActiveList(product.id);
      await markProductUsed(product);
      setFoundProduct(product);
      setMessage(`✓ ${product.name} ajouté à la liste active.`);
      return;
    }

    setMissingBarcode(barcode);
    setMessage('Produit non trouvé dans la base locale. Recherche sur Open Food Facts...');
    setOffLookupStatus('loading');
    const suggestion = await lookupOpenFoodFactsProduct(barcode);
    if (suggestion) {
      const created = await createProductFromOffAndAdd(barcode, suggestion);
      if (created) {
        setMissingBarcode('');
        setOffLookupStatus('idle');
        setFoundProduct(created);
        setMessage(`✓ ${created.name} ajouté à la liste (nouveau produit, Open Food Facts).`);
      } else {
        setOffLookupStatus('not_found');
        setMessage(
          "Trouvé sur Open Food Facts mais impossible de créer le produit automatiquement. Utilise la saisie manuelle."
        );
      }
    } else {
      await setCachedProduct(barcode, null, 'not_found');
      setCacheSource('not_found');
      setCacheAge('à l\'instant');
      setOffLookupStatus('not_found');
      setMessage('Produit non trouvé, ni localement ni sur Open Food Facts.');
    }
  }

  async function handleManualSubmit() {
    await handleBarcode(manualBarcode);
  }

  function wait(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // ideal (not exact/min) never throws OverconstrainedError — the browser
  // just picks the closest resolution the sensor actually supports instead
  // of rejecting the request. That's what keeps this a single getUserMedia
  // call. Without ANY width/height hint here the browser was defaulting to
  // 640x480 even on a 50MP main sensor (S24) with 3 rear lenses capable of
  // far more — this simply asks for better without a retry ladder.
  const IDEAL_SCAN_RESOLUTION = { width: { ideal: 1920 }, height: { ideal: 1080 } };

  // One deviceId, one getUserMedia call. A prior version tried a 3-step
  // "exact" resolution ladder on top of device selection — up to 6
  // acquisitions per tap of "Scanner" across probe + ladder. Repeated
  // start/stop cycles at that rate wedged the Android camera service until
  // it started refusing every request (see docs/RAPPORT_FIX_SCAN_CAMERA.md).
  // This restores that single-call baseline but adds an `ideal` resolution
  // hint, which — unlike `exact` — cannot itself trigger a failure/retry.
  async function openStreamForDevice(deviceId: string): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, ...IDEAL_SCAN_RESOLUTION },
      audio: false
    });

    const track = stream.getVideoTracks()[0];
    if (track) {
      await applyContinuousAutofocus(track);
    }
    return stream;
  }

  async function startScan() {
    if (cameraBusy) return;
    setMessage('');
    setFoundProduct(null);
    setMissingBarcode('');

    if (!isCameraScanSupported()) {
      setScanStatus('unsupported');
      setMessage('Scan caméra indisponible sur ce navigateur. Utilise la saisie manuelle.');
      return;
    }

    setCameraBusy(true);
    try {
      // Give any just-stopped stream (e.g. the user hit "Arrêter" a moment
      // ago) a beat to actually release the camera before renegotiating.
      await wait(200);
      // A single probe to get permission + device labels — deliberately no
      // resolution ladder here, so this is always exactly one getUserMedia
      // call. It also carries the ideal resolution hint since it may end up
      // being the stream we actually keep (see the reuse branch below).
      const probeStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', ...IDEAL_SCAN_RESOLUTION },
        audio: false
      });
      // The browser's own facingMode:'environment' resolution (probeDeviceId)
      // is trusted first — it's what actually opened the stream we're
      // holding, so it's guaranteed to be a real back-facing camera. A prior
      // version let pickBackCameraDeviceId's enumerateDevices-index-0 guess
      // override it unconditionally, which picked the FRONT camera on this
      // phone (index ordering isn't guaranteed to put a back lens first).
      // Keep it only as a fallback for the rare case facingMode isn't
      // reported at all.
      const probeDeviceId = probeStream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
      const backCameraId = probeDeviceId ? null : await pickBackCameraDeviceId();
      const deviceId = probeDeviceId ?? backCameraId;
      if (!deviceId) {
        probeStream.getTracks().forEach((track) => track.stop());
        throw new Error('NO_CAMERA_DEVICE');
      }

      let stream: MediaStream;
      if (deviceId === probeDeviceId) {
        // The probe already opened the exact device we want — reuse it
        // instead of stopping it and renegotiating a second getUserMedia
        // call. Repeated acquisitions per tap of "Scanner" is what wedged
        // the Android camera service after a few start/stop cycles (see
        // docs/RAPPORT_FIX_SCAN_CAMERA.md); halving the calls here matters.
        stream = probeStream;
        const track = stream.getVideoTracks()[0];
        if (track) {
          await applyContinuousAutofocus(track);
        }
      } else {
        probeStream.getTracks().forEach((track) => track.stop());
        // Give the camera service a beat to actually release the probe
        // stream before renegotiating a different device.
        await wait(200);
        stream = await openStreamForDevice(deviceId);
      }

      streamRef.current = stream;
      setSelectedCameraId(deviceId);
      setCameraOptions(await listBackCameraDevices());
      detectorRef.current = createBarcodeDetector();
      // The scanStatus effect above attaches the stream once the <video>
      // element actually exists in the DOM.
      setScanStatus('camera');
    } catch {
      stopCamera();
      setScanStatus('error');
      setMessage('Permission caméra refusée ou caméra indisponible. Utilise la saisie manuelle.');
    } finally {
      setCameraBusy(false);
    }
  }

  async function switchCamera(deviceId: string) {
    if (cameraBusy) return;
    setCameraBusy(true);
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    zxingDecoderRef.current?.stop();
    zxingDecoderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    await wait(200);

    try {
      const stream = await openStreamForDevice(deviceId);
      streamRef.current = stream;
      setSelectedCameraId(deviceId);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play();
      }
      if (detectorRef.current) {
        const detector = detectorRef.current;
        scanTimerRef.current = window.setInterval(() => {
          void scanVideoFrame(detector);
        }, 700);
      } else if (videoRef.current) {
        zxingDecoderRef.current = createContinuousZxingDecoder(videoRef.current, handleScanSuccess, {
          brightness,
          contrast
        });
      }
    } catch {
      setMessage("Impossible de basculer sur cette caméra.");
    } finally {
      setCameraBusy(false);
    }
  }

  async function scanVideoFrame(detector: ReturnType<typeof createBarcodeDetector>) {
    if (!detector || !videoRef.current) {
      return;
    }

    const barcodes = await detector.detect(videoRef.current);
    const barcode = barcodes[0]?.rawValue;
    if (barcode) {
      handleScanSuccess(barcode);
    }
  }

  function stopCamera() {
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (zxingDecoderRef.current) {
      zxingDecoderRef.current.stop();
      zxingDecoderRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraOptions([]);
    setSelectedCameraId(null);
    setScanStatus((current) => (current === 'camera' ? 'idle' : current));
  }

  const suggestions = searchProducts(knownProducts, nameQuery);
  const trimmedQuery = nameQuery.trim();

  return (
    <section className="pageStack scanPageLayout" aria-labelledby="scan-title">
      <div className="settingsPanel">
        <h3>Ajouter par son nom</h3>
        <label className="quickAddField">
          <span>Nom du produit</span>
          <input
            id="quick-add-name"
            name="quickAddName"
            type="search"
            autoComplete="off"
            placeholder="beurre demi-sel"
            value={nameQuery}
            onChange={(event) => {
              setNameQuery(event.target.value);
              // Les propositions portent sur la recherche précédente : les
              // garder à l'écran ferait choisir une fiche sans rapport.
              setOffSuggestions([]);
              setOffSearchStatus('idle');
            }}
          />
        </label>

        {suggestions.length > 0 && (
          <ul className="quickAddResults" aria-label="Produits déjà connus">
            {suggestions.map(({ product }) => (
              <li key={product.id}>
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={storeSearchBusy !== null}
                  onClick={() => void handleAddKnownProduct(product)}
                >
                  <span>{product.name}</span>
                  {product.brand && <small> · {product.brand}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {trimmedQuery.length > 0 && offSearchEnabled && (
          <div className="quickAddStores">
            <p className="panelText">
              Tu peux d'abord retrouver la fiche officielle du produit (marque, format et
              code-barres). Avec son code-barres, le magasin est ensuite identifié avec
              certitude, sans validation à faire à la main.
            </p>
            <button
              className="secondaryButton"
              type="button"
              disabled={offSearchStatus === 'searching' || barcodeBusy || storeSearchBusy !== null}
              onClick={() => void handleSearchOpenFoodFacts()}
            >
              {offSearchStatus === 'searching'
                ? 'Recherche de la fiche…'
                : 'Trouver la fiche produit'}
            </button>
            {offSearchStatus === 'done' && offSuggestions.length === 0 && (
              <p className="panelText">
                Aucune fiche trouvée pour « {trimmedQuery} ». Cherche directement dans un magasin.
              </p>
            )}
            {offSuggestions.length > 0 && (
              <>
                <ul className="quickAddResults" aria-label="Fiches produit trouvées">
                  {offSuggestions.map((suggestion) => (
                    <li key={suggestion.barcode}>
                      <button
                        className="secondaryButton"
                        type="button"
                        disabled={barcodeBusy || storeSearchBusy !== null}
                        onClick={() => void handleAdoptOffSuggestion(suggestion)}
                      >
                        <span>{suggestion.name}</span>
                        {suggestion.brand && <small> · {suggestion.brand}</small>}
                        {suggestion.baseQuantity !== undefined && suggestion.baseUnit && (
                          <small>
                            {' · '}
                            {suggestion.baseQuantity} {suggestion.baseUnit}
                          </small>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="panelText">
                  Ces fiches viennent d'une base mondiale : vérifie la marque et le format avant
                  d'en choisir une. Aucune n'est retenue automatiquement.
                </p>
              </>
            )}
          </div>
        )}

        {trimmedQuery.length > 0 && (
          <div className="quickAddStores">
            <p className="panelText">
              {suggestions.length === 0
                ? "Pas encore dans ta base. Cherche-le directement dans un magasin :"
                : 'Aucun de ceux-ci ? Cherche dans un magasin :'}
            </p>
            {configuredStores.length === 0 ? (
              <p className="panelText">
                Aucun magasin configuré pour l'instant — ajoute-en un dans les réglages pour
                pouvoir chercher dans un catalogue.
              </p>
            ) : (
              configuredStores.map((storeKey) => (
                <button
                  key={storeKey}
                  className="secondaryButton"
                  type="button"
                  disabled={storeSearchBusy !== null}
                  onClick={() => void handleSearchInStore(storeKey)}
                >
                  {storeSearchBusy === storeKey
                    ? `Ouverture de ${storeLabels[storeKey]}…`
                    : `Chercher chez ${storeLabels[storeKey]}`}
                </button>
              ))
            )}
            {!manualFormOpen && (
              <button className="secondaryButton" type="button" onClick={openManualForm}>
                Créer la fiche à la main
              </button>
            )}
          </div>
        )}

        {manualFormOpen && (
          <div className="quickAddStores">
            <h4>Créer la fiche à la main</h4>
            <p className="panelText">
              À utiliser quand le produit n'existe dans aucun des deux catalogues, ou qu'il se
              vend en vrac. Le nom suffit ; la marque et le format aident le comparatif à
              retrouver le même produit dans les deux magasins.
            </p>
            <ProductForm
              values={manualValues}
              errors={manualErrors}
              idPrefix="scan-manual-product"
              submitLabel="Créer et ajouter à ma liste"
              onChange={setManualValues}
              onSubmit={() => void handleCreateManualProduct()}
              onCancel={() => {
                setManualFormOpen(false);
                setManualErrors({});
              }}
            />
          </div>
        )}
      </div>

      <div className="settingsPanel">
        <button className="primaryButton" type="button" onClick={startScan} disabled={cameraBusy}>
          Scanner un produit
        </button>
        {scanStatus === 'camera' && (
          <>
            <div className="scanPreviewWrap">
              <video className="scanPreview" ref={videoRef} muted playsInline aria-label="Aperçu caméra" />
              {justScanned && (
                <div className="scanSuccessFlash" role="status" aria-live="polite">
                  ✓
                </div>
              )}
            </div>
            <details className="advancedScanControls">
              <summary>⚙️ Réglages avancés (luminosité, contraste)</summary>
              {cameraOptions.length > 0 && (
                <label className="thresholdControl">
                  <span>Caméra</span>
                  <select
                    value={selectedCameraId ?? ''}
                    disabled={cameraBusy}
                    onChange={(event) => void switchCamera(event.target.value)}
                  >
                    {cameraOptions.map((option) => (
                      <option key={option.deviceId} value={option.deviceId}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="thresholdControl">
                <span>Luminosité: {brightness > 0 ? '+' : ''}{brightness}%</span>
                <input
                  type="range"
                  min="-100"
                  max="100"
                  value={brightness}
                  onChange={(e) => setBrightness(parseInt(e.target.value, 10))}
                  disabled={cameraBusy}
                />
              </label>
              <label className="thresholdControl">
                <span>Contraste: {contrast}%</span>
                <input
                  type="range"
                  min="50"
                  max="200"
                  value={contrast}
                  onChange={(e) => setContrast(parseInt(e.target.value, 10))}
                  disabled={cameraBusy}
                />
              </label>
            </details>
            <button className="secondaryButton" type="button" onClick={stopCamera} disabled={cameraBusy}>
              Arrêter le scan
            </button>
          </>
        )}
        {(scanStatus === 'unsupported' || scanStatus === 'error') && (
          <p className="panelText">{message}</p>
        )}
      </div>

      <form
        className="productForm"
        onSubmit={(event) => {
          event.preventDefault();
          void handleManualSubmit();
        }}
      >
        <label>
          <span>Code-barres saisi à la main</span>
          <input
            id="manual-barcode"
            name="barcode"
            inputMode="numeric"
            value={manualBarcode}
            onChange={(event) => setManualBarcode(event.target.value)}
            list="barcode-history"
          />
          {scannedHistory.length > 0 && (
            <datalist id="barcode-history">
              {scannedHistory.map((barcode) => (
                <option key={barcode} value={barcode} />
              ))}
            </datalist>
          )}
        </label>
        <button className="primaryButton" type="submit" disabled={barcodeBusy}>
          Rechercher en local
        </button>
      </form>

      {message && scanStatus !== 'unsupported' && scanStatus !== 'error' && (
        <>
          <p className="panelText">{message}</p>
          {cacheSource && (
            <p className="panelText" style={{ fontSize: '0.85em', opacity: 0.75 }}>
              {cacheSource === 'local' && '📱 Trouvé localement'}
              {cacheSource === 'off' && '🔍 Trouvé sur Open Food Facts'}
              {cacheSource === 'not_found' && '✗ Pas trouvé'}
              {cacheAge && ` · en cache ${cacheAge}`}
            </p>
          )}
        </>
      )}

      <details className="scanInfoPanel">
        <summary>ℹ️ À propos du scanning</summary>
        <div>
          <p className="lead">
            Recherche d'abord dans ta base locale. Si le produit n'y est pas, seul le code-barres
            (rien d'autre) est envoyé à Open Food Facts, une base ouverte, pour proposer un nom.
          </p>
        </div>
      </details>

      {/* Pas de bouton "Ajouter" ici : le scan a déjà ajouté ce produit à la
          liste dans handleBarcode, avant même cet affichage. Un bouton qui
          rappelait addProductToActiveList ici avait provoqué des doublons
          (rescan ou double-tap pendant que la carte restait affichée) — voir
          git blame sur handleAddFoundProduct. */}
      {foundProduct && (
        <article className="productCard">
          <h3>{foundProduct.name}</h3>
          <p>{foundProduct.brand ?? 'Marque non renseignée'}</p>
          <p className="panelText">✓ Ajouté à la liste.</p>
          <div className="cardActions">
            <Link className="buttonLink" to="/liste">
              Voir la liste
            </Link>
          </div>
        </article>
      )}

      {missingBarcode && (
        <div className="settingsPanel">
          <p>Code {missingBarcode} non trouvé localement.</p>
          {offLookupStatus === 'loading' && <p className="panelText">Recherche sur Open Food Facts...</p>}
          <Link className="buttonLink" to="/produits">
            Créer le produit manuellement
          </Link>
        </div>
      )}
    </section>
  );
}
