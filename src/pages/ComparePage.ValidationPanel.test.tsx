// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ComparisonDecision, type StoreCoverage, type StoreCoverageLine } from '../features/comparison/comparisonEngine';
import { type ProductCandidate } from '../types/domain';
import { runLivePick } from '../features/drive-bridge/driveRefreshService';
import { CoverageBreakdown, ValidationPanel } from './ComparePage';

// Automock (pas de factory partielle) : ComparePage.tsx importe plusieurs
// autres symboles de ce module (runDriveRefresh, downloadDriveDiagnostic,
// isDriveExtensionAvailable...) qu'une factory ne mockant que runLivePick
// casserait à l'import.
vi.mock('../features/drive-bridge/driveRefreshService');

afterEach(cleanup);

// Étape 4 du plan de fiabilisation : un produit "à valider" doit toujours
// afficher une issue actionnable (choisir un candidat proposé, voir sa
// fiche, ou le rejeter) plutôt qu'un simple message d'échec sans suite.
function makeDecision(overrides?: Partial<ComparisonDecision>): ComparisonDecision {
  return {
    itemId: 'item-1',
    productId: 'product-1',
    confidenceScore: 0,
    quantityToBuy: 1,
    reason: 'Riz basmati doit être vérifié manuellement.',
    warnings: ['Prix absent'],
    requiresValidation: true,
    alternates: [],
    storeCandidateIds: {},
    ...overrides
  };
}

describe('ValidationPanel', () => {
  it("affiche un message neutre quand il n'y a rien à valider", () => {
    render(
      <ValidationPanel
        decisions={[]}
        productNameById={new Map()}
        forcedStoreKeyByItemId={new Map()}
        forcedCandidateIdByItemId={new Map()}
        onForceStore={vi.fn()}
        onForceCandidate={vi.fn()}
        onCandidateConfirmed={vi.fn()}
        onRejectCandidate={vi.fn()}
      />
    );

    expect(screen.getByText('Aucun produit à valider pour cette comparaison.')).toBeTruthy();
  });

  it('propose un quasi-match incertain avec un bouton "Choisir" et un bouton "Aucun de ceux-là"', () => {
    const onForceCandidate = vi.fn();
    const onRejectCandidate = vi.fn();
    const decision = makeDecision({
      alternates: [
        {
          candidateId: 'cand-nearmiss-1',
          storeKey: 'leclerc',
          name: 'Produit approchant',
          price: 3.5,
          matchType: 'uncertain',
          productUrl: 'https://www.leclercdrive.fr/produit/proche-1'
        }
      ]
    });

    render(
      <ValidationPanel
        decisions={[decision]}
        productNameById={new Map([['product-1', 'Riz basmati']])}
        forcedStoreKeyByItemId={new Map()}
        forcedCandidateIdByItemId={new Map()}
        onForceStore={vi.fn()}
        onForceCandidate={onForceCandidate}
        onCandidateConfirmed={vi.fn()}
        onRejectCandidate={onRejectCandidate}
      />
    );

    expect(screen.getByText('Riz basmati')).toBeTruthy();
    expect(screen.getByText(/Aucune correspondance fiable/)).toBeTruthy();

    const chooseButton = screen.getByText(/Choisir : Produit approchant/);
    fireEvent.click(chooseButton);
    expect(onForceCandidate).toHaveBeenCalledWith('item-1', 'cand-nearmiss-1');

    const link = screen.getByText('Voir la fiche') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.leclercdrive.fr/produit/proche-1');

    fireEvent.click(screen.getByText('Aucun de ceux-là'));
    expect(onRejectCandidate).toHaveBeenCalledWith('cand-nearmiss-1');
  });

  it('affiche le libellé "format différent" quand toutes les alternates sont de vrais formats trouvés (pas des quasi-matchs)', () => {
    const decision = makeDecision({
      alternates: [
        {
          candidateId: 'cand-format-1',
          storeKey: 'hyperu',
          name: 'Riz basmati 500g',
          price: 1.8,
          matchType: 'same_brand_different_format'
        }
      ]
    });

    render(
      <ValidationPanel
        decisions={[decision]}
        productNameById={new Map([['product-1', 'Riz basmati 1kg']])}
        forcedStoreKeyByItemId={new Map()}
        forcedCandidateIdByItemId={new Map()}
        onForceStore={vi.fn()}
        onForceCandidate={vi.fn()}
        onCandidateConfirmed={vi.fn()}
        onRejectCandidate={vi.fn()}
      />
    );

    expect(screen.getByText(/formats trouvés en magasin/)).toBeTruthy();
    // Sans productUrl, pas de lien "Voir la fiche" à afficher.
    expect(screen.queryByText('Voir la fiche')).toBeNull();
  });

  it('"Choisir sur la page Leclerc" fiabilise le candidat sans le verrouiller (pas de forcedCandidateId)', async () => {
    vi.mocked(runLivePick).mockResolvedValue({
      ok: true,
      candidateId: 'price-leclerc-product-1',
      observedName: 'Riz basmati 1kg',
      priceEuro: 2.3
    });

    const onForceCandidate = vi.fn();
    const onCandidateConfirmed = vi.fn();
    const decision = makeDecision();

    render(
      <ValidationPanel
        decisions={[decision]}
        productNameById={new Map([['product-1', 'Riz basmati 1kg']])}
        productBarcodeById={new Map()}
        forcedStoreKeyByItemId={new Map()}
        forcedCandidateIdByItemId={new Map()}
        onForceStore={vi.fn()}
        onForceCandidate={onForceCandidate}
        onCandidateConfirmed={onCandidateConfirmed}
        onRejectCandidate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Choisir sur la page Leclerc'));

    await waitFor(() => {
      expect(onCandidateConfirmed).toHaveBeenCalledWith('item-1');
    });
    expect(onForceCandidate).not.toHaveBeenCalled();
  });

  // Retour explicite du 31/08 : si un magasin a déjà un candidat fiable
  // (recherche automatique réussie, ou pick manuel d'un rendu précédent), le
  // bouton "Choisir sur la page ..." doit le signaler comme déjà réglé
  // plutôt que de laisser croire qu'il reste une action à faire — pendant
  // que l'autre magasin, lui, reste actionnable normalement.
  it('signale un magasin déjà couvert (storeCandidateIds) comme "✓ Déjà trouvé", sans toucher au bouton de l\'autre magasin', () => {
    const decision = makeDecision({ storeCandidateIds: { hyperu: 'cand-hyperu-1' } });

    render(
      <ValidationPanel
        decisions={[decision]}
        productNameById={new Map([['product-1', 'Riz basmati 1kg']])}
        forcedStoreKeyByItemId={new Map()}
        forcedCandidateIdByItemId={new Map()}
        onForceStore={vi.fn()}
        onForceCandidate={vi.fn()}
        onCandidateConfirmed={vi.fn()}
        onRejectCandidate={vi.fn()}
      />
    );

    expect(screen.getByText('✓ Déjà trouvé chez Hyper U')).toBeTruthy();
    expect(screen.queryByText('Choisir sur la page Hyper U')).toBeNull();
    expect(screen.getByText('Choisir sur la page Leclerc')).toBeTruthy();
  });

  // Étape 4 du plan de fiabilisation : une ligne bloquée pour quantité > 1 à
  // format non garanti doit rester lisible dans le panneau de validation,
  // avec le même warning que celui produit par comparisonEngine.ts.
  it('affiche le warning de blocage quantité pour une ligne bloquée par format non garanti', () => {
    const decision = makeDecision({
      warnings: [
        "Quantité 3 demandée mais le format du produit trouvé n'est pas garanti identique — à confirmer avant ajout au panier"
      ]
    });

    render(
      <ValidationPanel
        decisions={[decision]}
        productNameById={new Map([['product-1', 'Riz basmati 1kg']])}
        forcedStoreKeyByItemId={new Map()}
        forcedCandidateIdByItemId={new Map()}
        onForceStore={vi.fn()}
        onForceCandidate={vi.fn()}
        onCandidateConfirmed={vi.fn()}
        onRejectCandidate={vi.fn()}
      />
    );

    expect(
      screen.getByText(
        "Quantité 3 demandée mais le format du produit trouvé n'est pas garanti identique — à confirmer avant ajout au panier"
      )
    ).toBeTruthy();
  });
});

// Sujet B/C (2026-08-29) : le détail par magasin doit lister TOUTES les
// lignes de la liste de courses (pas seulement celles au prix ferme), avec
// un statut explicite par ligne, et une structure DOM à arité fixe (3
// colonnes toujours présentes) pour un alignement cohérent ligne à ligne.
describe('CoverageBreakdown', () => {
  function makeCandidate(overrides?: Partial<ProductCandidate>): ProductCandidate {
    return {
      id: 'cand-1',
      productId: 'product-1',
      storeKey: 'leclerc',
      name: 'Produit test',
      matchType: 'exact_barcode',
      confidenceScore: 100,
      confidenceReasons: [],
      productUrl: 'https://www.leclercdrive.fr/produit/1',
      ...overrides
    };
  }

  function makeCoverage(lines: StoreCoverageLine[]): StoreCoverage {
    return { covered: lines.filter((line) => line.status === 'priced').length, total: lines.length, lines };
  }

  it('affiche une ligne priced avec son prix et un lien vers le produit', () => {
    render(
      <CoverageBreakdown
        storeKey="leclerc"
        storeLabel="Leclerc"
        coverage={makeCoverage([
          { itemId: 'item-1', productId: 'product-1', status: 'priced', price: 1.89, candidateId: 'cand-1' }
        ])}
        productNameById={new Map([['product-1', 'Thé glacé pêche']])}
        productBarcodeById={new Map()}
        candidateById={new Map([['cand-1', makeCandidate()]])}
        onCandidateConfirmed={vi.fn()}
      />
    );

    expect(screen.getByText('Thé glacé pêche')).toBeTruthy();
    expect(screen.getByText('1.89 €')).toBeTruthy();
    const link = screen.getByText('Voir le produit') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.leclercdrive.fr/produit/1');
    // Prix déjà ferme : rien à valider manuellement sur cette ligne.
    expect(screen.queryByText('Valider cette page')).toBeNull();
  });

  it('affiche une ligne requiresValidation avec son statut "À valider" — jamais confondue avec un prix ferme', () => {
    render(
      <CoverageBreakdown
        storeKey="hyperu"
        storeLabel="Hyper U"
        coverage={makeCoverage([
          { itemId: 'item-1', productId: 'product-1', status: 'requiresValidation', price: 1.35, candidateId: 'cand-1' }
        ])}
        productNameById={new Map([['product-1', 'Thé glacé pêche']])}
        productBarcodeById={new Map()}
        candidateById={new Map([['cand-1', makeCandidate({ storeKey: 'hyperu' })]])}
        onCandidateConfirmed={vi.fn()}
      />
    );

    expect(screen.getByText('À valider (1.35 €)')).toBeTruthy();
  });

  it('affiche une ligne unavailable ("indisponible chez ce magasin") et une ligne notFound ("non trouvé"), sans lien produit', () => {
    render(
      <CoverageBreakdown
        storeKey="leclerc"
        storeLabel="Leclerc"
        coverage={makeCoverage([
          { itemId: 'item-1', productId: 'product-1', status: 'unavailable', candidateId: 'cand-1' },
          { itemId: 'item-2', productId: 'product-2', status: 'notFound' }
        ])}
        productNameById={new Map([
          ['product-1', 'Thé glacé pêche'],
          ['product-2', 'Riz basmati']
        ])}
        productBarcodeById={new Map()}
        candidateById={new Map([['cand-1', makeCandidate({ productUrl: undefined, searchUrl: undefined })]])}
        onCandidateConfirmed={vi.fn()}
      />
    );

    expect(screen.getByText('Indisponible chez ce magasin')).toBeTruthy();
    expect(screen.getByText('Non trouvé chez ce magasin')).toBeTruthy();
    expect(screen.queryByText('Voir le produit')).toBeNull();
  });

  it('garde une structure DOM à arité fixe (3 colonnes) que le lien produit existe ou non', () => {
    const { container } = render(
      <CoverageBreakdown
        storeKey="leclerc"
        storeLabel="Leclerc"
        coverage={makeCoverage([
          { itemId: 'item-1', productId: 'product-1', status: 'priced', price: 1.89, candidateId: 'cand-1' },
          { itemId: 'item-2', productId: 'product-2', status: 'notFound' }
        ])}
        productNameById={new Map([
          ['product-1', 'Thé glacé pêche'],
          ['product-2', 'Riz basmati']
        ])}
        productBarcodeById={new Map()}
        candidateById={new Map([['cand-1', makeCandidate()]])}
        onCandidateConfirmed={vi.fn()}
      />
    );

    const items = container.querySelectorAll('.coverageBreakdownList > li');
    expect(items).toHaveLength(2);
    items.forEach((item) => {
      expect(item.children).toHaveLength(3);
    });
  });

  it("affiche un message neutre quand la liste de courses est vide", () => {
    render(
      <CoverageBreakdown
        storeKey="leclerc"
        storeLabel="Leclerc"
        coverage={makeCoverage([])}
        productNameById={new Map()}
        productBarcodeById={new Map()}
        candidateById={new Map()}
        onCandidateConfirmed={vi.fn()}
      />
    );

    expect(screen.getByText('Aucun produit dans la liste de courses.')).toBeTruthy();
  });

  // Retour explicite du 31/08 : "je n'ai pas la coche verte pour valider ce
  // produit et que tu prennes cette page produit pour le produit en
  // question" — une ligne pas encore au prix ferme doit permettre de valider
  // la page directement depuis ce détail par magasin, sans redescendre
  // chercher le même produit dans le panneau de validation plus bas.
  it('propose "Valider cette page" pour une ligne notFound, absent pour une ligne priced, et confirme via runLivePick au clic', async () => {
    vi.mocked(runLivePick).mockResolvedValue({
      ok: true,
      candidateId: 'price-leclerc-product-2',
      observedName: 'Riz basmati 1kg',
      priceEuro: 2.3
    });
    const onCandidateConfirmed = vi.fn();

    render(
      <CoverageBreakdown
        storeKey="leclerc"
        storeLabel="Leclerc"
        coverage={makeCoverage([
          { itemId: 'item-1', productId: 'product-1', status: 'priced', price: 1.89, candidateId: 'cand-1' },
          { itemId: 'item-2', productId: 'product-2', status: 'notFound' }
        ])}
        productNameById={new Map([
          ['product-1', 'Thé glacé pêche'],
          ['product-2', 'Riz basmati']
        ])}
        productBarcodeById={new Map()}
        candidateById={new Map([['cand-1', makeCandidate()]])}
        onCandidateConfirmed={onCandidateConfirmed}
      />
    );

    expect(screen.getAllByText('Valider cette page')).toHaveLength(1);

    fireEvent.click(screen.getByText('Valider cette page'));

    await waitFor(() => {
      expect(onCandidateConfirmed).toHaveBeenCalledWith('item-2');
    });
    // 6e argument (startUrl) undefined : aucun candidat connu pour cette
    // ligne notFound, rien à passer comme point de départ — comportement
    // d'origine (accueil catalogue) inchangé.
    expect(runLivePick).toHaveBeenCalledWith(
      'product-2',
      'Riz basmati',
      undefined,
      'leclerc',
      expect.any(Function),
      undefined
    );
  });

  // Retour explicite du 31/08 (2e itération) : "je voulais que tu laisses
  // juste le bouton voir le produit [...] et une fois que je suis dessus,
  // il y a le petit overlay avec la coche verte" — pas un bouton séparé :
  // le lien "Voir le produit" lui-même doit armer le pick, et l'amener
  // directement sur le candidat déjà connu plutôt que l'accueil catalogue.
  it('remplace "Voir le produit" par l\'action de pick (avec startUrl) quand un candidat est déjà connu pour une ligne pas encore ferme', async () => {
    vi.mocked(runLivePick).mockResolvedValue({
      ok: true,
      candidateId: 'price-leclerc-product-1',
      observedName: 'Riz basmati Lustucru 10min - 5x180g',
      priceEuro: 3.28
    });
    const onCandidateConfirmed = vi.fn();

    render(
      <CoverageBreakdown
        storeKey="leclerc"
        storeLabel="Leclerc"
        coverage={makeCoverage([
          { itemId: 'item-1', productId: 'product-1', status: 'requiresValidation', price: 3.28, candidateId: 'cand-1' }
        ])}
        productNameById={new Map([['product-1', 'Riz basmati']])}
        productBarcodeById={new Map()}
        candidateById={new Map([['cand-1', makeCandidate({ productUrl: 'https://www.leclercdrive.fr/produit/1' })]])}
        onCandidateConfirmed={onCandidateConfirmed}
      />
    );

    // Un seul contrôle par ligne : pas de "Valider cette page" séparé.
    expect(screen.queryByText('Valider cette page')).toBeNull();
    const trigger = screen.getByText('Voir le produit');
    expect(trigger.tagName).toBe('BUTTON');

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(onCandidateConfirmed).toHaveBeenCalledWith('item-1');
    });
    expect(runLivePick).toHaveBeenCalledWith(
      'product-1',
      'Riz basmati',
      undefined,
      'leclerc',
      expect.any(Function),
      'https://www.leclercdrive.fr/produit/1'
    );
  });
});
