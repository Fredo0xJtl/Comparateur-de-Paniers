import { ListAlreadyUsedNotice } from '../features/shopping-list/ListAlreadyUsedNotice';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listProducts } from '../db/seed';
import {
  addProductToActiveList,
  archiveActiveShoppingList,
  buildShoppingListText,
  clearActiveShoppingList,
  getActiveShoppingListWithItems,
  removeShoppingListItem,
  updateShoppingListItemQuantity,
  type ShoppingListRow
} from '../features/shopping-list/shoppingListService';
import { copyTextWithFallback } from '../features/shopping-list/clipboard';
import { ListImportPanel } from '../features/list-import/ListImportPanel';
import { type Product } from '../types/domain';

export function ShoppingListPage() {
  const [rows, setRows] = useState<ShoppingListRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [copyFallbackText, setCopyFallbackText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  // « Nouvelle liste » range la liste en cours sans moyen de la rouvrir
  // depuis l'application : confirmation, comme pour « Vider la liste » (16/11).
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const [activeList, storedProducts] = await Promise.all([
          getActiveShoppingListWithItems(),
          listProducts()
        ]);
        if (!ignore) {
          setRows(activeList.rows);
          setQuantityDrafts(toQuantityDrafts(activeList.rows));
          setProducts(storedProducts);
          setStatus('ready');
        }
      } catch {
        if (!ignore) {
          setStatus('error');
        }
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, []);

  async function refreshList() {
    const activeList = await getActiveShoppingListWithItems();
    setRows(activeList.rows);
    setQuantityDrafts(toQuantityDrafts(activeList.rows));
    setStatus('ready');
  }

  async function handleAddProduct(product: Product) {
    await addProductToActiveList(product.id);
    setMessage(`${product.name} ajouté à la liste active.`);
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleQuantityCommit(row: ShoppingListRow) {
    const draftValue = quantityDrafts[row.item.id] ?? String(row.item.wantedQuantity);
    const wantedQuantity = Number(draftValue);

    if (!Number.isFinite(wantedQuantity) || wantedQuantity < 1) {
      setQuantityDrafts((current) => ({
        ...current,
        [row.item.id]: String(row.item.wantedQuantity)
      }));
      setMessage('Quantité inchangée : saisir un nombre entier à partir de 1.');
      return;
    }

    try {
      await updateShoppingListItemQuantity(row.item.id, wantedQuantity);
      setMessage('Quantité mise à jour.');
      setCopyFallbackText('');
      setConfirmClear(false);
      await refreshList();
    } catch {
      setMessage("La quantité n'a pas pu être enregistrée.");
    }
  }

  async function handleRemove(row: ShoppingListRow) {
    await removeShoppingListItem(row.item.id);
    setMessage(`${row.product.name} retiré de la liste.`);
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleClearConfirmed() {
    await clearActiveShoppingList();
    setMessage('Liste vidée.');
    setCopyFallbackText('');
    setConfirmClear(false);
    await refreshList();
  }

  async function handleArchive() {
    await archiveActiveShoppingList();
    setMessage('Nouvelle liste commencée. Tes produits restent dans la page Produits.');
    setCopyFallbackText('');
    setConfirmClear(false);
    setConfirmArchive(false);
    await refreshList();
  }

  async function handleCopy() {
    const text = buildShoppingListText(rows);
    const result = await copyTextWithFallback(text);
    if (result === 'copied') {
      setCopyFallbackText('');
      setMessage('Liste copiée en texte.');
    } else {
      setCopyFallbackText(text);
      setMessage('Copie automatique indisponible. Texte affiché ci-dessous.');
    }
  }

  return (
    <section className="pageStack" aria-labelledby="list-title">
      <div className="pageTitle">
        <h2 id="list-title">Ma liste de courses</h2>
        <p className="lead">Ce que tu veux acheter cette fois-ci. Une fois la liste prête, compare les prix.</p>
      </div>

      {message && <p className="panelText">{message}</p>}
      {copyFallbackText && <pre className="copyFallbackText">{copyFallbackText}</pre>}
      {status === 'loading' && <p className="panelText">Chargement de la liste locale...</p>}
      {status === 'error' && (
        <p className="panelText panelTextDanger">Impossible de charger la liste locale.</p>
      )}

      {status === 'ready' && (
        <>
          {rows.length > 0 && <ListAlreadyUsedNotice onNewList={refreshList} />}
          <details className="shoppingListPanel" open>
            <summary>
              <span>Articles de la liste</span>
              <span className="countBadge">{rows.length}</span>
            </summary>

            {rows.length === 0 ? (
              <>
                <p className="panelText">Ta liste est vide. Commence par ajouter un produit.</p>
                <div className="cardActions">
                  <Link className="buttonLink" to="/scan">
                    Ajouter un produit
                  </Link>
                </div>
              </>
            ) : (
              <div className="shoppingRows">
                {rows.map((row) => (
                  <article className="shoppingRow" key={row.item.id}>
                    <div>
                      <h4>{row.product.name}</h4>
                      {row.product.brand && <p>{row.product.brand}</p>}
                    </div>
                    <label>
                      <span>Quantité</span>
                      <input
                        id={`shopping-quantity-${row.item.id}`}
                        name="wantedQuantity"
                        min="1"
                        inputMode="numeric"
                        type="number"
                        value={quantityDrafts[row.item.id] ?? String(row.item.wantedQuantity)}
                        onBlur={() => void handleQuantityCommit(row)}
                        onChange={(event) =>
                          setQuantityDrafts((current) => ({
                            ...current,
                            [row.item.id]: event.target.value
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <button className="dangerButton" type="button" onClick={() => void handleRemove(row)}>
                      Retirer
                    </button>
                  </article>
                ))}
              </div>
            )}

            {rows.length > 0 && (
              <div className="cardActions">
                <button className="secondaryButton" type="button" onClick={() => void handleCopy()}>
                  Copier la liste
                </button>
                <button className="secondaryButton" type="button" onClick={() => setConfirmArchive(true)}>
                  Nouvelle liste
                </button>
              </div>
            )}
            {confirmArchive && rows.length > 0 && (
              <div className="confirmPanel" role="alert">
                <p>
                  Commencer une nouvelle liste vide ? La liste actuelle sera rangée et ne s’affichera plus ici ; tes
                  produits restent dans la page Produits.
                </p>
                <button className="primaryButton" type="button" onClick={() => void handleArchive()}>
                  Nouvelle liste
                </button>
                <button className="secondaryButton" type="button" autoFocus onClick={() => setConfirmArchive(false)}>
                  Annuler
                </button>
              </div>
            )}
          </details>

          {/* L'étape suivante juste sous la liste, pas tout en bas de page. */}
          {rows.length > 0 && (
            <div className="cardActions cardActionsCentered">
              <Link className="buttonLink" to="/scan">
                Ajouter un produit
              </Link>
              <Link className="primaryButton" to="/comparaison">
                Comparer les prix
              </Link>
            </div>
          )}

          <details className="shoppingListPanel shoppingListPanelFavorites" open>
            <summary>
              <span>★ Produits favoris</span>
              <span className="countBadge">{products.filter((product) => product.isFavorite).length}</span>
            </summary>
            {(() => {
              const favorites = products.filter((product) => product.isFavorite);
              return favorites.length === 0 ? (
                <p className="panelText">Aucun favori pour le moment — marque-en depuis la page Produits.</p>
              ) : (
                <div className="quickAddGrid">
                  {favorites.map((product) => (
                    <button
                      className="secondaryButton quickAddButton"
                      key={product.id}
                      type="button"
                      onClick={() => void handleAddProduct(product)}
                    >
                      ★ {product.name}
                    </button>
                  ))}
                </div>
              );
            })()}
          </details>

          <ListImportPanel onImported={() => void refreshList()} />

          {/* Hors des deux <details> ci-dessus : reste accessible tout en
              bas de la page, même volets fermés. */}
          <div className="cardActions cardActionsCentered">
            <button
              className="dangerButton"
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={rows.length === 0}
            >
              Vider la liste
            </button>
          </div>

          {confirmClear && (
            <div className="confirmPanel">
              <p>
                {rows.length > 1
                  ? `Vider la liste ? Les ${rows.length} produits en seront retirés (ils restent dans la page Produits).`
                  : 'Vider la liste ? Le produit en sera retiré (il reste dans la page Produits).'}
              </p>
              <button className="dangerButton" type="button" onClick={() => void handleClearConfirmed()}>
                Confirmer
              </button>
              <button className="secondaryButton" type="button" autoFocus onClick={() => setConfirmClear(false)}>
                Annuler
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function toQuantityDrafts(rows: ShoppingListRow[]) {
  return Object.fromEntries(rows.map((row) => [row.item.id, String(row.item.wantedQuantity)]));
}
