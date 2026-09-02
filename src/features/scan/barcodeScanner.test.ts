// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeBarcodeInput, findProductByBarcode, createContinuousZxingDecoder } from './barcodeScanner';

// Le lecteur ZXing réel dépend d'un vrai flux vidéo/canvas — inutilisable
// en test. On le remplace par un double qu'on pilote entièrement : chaque
// instance est capturée dans `readerInstances` pour vérifier COMBIEN de
// lecteurs sont créés et QUAND (le point central de la fonctionnalité
// "repêchage par rotation en tâche de fond, sans ralentir le cas normal").
type MockReader = {
  decodeFromVideoElementContinuously: ReturnType<typeof vi.fn>;
  decodeBitmap: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};
const readerInstances: MockReader[] = [];

vi.mock('@zxing/library', () => {
  class MockNotFoundException extends Error {}
  class MockBrowserMultiFormatReader {
    decodeFromVideoElementContinuously = vi.fn().mockReturnValue(Promise.resolve());
    // Lève systématiquement (comme le ferait le vrai decodeBitmap face à un
    // NotFoundException) : simule un angle où aucun code n'est détecté, ce
    // qui force la boucle de repêchage à se replanifier — utile pour
    // vérifier qu'elle ne s'arrête jamais d'elle-même.
    decodeBitmap = vi.fn().mockImplementation(() => {
      throw new MockNotFoundException('aucun code décodé');
    });
    reset = vi.fn();
    constructor() {
      readerInstances.push(this);
    }
  }
  // Doubles minimalistes : le vrai HTMLCanvasElementLuminanceSource lirait
  // canvas.getContext('2d').getImageData(...), indisponible sur le double de
  // canvas jsdom utilisé plus bas. barcodeScanner.ts se contente de les
  // instancier puis de passer le résultat à reader.decodeBitmap (mocké
  // au-dessus), leur contenu réel n'a donc pas besoin d'être fonctionnel ici.
  class MockHTMLCanvasElementLuminanceSource {}
  class MockHybridBinarizer {}
  class MockBinaryBitmap {}
  return {
    BrowserMultiFormatReader: MockBrowserMultiFormatReader,
    NotFoundException: MockNotFoundException,
    HTMLCanvasElementLuminanceSource: MockHTMLCanvasElementLuminanceSource,
    HybridBinarizer: MockHybridBinarizer,
    BinaryBitmap: MockBinaryBitmap
  };
});

describe('barcodeScanner', () => {
  it('keeps only digits from manual barcode input', () => {
    expect(normalizeBarcodeInput(' 301 234-5678907 ')).toBe('3012345678907');
  });

  it('finds a local product by normalized barcode', () => {
    const product = findProductByBarcode(
      [
        {
          id: 'prod-test',
          barcode: '3012345678907',
          name: 'Produit test',
          comparisonUnit: 'unit',
          allowDifferentFormat: true,
          allowPrivateLabel: true,
          createdAt: '2026-07-07T10:00:00.000Z',
          updatedAt: '2026-07-07T10:00:00.000Z'
        }
      ],
      '301 234-5678907'
    );

    expect(product?.id).toBe('prod-test');
  });
});

// Un code-barres tenu de travers (90°/180°/270°) ne se décode jamais avec le
// seul flux continu, qui ne teste que l'orientation telle quelle à chaque
// frame. createContinuousZxingDecoder branche createEnhancedZxingDecoder
// (rotation 0/180/90/270°) en repêchage — mais seulement après un délai sans
// détection, et sans jamais remplacer le flux continu, pour ne pas ralentir
// le cas très majoritaire du code bien orienté.
describe('createContinuousZxingDecoder — repêchage par rotation', () => {
  let restoreCreateElement: () => void;

  beforeEach(() => {
    readerInstances.length = 0;
    vi.useFakeTimers();

    // jsdom n'implémente pas de vrai contexte canvas 2D (getContext('2d')
    // renvoie null) : sans ce double, la boucle de rotation s'arrêterait dès
    // sa première itération (garde `!ctx`) et on ne pourrait rien vérifier
    // sur sa logique de replanification. Ce double se contente de fournir
    // les méthodes utilisées par barcodeScanner.ts (aucun vrai rendu).
    const realCreateElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        const ctx = { save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn() };
        return {
          width: 0,
          height: 0,
          getContext: () => ctx,
          toDataURL: () => 'data:image/png;base64,fake'
        } as unknown as HTMLCanvasElement;
      }
      return realCreateElement(tagName);
    }) as typeof document.createElement);
    restoreCreateElement = () => spy.mockRestore();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreCreateElement();
  });

  it('ne démarre pas le repêchage par rotation avant le délai (le cas normal ne doit jamais être ralenti)', () => {
    const video = document.createElement('video');
    const decoder = createContinuousZxingDecoder(video, vi.fn());

    expect(readerInstances).toHaveLength(1); // seulement le flux continu

    vi.advanceTimersByTime(1000); // < délai de repêchage
    expect(readerInstances).toHaveLength(1);

    decoder.stop();
  });

  it('démarre le repêchage par rotation après le délai si rien n\'a encore été détecté', async () => {
    const video = document.createElement('video');
    const decoder = createContinuousZxingDecoder(video, vi.fn());

    await vi.advanceTimersByTimeAsync(1500);
    expect(readerInstances).toHaveLength(2); // flux continu + repêchage rotation

    decoder.stop();
  });

  it("ne cesse jamais de retenter tant que la caméra tourne, même au-delà de l'ancien plafond de 60 tentatives", async () => {
    const video = document.createElement('video');
    const decoder = createContinuousZxingDecoder(video, vi.fn());

    await vi.advanceTimersByTimeAsync(1500);
    const rotationReader = readerInstances[1];

    // 80 tentatives à ~100ms d'intervalle : dépasse largement les 60
    // tentatives que l'ancien plafond MAX_ATTEMPTS aurait autorisées avant de
    // s'arrêter définitivement.
    await vi.advanceTimersByTimeAsync(80 * 100);

    expect(rotationReader.decodeBitmap.mock.calls.length).toBeGreaterThan(60);

    decoder.stop();
  });

  it('arrête le repêchage dès que le flux continu détecte un code (pas de double appel)', async () => {
    const onDetected = vi.fn();
    const video = document.createElement('video');
    const decoder = createContinuousZxingDecoder(video, onDetected);

    await vi.advanceTimersByTimeAsync(1500);
    const continuousReader = readerInstances[0];
    const rotationReader = readerInstances[1];

    // Simule une détection par le flux continu (le callback passé à
    // decodeFromVideoElementContinuously reçoit normalement (result, error)).
    const callback = continuousReader.decodeFromVideoElementContinuously.mock.calls[0][1] as (
      result: { getText: () => string } | undefined,
      error: undefined
    ) => void;
    callback({ getText: () => '3012345678907' }, undefined);

    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected).toHaveBeenCalledWith('3012345678907');
    expect(rotationReader.reset).toHaveBeenCalledTimes(1);

    // Une éventuelle tentative de rotation encore en vol ne doit plus
    // remonter de deuxième détection.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDetected).toHaveBeenCalledTimes(1);

    decoder.stop();
  });

  it('stop() arrête aussi le repêchage par rotation s\'il avait démarré', async () => {
    const video = document.createElement('video');
    const decoder = createContinuousZxingDecoder(video, vi.fn());

    await vi.advanceTimersByTimeAsync(1500);
    const rotationReader = readerInstances[1];

    decoder.stop();
    expect(rotationReader.reset).toHaveBeenCalledTimes(1);

    const callsBeforeWait = rotationReader.decodeBitmap.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(rotationReader.decodeBitmap.mock.calls.length).toBe(callsBeforeWait);
  });
});
