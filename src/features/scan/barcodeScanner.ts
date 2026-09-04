import {
  BrowserMultiFormatReader,
  NotFoundException,
  HTMLCanvasElementLuminanceSource,
  HybridBinarizer,
  BinaryBitmap
} from '@zxing/library';
import { type Product } from '../../types/domain';

type DetectedBarcode = {
  rawValue: string;
};

type BarcodeDetectorInstance = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

export function normalizeBarcodeInput(input: string) {
  return input.replace(/\D/g, '');
}

export function findProductByBarcode(products: Product[], barcodeInput: string) {
  const normalized = normalizeBarcodeInput(barcodeInput);
  return products.find((product) => product.barcode === normalized);
}

// Native BarcodeDetector (Chrome/Chromium) is faster, but Firefox never
// implements the Shape Detection API — ZXing decoding from a video element
// works everywhere getUserMedia is available, so camera scan support only
// needs the media API, not the native detector.
export function isCameraScanSupported() {
  return Boolean(typeof window !== 'undefined' && navigator.mediaDevices?.getUserMedia);
}

export function createBarcodeDetector() {
  if (!window.BarcodeDetector) {
    return null;
  }

  return new window.BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e']
  });
}

// facingMode: 'environment' alone is unreliable on multi-lens Android phones
// (Samsung S921U1 and similar) — the browser can hand back an ultra-wide,
// macro, or depth-sensor lens instead of the main rear camera, which reads
// as a black/frozen feed. A label-based heuristic (front/back, ultra/wide/
// macro keywords) turned out just as unreliable — GeckoView's own camera
// numbering doesn't line up with the label wording on some devices. The
// device at index 0 in enumerateDevices() is the one confirmed to actually
// be the sharp, correctly-focused rear lens on the target phone — just use
// that directly instead of guessing from labels.
export async function pickBackCameraDeviceId(): Promise<string | null> {
  const allCameras = await listBackCameraDevices();
  return allCameras[0]?.deviceId ?? null;
}

export type CameraDeviceOption = { deviceId: string; label: string };

// Filtering by label ("back"/"front"/index guesses) turned out unreliable in
// practice: GeckoView's own camera numbering doesn't line up with which lens
// is physically front/back, so a keyword or index heuristic silently hid a
// real rear lens on at least one device. List every video input unfiltered
// and let the user try each one visually — they can see immediately which
// feed is sharp/pointed the right way, which no label heuristic can know.
export async function listBackCameraDevices(): Promise<CameraDeviceOption[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === 'videoinput');
    return videoInputs.map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Caméra ${index + 1}`
    }));
  } catch {
    return [];
  }
}

// Most Android camera modules default to a fixed or slow-hunting focus for
// getUserMedia streams, which reads as permanently blurry up close on a
// barcode. `focusMode` isn't part of MediaTrackConstraints' typed surface,
// and — confirmed directly against this project's target device (Samsung
// S921U1, Firefox for Android) via navigator.mediaDevices.getSupportedConstraints()
// over remote debugging — Gecko does not list `focusMode` or
// `pointsOfInterest` as supported constraints at all. Per spec, unrecognized
// properties inside `advanced` are allowed to be silently ignored rather than
// throwing, so this call is likely inert on Firefox Android; it's kept as a
// harmless best-effort attempt for browsers that do support it (Chromium),
// and to fail safe wherever it's rejected outright.
export async function applyContinuousAutofocus(track: MediaStreamTrack): Promise<void> {
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet] });
    return;
  } catch {
    // Fall through to single-shot below.
  }
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' } as unknown as MediaTrackConstraintSet] });
  } catch {
    // Unsupported at runtime — ignore, feed stays at whatever default focus the device picked.
  }
}

export type ZxingDecoder = {
  stop: () => void;
  setBrightness: (value: number) => void;
  setContrast: (value: number) => void;
};

// Délai avant de lancer le repêchage par rotation : le cas normal (code
// bien orienté) est détecté par le flux continu en une poignée de frames
// (quelques centaines de ms) — au-delà de ça, il y a de bonnes chances que
// le code soit tenu de travers plutôt que simplement pas encore centré.
const ROTATION_FALLBACK_DELAY_MS = 1500;

export function createContinuousZxingDecoder(
  video: HTMLVideoElement,
  onDetected: (barcode: string) => void,
  options?: { brightness?: number; contrast?: number }
): ZxingDecoder {
  const reader = new BrowserMultiFormatReader();
  let stopped = false;
  let detected = false;
  let brightness = options?.brightness ?? 0;
  let contrast = options?.contrast ?? 100;
  let rotationFallback: ZxingDecoder | null = null;

  const applyFilters = () => {
    video.style.filter = `brightness(${100 + brightness}%) contrast(${contrast}%)`;
  };

  applyFilters();

  // Un seul appelant doit recevoir le résultat, que ce soit le flux continu
  // ou le repêchage par rotation qui détecte en premier — sans ce garde, un
  // scan pourrait déclencher handleBarcode() deux fois (l'un juste après
  // l'autre) si les deux décodeurs trouvent le même code à quelques ms
  // d'écart.
  const handleDetected = (barcode: string) => {
    if (detected) return;
    detected = true;
    rotationFallback?.stop();
    rotationFallback = null;
    onDetected(barcode);
  };

  reader
    .decodeFromVideoElementContinuously(video, (result, error) => {
      if (stopped || detected) return;
      if (result) {
        handleDetected(result.getText());
        return;
      }
      if (error && !(error instanceof NotFoundException)) {
        // Transient per-frame decode failures are expected between reads.
      }
    })
    .catch(() => undefined);

  // Le flux continu ci-dessus ne teste qu'une seule orientation par frame
  // (celle de la vidéo telle quelle) : un code-barres tenu de travers
  // (90°/270°) ou tête en bas (180°) ne s'y décode jamais, aussi longtemps
  // qu'on le tienne. Plutôt que de tester les rotations sur CHAQUE frame (ce
  // qui ralentirait le cas normal, très majoritaire), on démarre
  // createEnhancedZxingDecoder — qui teste explicitement 0/180/90/270° en
  // tâche de fond à fréquence réduite (une capture toutes les ~100ms, pas à
  // chaque frame vidéo) — seulement après ce délai sans détection, et il
  // tourne EN PLUS du flux continu (pas à sa place) jusqu'à ce que l'un des
  // deux trouve quelque chose ou que stop() soit appelé.
  const rotationFallbackTimer = window.setTimeout(() => {
    if (stopped || detected) return;
    rotationFallback = createEnhancedZxingDecoder(video, handleDetected, {
      brightness,
      contrast
    });
  }, ROTATION_FALLBACK_DELAY_MS);

  return {
    stop() {
      stopped = true;
      window.clearTimeout(rotationFallbackTimer);
      reader.reset();
      rotationFallback?.stop();
      rotationFallback = null;
      video.style.filter = '';
    },
    setBrightness(value: number) {
      brightness = Math.max(-100, Math.min(100, value));
      applyFilters();
      rotationFallback?.setBrightness(value);
    },
    setContrast(value: number) {
      contrast = Math.max(50, Math.min(200, value));
      applyFilters();
      rotationFallback?.setContrast(value);
    }
  };
}

// Repêchage par rotation pour les codes-barres tenus de travers. Pas assez
// rapide pour être le chemin principal (une capture canvas + décodage par
// angle prend plus cher qu'une frame vidéo directe), donc branché uniquement
// en fallback par createContinuousZxingDecoder ci-dessus après un délai sans
// détection — jamais comme décodeur unique.
export function createEnhancedZxingDecoder(
  video: HTMLVideoElement,
  onDetected: (barcode: string) => void,
  options?: {
    brightness?: number;
    contrast?: number;
    onProgress?: (attempt: number, maxAttempts: number) => void;
  }
): ZxingDecoder {
  const reader = new BrowserMultiFormatReader();
  let stopped = false;
  let brightness = options?.brightness ?? 0;
  let contrast = options?.contrast ?? 100;
  let detectionAttempts = 0;
  const onProgress = options?.onProgress;
  // Purement indicatif pour l'affichage de progression (attempt/maxAttempts) :
  // ne limite plus le nombre de tentatives (voir plus bas), car tant que la
  // caméra reste ouverte le repêchage doit continuer à essayer — un code
  // tenu de travers plus de quelques secondes ne doit pas cesser d'être
  // recherché juste parce qu'un plafond arbitraire a été atteint.
  const MAX_ATTEMPTS = 60;

  const applyFilters = () => {
    video.style.filter = `brightness(${100 + brightness}%) contrast(${contrast}%)`;
  };

  applyFilters();

  const rotationAngles = [0, 180, 90, 270];
  let currentAngleIndex = 0;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const tryDetectWithRotation = async () => {
    if (stopped || !ctx) return;

    try {
      const angle = rotationAngles[currentAngleIndex];
      const isSideways = angle === 90 || angle === 270;
      canvas.width = isSideways ? video.videoHeight : video.videoWidth;
      canvas.height = isSideways ? video.videoWidth : video.videoHeight;

      if (angle !== 0) {
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((angle * Math.PI) / 180);
        ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
        ctx.restore();
      } else {
        ctx.drawImage(video, 0, 0);
      }

      try {
        // decodeFromImage(source) traite un `string` comme un id d'élément DOM
        // (document.getElementById), jamais comme une image encodée — passer un
        // dataURL ici échouait donc systématiquement (silencieusement, avalé par
        // ce catch), sans jamais réellement tenter le décodage. On construit à la
        // place le bitmap directement depuis le canvas déjà tourné, en interne
        // (plus rapide aussi : pas d'encodage base64 à chaque tentative).
        const luminanceSource = new HTMLCanvasElementLuminanceSource(canvas);
        const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
        const result = reader.decodeBitmap(binaryBitmap);
        if (result) {
          onDetected(result.getText());
          return;
        }
      } catch {
        // Tentative échouée (rien détecté à cet angle), essayer l'angle suivant
      }

      currentAngleIndex = (currentAngleIndex + 1) % rotationAngles.length;
      detectionAttempts++;

      if (detectionAttempts % 4 === 0 && onProgress) {
        onProgress(detectionAttempts, MAX_ATTEMPTS);
      }

      if (!stopped) {
        window.setTimeout(tryDetectWithRotation, 100);
      }
    } catch {
      detectionAttempts++;
      if (!stopped) {
        window.setTimeout(tryDetectWithRotation, 100);
      }
    }
  };

  tryDetectWithRotation();

  return {
    stop() {
      stopped = true;
      reader.reset();
      video.style.filter = '';
    },
    setBrightness(value: number) {
      brightness = Math.max(-100, Math.min(100, value));
      applyFilters();
    },
    setContrast(value: number) {
      contrast = Math.max(50, Math.min(200, value));
      applyFilters();
    }
  };
}

const MAX_HISTORY_SIZE = 20;
const barcodeHistory: string[] = [];

export function addToScannedHistory(barcode: string): void {
  const normalized = normalizeBarcodeInput(barcode);
  if (normalized && !barcodeHistory.includes(normalized)) {
    barcodeHistory.unshift(normalized);
    if (barcodeHistory.length > MAX_HISTORY_SIZE) {
      barcodeHistory.pop();
    }
  }
}

export function getScannedHistory(): string[] {
  return [...barcodeHistory];
}
